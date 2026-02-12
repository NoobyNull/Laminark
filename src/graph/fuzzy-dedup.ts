/**
 * Fuzzy deduplication strategies for knowledge graph entities.
 *
 * Extends the existing exact-match, abbreviation, and path normalization
 * strategies with:
 *   - Levenshtein distance (max 2 chars) for typo tolerance
 *   - Jaccard word similarity (0.7 threshold) on tokenized names
 *   - Path suffix matching for File type
 *
 * These are integrated into the entity deduplication pipeline via
 * findFuzzyDuplicates(), called from constraints.ts.
 */

import type { GraphNode } from './types.js';
import type { GraphExtractionConfig } from '../config/graph-extraction-config.js';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_LEVENSHTEIN = 2;
const DEFAULT_JACCARD_THRESHOLD = 0.7;

// =============================================================================
// Levenshtein Distance
// =============================================================================

/**
 * Computes Levenshtein edit distance between two strings.
 * Uses the iterative matrix approach with O(min(m,n)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;

  let prev = new Array<number>(aLen + 1);
  let curr = new Array<number>(aLen + 1);

  for (let i = 0; i <= aLen; i++) {
    prev[i] = i;
  }

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,       // deletion
        curr[i - 1] + 1,   // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[aLen];
}

// =============================================================================
// Jaccard Word Similarity
// =============================================================================

/**
 * Tokenizes a name by splitting on common delimiters: / . _ -
 * and lowercasing all tokens.
 */
export function tokenizeName(name: string): Set<string> {
  const tokens = name.toLowerCase().split(/[/._\-\s]+/).filter(t => t.length > 0);
  return new Set(tokens);
}

/**
 * Computes Jaccard similarity between two token sets.
 * J(A,B) = |A ∩ B| / |A ∪ B|
 * Returns 0 if both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// =============================================================================
// Path Suffix Matching
// =============================================================================

/**
 * Checks if two File paths refer to the same file via suffix matching.
 * For example: "src/graph/types.ts" and "graph/types.ts" match because
 * one is a suffix of the other.
 */
export function isPathSuffixMatch(path1: string, path2: string): boolean {
  // Normalize paths
  const norm1 = path1.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
  const norm2 = path2.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();

  if (norm1 === norm2) return false; // Exact match handled elsewhere

  // Check if one is a suffix of the other
  return norm1.endsWith('/' + norm2) || norm2.endsWith('/' + norm1);
}

// =============================================================================
// Fuzzy Duplicate Detection
// =============================================================================

/**
 * Finds fuzzy duplicates among a list of same-type nodes.
 *
 * Strategies applied:
 *   1. Levenshtein distance ≤ max (default 2) for typo tolerance
 *   2. Jaccard word similarity ≥ threshold (default 0.7)
 *   3. Path suffix matching for File type
 *
 * Only compares nodes of the same type. Returns grouped duplicate
 * candidates with reasons.
 *
 * @param nodes - Nodes to check (should be same type for best results)
 * @param config - Optional configuration overrides
 * @returns Array of duplicate groups with entities and reason
 */
export function findFuzzyDuplicates(
  nodes: GraphNode[],
  config?: GraphExtractionConfig,
): Array<{ entities: GraphNode[]; reason: string }> {
  const maxLev = config?.fuzzyDedup?.maxLevenshteinDistance ?? DEFAULT_MAX_LEVENSHTEIN;
  const jaccardThresh = config?.fuzzyDedup?.jaccardThreshold ?? DEFAULT_JACCARD_THRESHOLD;

  const duplicates: Array<{ entities: GraphNode[]; reason: string }> = [];
  const seen = new Set<string>(); // Track already-grouped pairs

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];

      // Only compare same-type entities
      if (a.type !== b.type) continue;

      const pairKey = [a.id, b.id].sort().join(',');
      if (seen.has(pairKey)) continue;

      const aLower = a.name.toLowerCase();
      const bLower = b.name.toLowerCase();

      // Skip exact case-insensitive matches (handled by existing strategy)
      if (aLower === bLower) continue;

      // Strategy 1: Levenshtein distance for short names (avoid expensive computation on long strings)
      if (aLower.length <= 50 && bLower.length <= 50) {
        // Only apply if lengths are similar (within maxLev difference)
        if (Math.abs(aLower.length - bLower.length) <= maxLev) {
          const dist = levenshteinDistance(aLower, bLower);
          if (dist > 0 && dist <= maxLev) {
            seen.add(pairKey);
            duplicates.push({
              entities: [a, b],
              reason: `Fuzzy match (Levenshtein distance ${dist}): "${a.name}" ↔ "${b.name}"`,
            });
            continue;
          }
        }
      }

      // Strategy 2: Jaccard word similarity
      const tokensA = tokenizeName(a.name);
      const tokensB = tokenizeName(b.name);
      // Only apply if both have multiple tokens (single-token names use Levenshtein)
      if (tokensA.size >= 2 && tokensB.size >= 2) {
        const similarity = jaccardSimilarity(tokensA, tokensB);
        if (similarity >= jaccardThresh) {
          seen.add(pairKey);
          duplicates.push({
            entities: [a, b],
            reason: `Fuzzy match (Jaccard similarity ${similarity.toFixed(2)}): "${a.name}" ↔ "${b.name}"`,
          });
          continue;
        }
      }

      // Strategy 3: Path suffix matching (File type only)
      if (a.type === 'File') {
        if (isPathSuffixMatch(a.name, b.name)) {
          seen.add(pairKey);
          duplicates.push({
            entities: [a, b],
            reason: `Path suffix match: "${a.name}" ↔ "${b.name}"`,
          });
        }
      }
    }
  }

  return duplicates;
}
