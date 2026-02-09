import type BetterSqlite3 from 'better-sqlite3';

import type { Observation, Session } from '../shared/types.js';
import type { ObservationRow } from '../shared/types.js';
import { rowToObservation } from '../shared/types.js';
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
 * Formats the context using progressive disclosure.
 *
 * Produces a compact index suitable for Claude's context window:
 * - Last session summary (if available)
 * - Recent observation index with truncated content and IDs for drill-down
 *
 * @param lastSession - The most recent completed session (with summary), or null
 * @param recentObservations - Recent high-value observations
 * @returns Formatted context string
 */
export function formatContextIndex(
  lastSession: Session | null,
  recentObservations: Observation[],
): string {
  if (!lastSession && recentObservations.length === 0) {
    return WELCOME_MESSAGE;
  }

  const lines: string[] = ['[Laminark Context - Session Recovery]', ''];

  if (lastSession && lastSession.summary) {
    const timeRange = lastSession.endedAt
      ? `${lastSession.startedAt} to ${lastSession.endedAt}`
      : lastSession.startedAt;
    lines.push(`## Last Session (${timeRange})`);
    lines.push(lastSession.summary);
    lines.push('');
  }

  if (recentObservations.length > 0) {
    lines.push('## Recent Memories (use search tool for full details)');
    for (const obs of recentObservations) {
      const shortId = obs.id.slice(0, 8);
      const content = truncate(obs.content, OBSERVATION_CONTENT_LIMIT);
      const relTime = formatRelativeTime(obs.createdAt);
      lines.push(`- [${shortId}] ${content} (source: ${obs.source}, ${relTime})`);
    }
  }

  return lines.join('\n');
}

/**
 * Queries recent high-value observations for context injection.
 *
 * Priority ordering:
 * 1. Observations from source "mcp:save_memory" (user explicitly saved)
 * 2. Observations from source "slash:remember" (user explicitly saved via slash command)
 * 3. Most recent observations regardless of source
 *
 * Excludes deleted observations. Scoped to projectHash.
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

  // Query with priority: explicit saves first, then recency
  // Uses CASE expression to sort mcp:save_memory and slash:remember sources first
  const rows = db
    .prepare(
      `SELECT * FROM observations
       WHERE project_hash = ? AND deleted_at IS NULL
       ORDER BY
         CASE
           WHEN source = 'mcp:save_memory' THEN 0
           WHEN source = 'slash:remember' THEN 0
           ELSE 1
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
 *
 * @param db - better-sqlite3 database connection
 * @param projectHash - Project scope identifier
 * @returns The last session with a summary, or null
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
 * Assembles the complete context string for SessionStart injection.
 *
 * This is the main entry point for context injection. It queries the database
 * for the last completed session summary and recent high-value observations,
 * then formats them into a compact progressive disclosure index.
 *
 * Performance: All queries are synchronous (better-sqlite3). Expected execution
 * time is under 100ms (2-3 simple SELECT queries on indexed columns).
 *
 * Token budget: Total output stays under 2000 tokens (~6000 characters).
 * If content exceeds budget, observations are trimmed (session summary preserved).
 *
 * @param db - better-sqlite3 database connection
 * @param projectHash - Project scope identifier
 * @returns Formatted context string for injection into Claude's context window
 */
export function assembleSessionContext(
  db: BetterSqlite3.Database,
  projectHash: string,
): string {
  debug('context', 'Assembling session context', { projectHash });

  const lastSession = getLastCompletedSession(db, projectHash);
  const observations = getHighValueObservations(db, projectHash, 5);

  let context = formatContextIndex(lastSession, observations);

  // Enforce token budget: if over limit, progressively remove observations
  if (context.length > MAX_CONTEXT_CHARS) {
    debug('context', 'Context exceeds budget, trimming observations', {
      length: context.length,
      budget: MAX_CONTEXT_CHARS,
    });

    // Remove observations one by one from the end until within budget
    let trimmedObs = observations.slice();
    while (trimmedObs.length > 0 && context.length > MAX_CONTEXT_CHARS) {
      trimmedObs = trimmedObs.slice(0, -1);
      context = formatContextIndex(lastSession, trimmedObs);
    }
  }

  debug('context', 'Session context assembled', { length: context.length });

  return context;
}
