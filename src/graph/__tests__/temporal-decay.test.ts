import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { calculateDecayedWeight, applyTemporalDecay } from '../temporal-decay.js';
import { initGraphSchema, upsertNode, insertEdge } from '../schema.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = join(
    tmpdir(),
    `laminark-decay-test-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const db = new Database(join(tmpDir, 'test.db'));
  initGraphSchema(db);
  return { db, tmpDir };
}

// ---------------------------------------------------------------------------
// calculateDecayedWeight
// ---------------------------------------------------------------------------

describe('calculateDecayedWeight', () => {
  it('returns original weight for age 0', () => {
    expect(calculateDecayedWeight(0.8, 0)).toBe(0.8);
  });

  it('returns original weight for negative age', () => {
    expect(calculateDecayedWeight(0.8, -5)).toBe(0.8);
  });

  it('returns approximately half weight at half-life', () => {
    const decayed = calculateDecayedWeight(1.0, 30); // default half-life = 30
    expect(decayed).toBeCloseTo(0.5, 1);
  });

  it('returns approximately quarter weight at 2x half-life', () => {
    const decayed = calculateDecayedWeight(1.0, 60);
    expect(decayed).toBeCloseTo(0.25, 1);
  });

  it('respects custom half-life', () => {
    const decayed = calculateDecayedWeight(1.0, 7, { halfLifeDays: 7 });
    expect(decayed).toBeCloseTo(0.5, 1);
  });

  it('clamps to minimum floor', () => {
    const decayed = calculateDecayedWeight(0.1, 365);
    expect(decayed).toBe(0.05); // default minFloor
  });

  it('respects custom minimum floor', () => {
    const decayed = calculateDecayedWeight(0.1, 365, { minFloor: 0.01 });
    expect(decayed).toBe(0.01);
  });

  it('produces monotonically decreasing values', () => {
    const values = [0, 10, 20, 30, 60, 90, 120].map(days =>
      calculateDecayedWeight(1.0, days),
    );
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// applyTemporalDecay (database integration)
// ---------------------------------------------------------------------------

describe('applyTemporalDecay', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero counts for empty graph', () => {
    const result = applyTemporalDecay(db);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('does not modify fresh edges', () => {
    const node1 = upsertNode(db, {
      type: 'File', name: 'src/a.ts', metadata: {}, observation_ids: ['obs-1'],
    });
    const node2 = upsertNode(db, {
      type: 'File', name: 'src/b.ts', metadata: {}, observation_ids: ['obs-2'],
    });
    insertEdge(db, {
      source_id: node1.id, target_id: node2.id,
      type: 'references', weight: 0.8, metadata: {},
    });

    const result = applyTemporalDecay(db);
    // Fresh edge should not be modified (age < 1 day, delta < 0.001)
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('deletes edges older than max age', () => {
    const node1 = upsertNode(db, {
      type: 'File', name: 'src/old-a.ts', metadata: {}, observation_ids: ['obs-1'],
    });
    const node2 = upsertNode(db, {
      type: 'File', name: 'src/old-b.ts', metadata: {}, observation_ids: ['obs-2'],
    });
    insertEdge(db, {
      source_id: node1.id, target_id: node2.id,
      type: 'references', weight: 0.8, metadata: {},
    });

    // Manually age the edge to 200 days
    db.prepare(`
      UPDATE graph_edges SET created_at = datetime('now', '-200 days')
    `).run();

    const result = applyTemporalDecay(db);
    expect(result.deleted).toBe(1);
  });

  it('deletes edges that decay below deletion threshold', () => {
    const node1 = upsertNode(db, {
      type: 'File', name: 'src/decay-a.ts', metadata: {}, observation_ids: ['obs-1'],
    });
    const node2 = upsertNode(db, {
      type: 'File', name: 'src/decay-b.ts', metadata: {}, observation_ids: ['obs-2'],
    });
    insertEdge(db, {
      source_id: node1.id, target_id: node2.id,
      type: 'references', weight: 0.1, metadata: {},
    });

    // Age edge enough that 0.1 * decay falls below 0.08 threshold
    // At 30 days, 0.1 * 0.5 = 0.05, below 0.08
    db.prepare(`
      UPDATE graph_edges SET created_at = datetime('now', '-30 days')
    `).run();

    const result = applyTemporalDecay(db);
    expect(result.deleted).toBe(1);
  });

  it('updates edge weights for moderately aged edges', () => {
    const node1 = upsertNode(db, {
      type: 'File', name: 'src/med-a.ts', metadata: {}, observation_ids: ['obs-1'],
    });
    const node2 = upsertNode(db, {
      type: 'File', name: 'src/med-b.ts', metadata: {}, observation_ids: ['obs-2'],
    });
    insertEdge(db, {
      source_id: node1.id, target_id: node2.id,
      type: 'references', weight: 0.8, metadata: {},
    });

    // Age edge 15 days (half of half-life, weight should reduce but stay above threshold)
    db.prepare(`
      UPDATE graph_edges SET created_at = datetime('now', '-15 days')
    `).run();

    const result = applyTemporalDecay(db);
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(0);

    // Verify the weight was reduced
    const edge = db.prepare('SELECT weight FROM graph_edges').get() as { weight: number };
    expect(edge.weight).toBeLessThan(0.8);
    expect(edge.weight).toBeGreaterThan(0.5);
  });

  it('respects config overrides', () => {
    const node1 = upsertNode(db, {
      type: 'File', name: 'src/cfg-a.ts', metadata: {}, observation_ids: ['obs-1'],
    });
    const node2 = upsertNode(db, {
      type: 'File', name: 'src/cfg-b.ts', metadata: {}, observation_ids: ['obs-2'],
    });
    insertEdge(db, {
      source_id: node1.id, target_id: node2.id,
      type: 'references', weight: 0.5, metadata: {},
    });

    // Age 10 days with short half-life of 7
    db.prepare(`
      UPDATE graph_edges SET created_at = datetime('now', '-10 days')
    `).run();

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
      temporalDecay: {
        halfLifeDays: 7,
        minFloor: 0.05,
        deletionThreshold: 0.08,
        maxAgeDays: 30,
      },
      fuzzyDedup: { maxLevenshteinDistance: 2, jaccardThreshold: 0.7 },
    };

    const result = applyTemporalDecay(db, config);
    // With halfLife 7 and age 10, weight should decay significantly
    expect(result.updated + result.deleted).toBeGreaterThan(0);
  });
});
