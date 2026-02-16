/**
 * Infers arc stage from tool pattern counts within a branch.
 *
 * No LLM call -- deterministic based on tool usage ratios.
 *
 * Classification sources (in priority order):
 *   1. Built-in tool table (hardcoded, always correct)
 *   2. Registry-primed cache (from tool_registry descriptions at startup)
 *   3. Name-pattern fallback (regex heuristic for tools not yet in registry)
 *
 * The cache is re-primed whenever the tool registry changes (detected by
 * row count delta). BranchTracker calls `primeFromRegistry()` on startup
 * and during periodic maintenance.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { ArcStage } from './types.js';
import { debug } from '../shared/debug.js';

// ---------------------------------------------------------------------------
// Arc Category
// ---------------------------------------------------------------------------

export type ArcCategory = 'investigation' | 'write' | 'verification' | 'planning' | 'uncategorized';

// ---------------------------------------------------------------------------
// Built-in Tool Categories (fast path, always correct)
// ---------------------------------------------------------------------------

const BUILTIN_CATEGORY: Record<string, ArcCategory> = {
  // Investigation
  'Read': 'investigation',
  'Glob': 'investigation',
  'Grep': 'investigation',
  'WebSearch': 'investigation',
  'WebFetch': 'investigation',
  'Task': 'investigation',
  'AskUserQuestion': 'investigation',

  // Write/execution
  'Write': 'write',
  'Edit': 'write',
  'NotebookEdit': 'write',

  // Verification
  'Bash': 'verification',

  // Planning
  'EnterPlanMode': 'planning',
  'ExitPlanMode': 'planning',
  'TaskCreate': 'planning',
  'TaskUpdate': 'planning',
  'TaskList': 'planning',
  'TaskGet': 'planning',
  'Skill': 'uncategorized',
};

// ---------------------------------------------------------------------------
// Description-keyword classification
// ---------------------------------------------------------------------------

/** Keywords matched against tool descriptions (case-insensitive). */
const DESCRIPTION_RULES: Array<{ category: ArcCategory; keywords: RegExp }> = [
  // Planning first (most specific)
  { category: 'planning', keywords: /\b(plan|todo|task|roadmap|milestone|phase|design|architect)\b/i },

  // Verification
  { category: 'verification', keywords: /\b(run|test|build|execute|evaluate|validate|verify|check|assert|lint|compile)\b/i },

  // Write/mutation
  { category: 'write', keywords: /\b(write|edit|create|update|save|upload|modify|delete|remove|fill|type|click|select|drag|press|submit|install|deploy|push|commit|insert|drop|replace)\b/i },

  // Investigation (broadest)
  { category: 'investigation', keywords: /\b(read|search|query|find|list|get|fetch|browse|snapshot|screenshot|inspect|show|view|discover|status|stats|navigate|hover|recall|monitor|log|trace|debug|profile|measure|analyze|explore)\b/i },
];

/**
 * Classify a tool from its description text.
 * Returns null if no confident match.
 */
