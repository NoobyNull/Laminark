import type BetterSqlite3 from 'better-sqlite3';

import type { ToolRegistryRow } from '../shared/tool-types.js';
import type { RoutingSuggestion } from './types.js';
import { debug } from '../shared/debug.js';

// ---------------------------------------------------------------------------
// Context snapshot types
// ---------------------------------------------------------------------------

export interface ContextSnapshot {
  branch: {
    arcStage: string;
    branchType: string;
    observationCount: number;
    toolPattern: Record<string, number>;
  } | null;
  debugPath: {
    status: string;
    waypointCount: number;
    errorCount: number;
  } | null;
  recentClassifications: string[];
}

// ---------------------------------------------------------------------------
// Context loading (3 fast SQLite queries)
// ---------------------------------------------------------------------------

/**
 * Loads a lightweight snapshot of current session context.
 * Three small queries, each <3ms on a typical database.
 */
export function loadContextSnapshot(
  db: BetterSqlite3.Database,
  projectHash: string,
  sessionId: string,
): ContextSnapshot {
  // 1. Active thought branch
  let branch: ContextSnapshot['branch'] = null;
  try {
    const row = db.prepare(`
      SELECT arc_stage, branch_type, observation_count, tool_pattern
      FROM thought_branches
      WHERE project_hash = ? AND session_id = ? AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get(projectHash, sessionId) as {
      arc_stage: string;
      branch_type: string;
      observation_count: number;
      tool_pattern: string;
    } | undefined;

    if (row) {
      let toolPattern: Record<string, number> = {};
      try { toolPattern = JSON.parse(row.tool_pattern); } catch { /* empty */ }
      branch = {
        arcStage: row.arc_stage,
        branchType: row.branch_type,
        observationCount: row.observation_count,
        toolPattern,
      };
    }
  } catch {
    // thought_branches table may not exist
  }

  // 2. Active debug path
  let debugPath: ContextSnapshot['debugPath'] = null;
  try {
    const pathRow = db.prepare(`
      SELECT dp.status,
        (SELECT COUNT(*) FROM path_waypoints pw WHERE pw.path_id = dp.id) AS waypoint_count,
        (SELECT COUNT(*) FROM path_waypoints pw WHERE pw.path_id = dp.id AND pw.waypoint_type = 'error') AS error_count
      FROM debug_paths dp
      WHERE dp.project_hash = ? AND dp.status = 'active'
      ORDER BY dp.started_at DESC LIMIT 1
    `).get(projectHash) as {
      status: string;
      waypoint_count: number;
      error_count: number;
    } | undefined;

    if (pathRow) {
      debugPath = {
        status: pathRow.status,
        waypointCount: pathRow.waypoint_count,
        errorCount: pathRow.error_count,
      };
    }
  } catch {
    // debug_paths table may not exist
  }

  // 3. Recent observation classifications
  let recentClassifications: string[] = [];
  try {
    const rows = db.prepare(`
      SELECT classification FROM observations
      WHERE project_hash = ? AND session_id = ? AND deleted_at IS NULL AND classification IS NOT NULL
      ORDER BY created_at DESC LIMIT 5
    `).all(projectHash, sessionId) as Array<{ classification: string }>;
    recentClassifications = rows.map(r => r.classification);
  } catch {
    // classification column may not exist
  }

  return { branch, debugPath, recentClassifications };
}

// ---------------------------------------------------------------------------
// Context rules (tool-agnostic)
// ---------------------------------------------------------------------------

interface ContextRule {
  id: string;
  searchKeywords: string[];
  confidence: number;
  reason: string;
  matches(ctx: ContextSnapshot): boolean;
}

/**
 * Rules map context patterns to keyword categories, NOT tool names.
 * The engine then searches the tool registry for matching tools.
 */
export const CONTEXT_RULES: ContextRule[] = [
  {
    id: 'debug-session',
    searchKeywords: ['debug', 'error tracking', 'issue investigation', 'systematic debugging'],
    confidence: 0.8,
    reason: 'Diagnosis stage detected with problems but no active debug path',
    matches(ctx) {
      if (!ctx.branch) return false;
      const inDiagnosis = ctx.branch.arcStage === 'diagnosis' || ctx.branch.arcStage === 'investigation';
      const hasProblems = ctx.recentClassifications.some(c => c === 'problem' || c === 'error');
      const noActivePath = !ctx.debugPath;
      return inDiagnosis && hasProblems && noActivePath;
    },
  },
  {
    id: 'planning-needed',
    searchKeywords: ['plan', 'design', 'architecture', 'implementation strategy'],
    confidence: 0.7,
    reason: 'Investigation phase with 5+ observations suggests planning would help',
    matches(ctx) {
      if (!ctx.branch) return false;
      const inInvestigation = ctx.branch.arcStage === 'investigation';
      const enoughObservations = ctx.branch.observationCount >= 5;
      // Mostly reads = Read/Grep/Glob dominate the tool pattern
      const readTools = (ctx.branch.toolPattern['Read'] ?? 0) +
        (ctx.branch.toolPattern['Grep'] ?? 0) +
        (ctx.branch.toolPattern['Glob'] ?? 0);
      const totalTools = Object.values(ctx.branch.toolPattern).reduce((a, b) => a + b, 0);
      const mostlyReads = totalTools > 0 && readTools / totalTools > 0.6;
      return inInvestigation && enoughObservations && mostlyReads;
    },
  },
  {
    id: 'ready-to-commit',
    searchKeywords: ['commit', 'save changes', 'checkpoint'],
    confidence: 0.75,
    reason: 'Execution stage with recent resolutions — good time to commit',
    matches(ctx) {
      if (!ctx.branch) return false;
      const inExecution = ctx.branch.arcStage === 'execution';
      const hasResolutions = ctx.recentClassifications.some(c => c === 'resolution' || c === 'success');
      const recentSuccesses = ctx.recentClassifications.filter(c => c === 'success' || c === 'resolution').length;
      return inExecution && hasResolutions && recentSuccesses >= 2;
    },
  },
  {
    id: 'verify-work',
    searchKeywords: ['verify', 'validate', 'test', 'acceptance', 'UAT'],
    confidence: 0.7,
    reason: 'Feature branch in verification stage',
    matches(ctx) {
      if (!ctx.branch) return false;
      return ctx.branch.branchType === 'feature' && ctx.branch.arcStage === 'verification';
    },
  },
  {
    id: 'resume-debugging',
    searchKeywords: ['debug', 'continue debugging', 'resume investigation'],
    confidence: 0.75,
    reason: 'Active debug path with multiple errors detected',
    matches(ctx) {
      if (!ctx.branch || !ctx.debugPath) return false;
      const inInvestigation = ctx.branch.arcStage === 'investigation' || ctx.branch.arcStage === 'diagnosis';
      return ctx.debugPath.status === 'active' && inInvestigation && ctx.debugPath.errorCount >= 2;
    },
  },
  {
    id: 'check-progress',
    searchKeywords: ['progress', 'status', 'milestone', 'overview'],
    confidence: 0.65,
    reason: 'Extended execution — consider reviewing progress',
    matches(ctx) {
      if (!ctx.branch) return false;
      return ctx.branch.arcStage === 'execution' && ctx.branch.observationCount >= 10;
    },
  },
];

// ---------------------------------------------------------------------------
// Tool matching (in-memory scan)
// ---------------------------------------------------------------------------

interface ToolMatch {
  tool: ToolRegistryRow;
  relevance: number;
}

/**
 * Searches suggestable tools for the best match against a set of keywords.
 * Checks trigger_hints, description, and name for substring matches.
 *
 * This is a lightweight in-memory scan, not a DB query.
 */
export function findMatchingTool(
  keywords: string[],
  suggestableTools: ToolRegistryRow[],
): ToolMatch | null {
  let best: ToolMatch | null = null;

  for (const tool of suggestableTools) {
    // Build searchable text from all relevant fields
    const searchText = [
      tool.trigger_hints ?? '',
      tool.description ?? '',
      tool.name,
    ].join(' ').toLowerCase();

    let matchCount = 0;
    for (const keyword of keywords) {
      if (searchText.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }

    if (matchCount === 0) continue;

    const relevance = matchCount / keywords.length;

    if (!best || relevance > best.relevance) {
      best = { tool, relevance };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates proactive suggestions by matching context rules against available tools.
 *
 * Returns the highest-confidence match (rule confidence * tool relevance) that
 * exceeds the threshold, or null if nothing qualifies.
 */
export function evaluateProactiveSuggestions(
  ctx: ContextSnapshot,
  suggestableTools: ToolRegistryRow[],
  threshold: number,
): RoutingSuggestion | null {
  let bestSuggestion: RoutingSuggestion | null = null;
  let bestScore = 0;

  for (const rule of CONTEXT_RULES) {
    try {
      if (!rule.matches(ctx)) continue;

      const toolMatch = findMatchingTool(rule.searchKeywords, suggestableTools);
      if (!toolMatch) continue;

      const combinedScore = rule.confidence * toolMatch.relevance;

      if (combinedScore > bestScore && combinedScore >= threshold) {
        bestScore = combinedScore;
        bestSuggestion = {
          toolName: toolMatch.tool.name,
          toolDescription: toolMatch.tool.description,
          confidence: combinedScore,
          tier: 'proactive',
          reason: rule.reason,
        };
      }
    } catch (err) {
      debug('proactive', `Rule ${rule.id} failed`, { error: String(err) });
    }
  }

  return bestSuggestion;
}
