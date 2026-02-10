import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCuration, CurationAgent } from '../curation-agent.js';
import {
  findMergeableClusters,
  mergeObservationCluster,
  pruneLowValue,
} from '../observation-merger.js';
import { initGraphSchema, upsertNode } from '../schema.js';
import { initStalenessSchema } from '../staleness.js';
import { runMigrations } from '../../storage/migrations.js';

// =============================================================================
// Test Helpers
// =============================================================================

function setupDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'laminark-curation-test-'));
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
  opts: {
    id: string;
    content: string;
    createdAt: string;
    projectHash?: string;
    source?: string;
  },
): void {
  db.prepare(
    `INSERT INTO observations (id, project_hash, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.projectHash ?? 'test-project',
    opts.content,
    opts.source ?? 'test',
    opts.createdAt,
    opts.createdAt,
  );
}

// =============================================================================
// Observation Merger Tests
// =============================================================================

describe('findMergeableClusters', () => {
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

  it('finds clusters of near-identical observations using Jaccard similarity', () => {
    // Create 3 nearly identical observations
    insertObservation(db, {
      id: 'obs-1',
      content: 'The project uses React for frontend development',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-2',
      content: 'The project uses React for frontend development work',
      createdAt: '2026-01-02T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-3',
      content: 'The project uses React for frontend development tasks',
      createdAt: '2026-01-03T00:00:00Z',
    });

    // Link to an entity
    upsertNode(db, {
      type: 'Tool',
      name: 'React',
      metadata: {},
      observation_ids: ['obs-1', 'obs-2', 'obs-3'],
    });

    const clusters = findMergeableClusters(db, { threshold: 0.95 });

    // Should form a cluster (Jaccard fallback, threshold 0.85)
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    const cluster = clusters[0];
    expect(cluster.observations.length).toBeGreaterThanOrEqual(2);
    expect(cluster.suggestedSummary).toContain('[Consolidated from');
  });

  it('does not cluster dissimilar observations', () => {
    insertObservation(db, {
      id: 'obs-a',
      content: 'React is used for the frontend user interface',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-b',
      content: 'PostgreSQL handles all database operations and storage',
      createdAt: '2026-01-02T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-c',
      content: 'Docker containers are used for deployment and CI/CD',
      createdAt: '2026-01-03T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Project',
      name: 'TestProject',
      metadata: {},
      observation_ids: ['obs-a', 'obs-b', 'obs-c'],
    });

    const clusters = findMergeableClusters(db);
    expect(clusters).toHaveLength(0);
  });

  it('requires at least 3 observations on an entity to consider clustering', () => {
    insertObservation(db, {
      id: 'obs-only-1',
      content: 'Same text here for testing',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-only-2',
      content: 'Same text here for testing',
      createdAt: '2026-01-02T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Tool',
      name: 'TwoObs',
      metadata: {},
      observation_ids: ['obs-only-1', 'obs-only-2'],
    });

    const clusters = findMergeableClusters(db);
    // Entity has only 2 observations, should not be considered
    expect(clusters).toHaveLength(0);
  });
});

describe('mergeObservationCluster', () => {
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

  it('creates consolidated observation and soft-deletes originals', () => {
    insertObservation(db, {
      id: 'merge-1',
      content: 'Uses React for the frontend',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'merge-2',
      content: 'Uses React for the frontend components',
      createdAt: '2026-01-02T00:00:00Z',
    });
    insertObservation(db, {
      id: 'merge-3',
      content: 'Uses React for the frontend rendering',
      createdAt: '2026-01-03T00:00:00Z',
    });

    const node = upsertNode(db, {
      type: 'Tool',
      name: 'React-merge-test',
      metadata: {},
      observation_ids: ['merge-1', 'merge-2', 'merge-3'],
    });

    const cluster = {
      entityId: node.id,
      observations: [
        { id: 'merge-1', text: 'Uses React for the frontend', embedding: null, created_at: '2026-01-01T00:00:00Z' },
        { id: 'merge-2', text: 'Uses React for the frontend components', embedding: null, created_at: '2026-01-02T00:00:00Z' },
        { id: 'merge-3', text: 'Uses React for the frontend rendering', embedding: null, created_at: '2026-01-03T00:00:00Z' },
      ],
      similarity: 0.9,
      suggestedSummary: '[Consolidated from 3 observations] Uses React for the frontend components (also: rendering)',
    };

    const result = mergeObservationCluster(db, cluster);

    // Should have created a merged observation
    expect(result.mergedId).toBeTruthy();
    expect(result.removedIds).toEqual(['merge-1', 'merge-2', 'merge-3']);

    // New observation exists
    const merged = db
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result.mergedId) as { content: string; source: string; deleted_at: string | null } | undefined;
    expect(merged).toBeDefined();
    expect(merged!.content).toContain('[Consolidated from 3 observations]');
    expect(merged!.source).toBe('curation:merge');
    expect(merged!.deleted_at).toBeNull();

    // Originals are soft-deleted (not hard-deleted)
    for (const id of result.removedIds) {
      const obs = db
        .prepare('SELECT * FROM observations WHERE id = ?')
        .get(id) as { deleted_at: string | null } | undefined;
      expect(obs).toBeDefined(); // Still exists
      expect(obs!.deleted_at).not.toBeNull(); // But soft-deleted
    }

    // Entity observation_ids updated
    const updatedNode = db
      .prepare('SELECT observation_ids FROM graph_nodes WHERE id = ?')
      .get(node.id) as { observation_ids: string };
    const updatedIds = JSON.parse(updatedNode.observation_ids) as string[];
    expect(updatedIds).toContain(result.mergedId);
    expect(updatedIds).not.toContain('merge-1');
    expect(updatedIds).not.toContain('merge-2');
    expect(updatedIds).not.toContain('merge-3');
  });
});

describe('pruneLowValue', () => {
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

  it('prunes short, old, unlinked, auto-captured observations', () => {
    // This observation matches ALL criteria: short, old, no entity, auto-captured
    insertObservation(db, {
      id: 'prune-me',
      content: 'tiny note',
      createdAt: '2025-01-01T00:00:00Z', // Over 90 days old
      source: 'hook:post_tool_use',
    });

    const result = pruneLowValue(db);
    expect(result.pruned).toBe(1);

    // Verify soft-deleted, not hard-deleted
    const obs = db
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get('prune-me') as { deleted_at: string | null } | undefined;
    expect(obs).toBeDefined();
    expect(obs!.deleted_at).not.toBeNull();
  });

  it('does NOT prune observations saved by user', () => {
    insertObservation(db, {
      id: 'user-saved',
      content: 'tiny',
      createdAt: '2025-01-01T00:00:00Z',
      source: 'mcp:save_memory',
    });

    const result = pruneLowValue(db);
    expect(result.pruned).toBe(0);
  });

  it('does NOT prune observations linked to entities', () => {
    insertObservation(db, {
      id: 'linked-obs',
      content: 'tiny note',
      createdAt: '2025-01-01T00:00:00Z',
      source: 'hook:post_tool_use',
    });

    upsertNode(db, {
      type: 'Tool',
      name: 'LinkedTool',
      metadata: {},
      observation_ids: ['linked-obs'],
    });

    const result = pruneLowValue(db);
    expect(result.pruned).toBe(0);
  });

  it('does NOT prune recent observations even if short', () => {
    const recent = new Date().toISOString();
    insertObservation(db, {
      id: 'recent-short',
      content: 'tiny',
      createdAt: recent,
      source: 'hook:post_tool_use',
    });

    const result = pruneLowValue(db);
    expect(result.pruned).toBe(0);
  });
});

// =============================================================================
// Curation Agent Tests
// =============================================================================

describe('runCuration', () => {
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

  it('merges similar observations during curation', async () => {
    // Set up: 3 nearly identical observations for same entity
    insertObservation(db, {
      id: 'cur-obs-1',
      content: 'The project uses React for building the frontend user interface',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'cur-obs-2',
      content: 'The project uses React for building the frontend user interface components',
      createdAt: '2026-01-02T00:00:00Z',
    });
    insertObservation(db, {
      id: 'cur-obs-3',
      content: 'The project uses React for building the frontend user interface pages',
      createdAt: '2026-01-03T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Tool',
      name: 'React-curation',
      metadata: {},
      observation_ids: ['cur-obs-1', 'cur-obs-2', 'cur-obs-3'],
    });

    const report = await runCuration(db);

    expect(report.observationsMerged).toBeGreaterThanOrEqual(2);
    expect(report.startedAt).toBeTruthy();
    expect(report.completedAt).toBeTruthy();
  });

  it('deduplicates entities during curation', async () => {
    // Set up: two Tool nodes "React" and "react" (case difference)
    upsertNode(db, {
      type: 'Tool',
      name: 'React',
      metadata: {},
      observation_ids: ['obs-react-1'],
    });
    upsertNode(db, {
      type: 'Tool',
      name: 'react',
      metadata: {},
      observation_ids: ['obs-react-2'],
    });

    // Insert the referenced observations so they exist
    insertObservation(db, {
      id: 'obs-react-1',
      content: 'Using React framework',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'obs-react-2',
      content: 'Using react library',
      createdAt: '2026-01-02T00:00:00Z',
    });

    const report = await runCuration(db);

    expect(report.entitiesDeduplicated).toBeGreaterThanOrEqual(1);

    // Should only have one Tool node for React now
    const nodes = db
      .prepare("SELECT * FROM graph_nodes WHERE type = 'Tool' AND LOWER(name) = 'react'")
      .all();
    expect(nodes).toHaveLength(1);
  });

  it('flags stale observations during curation', async () => {
    // Set up: older observation "uses Redux", newer "switched to Zustand"
    insertObservation(db, {
      id: 'stale-old',
      content: 'We use Redux for state management',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'stale-new',
      content: 'We switched from Redux to Zustand for state management',
      createdAt: new Date().toISOString(), // Recent -- triggers "updated recently" path
    });

    // Create entity with both observations, set updated_at to now
    upsertNode(db, {
      type: 'Tool',
      name: 'Redux-curation',
      metadata: {},
      observation_ids: ['stale-old', 'stale-new'],
    });

    const report = await runCuration(db);

    expect(report.stalenessFlagsAdded).toBeGreaterThanOrEqual(1);

    // Verify the flag was actually created
    const flags = db
      .prepare('SELECT * FROM staleness_flags WHERE observation_id = ?')
      .all('stale-old');
    expect(flags.length).toBeGreaterThanOrEqual(1);
  });

  it('handles errors gracefully without crashing', async () => {
    // Create a scenario that may trigger errors but should not crash

    // Mock: create a node pointing to non-existent observations
    db.prepare(
      `INSERT INTO graph_nodes (id, type, name, metadata, observation_ids, created_at, updated_at)
       VALUES (?, 'Tool', 'BrokenTool', '{}', '["nonexistent-1", "nonexistent-2", "nonexistent-3"]', datetime('now'), datetime('now'))`,
    ).run('broken-node-id');

    // Should not throw, should still complete
    const report = await runCuration(db);
    expect(report.completedAt).toBeTruthy();
    // The report itself should be valid even if individual steps had issues
    expect(typeof report.observationsMerged).toBe('number');
    expect(typeof report.entitiesDeduplicated).toBe('number');
    expect(typeof report.stalenessFlagsAdded).toBe('number');
    expect(typeof report.lowValuePruned).toBe('number');
  });

  it('is idempotent -- running twice produces the same result', async () => {
    // Set up: similar observations for merging
    insertObservation(db, {
      id: 'idem-1',
      content: 'The application is built with TypeScript and Node.js backend',
      createdAt: '2026-01-01T00:00:00Z',
    });
    insertObservation(db, {
      id: 'idem-2',
      content: 'The application is built with TypeScript and Node.js backend server',
      createdAt: '2026-01-02T00:00:00Z',
    });
    insertObservation(db, {
      id: 'idem-3',
      content: 'The application is built with TypeScript and Node.js backend service',
      createdAt: '2026-01-03T00:00:00Z',
    });

    upsertNode(db, {
      type: 'Project',
      name: 'IdempotencyTest',
      metadata: {},
      observation_ids: ['idem-1', 'idem-2', 'idem-3'],
    });

    // First run: should do work
    const firstReport = await runCuration(db);

    // Second run: should do no new work
    const secondReport = await runCuration(db);

    expect(secondReport.observationsMerged).toBe(0);
    expect(secondReport.entitiesDeduplicated).toBe(0);
    // Staleness flags should not be re-added
    expect(secondReport.stalenessFlagsAdded).toBe(0);
  });
});

describe('CurationAgent lifecycle', () => {
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

  it('starts and stops without errors', () => {
    const agent = new CurationAgent(db, { intervalMs: 60000 });

    expect(agent.isRunning()).toBe(false);

    agent.start();
    expect(agent.isRunning()).toBe(true);

    agent.stop();
    expect(agent.isRunning()).toBe(false);
  });

  it('start is idempotent (calling start twice does not create double timers)', () => {
    const agent = new CurationAgent(db, { intervalMs: 60000 });

    agent.start();
    agent.start(); // Should be no-op

    expect(agent.isRunning()).toBe(true);

    agent.stop();
    expect(agent.isRunning()).toBe(false);
  });

  it('runOnce executes a curation cycle and updates lastRun', async () => {
    const agent = new CurationAgent(db);

    expect(agent.getLastRun()).toBeNull();

    const report = await agent.runOnce();

    expect(report.completedAt).toBeTruthy();
    expect(agent.getLastRun()).toBeTruthy();
  });

  it('calls onComplete callback after each cycle', async () => {
    const callback = vi.fn();
    const agent = new CurationAgent(db, { onComplete: callback });

    await agent.runOnce();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      }),
    );
  });
});
