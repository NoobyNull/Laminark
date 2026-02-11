import type BetterSqlite3 from 'better-sqlite3';

import type { Observation, ObservationKind, Session } from '../shared/types.js';
import type { ObservationRow } from '../shared/types.js';
import { rowToObservation } from '../shared/types.js';
import type { ToolRegistryRepository } from '../storage/tool-registry.js';
import type { ToolRegistryRow, ToolUsageStats } from '../shared/tool-types.js';
import { debug } from '../shared/debug.js';

/**
 * Maximum character budget for injected context (~2000 tokens at ~3 chars/token).
 * If the assembled context exceeds this, observations are truncated.
 */
const MAX_CONTEXT_CHARS = 6000;

/**
 * Maximum number of characters to show per observation in the index.
 */
const OBSERVATION_CONTENT_LIMIT = 120;

/**
 * Maximum number of tools to show in the context section.
 * Keeps the tool section compact to preserve budget for observations.
 */
const MAX_TOOLS_IN_CONTEXT = 10;

/**
 * Maximum character budget for the "## Available Tools" section.
 * Prevents tool listings from consuming too much of the 6000-char overall budget.
 */
const TOOL_SECTION_BUDGET = 500;

/**
 * Welcome message for first-ever session (no prior sessions or observations).
 */
const WELCOME_MESSAGE = `[Laminark] First session detected. Memory system is active and capturing observations.
Use /laminark:remember to save important context. Use /laminark:recall to search memories.`;

/**
 * Formats an ISO 8601 timestamp into a human-readable relative time string.
 *
 * @param isoDate - ISO 8601 timestamp string
 * @returns Relative time string (e.g., "2 hours ago", "yesterday", "3 days ago")
 */
export function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (weeks === 1) return '1 week ago';
  return `${weeks} weeks ago`;
}

/**
 * Truncates a string to `maxLen` characters, appending "..." if truncated.
 */
function truncate(text: string, maxLen: number): string {
  // Normalize whitespace (collapse newlines/tabs to spaces)
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen) + '...';
}

/**
 * Queries recent observations filtered by kind with a time window.
 */
function getRecentByKind(
  db: BetterSqlite3.Database,
  projectHash: string,
  kind: ObservationKind,
  limit: number,
  sinceDays: number,
): Observation[] {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM observations
       WHERE project_hash = ? AND kind = ? AND deleted_at IS NULL
         AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(projectHash, kind, since, limit) as ObservationRow[];
  return rows.map(rowToObservation);
}

/**
 * Formats the context using structured kind-aware sections.
 *
 * Produces a compact index suitable for Claude's context window:
 * - Last session summary
 * - Recent changes (with provenance context)
 * - Active decisions
 * - Reference docs
 * - Findings
 */
export function formatContextIndex(
  lastSession: Session | null,
  sections: {
    changes: Observation[];
    decisions: Observation[];
    findings: Observation[];
    references: Observation[];
  },
): string {
  const hasContent = lastSession?.summary ||
    sections.changes.length > 0 ||
    sections.decisions.length > 0 ||
    sections.findings.length > 0 ||
    sections.references.length > 0;

  if (!hasContent) {
    return WELCOME_MESSAGE;
  }

  const lines: string[] = ['[Laminark - Session Context]', ''];

  if (lastSession && lastSession.summary) {
    lines.push('## Previous Session');
    lines.push(lastSession.summary);
    lines.push('');
  }

  if (sections.changes.length > 0) {
    lines.push('## Recent Changes');
    for (const obs of sections.changes) {
      const content = truncate(obs.content, OBSERVATION_CONTENT_LIMIT);
      const relTime = formatRelativeTime(obs.createdAt);
      lines.push(`- ${content} (${relTime})`);
    }
    lines.push('');
  }

  if (sections.decisions.length > 0) {
    lines.push('## Active Decisions');
    for (const obs of sections.decisions) {
      const content = truncate(obs.content, OBSERVATION_CONTENT_LIMIT);
      lines.push(`- ${content}`);
    }
    lines.push('');
  }

  if (sections.references.length > 0) {
    lines.push('## Reference Docs');
    for (const obs of sections.references) {
      const content = truncate(obs.content, OBSERVATION_CONTENT_LIMIT);
      lines.push(`- ${content}`);
    }
    lines.push('');
  }

  if (sections.findings.length > 0) {
    lines.push('## Recent Findings');
    for (const obs of sections.findings) {
      const shortId = obs.id.slice(0, 8);
      const content = truncate(obs.content, OBSERVATION_CONTENT_LIMIT);
      lines.push(`- [${shortId}] ${content}`);
    }
  }

  return lines.join('\n');
}

/**
 * Queries recent high-value observations for context injection.
 * Kind-aware: prioritizes changes, decisions, and findings.
 *
 * @param db - better-sqlite3 database connection
 * @param projectHash - Project scope identifier
 * @param limit - Maximum observations to return (default 5)
 * @returns Array of high-value observations
 */
