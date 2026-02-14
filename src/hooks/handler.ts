import { openDatabase } from '../storage/database.js';
import { getDatabaseConfig, getProjectHash } from '../shared/config.js';
import { ObservationRepository } from '../storage/observations.js';
import { ResearchBufferRepository } from '../storage/research-buffer.js';
import { SessionRepository } from '../storage/sessions.js';
import { extractObservation } from './capture.js';
import { handleSessionStart, handleSessionEnd, handleStop } from './session-lifecycle.js';
import { redactSensitiveContent, isExcludedFile } from './privacy-filter.js';
import { shouldAdmit, isMeaningfulBashCommand } from './admission-filter.js';
import { SaveGuard } from './save-guard.js';
import { isLaminarksOwnTool } from './self-referential.js';
import { handlePreToolUse } from './pre-tool-context.js';
import { ToolRegistryRepository } from '../storage/tool-registry.js';
import { ConversationRouter } from '../routing/conversation-router.js';
import { inferToolType, inferScope, extractServerName } from './tool-name-parser.js';
import { PathRepository } from '../paths/path-repository.js';
import { initPathSchema } from '../paths/schema.js';
import { debug } from '../shared/debug.js';

/**
 * Hook handler entry point.
 *
 * This file is the CLI entry point for all Claude Code hook events.
 * It reads stdin JSON, opens a direct SQLite connection (no HTTP intermediary),
 * dispatches to the appropriate handler based on hook_event_name, and exits 0.
 *
 * CRITICAL CONSTRAINTS:
 * - Only SessionStart and PreToolUse write to stdout (synchronous hooks -- stdout is injected into Claude's context window)
 * - All other hooks NEVER write to stdout (stdout output is interpreted by Claude Code)
 * - ALWAYS exits 0 (non-zero exit codes surface as errors to Claude)
 * - Opens its own database connection (WAL mode handles concurrent access with MCP server)
 * - Imports only storage modules -- NO @modelcontextprotocol/sdk (cold start overhead)
 *
 * Filter pipeline (PostToolUse/PostToolUseFailure):
 *   0. Organic tool discovery (DISC-05: records ALL tools including Laminark's own)
 *   1. Self-referential filter (dual-prefix: mcp__laminark__ and mcp__plugin_laminark_laminark__)
 *   2. Extract observation text from payload
 *   3. Privacy filter: exclude sensitive files, redact secrets
 *   4. Admission filter: reject noise content
 *   5. Store to database
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Tools that are routed to the research buffer instead of creating observations.
 * These are high-volume exploration tools whose individual calls are noise,
 * but whose targets provide useful provenance context for subsequent changes.
 */
const RESEARCH_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * Processes a PostToolUse or PostToolUseFailure event through the full
 * filter pipeline: route research tools -> extract -> privacy -> admission -> store.
 *
 * Exported for unit testing of the pipeline logic.
 */