function classifyFromDescription(description: string): ArcCategory | null {
  for (const rule of DESCRIPTION_RULES) {
    if (rule.keywords.test(description)) {
      return rule.category;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Name-pattern fallback (for tools not in registry)
// ---------------------------------------------------------------------------

const NAME_RULES: Array<{ category: ArcCategory; pattern: RegExp }> = [
  { category: 'planning', pattern: /\b(plan|todo|task|roadmap|phase|milestone)\b/i },
  { category: 'verification', pattern: /\b(run|test|build|exec|evaluate|validate|check|verify)\b/i },
  { category: 'write', pattern: /\b(write|edit|create|update|save|upload|fill|type|click|select|drag|press|install)\b/i },
  { category: 'investigation', pattern: /\b(search|query|find|list|get|read|fetch|browse|snapshot|screenshot|inspect|show|view|recall|discover|status|stats|console|network|navigate|tabs|hover)\b/i },
];

function classifyFromName(toolName: string): ArcCategory {
  // For MCP tools, extract the action part after the last `__`
  const actionPart = toolName.includes('__')
    ? toolName.substring(toolName.lastIndexOf('__') + 2)
    : toolName;

  for (const rule of NAME_RULES) {
    if (rule.pattern.test(actionPart)) return rule.category;
  }

  // Laminark's own tools are investigation
  if (toolName.includes('laminark')) return 'investigation';

  return 'uncategorized';
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

const classificationCache = new Map<string, ArcCategory>();
let lastRegistryCount = -1;

// ---------------------------------------------------------------------------
// Public: prime cache from tool registry
// ---------------------------------------------------------------------------

/**
 * Re-reads the tool_registry table and classifies every tool by its
 * description. Only rescans when the registry row count has changed.
 *
 * Call on startup and periodically (e.g., during BranchTracker maintenance).
 */
export function primeFromRegistry(db: BetterSqlite3.Database, projectHash: string): void {
  try {
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM tool_registry').get() as { cnt: number } | undefined;
    const currentCount = countRow?.cnt ?? 0;

    // Skip if registry hasn't changed
    if (currentCount === lastRegistryCount && lastRegistryCount >= 0) return;

    const rows = db.prepare(`
      SELECT name, description FROM tool_registry
      WHERE status = 'active'
        AND (scope = 'global' OR project_hash IS NULL OR project_hash = ?)
    `).all(projectHash) as Array<{ name: string; description: string | null }>;

    let primed = 0;
    for (const row of rows) {
      // Don't override built-in classifications
      if (BUILTIN_CATEGORY[row.name]) continue;

      let category: ArcCategory | null = null;

      // Try description first (best signal)
      if (row.description) {
        category = classifyFromDescription(row.description);
      }

      // Fall back to name patterns
      if (!category) {
        category = classifyFromName(row.name);
      }

      classificationCache.set(row.name, category);
      primed++;
    }

    lastRegistryCount = currentCount;
    debug('branches', 'Arc detector cache primed from registry', {
      registryTools: rows.length,
      primed,
    });
  } catch {
    // tool_registry may not exist yet (pre-migration-16)
  }
}

// ---------------------------------------------------------------------------
// Public: classify a single tool
// ---------------------------------------------------------------------------

/**
 * Classify any tool name into an arc category.
 *
 * Priority: built-in table > registry-primed cache > name-pattern fallback.
 */
export function classifyTool(toolName: string): ArcCategory {
  // 1. Check cache (includes both built-in and registry-primed entries)
  const cached = classificationCache.get(toolName);
  if (cached) return cached;

  // 2. Built-in exact match
  const builtin = BUILTIN_CATEGORY[toolName];
  if (builtin) {
    classificationCache.set(toolName, builtin);
    return builtin;
  }

  // 3. Name-pattern fallback (tool not in registry yet)
  const fromName = classifyFromName(toolName);
  classificationCache.set(toolName, fromName);
  return fromName;
}

// ---------------------------------------------------------------------------
// Public: infer arc stage
// ---------------------------------------------------------------------------

/**
 * Infers the current arc stage from tool usage pattern counts.
 *
 * Handles all tool types: builtins, MCP tools, plugins, skills, slash commands.
 * Uncategorized tools are excluded from ratio calculations so they don't
 * dilute the signal from known tools.
 *
 * @param toolPattern - Map of tool name to usage count within the branch
 * @param classification - Optional dominant observation classification
 * @returns The inferred arc stage
 */
export function inferArcStage(
  toolPattern: Record<string, number>,
  classification?: string | null,
): ArcStage {
  let investigationCount = 0;
  let writeCount = 0;
  let verificationCount = 0;
  let planningCount = 0;
  let categorizedCount = 0;

  for (const [tool, count] of Object.entries(toolPattern)) {
    const category = classifyTool(tool);
    switch (category) {
      case 'investigation':
        investigationCount += count;
        categorizedCount += count;
        break;
      case 'write':
        writeCount += count;
        categorizedCount += count;
        break;
      case 'verification':
        verificationCount += count;
        categorizedCount += count;
        break;
      case 'planning':
        planningCount += count;
        categorizedCount += count;
        break;
      case 'uncategorized':
        // Excluded from ratios so unknown tools don't dilute the signal
        break;
    }
  }

  if (categorizedCount === 0) return 'investigation';

  // Check for verification: Bash/test commands after writes
  if (verificationCount > 0 && writeCount > 0) {
    const verificationRatio = verificationCount / categorizedCount;
    if (verificationRatio > 0.2) return 'verification';
  }

  // Check for execution: Write/Edit dominates
  const writeRatio = writeCount / categorizedCount;
  if (writeRatio > 0.4) return 'execution';

  // Check for planning: plan mode or task creation
  if (planningCount > 0) {
    const planRatio = planningCount / categorizedCount;
    if (planRatio > 0.1) return 'planning';
  }

  // Check for diagnosis: observations classified as 'problem' with mixed read/write
  if (classification === 'problem' && writeCount > 0 && investigationCount > 0) {
    return 'diagnosis';
  }

  // Default: investigation (mostly reads)
  return 'investigation';
}
