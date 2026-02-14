/**
 * Path recall — finds relevant past resolved debug paths based on text similarity.
 *
 * Used by the PreToolUse hook to surface "you've seen this before" context
 * when new debugging starts on similar issues.
 *
 * Implements INTEL-03: proactive path recall via Jaccard similarity matching.
 */

import { jaccardSimilarity } from '../shared/similarity.js';
import type { PathRepository } from './path-repository.js';
import type { DebugPath } from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface PathRecallResult {
  path: DebugPath;
  similarity: number;
  kissSummary: string | null;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Finds past resolved debug paths similar to the current context text.
 *
 * Computes Jaccard similarity against both trigger_summary and resolution_summary
 * of recent resolved paths, taking the max score. Filters to paths scoring >= 0.25
 * and returns the top `limit` results sorted by similarity descending.
 */
export function findSimilarPaths(
  pathRepo: PathRepository,
  currentContext: string,
  limit: number = 3,
): PathRecallResult[] {
  // Get recent paths and filter to resolved ones
  const recentPaths = pathRepo.listPaths(50);
  const resolvedPaths = recentPaths.filter(p => p.status === 'resolved');

  if (resolvedPaths.length === 0) return [];

  // Score each resolved path by similarity to current context
  const scored: PathRecallResult[] = [];

  for (const path of resolvedPaths) {
    const triggerScore = jaccardSimilarity(currentContext, path.trigger_summary);
    const resolutionScore = jaccardSimilarity(currentContext, path.resolution_summary ?? '');
    const similarity = Math.max(triggerScore, resolutionScore);

    if (similarity >= 0.25) {
      // Parse kiss_summary from JSON string
      let kissSummary: string | null = null;
      if (path.kiss_summary) {
        try {
          const parsed = JSON.parse(path.kiss_summary);
          // KissSummary has a next_time field — use that as the actionable summary
          kissSummary = parsed.next_time ?? parsed.root_cause ?? null;
        } catch {
          kissSummary = null;
        }
      }

      scored.push({ path, similarity, kissSummary });
    }
  }

  // Sort by similarity descending, return top N
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Formats path recall results into a compact string for context injection.
 *
 * Returns empty string if no results. Caps total output to 600 chars.
 */
export function formatPathRecall(results: PathRecallResult[]): string {
  if (results.length === 0) return '';

  const lines: string[] = ['[Laminark] Similar past debug paths found:'];

  for (const r of results) {
    const trigger = r.path.trigger_summary.slice(0, 80);
    lines.push(`- ${trigger} (similarity: ${r.similarity.toFixed(2)})`);
    lines.push(`  KISS: ${r.kissSummary ?? 'No summary available'}`);
  }

  const output = lines.join('\n');

  if (output.length > 600) {
    return output.slice(0, 597) + '...';
  }

  return output;
}
