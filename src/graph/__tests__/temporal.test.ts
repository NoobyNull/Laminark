import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  calculateRecencyScore,
  getObservationAge,
  getObservationsByTimeRange,
  getEntityTimeline,
  getRecentEntities,
} from '../temporal.js';
import {
  detectStaleness,
  flagStaleObservation,
  getStaleObservations,
  initStalenessSchema,
} from '../staleness.js';
import { initGraphSchema, upsertNode } from '../schema.js';
import { runMigrations } from '../../storage/migrations.js';

// =============================================================================
// Test Helpers
// =============================================================================

function setupDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'laminark-temporal-test-'));
  const db = new Database(join(tmpDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run observation migrations (creates observations table)
  runMigrations(db);

  // Initialize graph schema
  initGraphSchema(db);

  // Initialize staleness schema
  initStalenessSchema(db);

  return { db, tmpDir };
}

function insertObservation(
  db: Database.Database,
  opts: { id: string; content: string; createdAt: string; projectHash?: string },
): void {
  db.prepare(
    `INSERT INTO observations (id, project_hash, content, source, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(
    opts.id,
    opts.projectHash ?? 'test-project',
    opts.content,
    opts.createdAt,
    opts.createdAt,
  );
}

// =============================================================================
// Recency Score Tests
// =============================================================================

describe('calculateRecencyScore', () => {
  it('returns 1.0 for an observation created just now', () => {
    const now = new Date();
    const score = calculateRecencyScore(now.toISOString(), now);
    expect(score).toBe(1.0);
  });

  it('returns approximately 0.5 for an observation 7 days old', () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const score = calculateRecencyScore(sevenDaysAgo.toISOString(), now);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('returns approximately 0.25 for an observation 14 days old', () => {
    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const score = calculateRecencyScore(fourteenDaysAgo.toISOString(), now);
    expect(score).toBeCloseTo(0.25, 1);
  });

  it('produces monotonically decreasing values for older observations', () => {
    const now = new Date();
    const scores: number[] = [];
    for (let days = 0; days <= 30; days += 5) {
      const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      scores.push(calculateRecencyScore(date.toISOString(), now));
    }

    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it('returns 1.0 for future timestamps (clamped)', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const score = calculateRecencyScore(future.toISOString(), now);
    expect(score).toBe(1.0);
  });
});

// =============================================================================
// Observation Age Tests
// =============================================================================

describe('getObservationAge', () => {
  it('labels observations under 1 hour as "just now"', () => {
    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const age = getObservationAge(thirtyMinAgo.toISOString(), now);
    expect(age.label).toBe('just now');
    expect(age.hours).toBe(0);
  });

  it('formats hours correctly for observations under 24 hours', () => {
    const now = new Date();
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const age = getObservationAge(fiveHoursAgo.toISOString(), now);
    expect(age.label).toBe('5 hours ago');
    expect(age.hours).toBe(5);
  });

  it('uses singular "hour" for exactly 1 hour', () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const age = getObservationAge(oneHourAgo.toISOString(), now);
    expect(age.label).toBe('1 hour ago');
  });

  it('formats days correctly for observations under 30 days', () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const age = getObservationAge(threeDaysAgo.toISOString(), now);
    expect(age.label).toBe('3 days ago');
    expect(age.days).toBe(3);
  });

  it('formats months for observations 30+ days old', () => {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const age = getObservationAge(sixtyDaysAgo.toISOString(), now);
    expect(age.label).toBe('2 months ago');
    expect(age.days).toBe(60);
  });
});

// =============================================================================
// Staleness Detection Tests
// =============================================================================

describe('detectStaleness', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects staleness from negation pattern', () => {
    // Create observations
    insertObservation(db, {
      id: 'obs-old',
      content: 'We use Redux for state management',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-new',
      content: 'We no longer use Redux, switched to Zustand',
      createdAt: '2026-02-01T00:00:00Z',
    });

    // Create entity linked to both observations
    upsertNode(db, {
      type: 'Project',
      name: 'Redux',
      metadata: {},
      observation_ids: ['obs-old', 'obs-new'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'Redux'")
      .get() as { id: string };

    const reports = detectStaleness(db, node.id);

    expect(reports).toHaveLength(1);
    expect(reports[0].olderObservation.id).toBe('obs-old');
    expect(reports[0].newerObservation.id).toBe('obs-new');
    expect(reports[0].reason).toContain('negation');
    expect(reports[0].entityName).toBe('Redux');
    expect(reports[0].entityType).toBe('Project');
  });

  it('detects staleness from replacement pattern', () => {
    insertObservation(db, {
      id: 'obs-jwt-old',
      content: 'Authentication uses jsonwebtoken library',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-jwt-new',
      content: 'Replaced jsonwebtoken with jose for Edge compatibility',
      createdAt: '2026-02-01T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Project',
      name: 'jsonwebtoken',
      metadata: {},
      observation_ids: ['obs-jwt-old', 'obs-jwt-new'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'jsonwebtoken'")
      .get() as { id: string };

    const reports = detectStaleness(db, node.id);

    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toContain('replacement');
  });

  it('detects staleness from status change pattern', () => {
    insertObservation(db, {
      id: 'obs-feat-old',
      content: 'The legacy API endpoint handles user registration',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-feat-new',
      content: 'The legacy API endpoint was deprecated in favor of the new auth service',
      createdAt: '2026-02-01T00:00:00Z',
    });

    upsertNode(db, {
      type: 'File',
      name: 'legacy-api',
      metadata: {},
      observation_ids: ['obs-feat-old', 'obs-feat-new'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'legacy-api'")
      .get() as { id: string };

    const reports = detectStaleness(db, node.id);

    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toContain('status change');
  });

  it('does not flag non-contradictory observations as stale', () => {
    insertObservation(db, {
      id: 'obs-add-old',
      content: 'Added user model to schema',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-add-new',
      content: 'Added admin role to user model',
      createdAt: '2026-02-01T00:00:00Z',
    });

    upsertNode(db, {
      type: 'File',
      name: 'user-model',
      metadata: {},
      observation_ids: ['obs-add-old', 'obs-add-new'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'user-model'")
      .get() as { id: string };

    const reports = detectStaleness(db, node.id);

    expect(reports).toHaveLength(0);
  });

  it('returns empty array for entity with single observation', () => {
    insertObservation(db, {
      id: 'obs-single',
      content: 'Some observation',
      createdAt: '2026-01-01T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Project',
      name: 'single-obs-entity',
      metadata: {},
      observation_ids: ['obs-single'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'single-obs-entity'")
      .get() as { id: string };

    const reports = detectStaleness(db, node.id);
    expect(reports).toHaveLength(0);
  });

  it('returns empty array for non-existent entity', () => {
    const reports = detectStaleness(db, 'non-existent-id');
    expect(reports).toHaveLength(0);
  });
});

// =============================================================================
// Flagging Tests
// =============================================================================

describe('flagStaleObservation', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags observation without deleting it', () => {
    insertObservation(db, {
      id: 'obs-to-flag',
      content: 'We use Redux for state management',
      createdAt: '2026-01-01T00:00:00Z',
    });

    // Flag it
    flagStaleObservation(db, 'obs-to-flag', 'Superseded by newer observation');

    // Verify the observation still exists
    const obs = db
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get('obs-to-flag');
    expect(obs).toBeDefined();

    // Verify the flag exists
    const flag = db
      .prepare('SELECT * FROM staleness_flags WHERE observation_id = ?')
      .get('obs-to-flag') as { observation_id: string; reason: string; resolved: number } | undefined;
    expect(flag).toBeDefined();
    expect(flag!.reason).toBe('Superseded by newer observation');
    expect(flag!.resolved).toBe(0);
  });

  it('can re-flag with updated reason', () => {
    insertObservation(db, {
      id: 'obs-reflag',
      content: 'Some observation',
      createdAt: '2026-01-01T00:00:00Z',
    });

    flagStaleObservation(db, 'obs-reflag', 'First reason');
    flagStaleObservation(db, 'obs-reflag', 'Updated reason');

    const flag = db
      .prepare('SELECT * FROM staleness_flags WHERE observation_id = ?')
      .get('obs-reflag') as { reason: string };
    expect(flag.reason).toBe('Updated reason');
  });
});

// =============================================================================
// Stale Observation Query Tests
// =============================================================================

describe('getStaleObservations', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns flagged observations with their staleness metadata', () => {
    insertObservation(db, {
      id: 'obs-stale-1',
      content: 'Old approach',
      createdAt: '2026-01-01T00:00:00Z',
    });

    flagStaleObservation(db, 'obs-stale-1', 'Contradicted by newer observation');

    const results = getStaleObservations(db);
    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe('obs-stale-1');
    expect(results[0].observation.content).toBe('Old approach');
    expect(results[0].flag.reason).toBe('Contradicted by newer observation');
    expect(results[0].flag.resolved).toBe(false);
  });

  it('filters by resolution status', () => {
    insertObservation(db, {
      id: 'obs-unresolved',
      content: 'Unresolved stale',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-resolved',
      content: 'Resolved stale',
      createdAt: '2026-01-02T00:00:00Z',
    });

    flagStaleObservation(db, 'obs-unresolved', 'Stale');
    flagStaleObservation(db, 'obs-resolved', 'Also stale');

    // Manually resolve one
    db.prepare(
      'UPDATE staleness_flags SET resolved = 1 WHERE observation_id = ?',
    ).run('obs-resolved');

    const unresolved = getStaleObservations(db, { resolved: false });
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].observation.id).toBe('obs-unresolved');

    const resolved = getStaleObservations(db, { resolved: true });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].observation.id).toBe('obs-resolved');
  });

  it('filters by entity ID', () => {
    insertObservation(db, {
      id: 'obs-entity-a',
      content: 'Entity A observation',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-entity-b',
      content: 'Entity B observation',
      createdAt: '2026-01-01T00:00:00Z',
    });

    // Create entities
    upsertNode(db, {
      type: 'Project',
      name: 'Entity-A',
      metadata: {},
      observation_ids: ['obs-entity-a'],
    });
    upsertNode(db, {
      type: 'Project',
      name: 'Entity-B',
      metadata: {},
      observation_ids: ['obs-entity-b'],
    });

    // Flag both
    flagStaleObservation(db, 'obs-entity-a', 'Stale A');
    flagStaleObservation(db, 'obs-entity-b', 'Stale B');

    const nodeA = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'Entity-A'")
      .get() as { id: string };

    const results = getStaleObservations(db, { entityId: nodeA.id });
    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe('obs-entity-a');
  });
});

// =============================================================================
// Time Range Query Tests
// =============================================================================

describe('getObservationsByTimeRange', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters observations by time range', () => {
    insertObservation(db, {
      id: 'obs-jan',
      content: 'January observation',
      createdAt: '2026-01-15T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-feb',
      content: 'February observation',
      createdAt: '2026-02-15T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-mar',
      content: 'March observation',
      createdAt: '2026-03-15T00:00:00Z',
    });

    const results = getObservationsByTimeRange(db, {
      since: '2026-02-01T00:00:00Z',
      until: '2026-02-28T00:00:00Z',
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('obs-feb');
  });

  it('returns newest first', () => {
    insertObservation(db, {
      id: 'obs-1',
      content: 'First',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-2',
      content: 'Second',
      createdAt: '2026-02-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-3',
      content: 'Third',
      createdAt: '2026-03-01T00:00:00Z',
    });

    const results = getObservationsByTimeRange(db);
    expect(results[0].id).toBe('obs-3');
    expect(results[2].id).toBe('obs-1');
  });

  it('filters by entity ID', () => {
    insertObservation(db, {
      id: 'obs-linked',
      content: 'Linked to entity',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-unlinked',
      content: 'Not linked',
      createdAt: '2026-01-01T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Project',
      name: 'LinkedEntity',
      metadata: {},
      observation_ids: ['obs-linked'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'LinkedEntity'")
      .get() as { id: string };

    const results = getObservationsByTimeRange(db, { entityId: node.id });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('obs-linked');
  });
});

// =============================================================================
// Entity Timeline Tests
// =============================================================================

describe('getEntityTimeline', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns observations sorted oldest first with recency scores', () => {
    insertObservation(db, {
      id: 'obs-t1',
      content: 'First event',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-t2',
      content: 'Second event',
      createdAt: '2026-01-15T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-t3',
      content: 'Third event',
      createdAt: '2026-02-01T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Project',
      name: 'Timeline-Test',
      metadata: {},
      observation_ids: ['obs-t1', 'obs-t2', 'obs-t3'],
    });

    const node = db
      .prepare("SELECT id FROM graph_nodes WHERE name = 'Timeline-Test'")
      .get() as { id: string };

    const timeline = getEntityTimeline(db, node.id);
    expect(timeline).toHaveLength(3);

    // Oldest first
    expect(timeline[0].observation.id).toBe('obs-t1');
    expect(timeline[2].observation.id).toBe('obs-t3');

    // Recency scores decrease for older observations
    expect(timeline[2].recencyScore).toBeGreaterThan(timeline[0].recencyScore);

    // Age info present
    expect(timeline[0].age.label).toBeDefined();
    expect(timeline[0].age.days).toBeGreaterThanOrEqual(0);
  });

  it('returns empty array for non-existent entity', () => {
    const timeline = getEntityTimeline(db, 'non-existent');
    expect(timeline).toHaveLength(0);
  });
});

// =============================================================================
// Recent Entities Tests
// =============================================================================

describe('getRecentEntities', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns entities created within the time window', () => {
    // Entities created with default datetime('now') will be "recent"
    upsertNode(db, {
      type: 'Project',
      name: 'RecentTool',
      metadata: {},
      observation_ids: [],
    });

    const recent = getRecentEntities(db, { hours: 1 });
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent.some((n) => n.name === 'RecentTool')).toBe(true);
  });

  it('filters by entity type', () => {
    upsertNode(db, {
      type: 'Project',
      name: 'TypeFilterTool',
      metadata: {},
      observation_ids: [],
    });
    upsertNode(db, {
      type: 'Reference',
      name: 'TypeFilterPerson',
      metadata: {},
      observation_ids: [],
    });

    const tools = getRecentEntities(db, { hours: 1, type: 'Project' });
    expect(tools.some((n) => n.name === 'TypeFilterTool')).toBe(true);
    expect(tools.some((n) => n.name === 'TypeFilterPerson')).toBe(false);
  });
});
