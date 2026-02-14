/**
 * Tests for deprecated signal classifier.
 *
 * These verify the legacy regex-based classification which is no longer used
 * in the live pipeline (replaced by HaikuProcessor and haiku-classifier-agent).
 * Retained because the deprecated code is still functional and may serve as
 * a non-Haiku fallback reference.
 */

import { describe, it, expect } from 'vitest';

import { classifySignal, hasContentBoost } from '../signal-classifier.js';

describe('classifySignal (deprecated -- replaced by Haiku classifier)', () => {
  // ---------------------------------------------------------------------------
  // High signal sources
  // ---------------------------------------------------------------------------

  it('classifies manual source as high', () => {
    const result = classifySignal('manual', 'Some meaningful observation content here');
    expect(result.level).toBe('high');
  });

  it('classifies hook:Write as high', () => {
    const result = classifySignal('hook:Write', 'Created src/graph/signal-classifier.ts');
    expect(result.level).toBe('high');
  });

  it('classifies hook:Edit as high', () => {
    const result = classifySignal('hook:Edit', 'Modified src/index.ts to add signal classification');
    expect(result.level).toBe('high');
  });

  it('classifies hook:WebFetch as high', () => {
    const result = classifySignal('hook:WebFetch', 'Fetched documentation about MCP servers');
    expect(result.level).toBe('high');
  });

  it('classifies hook:WebSearch as high', () => {
    const result = classifySignal('hook:WebSearch', 'Searched for knowledge graph anti-bloat strategies');
    expect(result.level).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Medium signal sources
  // ---------------------------------------------------------------------------

  it('classifies hook:Bash as medium', () => {
    const result = classifySignal('hook:Bash', 'Ran npm test and all tests passed');
    expect(result.level).toBe('medium');
  });

  it('classifies curation:merge as medium', () => {
    const result = classifySignal('curation:merge', 'Consolidated 3 observations about entity extraction');
    expect(result.level).toBe('medium');
  });

  // ---------------------------------------------------------------------------
  // Skip sources
  // ---------------------------------------------------------------------------

  it('classifies hook:Read as skip', () => {
    const result = classifySignal('hook:Read', 'Read the contents of src/index.ts');
    expect(result.level).toBe('skip');
  });

  it('classifies hook:Glob as skip', () => {
    const result = classifySignal('hook:Glob', 'Found 15 TypeScript files matching pattern');
    expect(result.level).toBe('skip');
  });

  it('classifies hook:Grep as skip', () => {
    const result = classifySignal('hook:Grep', 'Searched for extractAndPersist in src/');
    expect(result.level).toBe('skip');
  });

  it('classifies hook:TaskUpdate as skip', () => {
    const result = classifySignal('hook:TaskUpdate', 'Updated task #3 status to completed');
    expect(result.level).toBe('skip');
  });

  it('classifies hook:TaskCreate as skip', () => {
    const result = classifySignal('hook:TaskCreate', 'Created task: implement signal classifier');
    expect(result.level).toBe('skip');
  });

  it('classifies hook:EnterPlanMode as skip', () => {
    const result = classifySignal('hook:EnterPlanMode', 'Entering plan mode for implementation');
    expect(result.level).toBe('skip');
  });

  it('classifies hook:ExitPlanMode as skip', () => {
    const result = classifySignal('hook:ExitPlanMode', 'Plan approved, exiting plan mode');
    expect(result.level).toBe('skip');
  });

  // ---------------------------------------------------------------------------
  // Content boost
  // ---------------------------------------------------------------------------

  it('promotes skip source to high when content has decision language', () => {
    const result = classifySignal('hook:Read', 'After reading the file, decided to use SQLite for storage');
    expect(result.level).toBe('high');
  });

  it('promotes skip source to high when content has problem language', () => {
    const result = classifySignal('hook:Grep', 'Found a bug in the authentication flow while searching');
    expect(result.level).toBe('high');
  });

  it('promotes skip source to high when content has solution language', () => {
    const result = classifySignal('hook:Read', 'Fixed by adding a null check before the API call');
    expect(result.level).toBe('high');
  });

  it('promotes medium source to high when content has decision language', () => {
    const result = classifySignal('hook:Bash', 'Chose to implement caching at the API layer');
    expect(result.level).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Minimum content length
  // ---------------------------------------------------------------------------

  it('skips content below minimum length', () => {
    const result = classifySignal('manual', 'short');
    expect(result.level).toBe('skip');
  });

  it('skips content at exactly minimum length boundary', () => {
    const result = classifySignal('manual', 'a'.repeat(29));
    expect(result.level).toBe('skip');
  });

  it('allows content at minimum length', () => {
    const result = classifySignal('manual', 'a'.repeat(30));
    expect(result.level).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Unknown sources
  // ---------------------------------------------------------------------------

  it('defaults unknown source to medium', () => {
    const result = classifySignal('hook:SomeNewTool', 'Some observation about code quality');
    expect(result.level).toBe('medium');
  });

  it('promotes unknown source to high with content boost', () => {
    const result = classifySignal('hook:SomeNewTool', 'Decided to refactor the authentication module');
    expect(result.level).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Config overrides
  // ---------------------------------------------------------------------------

  it('respects custom config for source classification', () => {
    const config = {
      enabled: true,
      signalClassifier: {
        highSignalSources: ['custom:source'],
        mediumSignalSources: [],
        skipSources: [],
        minContentLength: 10,
      },
      qualityGate: {
        minNameLength: 3,
        maxNameLength: 200,
        maxFilesPerObservation: 5,
        typeConfidenceThresholds: { File: 0.95, Project: 0.8, Reference: 0.85, Decision: 0.65, Problem: 0.6, Solution: 0.6 },
        fileNonChangeMultiplier: 0.74,
      },
      relationshipDetector: { minEdgeConfidence: 0.45 },
      temporalDecay: { halfLifeDays: 30, minFloor: 0.05, deletionThreshold: 0.08, maxAgeDays: 180 },
      fuzzyDedup: { maxLevenshteinDistance: 2, jaccardThreshold: 0.7 },
    };
    const result = classifySignal('custom:source', 'Some observation text', config);
    expect(result.level).toBe('high');
  });
});

describe('hasContentBoost', () => {
  it('detects decision language', () => {
    expect(hasContentBoost('Decided to use Redis for caching')).toBe(true);
  });

  it('detects problem language', () => {
    expect(hasContentBoost('Found a bug in the login flow')).toBe(true);
  });

  it('detects solution language', () => {
    expect(hasContentBoost('Fixed by adding retry logic')).toBe(true);
  });

  it('returns false for neutral content', () => {
    expect(hasContentBoost('Read the contents of the file')).toBe(false);
  });
});
