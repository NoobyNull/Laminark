import { describe, it, expect } from 'vitest';

import { applyQualityGate } from '../write-quality-gate.js';
import type { EntityType } from '../types.js';

// Helper to create test entities
function entity(name: string, type: EntityType, confidence: number) {
  return { name, type, confidence };
}

describe('applyQualityGate', () => {
  // ---------------------------------------------------------------------------
  // Name length bounds
  // ---------------------------------------------------------------------------

  it('rejects entities with names shorter than 3 chars', () => {
    const result = applyQualityGate(
      [entity('ab', 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('too short');
  });

  it('rejects entities with names longer than 200 chars', () => {
    const result = applyQualityGate(
      [entity('a'.repeat(201), 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('too long');
  });

  it('accepts entities at exact length bounds', () => {
    const result = applyQualityGate(
      [
        entity('abc', 'Decision', 0.7),
        entity('d'.repeat(200), 'Decision', 0.7),
      ],
      true,
    );
    expect(result.passed).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Vague name rejection
  // ---------------------------------------------------------------------------

  it('rejects entities starting with "the "', () => {
    const result = applyQualityGate(
      [entity('the configuration file', 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('Vague');
  });

  it('rejects entities starting with "this "', () => {
    const result = applyQualityGate(
      [entity('this approach works', 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(0);
  });

  it('rejects entities starting with "some "', () => {
    const result = applyQualityGate(
      [entity('some random thing', 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(0);
  });

  it('rejects entities starting with "tmp "', () => {
    const result = applyQualityGate(
      [entity('tmp file for testing', 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(0);
  });

  it('accepts entities that dont start with vague prefixes', () => {
    const result = applyQualityGate(
      [entity('use SQLite for storage', 'Decision', 0.7)],
      true,
    );
    expect(result.passed).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Per-type confidence thresholds
  // ---------------------------------------------------------------------------

  it('requires File confidence >= 0.95', () => {
    const result = applyQualityGate(
      [
        entity('src/index.ts', 'File', 0.95),
        entity('src/utils.ts', 'File', 0.94),
      ],
      true,
    );
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].name).toBe('src/index.ts');
  });

  it('requires Decision confidence >= 0.65', () => {
    const result = applyQualityGate(
      [
        entity('use Redis', 'Decision', 0.65),
        entity('maybe switch', 'Decision', 0.64),
      ],
      true,
    );
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].name).toBe('use Redis');
  });

  it('requires Problem confidence >= 0.6', () => {
    const result = applyQualityGate(
      [entity('auth flow broken', 'Problem', 0.6)],
      true,
    );
    expect(result.passed).toHaveLength(1);
  });

  it('requires Solution confidence >= 0.6', () => {
    const result = applyQualityGate(
      [entity('add null check', 'Solution', 0.6)],
      true,
    );
    expect(result.passed).toHaveLength(1);
  });

  it('requires Reference confidence >= 0.85', () => {
    const result = applyQualityGate(
      [entity('https://example.com', 'Reference', 0.9)],
      true,
    );
    expect(result.passed).toHaveLength(1);
  });

  it('requires Project confidence >= 0.8', () => {
    const result = applyQualityGate(
      [entity('facebook/react', 'Project', 0.8)],
      true,
    );
    expect(result.passed).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Context-aware File confidence adjustment
  // ---------------------------------------------------------------------------

  it('reduces File confidence for non-change observations', () => {
    // 0.95 * 0.74 = 0.703, below 0.95 threshold -> rejected
    const result = applyQualityGate(
      [entity('src/index.ts', 'File', 0.95)],
      false, // NOT a change observation
    );
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toContain('confidence threshold');
  });

  it('preserves File confidence for change observations', () => {
    const result = applyQualityGate(
      [entity('src/index.ts', 'File', 0.95)],
      true, // IS a change observation
    );
    expect(result.passed).toHaveLength(1);
  });

  it('does not adjust non-File entity confidence', () => {
    const result = applyQualityGate(
      [entity('use SQLite for storage', 'Decision', 0.7)],
      false, // Not a change observation
    );
    // Decision threshold is 0.65, 0.7 >= 0.65 -> passes
    expect(result.passed).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // File cap per observation
  // ---------------------------------------------------------------------------

  it('caps File nodes to 5 per observation', () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      entity(`src/file${i}.ts`, 'File', 0.95 + i * 0.001),
    );
    const result = applyQualityGate(files, true);
    expect(result.passed).toHaveLength(5);
    // Should keep highest confidence files
    expect(result.passed.map(e => e.name)).toContain('src/file7.ts');
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected[0].reason).toContain('File cap');
  });

  it('does not cap when File count is at or below limit', () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      entity(`src/file${i}.ts`, 'File', 0.95),
    );
    const result = applyQualityGate(files, true);
    expect(result.passed).toHaveLength(5);
    expect(result.rejected).toHaveLength(0);
  });

  it('does not cap non-File entities', () => {
    const decisions = Array.from({ length: 8 }, (_, i) =>
      entity(`decision ${i} about architecture`, 'Decision', 0.7),
    );
    const result = applyQualityGate(decisions, true);
    expect(result.passed).toHaveLength(8);
  });

  // ---------------------------------------------------------------------------
  // Mixed entities
  // ---------------------------------------------------------------------------

  it('filters mixed entity types correctly', () => {
    const entities = [
      entity('src/auth/login.ts', 'File', 0.95),
      entity('use JWT tokens', 'Decision', 0.7),
      entity('ab', 'Problem', 0.65), // too short
      entity('the thing', 'Solution', 0.65), // vague
      entity('https://docs.example.com', 'Reference', 0.9),
    ];
    const result = applyQualityGate(entities, true);
    expect(result.passed).toHaveLength(3);
    expect(result.rejected).toHaveLength(2);
  });
});