export function getHighValueObservations(
  db: BetterSqlite3.Database,
  projectHash: string,
  limit: number = 5,
): Observation[] {
  debug('context', 'Querying high-value observations', { projectHash, limit });

  const rows = db
    .prepare(
      `SELECT * FROM observations
       WHERE project_hash = ? AND deleted_at IS NULL
         AND classification IS NOT NULL AND classification != 'noise'
       ORDER BY
         CASE
           WHEN source = 'mcp:save_memory' THEN 0
           WHEN source = 'slash:remember' THEN 0
           WHEN kind = 'change' THEN 1
           WHEN kind = 'decision' THEN 1
           ELSE 2
         END ASC,
         created_at DESC,
         rowid DESC
       LIMIT ?`,
    )
    .all(projectHash, limit) as ObservationRow[];

  debug('context', 'High-value observations retrieved', { count: rows.length });

  return rows.map(rowToObservation);
}

/**
 * Gets the most recent completed session with a non-null summary.
 */
function getLastCompletedSession(
  db: BetterSqlite3.Database,
  projectHash: string,
): Session | null {
  const row = db
    .prepare(
      `SELECT * FROM sessions
       WHERE project_hash = ? AND summary IS NOT NULL AND ended_at IS NOT NULL
       ORDER BY ended_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(projectHash) as
    | {
        id: string;
        project_hash: string;
        started_at: string;
        ended_at: string | null;
        summary: string | null;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    projectHash: row.project_hash,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
  };
}

/**
 * Ranks tools by relevance using a weighted combination of recent usage
 * frequency and recency. Tools with no recent usage score 0.
 *
 * Formula: score = eventCount / totalEvents (frequency share among peers)
 *
 * Uses event-count-based window (last N events) instead of time-based decay.
 * This is immune to usage gaps — if you don't use the app for a week,
 * your usage patterns are preserved because the window slides by event
 * count, not calendar time.
 *
 * MCP server entries aggregate usage stats from their individual tool events
 * to ensure accurate scoring.
 */
function rankToolsByRelevance(
  tools: ToolRegistryRow[],
  usageStats: ToolUsageStats[],
): ToolRegistryRow[] {
  if (usageStats.length === 0) return tools; // No event data: keep existing order

  // Build direct lookup: tool_name -> stats
  const statsMap = new Map<string, ToolUsageStats>();
  for (const stat of usageStats) {
    statsMap.set(stat.tool_name, stat);
  }

  // Aggregate usage stats by MCP server prefix for server-level rows
  const serverStats = new Map<string, { usage_count: number }>();
  for (const stat of usageStats) {
    const match = stat.tool_name.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
    if (match) {
      const serverName = match[1];
      const existing = serverStats.get(serverName);
      if (existing) {
        existing.usage_count += stat.usage_count;
      } else {
        serverStats.set(serverName, { usage_count: stat.usage_count });
      }
    }
  }

  // Total events across all tools (floor of 1 prevents division by zero)
  const totalEvents = Math.max(1,
    [...statsMap.values()].reduce((sum, s) => sum + s.usage_count, 0),
  );

  const scored = tools.map(row => {
    // Look up stats directly by tool name first
    let count: number | undefined = statsMap.get(row.name)?.usage_count;

    // For MCP server rows, fall back to aggregated server stats
    if (count === undefined && row.tool_type === 'mcp_server' && row.server_name) {
      count = serverStats.get(row.server_name)?.usage_count;
    }

    if (count === undefined) {
      return { row, score: 0 };
    }

    // Frequency share: what fraction of recent events belong to this tool
    return { row, score: count / totalEvents };
  });

  // Sort by score descending; ties broken by lifetime usage_count descending
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.row.usage_count - a.row.usage_count;
  });

  return scored.map(s => s.row);
}

/**
 * Formats available tools as a compact section for session context.
 *
 * Deduplicates MCP servers vs individual MCP tools (prefers server entries).
 * Excludes built-in tools (Claude already knows Read, Write, Edit, Bash, etc.).
 * Enforces a 500-character sub-budget via incremental line checking.
 */
function formatToolSection(tools: ToolRegistryRow[]): string {
  if (tools.length === 0) return '';

  // Deduplicate: prefer mcp_server entries over individual mcp_tool entries
  const seenServers = new Set<string>();
  const deduped: ToolRegistryRow[] = [];

  // First pass: collect server-level entries
  for (const tool of tools) {
    if (tool.tool_type === 'mcp_server') {
      seenServers.add(tool.server_name ?? tool.name);
      deduped.push(tool);
    }
  }
  // Second pass: add non-server entries, skipping individual tools from listed servers
  for (const tool of tools) {
    if (tool.tool_type !== 'mcp_server') {
      if (tool.tool_type === 'mcp_tool' && tool.server_name && seenServers.has(tool.server_name)) {
        continue;
      }
      deduped.push(tool);
    }
  }

  // Exclude built-in tools -- Claude already knows about them
  const displayable = deduped.filter(t => t.tool_type !== 'builtin');

  if (displayable.length === 0) return '';

  const lines: string[] = ['## Available Tools'];

  for (const tool of displayable) {
    const scopeTag = tool.scope === 'project' ? 'project' : 'global';
    const usageStr = tool.usage_count > 0 ? `, ${tool.usage_count}x` : '';

    let candidateLine: string;
    if (tool.tool_type === 'mcp_server') {
      candidateLine = `- MCP: ${tool.server_name ?? tool.name} (${scopeTag}${usageStr})`;
    } else if (tool.tool_type === 'slash_command') {
      candidateLine = `- ${tool.name} (${scopeTag}${usageStr})`;
    } else if (tool.tool_type === 'skill') {
      const desc = tool.description ? ` - ${tool.description}` : '';
      candidateLine = `- skill: ${tool.name} (${scopeTag})${desc}`;
    } else if (tool.tool_type === 'plugin') {
      candidateLine = `- plugin: ${tool.name} (${scopeTag})`;
    } else {
      candidateLine = `- ${tool.name} (${scopeTag}${usageStr})`;
    }

    // Incremental budget check: stop if adding this line exceeds 500 chars
    if ([...lines, candidateLine].join('\n').length > TOOL_SECTION_BUDGET) break;
    lines.push(candidateLine);
  }

  // Overflow indicator: show how many tools were dropped
  const added = lines.length - 1; // subtract header line
  if (displayable.length > added && added > 0) {
    const overflow = `(${displayable.length - added} more available)`;
    if ((lines.join('\n') + '\n' + overflow).length <= TOOL_SECTION_BUDGET) {
      lines.push(overflow);
    }
  }

  return lines.join('\n');
}

/**
 * Assembles the complete context string for SessionStart injection.
 *
 * Kind-aware: queries changes (last 24h), decisions (last 7d),
 * findings (last 7d), and references (last 3d) separately,
 * then assembles them into structured sections.
 *
 * Token budget: Total output stays under 2000 tokens (~6000 characters).
 */
export function assembleSessionContext(
  db: BetterSqlite3.Database,
  projectHash: string,
  toolRegistry?: ToolRegistryRepository,
): string {
  debug('context', 'Assembling session context', { projectHash });

  const lastSession = getLastCompletedSession(db, projectHash);

  // Kind-aware queries with different time windows and limits
  const changes = getRecentByKind(db, projectHash, 'change', 10, 1);
  const decisions = getRecentByKind(db, projectHash, 'decision', 5, 7);
  const findings = getRecentByKind(db, projectHash, 'finding', 5, 7);
  const references = getRecentByKind(db, projectHash, 'reference', 3, 3);

  // SCOP-02: Query scope-filtered tools for this session
  let toolSection = '';
  if (toolRegistry) {
    try {
      const availableTools = toolRegistry.getAvailableForSession(projectHash);
      const usageStats = toolRegistry.getRecentUsage(projectHash, 200);
      const ranked = rankToolsByRelevance(availableTools, usageStats);
      toolSection = formatToolSection(ranked);
    } catch {
      // Tool registry is supplementary -- never block context assembly
    }
  }

  let context = formatContextIndex(lastSession, { changes, decisions, findings, references });

  // Append tool section after observations (lower priority for budget)
  if (toolSection) {
    context = context + '\n\n' + toolSection;
  }

  // Enforce token budget: progressively trim sections
  if (context.length > MAX_CONTEXT_CHARS) {
    debug('context', 'Context exceeds budget, trimming', {
      length: context.length,
      budget: MAX_CONTEXT_CHARS,
    });

    // Drop tool section first (lowest priority)
    if (toolSection) {
      context = formatContextIndex(lastSession, { changes, decisions, findings, references });
      toolSection = ''; // Mark as dropped so we don't re-add
    }
  }

  if (context.length > MAX_CONTEXT_CHARS) {
    // Trim in priority order: references first, then findings, then changes
    let trimmedRefs = references.slice();
    let trimmedFindings = findings.slice();
    let trimmedChanges = changes.slice();

    while (context.length > MAX_CONTEXT_CHARS && trimmedRefs.length > 0) {
      trimmedRefs = trimmedRefs.slice(0, -1);
      context = formatContextIndex(lastSession, {
        changes: trimmedChanges, decisions, findings: trimmedFindings, references: trimmedRefs,
      });
    }
    if (context.length > MAX_CONTEXT_CHARS) {
      while (context.length > MAX_CONTEXT_CHARS && trimmedFindings.length > 0) {
        trimmedFindings = trimmedFindings.slice(0, -1);
        context = formatContextIndex(lastSession, {
          changes: trimmedChanges, decisions, findings: trimmedFindings, references: trimmedRefs,
        });
      }
    }
    if (context.length > MAX_CONTEXT_CHARS) {
      while (context.length > MAX_CONTEXT_CHARS && trimmedChanges.length > 0) {
        trimmedChanges = trimmedChanges.slice(0, -1);
        context = formatContextIndex(lastSession, {
          changes: trimmedChanges, decisions, findings: trimmedFindings, references: trimmedRefs,
        });
      }
    }
  }

  debug('context', 'Session context assembled', { length: context.length });

  return context;
}