export function processPostToolUseFiltered(
  input: Record<string, unknown>,
  obsRepo: ObservationRepository,
  researchBuffer?: ResearchBufferRepository,
  toolRegistry?: ToolRegistryRepository,
  projectHash?: string,
  db?: import('better-sqlite3').Database,
): void {
  const toolName = input.tool_name as string | undefined;
  const hookEventName = input.hook_event_name as string | undefined;

  if (!toolName) {
    debug('hook', 'PostToolUse missing tool_name, skipping');
    return;
  }

  // 0. DISC-05: Organic tool discovery -- record every tool we see
  // This runs BEFORE the self-referential filter so Laminark's own tools are registered
  if (toolRegistry) {
    try {
      const sessionId = input.session_id as string | undefined;
      const isFailure = hookEventName === 'PostToolUseFailure';
      toolRegistry.recordOrCreate(toolName, {
        toolType: inferToolType(toolName),
        scope: inferScope(toolName),
        source: 'hook:PostToolUse',
        projectHash: projectHash ?? null,
        description: null,
        serverName: extractServerName(toolName),
      }, sessionId ?? null, !isFailure);

      // STAL-03: Failure-driven demotion / success restoration
      if (isFailure) {
        // Check sliding window: 3+ failures in last 5 events triggers demotion
        const recentEvents = toolRegistry.getRecentEventsForTool(
          toolName, projectHash ?? '', 5,
        );
        const failures = recentEvents.filter(e => e.success === 0).length;
        if (failures >= 3) {
          toolRegistry.markDemoted(toolName, projectHash ?? null);
          debug('hook', 'Tool demoted due to failures', { tool: toolName, failures });
        }
      } else {
        // Successful use restores demoted tools immediately
        toolRegistry.markActive(toolName, projectHash ?? null);
      }
    } catch {
      // Non-fatal: registry is supplementary to core memory function
    }
  }

  // 1. Skip self-referential capture (Laminark observing its own operations)
  if (isLaminarksOwnTool(toolName)) {
    debug('hook', 'Skipping self-referential tool', { tool: toolName });
    return;
  }

  // 2. Extract file path from tool_input (for file exclusion check)
  const toolInput = (input.tool_input as Record<string, unknown>) ?? {};
  const filePath = toolInput.file_path as string | undefined;

  // 3. Privacy filter: check file exclusion first
  if (filePath && isExcludedFile(filePath)) {
    debug('hook', 'Observation excluded (sensitive file)', { tool: toolName, filePath });
    return;
  }

  // 3.5. Route exploration tools to research buffer (not full observations)
  if (RESEARCH_TOOLS.has(toolName) && researchBuffer) {
    const target = String(toolInput.file_path ?? toolInput.pattern ?? '');
    researchBuffer.add({
      sessionId: (input.session_id as string) ?? null,
      toolName,
      target,
    });
    return;
  }

  // 3.6. Filter navigation Bash commands (only for success events)
  if (toolName === 'Bash' && hookEventName !== 'PostToolUseFailure') {
    const command = String(toolInput.command ?? '');
    if (!isMeaningfulBashCommand(command)) {
      debug('hook', 'Bash command filtered as navigation', { command: command.slice(0, 60) });
      return;
    }
  }

  // 4. Extract observation text from payload
  const payload = {
    session_id: input.session_id as string,
    cwd: input.cwd as string,
    hook_event_name: input.hook_event_name as string,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: input.tool_response as Record<string, unknown> | undefined,
    tool_use_id: input.tool_use_id as string | undefined,
  };

  const summary = extractObservation(payload);

  if (summary === null) {
    debug('hook', 'No observation extracted', { tool: toolName });
    return;
  }

  // 5. Privacy filter: redact sensitive content
  let redacted = redactSensitiveContent(summary, filePath);

  if (redacted === null) {
    debug('hook', 'Observation excluded by privacy filter', { tool: toolName });
    return;
  }

  // 5.5. Attach research context to Write/Edit observations
  if ((toolName === 'Write' || toolName === 'Edit') && researchBuffer && payload.session_id) {
    const research = researchBuffer.getRecent(payload.session_id, 5);
    if (research.length > 0) {
      const lines = research.map(r => `  - [${r.toolName}] ${r.target}`).join('\n');
      redacted += `\nResearch context:\n${lines}`;
    }
  }

  // 6. Admission filter: reject noise
  if (!shouldAdmit(toolName, redacted)) {
    debug('hook', 'Observation rejected by admission filter', { tool: toolName });
    return;
  }

  // 6.5. Save guard: duplicate detection
  const guard = new SaveGuard(obsRepo);
  const decision = guard.evaluateSync(redacted, 'hook:' + toolName);
  if (!decision.save) {
    debug('hook', 'Observation rejected by save guard', {
      tool: toolName, reason: decision.reason, duplicateOf: decision.duplicateOf,
    });
    return;
  }

  // 7. Determine observation kind from tool type
  let kind = 'finding';
  if (toolName === 'Write' || toolName === 'Edit') {
    kind = 'change';
  } else if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    kind = 'reference';
  } else if (toolName === 'Bash') {
    const command = String(toolInput.command ?? '');
    if (/^git\s+(commit|push|merge|rebase|cherry-pick)\b/.test(command.trim())) {
      kind = 'change';
    } else {
      kind = 'verification';
    }
  }

  // 8. Store the filtered, redacted observation
  obsRepo.create({
    content: redacted,
    source: 'hook:' + toolName,
    kind,
    sessionId: payload.session_id ?? null,
  });

  debug('hook', 'Captured observation', { tool: toolName, kind, length: redacted.length });

  // 9. ROUT-01/02/03/04: Routing evaluation (suggest tools based on conversation context)
  // Runs AFTER observation storage and self-referential filter
  if (db && toolRegistry && projectHash) {
    try {
      const sessionId = input.session_id as string | undefined;
      if (sessionId) {
        const router = new ConversationRouter(db, projectHash);
        router.evaluate(sessionId, toolName, toolRegistry);
      }
    } catch {
      // Routing is supplementary -- never block core pipeline
    }
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as Record<string, unknown>;

  const eventName = input.hook_event_name as string;
  const cwd = input.cwd as string;

  if (!eventName || !cwd) {
    debug('hook', 'Missing hook_event_name or cwd in input');
    return;
  }

  const projectHash = getProjectHash(cwd);

  debug('hook', 'Processing hook event', { eventName, projectHash });

  // Open database -- cheap with WAL mode (~2ms)
  const laminarkDb = openDatabase(getDatabaseConfig());

  try {
    const obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
    const sessionRepo = new SessionRepository(laminarkDb.db, projectHash);
    let researchBuffer: ResearchBufferRepository | undefined;
    try {
      researchBuffer = new ResearchBufferRepository(laminarkDb.db, projectHash);
    } catch {
      // research_buffer table may not exist yet before migration 13
    }
    let toolRegistry: ToolRegistryRepository | undefined;
    try {
      toolRegistry = new ToolRegistryRepository(laminarkDb.db);
    } catch {
      // tool_registry table may not exist yet before migration 16
    }
    let pathRepo: PathRepository | undefined;
    try {
      initPathSchema(laminarkDb.db);
      pathRepo = new PathRepository(laminarkDb.db, projectHash);
    } catch {
      // debug_paths table may not exist yet
    }

    switch (eventName) {
      case 'PreToolUse': {
        const preContext = handlePreToolUse(input, laminarkDb.db, projectHash, pathRepo);
        if (preContext) process.stdout.write(preContext);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        processPostToolUseFiltered(input, obsRepo, researchBuffer, toolRegistry, projectHash, laminarkDb.db);
        break;
      case 'SessionStart': {
        const context = handleSessionStart(input, sessionRepo, laminarkDb.db, projectHash, toolRegistry, pathRepo);
        // SessionStart is synchronous -- stdout is injected into Claude's context window
        if (context) {
          process.stdout.write(context);
        }
        break;
      }
      case 'SessionEnd':
        handleSessionEnd(input, sessionRepo);
        break;
      case 'Stop':
        handleStop(input, obsRepo, sessionRepo);
        break;
      default:
        debug('hook', 'Unknown hook event', { eventName });
        break;
    }
  } finally {
    laminarkDb.close();
  }
}

// Wrap in .catch() -- hooks must NEVER fail. Always exit 0.
main().catch((err: Error) => {
  debug('hook', 'Hook handler error', { error: err.message });
});
