import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  AdaptiveThresholdManager,
  type ThresholdState,
} from '../adaptive-threshold.js';
import { ThresholdStore } from '../../storage/threshold-store.js';

// ---------------------------------------------------------------------------
// AdaptiveThresholdManager -- EWMA Computation
// ---------------------------------------------------------------------------

describe('AdaptiveThresholdManager', () => {
  describe('constructor and defaults', () => {
    it('initializes with default state when no options or seed provided', () => {
      const manager = new AdaptiveThresholdManager();
      const state = manager.getState();

      expect(state.ewmaDistance).toBe(0.3);
      expect(state.ewmaVariance).toBe(0.01);
      expect(state.alpha).toBe(0.3);
      expect(state.sensitivityMultiplier).toBe(1.5);
      expect(state.observationCount).toBe(0);
    });

    it('accepts custom alpha and sensitivityMultiplier', () => {
      const manager = new AdaptiveThresholdManager({
        alpha: 0.5,
        sensitivityMultiplier: 2.0,
      });
      const state = manager.getState();

      expect(state.alpha).toBe(0.5);
      expect(state.sensitivityMultiplier).toBe(2.0);
    });

    it('seeds from historical averages when provided', () => {
      const manager = new AdaptiveThresholdManager();
      manager.seedFromHistory(0.4, 0.02);
      const state = manager.getState();

      expect(state.ewmaDistance).toBe(0.4);
      expect(state.ewmaVariance).toBe(0.02);
    });
  });

  describe('getThreshold()', () => {
    it('returns initial threshold from default state', () => {
      const manager = new AdaptiveThresholdManager();
      const threshold = manager.getThreshold();

      // ewmaDistance(0.3) + sensitivityMultiplier(1.5) * sqrt(ewmaVariance(0.01))
      // = 0.3 + 1.5 * 0.1 = 0.3 + 0.15 = 0.45
      expect(threshold).toBeCloseTo(0.45, 5);
    });

    it('is bounded by minimum 0.15', () => {
      const manager = new AdaptiveThresholdManager({
        sensitivityMultiplier: 0,
      });
      // ewmaDistance(0.3) + 0 * sqrt(...) = 0.3, which is > 0.15
      // Need to seed with low values to get below 0.15
      manager.seedFromHistory(0.05, 0.0001);
      // 0.05 + 0 * sqrt(0.0001) = 0.05 -> clamped to 0.15
      expect(manager.getThreshold()).toBe(0.15);
    });

    it('is bounded by maximum 0.6', () => {
      const manager = new AdaptiveThresholdManager({
        sensitivityMultiplier: 5.0,
      });
      manager.seedFromHistory(0.5, 0.1);
      // 0.5 + 5.0 * sqrt(0.1) = 0.5 + 5.0 * 0.316 = 0.5 + 1.58 = 2.08 -> clamped to 0.6
      expect(manager.getThreshold()).toBe(0.6);
    });
  });

  describe('update(distance)', () => {
    it('updates EWMA distance correctly', () => {
      const manager = new AdaptiveThresholdManager({ alpha: 0.3 });
      // Initial ewmaDistance = 0.3
      // After update(0.8): ewmaDistance = 0.3 * 0.8 + 0.7 * 0.3 = 0.24 + 0.21 = 0.45
      manager.update(0.8);
      const state = manager.getState();
      expect(state.ewmaDistance).toBeCloseTo(0.45, 10);
    });

    it('updates EWMA variance correctly', () => {
      const manager = new AdaptiveThresholdManager({ alpha: 0.3 });
      // Initial ewmaDistance = 0.3, ewmaVariance = 0.01
      // After update(0.8):
      //   newEwma = 0.3 * 0.8 + 0.7 * 0.3 = 0.45
      //   diff = 0.8 - 0.45 = 0.35
      //   newVar = 0.3 * (0.35 * 0.35) + 0.7 * 0.01 = 0.3 * 0.1225 + 0.007 = 0.03675 + 0.007 = 0.04375
      manager.update(0.8);
      const state = manager.getState();
      expect(state.ewmaVariance).toBeCloseTo(0.04375, 10);
    });

    it('increments observation count', () => {
      const manager = new AdaptiveThresholdManager();
      expect(manager.getState().observationCount).toBe(0);

      manager.update(0.5);
      expect(manager.getState().observationCount).toBe(1);

      manager.update(0.3);
      expect(manager.getState().observationCount).toBe(2);
    });

    it('returns the new threshold after update', () => {
      const manager = new AdaptiveThresholdManager();
      const threshold = manager.update(0.5);
      expect(typeof threshold).toBe('number');
      expect(threshold).toBeGreaterThanOrEqual(0.15);
      expect(threshold).toBeLessThanOrEqual(0.6);
    });
  });

  describe('convergence: scattered session raises threshold', () => {
    it('threshold increases when fed high distances', () => {
      const manager = new AdaptiveThresholdManager();
      const initialThreshold = manager.getThreshold();

      // Feed 20 high-distance observations (scattered session)
      for (let i = 0; i < 20; i++) {
        manager.update(0.8);
      }

      const finalThreshold = manager.getThreshold();
      expect(finalThreshold).toBeGreaterThan(initialThreshold);
    });

    it('threshold approaches upper bound 0.6 with very high distances', () => {
      const manager = new AdaptiveThresholdManager();

      // Feed many very high distances
      for (let i = 0; i < 50; i++) {
        manager.update(0.9);
      }

      const threshold = manager.getThreshold();
      expect(threshold).toBe(0.6); // Should hit the cap
    });
  });

  describe('convergence: focused session lowers threshold', () => {
    it('threshold decreases when fed low distances', () => {
      const manager = new AdaptiveThresholdManager();
      const initialThreshold = manager.getThreshold();

      // Feed 20 low-distance observations (focused session)
      for (let i = 0; i < 20; i++) {
        manager.update(0.05);
      }

      const finalThreshold = manager.getThreshold();
      expect(finalThreshold).toBeLessThan(initialThreshold);
    });

    it('threshold approaches lower bound 0.15 with very low distances', () => {
      const manager = new AdaptiveThresholdManager();

      // Feed many very low distances
      for (let i = 0; i < 50; i++) {
        manager.update(0.01);
      }

      const threshold = manager.getThreshold();
      expect(threshold).toBe(0.15); // Should hit the floor
    });
  });

  describe('mixed distances converge to middle', () => {
    it('alternating high/low distances produce a moderate threshold', () => {
      const manager = new AdaptiveThresholdManager();

      for (let i = 0; i < 40; i++) {
        manager.update(i % 2 === 0 ? 0.7 : 0.1);
      }

      const threshold = manager.getThreshold();
      expect(threshold).toBeGreaterThan(0.15);
      expect(threshold).toBeLessThan(0.6);
    });
  });

  describe('boundary clamping', () => {
    it('threshold never exceeds 0.6', () => {
      const manager = new AdaptiveThresholdManager();

      for (let i = 0; i < 100; i++) {
        const threshold = manager.update(1.5); // Extreme distance
        expect(threshold).toBeLessThanOrEqual(0.6);
      }
    });

    it('threshold never goes below 0.15', () => {
      const manager = new AdaptiveThresholdManager();

      for (let i = 0; i < 100; i++) {
        const threshold = manager.update(0.001); // Tiny distance
        expect(threshold).toBeGreaterThanOrEqual(0.15);
      }
    });
  });

  describe('seedFromHistory()', () => {
    it('overrides default ewmaDistance and ewmaVariance', () => {
      const manager = new AdaptiveThresholdManager();
      manager.seedFromHistory(0.5, 0.05);

      const state = manager.getState();
      expect(state.ewmaDistance).toBe(0.5);
      expect(state.ewmaVariance).toBe(0.05);
    });

    it('affects subsequent threshold calculations', () => {
      const defaultManager = new AdaptiveThresholdManager();
      const seededManager = new AdaptiveThresholdManager();
      seededManager.seedFromHistory(0.5, 0.05);

      expect(seededManager.getThreshold()).not.toBeCloseTo(
        defaultManager.getThreshold(),
        5,
      );
    });

    it('does not reset observation count', () => {
      const manager = new AdaptiveThresholdManager();
      manager.update(0.5);
      manager.update(0.6);
      expect(manager.getState().observationCount).toBe(2);

      manager.seedFromHistory(0.4, 0.02);
      expect(manager.getState().observationCount).toBe(2);
    });
  });

  describe('reset()', () => {
    it('restores all state to defaults', () => {
      const manager = new AdaptiveThresholdManager();
      manager.update(0.8);
      manager.update(0.7);

      manager.reset();
      const state = manager.getState();

      expect(state.ewmaDistance).toBe(0.3);
      expect(state.ewmaVariance).toBe(0.01);
      expect(state.observationCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// ThresholdStore -- Persistence layer
// ---------------------------------------------------------------------------

describe('ThresholdStore', () => {
  let db: Database.Database;
  let store: ThresholdStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `laminark-threshold-test-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));

    // Create threshold_history table (migration 008)
    db.exec(`
      CREATE TABLE threshold_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        final_ewma_distance REAL NOT NULL,
        final_ewma_variance REAL NOT NULL,
        observation_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_threshold_history_project
        ON threshold_history(project_id, created_at DESC);
    `);

    store = new ThresholdStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveSessionThreshold()', () => {
    it('persists threshold state for a session', () => {
      const state: ThresholdState = {
        ewmaDistance: 0.45,
        ewmaVariance: 0.03,
        alpha: 0.3,
        sensitivityMultiplier: 1.5,
        observationCount: 15,
      };

      store.saveSessionThreshold('project-1', 'session-1', state);

      // Verify by direct DB query
      const row = db
        .prepare('SELECT * FROM threshold_history WHERE session_id = ?')
        .get('session-1') as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.project_id).toBe('project-1');
      expect(row.session_id).toBe('session-1');
      expect(row.final_ewma_distance).toBeCloseTo(0.45, 10);
      expect(row.final_ewma_variance).toBeCloseTo(0.03, 10);
      expect(row.observation_count).toBe(15);
    });
  });

  describe('loadHistoricalSeed()', () => {
    it('returns null when no history exists', () => {
      const result = store.loadHistoricalSeed('nonexistent-project');
      expect(result).toBeNull();
    });

    it('returns average of last 10 sessions when history exists', () => {
      // Insert 3 sessions with known values
      const insert = db.prepare(`
        INSERT INTO threshold_history (project_id, session_id, final_ewma_distance, final_ewma_variance, observation_count)
        VALUES (?, ?, ?, ?, ?)
      `);

      insert.run('proj-1', 'sess-1', 0.3, 0.01, 10);
      insert.run('proj-1', 'sess-2', 0.4, 0.02, 20);
      insert.run('proj-1', 'sess-3', 0.5, 0.03, 15);

      const result = store.loadHistoricalSeed('proj-1');

      expect(result).not.toBeNull();
      // Average distance: (0.3 + 0.4 + 0.5) / 3 = 0.4
      expect(result!.averageDistance).toBeCloseTo(0.4, 10);
      // Average variance: (0.01 + 0.02 + 0.03) / 3 = 0.02
      expect(result!.averageVariance).toBeCloseTo(0.02, 10);
    });

    it('only considers last 10 sessions (not older ones)', () => {
      const insert = db.prepare(`
        INSERT INTO threshold_history (project_id, session_id, final_ewma_distance, final_ewma_variance, observation_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      // Insert 12 sessions -- the 2 oldest should be excluded
      for (let i = 0; i < 12; i++) {
        const date = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00`;
        insert.run('proj-1', `sess-${i}`, i < 2 ? 0.9 : 0.3, 0.01, 10, date);
      }

      const result = store.loadHistoricalSeed('proj-1');
      expect(result).not.toBeNull();
      // The 2 old sessions with 0.9 are excluded, remaining 10 are all 0.3
      expect(result!.averageDistance).toBeCloseTo(0.3, 5);
    });

    it('scopes to project (does not mix projects)', () => {
      const insert = db.prepare(`
        INSERT INTO threshold_history (project_id, session_id, final_ewma_distance, final_ewma_variance, observation_count)
        VALUES (?, ?, ?, ?, ?)
      `);

      insert.run('proj-a', 'sess-1', 0.2, 0.01, 10);
      insert.run('proj-b', 'sess-2', 0.8, 0.05, 20);

      const resultA = store.loadHistoricalSeed('proj-a');
      const resultB = store.loadHistoricalSeed('proj-b');

      expect(resultA!.averageDistance).toBeCloseTo(0.2, 10);
      expect(resultB!.averageDistance).toBeCloseTo(0.8, 10);
    });
  });

  describe('round-trip: save then load', () => {
    it('saved session data feeds back into historical seed', () => {
      const state: ThresholdState = {
        ewmaDistance: 0.42,
        ewmaVariance: 0.025,
        alpha: 0.3,
        sensitivityMultiplier: 1.5,
        observationCount: 12,
      };

      store.saveSessionThreshold('proj-rt', 'sess-rt', state);

      const seed = store.loadHistoricalSeed('proj-rt');
      expect(seed).not.toBeNull();
      expect(seed!.averageDistance).toBeCloseTo(0.42, 10);
      expect(seed!.averageVariance).toBeCloseTo(0.025, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: AdaptiveThresholdManager + ThresholdStore
// ---------------------------------------------------------------------------

describe('AdaptiveThresholdManager + ThresholdStore integration', () => {
  let db: Database.Database;
  let store: ThresholdStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `laminark-threshold-int-${randomBytes(8).toString('hex')}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    db = new Database(join(tmpDir, 'test.db'));

    db.exec(`
      CREATE TABLE threshold_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        final_ewma_distance REAL NOT NULL,
        final_ewma_variance REAL NOT NULL,
        observation_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_threshold_history_project
        ON threshold_history(project_id, created_at DESC);
    `);

    store = new ThresholdStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('session 1: no history -> uses default seed -> saves final state', () => {
    const seed = store.loadHistoricalSeed('proj-int');
    expect(seed).toBeNull();

    const manager = new AdaptiveThresholdManager();
    // No seed to apply -- uses defaults

    // Simulate a session
    manager.update(0.5);
    manager.update(0.3);
    manager.update(0.6);

    store.saveSessionThreshold('proj-int', 'sess-1', manager.getState());

    // Verify persisted
    const loaded = store.loadHistoricalSeed('proj-int');
    expect(loaded).not.toBeNull();
  });

  it('session 2: seeded from session 1 history', () => {
    // Session 1
    const manager1 = new AdaptiveThresholdManager();
    manager1.update(0.5);
    manager1.update(0.4);
    store.saveSessionThreshold('proj-int2', 'sess-1', manager1.getState());

    // Session 2 -- seed from history
    const seed = store.loadHistoricalSeed('proj-int2');
    expect(seed).not.toBeNull();

    const manager2 = new AdaptiveThresholdManager();
    manager2.seedFromHistory(seed!.averageDistance, seed!.averageVariance);

    const state = manager2.getState();
    expect(state.ewmaDistance).toBeCloseTo(seed!.averageDistance, 10);
    expect(state.ewmaVariance).toBeCloseTo(seed!.averageVariance, 10);
  });
});
