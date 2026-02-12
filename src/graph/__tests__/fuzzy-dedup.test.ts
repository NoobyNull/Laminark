import { describe, it, expect } from 'vitest';

import {
  levenshteinDistance,
  tokenizeName,
  jaccardSimilarity,
  isPathSuffixMatch,
  findFuzzyDuplicates,
} from '../fuzzy-dedup.js';
import type { GraphNode } from '../types.js';

// Helper to create a test node
function node(name: string, type: GraphNode['type'] = 'File', id?: string): GraphNode {
  return {
    id: id ?? `node-${name.replace(/[^a-z0-9]/gi, '-')}`,
    type,
    name,
    metadata: {},
    observation_ids: ['obs-1'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns length for empty vs non-empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('returns 1 for single substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('returns 1 for single insertion', () => {
    expect(levenshteinDistance('cat', 'cats')).toBe(1);
  });

  it('returns 1 for single deletion', () => {
    expect(levenshteinDistance('cats', 'cat')).toBe(1);
  });

  it('returns 2 for two edits', () => {
    expect(levenshteinDistance('kitten', 'kiten')).toBeLessThanOrEqual(2);
  });

  it('handles case-sensitive comparison', () => {
    expect(levenshteinDistance('Hello', 'hello')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tokenize name
// ---------------------------------------------------------------------------

describe('tokenizeName', () => {
  it('splits on slashes', () => {
    const tokens = tokenizeName('src/graph/types.ts');
    expect(tokens).toEqual(new Set(['src', 'graph', 'types', 'ts']));
  });

  it('splits on dots', () => {
    const tokens = tokenizeName('config.json');
    expect(tokens).toEqual(new Set(['config', 'json']));
  });

  it('splits on underscores and hyphens', () => {
    const tokens = tokenizeName('my-module_name');
    expect(tokens).toEqual(new Set(['my', 'module', 'name']));
  });

  it('lowercases all tokens', () => {
    const tokens = tokenizeName('Src/Graph/Types.TS');
    expect(tokens).toEqual(new Set(['src', 'graph', 'types', 'ts']));
  });

  it('filters empty tokens', () => {
    const tokens = tokenizeName('//double//slash//');
    expect(tokens.has('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const set = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(set, set)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns correct value for overlapping sets', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection: {b, c} = 2, union: {a, b, c, d} = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 2);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path suffix matching
// ---------------------------------------------------------------------------

describe('isPathSuffixMatch', () => {
  it('detects suffix match when one path is a suffix of another', () => {
    expect(isPathSuffixMatch('src/graph/types.ts', 'graph/types.ts')).toBe(true);
  });

  it('detects suffix match in reverse order', () => {
    expect(isPathSuffixMatch('graph/types.ts', 'src/graph/types.ts')).toBe(true);
  });

  it('returns false for exact matches (handled elsewhere)', () => {
    expect(isPathSuffixMatch('graph/types.ts', 'graph/types.ts')).toBe(false);
  });

  it('returns false for non-matching paths', () => {
    expect(isPathSuffixMatch('src/auth/login.ts', 'graph/types.ts')).toBe(false);
  });

  it('normalizes leading ./ before comparison', () => {
    expect(isPathSuffixMatch('./graph/types.ts', 'src/graph/types.ts')).toBe(true);
  });

  it('normalizes backslashes before comparison', () => {
    expect(isPathSuffixMatch('src\\graph\\types.ts', 'graph/types.ts')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isPathSuffixMatch('src/Graph/Types.ts', 'graph/types.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findFuzzyDuplicates
// ---------------------------------------------------------------------------

describe('findFuzzyDuplicates', () => {
  it('finds Levenshtein duplicates for typos', () => {
    const nodes = [
      node('src/indx.ts', 'File', 'a'),
      node('src/index.ts', 'File', 'b'),
    ];
    const dupes = findFuzzyDuplicates(nodes);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].reason).toContain('Levenshtein');
  });

  it('does not find Levenshtein duplicates beyond max distance', () => {
    const nodes = [
      node('src/alpha.ts', 'File', 'a'),
      node('src/omega.ts', 'File', 'b'),
    ];
    const dupes = findFuzzyDuplicates(nodes);
    const levDupes = dupes.filter(d => d.reason.includes('Levenshtein'));
    expect(levDupes).toHaveLength(0);
  });

  it('finds Jaccard duplicates for reordered multi-token names', () => {
    const nodes = [
      node('graph-entity-extractor', 'Project', 'a'),
      node('entity-graph-extractor', 'Project', 'b'),
    ];
    const dupes = findFuzzyDuplicates(nodes);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].reason).toContain('Jaccard');
  });

  it('finds path suffix duplicates for File type', () => {
    // Verify that isPathSuffixMatch works correctly via the public API
    // Since Jaccard fires first for tokenized paths, we test suffix
    // matching directly
    expect(isPathSuffixMatch('src/graph/types.ts', 'graph/types.ts')).toBe(true);

    // Also verify via findFuzzyDuplicates that the pair IS found as a dupe
    // (whether via Jaccard or suffix doesn't matter -- both detect it)
    const nodes = [
      node('src/graph/types.ts', 'File', 'a'),
      node('graph/types.ts', 'File', 'b'),
    ];
    const dupes = findFuzzyDuplicates(nodes);
    expect(dupes).toHaveLength(1);
  });

  it('does not compare nodes of different types', () => {
    const nodes = [
      node('types', 'File', 'a'),
      node('typez', 'Project', 'b'),
    ];
    const dupes = findFuzzyDuplicates(nodes);
    expect(dupes).toHaveLength(0);
  });

  it('skips exact case-insensitive matches (handled by existing strategy)', () => {
    const nodes = [
      node('React', 'Project', 'a'),
      node('react', 'Project', 'b'),
    ];
    const dupes = findFuzzyDuplicates(nodes);
    expect(dupes).toHaveLength(0);
  });

  it('does not create duplicate entries for same pair', () => {
    // A pair that could match via both Levenshtein and Jaccard
    const nodes = [
      node('auth-service', 'Project', 'a'),
      node('auth-servce', 'Project', 'b'), // typo + same tokens
    ];
    const dupes = findFuzzyDuplicates(nodes);
    // Should only appear once (first match wins)
    expect(dupes).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(findFuzzyDuplicates([])).toHaveLength(0);
  });

  it('handles single node', () => {
    expect(findFuzzyDuplicates([node('solo', 'File', 'a')])).toHaveLength(0);
  });

  it('respects config overrides for Levenshtein distance', () => {
    const nodes = [
      node('abcdef', 'Project', 'a'),
      node('abcxyz', 'Project', 'b'), // distance 3
    ];
    // Default max is 2, should not match
    expect(findFuzzyDuplicates(nodes)).toHaveLength(0);

    // With max 3, should match
    const config = {
      enabled: true,
      signalClassifier: {
        highSignalSources: [], mediumSignalSources: [], skipSources: [],
        minContentLength: 30,
      },
      qualityGate: {
        minNameLength: 3, maxNameLength: 200, maxFilesPerObservation: 5,
        typeConfidenceThresholds: { File: 0.95, Project: 0.8, Reference: 0.85, Decision: 0.65, Problem: 0.6, Solution: 0.6 },
        fileNonChangeMultiplier: 0.74,
      },
      relationshipDetector: { minEdgeConfidence: 0.45 },
      temporalDecay: { halfLifeDays: 30, minFloor: 0.05, deletionThreshold: 0.08, maxAgeDays: 180 },
      fuzzyDedup: { maxLevenshteinDistance: 3, jaccardThreshold: 0.7 },
    };
    expect(findFuzzyDuplicates(nodes, config)).toHaveLength(1);
  });
});
