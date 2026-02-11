import type BetterSqlite3 from 'better-sqlite3';

import type { ToolPattern, RoutingSuggestion } from './types.js';
import { inferToolType } from '../hooks/tool-name-parser.js';
import { isLaminarksOwnTool } from '../hooks/self-referential.js';
import { debug } from '../shared/debug.js';

/**
 * Extracts tool sequence patterns from historical tool_usage_events.
 *
 * Scans all successful tool usage events for the project, groups them by session,
 * and identifies recurring sliding-window patterns where a specific sequence of
 * preceding tool calls led to a target tool activation.
 *
 * Runs at SessionStart and stores results in the routing_patterns table for
 * cheap PostToolUse lookup.
 *
 * @param db - Database connection
 * @param projectHash - Project identifier
 * @param windowSize - Number of preceding tools to consider (default 5)
 * @returns Extracted patterns sorted by frequency descending
 */
export function extractPatterns(
  db: BetterSqlite3.Database,
  projectHash: string,
  windowSize: number = 5,
): ToolPattern[] {
  // Query successful tool usage events for this project, ordered by session then time
  const events = db.prepare(`
    SELECT tool_name, session_id
    FROM tool_usage_events
    WHERE project_hash = ? AND success = 1
    ORDER BY session_id, created_at
  `).all(projectHash) as Array<{ tool_name: string; session_id: string }>;

  // Group events by session into arrays of tool_name strings
  const sessions = new Map<string, string[]>();
  for (const evt of events) {
    if (!sessions.has(evt.session_id)) {
      sessions.set(evt.session_id, []);
    }
    sessions.get(evt.session_id)!.push(evt.tool_name);
  }

  // Extract sliding-window patterns
  const patternCounts = new Map<string, { target: string; preceding: string[]; count: number }>();

  for (const [, toolSequence] of sessions) {
    for (let i = windowSize; i < toolSequence.length; i++) {
      const target = toolSequence[i];
      const preceding = toolSequence.slice(i - windowSize, i);

      // Skip built-in tools as targets (we never suggest those)
      if (inferToolType(target) === 'builtin') continue;
      // Skip Laminark's own tools as targets
      if (isLaminarksOwnTool(target)) continue;

      const key = `${target}:${preceding.join(',')}`;
      const existing = patternCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        patternCounts.set(key, { target, preceding, count: 1 });
      }
    }
  }

  // Filter to patterns with frequency >= 2 (appeared at least twice) and sort by frequency
  return Array.from(patternCounts.values())
    .filter(p => p.count >= 2)
    .map(p => ({
      targetTool: p.target,
      precedingTools: p.preceding,
      frequency: p.count,
    }))
    .sort((a, b) => b.frequency - a.frequency);
}

/**
 * Stores pre-computed routing patterns in the routing_patterns table.
 *
 * Creates the table inline (CREATE TABLE IF NOT EXISTS), deletes old patterns
 * for the project, and inserts new ones in a transaction.
 *
 * @param db - Database connection
 * @param projectHash - Project identifier
 * @param patterns - Pre-computed patterns from extractPatterns()
 */
export function storePrecomputedPatterns(
  db: BetterSqlite3.Database,
  projectHash: string,
  patterns: ToolPattern[],
): void {
  // Create table inline (no migration -- transient data refreshed each SessionStart)
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_hash TEXT NOT NULL,
      target_tool TEXT NOT NULL,
      preceding_tools TEXT NOT NULL,
      frequency INTEGER NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_routing_patterns_project ON routing_patterns(project_hash)
  `);

  // Transaction: delete old patterns for this project, insert new ones
  const deleteStmt = db.prepare('DELETE FROM routing_patterns WHERE project_hash = ?');
  const insertStmt = db.prepare(
    'INSERT INTO routing_patterns (project_hash, target_tool, preceding_tools, frequency) VALUES (?, ?, ?, ?)',
  );

  const upsertAll = db.transaction(() => {
    deleteStmt.run(projectHash);
    for (const pattern of patterns) {
      insertStmt.run(
        projectHash,
        pattern.targetTool,
        JSON.stringify(pattern.precedingTools),
        pattern.frequency,
      );
    }
  });

  upsertAll();
  debug('routing', 'Stored pre-computed patterns', { projectHash, count: patterns.length });
}

/**
 * Evaluates the current session's recent tool sequence against pre-computed patterns.
 *
 * Queries the current session's recent tool names, compares against stored patterns,
 * and returns the best match if it exceeds the confidence threshold and the target
 * tool is in the suggestable set.
 *
 * @param db - Database connection
 * @param sessionId - Current session identifier
 * @param projectHash - Project identifier
 * @param suggestableToolNames - Set of tool names available for suggestion (availability gate)
 * @param confidenceThreshold - Minimum confidence to return a suggestion
 * @returns Best matching suggestion, or null if none qualifies
 */
export function evaluateLearnedPatterns(
  db: BetterSqlite3.Database,
  sessionId: string,
  projectHash: string,
  suggestableToolNames: Set<string>,
  confidenceThreshold: number,
): RoutingSuggestion | null {
  // Get the current session's recent tool names (last 10 events, newest first)
  const recentEvents = db.prepare(`
    SELECT tool_name FROM tool_usage_events
    WHERE session_id = ? AND project_hash = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(sessionId, projectHash) as Array<{ tool_name: string }>;

  // Reverse to chronological order for sequence comparison
  const currentTools = recentEvents.map(e => e.tool_name).reverse();

  if (currentTools.length === 0) return null;

  // Query pre-computed patterns for this project
  const storedPatterns = db.prepare(`
    SELECT target_tool, preceding_tools, frequency
    FROM routing_patterns
    WHERE project_hash = ?
    ORDER BY frequency DESC
  `).all(projectHash) as Array<{ target_tool: string; preceding_tools: string; frequency: number }>;

  if (storedPatterns.length === 0) return null;

  let bestMatch: { targetTool: string; confidence: number; frequency: number } | null = null;

  for (const row of storedPatterns) {
    // Availability gate: only consider patterns whose target is in the suggestable set
    if (!suggestableToolNames.has(row.target_tool)) continue;

    const patternTools: string[] = JSON.parse(row.preceding_tools);
    const overlap = computeSequenceOverlap(currentTools, patternTools);

    if (overlap > (bestMatch?.confidence ?? 0)) {
      bestMatch = {
        targetTool: row.target_tool,
        confidence: overlap,
        frequency: row.frequency,
      };
    }
  }

  if (!bestMatch || bestMatch.confidence < confidenceThreshold) return null;

  return {
    toolName: bestMatch.targetTool,
    toolDescription: null,
    confidence: bestMatch.confidence,
    tier: 'learned',
    reason: `Tool sequence pattern match (seen ${bestMatch.frequency}x in similar contexts)`,
  };
}

/**
 * Computes Jaccard-like overlap between the current session's recent tool set
 * and a pattern's preceding tools set.
 *
 * Takes the last N tools from the current sequence (where N = pattern length),
 * converts both to sets, and counts how many pattern tools appear in the current set.
 *
 * @param currentTools - Current session's recent tool names (chronological order)
 * @param patternTools - Pattern's preceding tools
 * @returns Overlap score from 0.0 to 1.0
 */
export function computeSequenceOverlap(
  currentTools: string[],
  patternTools: string[],
): number {
  if (patternTools.length === 0) return 0;

  const current = new Set(currentTools.slice(-patternTools.length));
  const pattern = new Set(patternTools);

  let matches = 0;
  for (const tool of pattern) {
    if (current.has(tool)) matches++;
  }

  return matches / pattern.size;
}
