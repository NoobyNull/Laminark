import type BetterSqlite3 from 'better-sqlite3';

import type { ObservationRepository } from '../storage/observations.js';
import type { SessionRepository } from '../storage/sessions.js';
import type { ToolRegistryRepository } from '../storage/tool-registry.js';
import type { DiscoveredTool } from '../shared/tool-types.js';
import { generateSessionSummary } from '../curation/summarizer.js';
import { assembleSessionContext } from '../context/injection.js';
import { scanConfigForTools } from './config-scanner.js';
import { extractPatterns, storePrecomputedPatterns } from '../routing/intent-patterns.js';
import type { PathRepository } from '../paths/path-repository.js';
import type { BranchRepository } from '../branches/branch-repository.js';
import { debug } from '../shared/debug.js';

/**
 * STAL-01: Detects tools that have been removed from config since last scan.
 *
 * Compares currently scanned config tools against the registry and marks
 * missing config-sourced tools as stale. Also cascades to individual MCP tools
 * from removed MCP servers.
 */
function detectRemovedTools(
  toolRegistry: ToolRegistryRepository,
  scannedTools: DiscoveredTool[],
  projectHash: string,
): void {
  // 1. Get all config-sourced tools currently marked active for this project (+ globals)
  const registeredConfigTools = toolRegistry.getConfigSourcedTools(projectHash);

  // 2. Build a Set of scanned tool names for O(1) lookup
  const scannedNames = new Set(scannedTools.map(t => t.name));

  // 3. Mark tools missing from scan as stale
  //    IMPORTANT: For wildcard MCP server entries (mcp__X__*), also mark
  //    individual tools from that server (mcp__X__specific_tool).
  //    Extract server name from wildcard entries that disappeared.
  const removedServers = new Set<string>();

  for (const registered of registeredConfigTools) {
    if (!scannedNames.has(registered.name)) {
      toolRegistry.markStale(registered.name, registered.project_hash);

      // Track removed MCP server names for individual tool cleanup
      if (registered.tool_type === 'mcp_server' && registered.server_name) {
        removedServers.add(registered.server_name);
      }
    }
  }

  // 4. Mark individual tools from removed MCP servers as stale
  //    These are organically-discovered tools (source = 'hook:PostToolUse')
  //    whose parent server was removed from config
  if (removedServers.size > 0) {
    for (const registered of toolRegistry.getAvailableForSession(projectHash)) {
      if (
        registered.server_name &&
        removedServers.has(registered.server_name) &&
        registered.tool_type === 'mcp_tool'
      ) {
        toolRegistry.markStale(registered.name, registered.project_hash);
      }
    }
  }

  // 5. Restore tools that reappeared in the scan
  //    The upsert in the scan loop already sets status='active' (per Plan 01),
  //    so we only need to handle tools that were previously stale
  //    and are now scanned again. The upsert handles this automatically.
}

/**
 * Handles a SessionStart hook event.
 *
 * Creates a new session record in the database, then assembles context
 * from prior sessions and observations for injection into Claude's
 * context window.
 *
 * This hook is SYNCHRONOUS -- stdout is injected into Claude's context.
 * Must complete within 2 seconds (performance budget for sync hooks).
 * Expected execution: <100ms (session create + 2-3 SELECT queries).
 *
 * @returns Context string to write to stdout, or null if no context available
 */
