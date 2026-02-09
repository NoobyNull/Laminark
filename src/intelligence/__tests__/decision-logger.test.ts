import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  TopicShiftDecisionLogger,
  type ShiftDecision,
} from '../decision-logger.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDecision(overrides: Partial<ShiftDecision> = {}): ShiftDecision {
  return {
    projectId: 'proj-001',
    sessionId: 'sess-001',
    observationId: 'obs-001',
    distance: 0.45,
    threshold: 0.3,
    ewmaDistance: 0.35,
    ewmaVariance: 0.02,
    sensitivityMultiplier: 1.5,
    shifted: true,
    confidence: 0.5,
    stashId: 'stash-001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TopicShiftDecisionLogger tests
// ---------------------------------------------------------------------------

describe('TopicShiftDecisionLogger', () => {
  let db: Database.Database;
  let logger: TopicShiftDecisionLogger;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `laminark-decision-log-test-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));

    // Create shift_decisions table (migration 009)
    db.exec(`
      CREATE TABLE shift_decisions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        observation_id TEXT,
        distance REAL NOT NULL,
        threshold REAL NOT NULL,
        ewma_distance REAL,
        ewma_variance REAL,
        sensitivity_multiplier REAL,
        shifted INTEGER NOT NULL,
        confidence REAL,
        stash_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_shift_decisions_session
        ON shift_decisions(project_id, session_id, created_at DESC);

      CREATE INDEX idx_shift_decisions_shifted
        ON shift_decisions(shifted, created_at DESC);
    `);

    logger = new TopicShiftDecisionLogger(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('log()', () => {
    it('logs a decision and retrieves it', () => {
      const decision = createDecision();
      logger.log(decision);

      const results = logger.getSessionDecisions('proj-001', 'sess-001');
      expect(results).toHaveLength(1);
      expect(results[0].distance).toBeCloseTo(0.45, 10);
      expect(results[0].threshold).toBeCloseTo(0.3, 10);
      expect(results[0].shifted).toBe(true);
    });

    it('persists all fields correctly including nulls', () => {
      const decision = createDecision({
        observationId: null,
        ewmaDistance: null,
        ewmaVariance: null,
        stashId: null,
        shifted: false,
        confidence: 0,
        distance: 0.15,
        threshold: 0.4,
        sensitivityMultiplier: 2.5,
      });
      logger.log(decision);

      const results = logger.getSessionDecisions('proj-001', 'sess-001');
      expect(results).toHaveLength(1);
      const row = results[0];

      expect(row.projectId).toBe('proj-001');
      expect(row.sessionId).toBe('sess-001');
      expect(row.observationId).toBeNull();
      expect(row.distance).toBeCloseTo(0.15, 10);
      expect(row.threshold).toBeCloseTo(0.4, 10);
      expect(row.ewmaDistance).toBeNull();
      expect(row.ewmaVariance).toBeNull();
      expect(row.sensitivityMultiplier).toBeCloseTo(2.5, 10);
      expect(row.shifted).toBe(false);
      expect(row.confidence).toBe(0);
      expect(row.stashId).toBeNull();
    });

    it('persists full EWMA state when available', () => {
      const decision = createDecision({
        ewmaDistance: 0.42,
        ewmaVariance: 0.035,
        stashId: 'stash-xyz',
      });
      logger.log(decision);

      const results = logger.getSessionDecisions('proj-001', 'sess-001');
      expect(results[0].ewmaDistance).toBeCloseTo(0.42, 10);
      expect(results[0].ewmaVariance).toBeCloseTo(0.035, 10);
      expect(results[0].stashId).toBe('stash-xyz');
    });
  });

  describe('getSessionDecisions()', () => {
    it('returns decisions ordered by recency (newest first)', () => {
      // Insert 3 decisions with explicit timestamps to ensure ordering
      const insert = db.prepare(`
        INSERT INTO shift_decisions
          (id, project_id, session_id, observation_id, distance, threshold,
           ewma_distance, ewma_variance, sensitivity_multiplier, shifted,
           confidence, stash_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run('d1', 'proj-001', 'sess-001', 'obs-1', 0.2, 0.3, 0.3, 0.01, 1.5, 0, 0, null, '2026-02-09T00:00:00Z');
      insert.run('d2', 'proj-001', 'sess-001', 'obs-2', 0.4, 0.3, 0.35, 0.02, 1.5, 1, 0.33, 'stash-1', '2026-02-09T00:01:00Z');
      insert.run('d3', 'proj-001', 'sess-001', 'obs-3', 0.15, 0.3, 0.3, 0.015, 1.5, 0, 0, null, '2026-02-09T00:02:00Z');

      const results = logger.getSessionDecisions('proj-001', 'sess-001');
      expect(results).toHaveLength(3);
      // Newest first
      expect(results[0].observationId).toBe('obs-3');
      expect(results[1].observationId).toBe('obs-2');
      expect(results[2].observationId).toBe('obs-1');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        logger.log(createDecision({ observationId: `obs-${i}` }));
      }

      const results = logger.getSessionDecisions('proj-001', 'sess-001', 3);
      expect(results).toHaveLength(3);
    });

    it('tracks multiple sessions independently', () => {
      logger.log(createDecision({ sessionId: 'sess-A', distance: 0.2 }));
      logger.log(createDecision({ sessionId: 'sess-A', distance: 0.3 }));
      logger.log(createDecision({ sessionId: 'sess-B', distance: 0.5 }));

      const sessAResults = logger.getSessionDecisions('proj-001', 'sess-A');
      const sessBResults = logger.getSessionDecisions('proj-001', 'sess-B');

      expect(sessAResults).toHaveLength(2);
      expect(sessBResults).toHaveLength(1);
      expect(sessBResults[0].distance).toBeCloseTo(0.5, 10);
    });
  });

  describe('getShiftRate()', () => {
    it('returns correct shift rate (3 shifts out of 10 = 0.3)', () => {
      // Log 10 decisions: 3 shifted, 7 not shifted
      for (let i = 0; i < 10; i++) {
        logger.log(
          createDecision({
            shifted: i < 3,
            stashId: i < 3 ? `stash-${i}` : null,
            confidence: i < 3 ? 0.5 : 0,
          }),
        );
      }

      const stats = logger.getShiftRate('proj-001');
      expect(stats.total).toBe(10);
      expect(stats.shifted).toBe(3);
      expect(stats.rate).toBeCloseTo(0.3, 10);
    });

    it('returns zero rate when no decisions exist', () => {
      const stats = logger.getShiftRate('proj-nonexistent');
      expect(stats.total).toBe(0);
      expect(stats.shifted).toBe(0);
      expect(stats.rate).toBe(0);
    });

    it('respects lastN parameter for recent-only calculation', () => {
      // Log 10 decisions: first 5 are shifts, last 5 are not
      const insert = db.prepare(`
        INSERT INTO shift_decisions
          (id, project_id, session_id, observation_id, distance, threshold,
           shifted, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < 10; i++) {
        const isShifted = i < 5;
        insert.run(
          `d-${i}`,
          'proj-001',
          'sess-001',
          `obs-${i}`,
          0.5,
          0.3,
          isShifted ? 1 : 0,
          isShifted ? 0.5 : 0,
          `2026-02-09T00:${String(i).padStart(2, '0')}:00Z`,
        );
      }

      // lastN=5 should only see the 5 most recent (not shifted)
      const recent = logger.getShiftRate('proj-001', 5);
      expect(recent.total).toBe(5);
      expect(recent.shifted).toBe(0);
      expect(recent.rate).toBe(0);

      // lastN=10 should see all 10 (5 shifted, 5 not)
      const all = logger.getShiftRate('proj-001', 10);
      expect(all.total).toBe(10);
      expect(all.shifted).toBe(5);
      expect(all.rate).toBeCloseTo(0.5, 10);
    });

    it('scopes to project (does not mix projects)', () => {
      logger.log(createDecision({ projectId: 'proj-A', shifted: true }));
      logger.log(createDecision({ projectId: 'proj-A', shifted: true }));
      logger.log(createDecision({ projectId: 'proj-B', shifted: false }));

      const statsA = logger.getShiftRate('proj-A');
      const statsB = logger.getShiftRate('proj-B');

      expect(statsA.total).toBe(2);
      expect(statsA.shifted).toBe(2);
      expect(statsA.rate).toBe(1.0);

      expect(statsB.total).toBe(1);
      expect(statsB.shifted).toBe(0);
      expect(statsB.rate).toBe(0);
    });
  });
});