export function handleSessionStart(
  input: Record<string, unknown>,
  sessionRepo: SessionRepository,
  db: BetterSqlite3.Database,
  projectHash: string,
  toolRegistry?: ToolRegistryRepository,
  pathRepo?: PathRepository,
  branchRepo?: BranchRepository,
): string | null {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'SessionStart missing session_id, skipping');
    return null;
  }

  sessionRepo.create(sessionId);
  debug('session', 'Session started', { sessionId });

  // Update project_metadata with the real project directory from the hook input.
  // The MCP server's process.cwd() returns the plugin install path, not the user's project.
  const cwd = input.cwd as string;
  if (cwd) {
    try {
      db.prepare(`
        INSERT INTO project_metadata (project_hash, project_path, last_seen_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(project_hash) DO UPDATE SET
          project_path = excluded.project_path,
          last_seen_at = excluded.last_seen_at
      `).run(projectHash, cwd);
    } catch {
      // Table may not exist yet
    }
  }

  // DISC-01 through DISC-04: Scan config files for available tools
  if (toolRegistry) {
    const cwd = input.cwd as string;
    try {
      const scanStart = Date.now();
      const tools = scanConfigForTools(cwd, projectHash);
      for (const tool of tools) {
        toolRegistry.upsert(tool);
      }

      // STAL-01: Detect tools removed from config
      try {
        detectRemovedTools(toolRegistry, tools, projectHash);
        debug('session', 'Staleness detection completed');
      } catch {
        debug('session', 'Staleness detection failed (non-fatal)');
      }

      const scanElapsed = Date.now() - scanStart;
      debug('session', 'Config scan completed', { toolsFound: tools.length, elapsed: scanElapsed });
      if (scanElapsed > 200) {
        debug('session', 'Config scan slow (>200ms budget)', { elapsed: scanElapsed });
      }
    } catch {
      // Tool registry is supplementary -- never block session start
      debug('session', 'Config scan failed (non-fatal)');
    }
  }

  // ROUT-01: Pre-compute routing patterns for this session
  if (toolRegistry) {
    try {
      const precomputeStart = Date.now();
      const patterns = extractPatterns(db, projectHash, 5);
      storePrecomputedPatterns(db, projectHash, patterns);
      const precomputeElapsed = Date.now() - precomputeStart;
      debug('session', 'Routing patterns pre-computed', { patternCount: patterns.length, elapsed: precomputeElapsed });
      if (precomputeElapsed > 50) {
        debug('session', 'Pattern pre-computation slow (>50ms)', { elapsed: precomputeElapsed });
      }
    } catch {
      // Routing is supplementary -- never block session start
      debug('session', 'Pattern pre-computation failed (non-fatal)');
    }
  }

  // Assemble context from prior sessions and observations
  const startTime = Date.now();
  let context = assembleSessionContext(db, projectHash, toolRegistry);
  const elapsed = Date.now() - startTime;

  if (elapsed > 500) {
    debug('session', 'Context assembly slow', { elapsed, sessionId });
  }

  debug('session', 'Context assembled for injection', {
    sessionId,
    contextLength: context.length,
    elapsed,
  });

  // PATH-06: Check for active debug paths from prior sessions
  if (pathRepo) {
    try {
      const activePath = pathRepo.findRecentActivePath();
      if (activePath) {
        const ageMs = Date.now() - new Date(activePath.started_at).getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          // Auto-abandon stale paths (>24h old)
          pathRepo.abandonPath(activePath.id);
          debug('session', 'Auto-abandoned stale debug path', { pathId: activePath.id, ageMs });
        } else {
          // Surface the active path for continuation
          const waypoints = pathRepo.getWaypoints(activePath.id);
          const lastWaypoint = waypoints[waypoints.length - 1];
          const pathContext = `\n[Laminark] Active debug path carried over from prior session:\n` +
            `  Issue: ${activePath.trigger_summary}\n` +
            `  Waypoints: ${waypoints.length}\n` +
            `  Last activity: ${lastWaypoint?.summary?.slice(0, 100) ?? 'none'}\n` +
            `  Use path_show to see full path, or path_resolve to close it.\n`;
          context = context + pathContext;
        }
      }
    } catch {
      debug('session', 'Cross-session path check failed (non-fatal)');
    }
  }

  // BRANCH-01: Check for active thought branch from prior sessions
  if (branchRepo) {
    try {
      const activeBranch = branchRepo.findRecentActiveBranch();
      if (activeBranch) {
        const title = activeBranch.title ?? activeBranch.id.slice(0, 12);
        const branchContext = `\n[Laminark] Active work branch carried over:\n` +
          `  ${title} (${activeBranch.branch_type})\n` +
          `  Stage: ${activeBranch.arc_stage} | Observations: ${activeBranch.observation_count}\n` +
          `  Use query_branches to see all branches.\n`;
        context = context + branchContext;
      }
    } catch {
      debug('session', 'Cross-session branch check failed (non-fatal)');
    }
  }

  // DISC-05: Prompt Claude to report its available tools for registry population.
  // The report_available_tools MCP tool accepts {tools: [{name, description}]}.
  // This runs every session (upsert is idempotent) to keep the registry fresh.
  const toolReportPrompt = toolRegistry
    ? '\nCall report_available_tools with all your tools (built-in and MCP) so Laminark can index them for discovery.'
    : '';

  return context + toolReportPrompt;
}

/**
 * Handles a SessionEnd hook event.
 *
 * Closes the session record by setting ended_at timestamp.
 */
export function handleSessionEnd(
  input: Record<string, unknown>,
  sessionRepo: SessionRepository,
): void {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'SessionEnd missing session_id, skipping');
    return;
  }

  sessionRepo.end(sessionId);

  debug('session', 'Session ended', { sessionId });
}

/**
 * Handles a Stop hook event.
 *
 * Triggers session summary generation by compressing all observations
 * from the session into a concise summary stored on the session row.
 *
 * Stop fires after SessionEnd, so the session is already closed.
 * Summary generation is heuristic (no LLM call) and typically completes
 * in under 10ms even with many observations.
 *
 * If the session has zero observations, this is a graceful no-op.
 */
export function handleStop(
  input: Record<string, unknown>,
  obsRepo: ObservationRepository,
  sessionRepo: SessionRepository,
): void {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'Stop missing session_id, skipping');
    return;
  }

  debug('session', 'Stop event received, generating summary', { sessionId });

  const result = generateSessionSummary(sessionId, obsRepo, sessionRepo);

  if (result) {
    debug('session', 'Session summary generated', {
      sessionId,
      observationCount: result.observationCount,
      summaryLength: result.summary.length,
    });
  } else {
    debug('session', 'No observations to summarize', { sessionId });
  }
}
