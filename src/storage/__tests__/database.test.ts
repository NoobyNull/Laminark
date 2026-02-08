import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.js';
import type { LaminarkDatabase } from '../database.js';
import type { DatabaseConfig } from '../../shared/types.js';

describe('openDatabase', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('opens database with WAL mode', () => {
    ldb = openDatabase(config);
    const mode = ldb.db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('sets busy_timeout to configured value', () => {
    ldb = openDatabase(config);
    const timeout = ldb.db.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
  });

  it('sets synchronous to NORMAL (1)', () => {
    ldb = openDatabase(config);
    const sync = ldb.db.pragma('synchronous', { simple: true });
    expect(sync).toBe(1);
  });

  it('enables foreign_keys', () => {
    ldb = openDatabase(config);
    const fk = ldb.db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('sets cache_size to -64000 (64MB)', () => {
    ldb = openDatabase(config);
    const cache = ldb.db.pragma('cache_size', { simple: true });
    expect(cache).toBe(-64000);
  });

  it('reports vector support status', () => {
    ldb = openDatabase(config);
    // sqlite-vec should load successfully in test environment
    expect(typeof ldb.hasVectorSupport).toBe('boolean');
  });

  it('creates database file on disk', () => {
    ldb = openDatabase(config);
    ldb.close();
    expect(existsSync(config.dbPath)).toBe(true);
  });

  it('close() does not throw', () => {
    ldb = openDatabase(config);
    expect(() => ldb.close()).not.toThrow();
  });

  it('checkpoint() does not throw', () => {
    ldb = openDatabase(config);
    expect(() => ldb.checkpoint()).not.toThrow();
  });
});

describe('migrations', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates _migrations table with applied migrations', () => {
    ldb = openDatabase(config);
    const rows = ldb.db
      .prepare('SELECT version, name FROM _migrations ORDER BY version')
      .all() as { version: number; name: string }[];

    // Should have at least 3 migrations (4 if vec support)
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toEqual({ version: 1, name: 'create_observations' });
    expect(rows[1]).toEqual({ version: 2, name: 'create_sessions' });
    expect(rows[2]).toEqual({ version: 3, name: 'create_fts5_observations' });
  });

  it('creates observations table with correct columns', () => {
    ldb = openDatabase(config);
    const columns = ldb.db
      .prepare("PRAGMA table_info('observations')")
      .all() as { name: string; type: string; pk: number }[];

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('rowid');
    expect(colNames).toContain('id');
    expect(colNames).toContain('project_hash');
    expect(colNames).toContain('content');
    expect(colNames).toContain('source');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('embedding');
    expect(colNames).toContain('embedding_model');
    expect(colNames).toContain('embedding_version');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
    expect(colNames).toContain('deleted_at');
  });

  it('observations.rowid is INTEGER PRIMARY KEY (AUTOINCREMENT)', () => {
    ldb = openDatabase(config);
    const columns = ldb.db
      .prepare("PRAGMA table_info('observations')")
      .all() as { name: string; type: string; pk: number }[];

    const rowidCol = columns.find((c) => c.name === 'rowid');
    expect(rowidCol).toBeDefined();
    expect(rowidCol!.type).toBe('INTEGER');
    expect(rowidCol!.pk).toBe(1); // Primary key

    // Verify AUTOINCREMENT by checking sqlite_sequence table exists
    const hasAutoincrement = ldb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",
      )
      .get();
    expect(hasAutoincrement).toBeDefined();
  });

  it('creates sessions table with correct columns', () => {
    ldb = openDatabase(config);
    const columns = ldb.db
      .prepare("PRAGMA table_info('sessions')")
      .all() as { name: string; type: string; pk: number }[];

    const colNames = columns.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        'id',
        'project_hash',
        'started_at',
        'ended_at',
        'summary',
      ]),
    );
  });

  it('creates observations_fts virtual table', () => {
    ldb = openDatabase(config);
    const fts = ldb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'",
      )
      .get() as { name: string } | undefined;
    expect(fts).toBeDefined();
    expect(fts!.name).toBe('observations_fts');
  });

  it('FTS5 trigger syncs on INSERT', () => {
    ldb = openDatabase(config);

    // Insert a test observation
    ldb.db
      .prepare(
        "INSERT INTO observations (project_hash, content, source) VALUES ('testhash', 'the quick brown fox jumps', 'test')",
      )
      .run();

    // FTS should find it
    const results = ldb.db
      .prepare("SELECT * FROM observations_fts WHERE content MATCH 'fox'")
      .all();
    expect(results.length).toBe(1);
  });

  it('FTS5 trigger syncs on UPDATE', () => {
    ldb = openDatabase(config);

    // Insert original
    ldb.db
      .prepare(
        "INSERT INTO observations (project_hash, content, source) VALUES ('testhash', 'original content here', 'test')",
      )
      .run();

    // Update content
    ldb.db
      .prepare(
        "UPDATE observations SET content = 'updated content replacement' WHERE project_hash = 'testhash'",
      )
      .run();

    // Old content should NOT be found
    const oldResults = ldb.db
      .prepare(
        "SELECT * FROM observations_fts WHERE content MATCH 'original'",
      )
      .all();
    expect(oldResults.length).toBe(0);

    // New content should be found
    const newResults = ldb.db
      .prepare(
        "SELECT * FROM observations_fts WHERE content MATCH 'replacement'",
      )
      .all();
    expect(newResults.length).toBe(1);
  });

  it('FTS5 trigger syncs on DELETE', () => {
    ldb = openDatabase(config);

    // Insert
    ldb.db
      .prepare(
        "INSERT INTO observations (project_hash, content, source) VALUES ('testhash', 'deletable content target', 'test')",
      )
      .run();

    // Verify it's indexed
    const before = ldb.db
      .prepare(
        "SELECT * FROM observations_fts WHERE content MATCH 'deletable'",
      )
      .all();
    expect(before.length).toBe(1);

    // Delete it
    ldb.db
      .prepare("DELETE FROM observations WHERE project_hash = 'testhash'")
      .run();

    // Should be gone from FTS
    const after = ldb.db
      .prepare(
        "SELECT * FROM observations_fts WHERE content MATCH 'deletable'",
      )
      .all();
    expect(after.length).toBe(0);
  });

  it('does NOT re-run migrations on reopen', () => {
    ldb = openDatabase(config);

    // Insert a test observation
    ldb.db
      .prepare(
        "INSERT INTO observations (project_hash, content, source) VALUES ('testhash', 'persist me', 'test')",
      )
      .run();

    const migrationCountBefore = (
      ldb.db
        .prepare('SELECT COUNT(*) as count FROM _migrations')
        .get() as { count: number }
    ).count;

    // Close and reopen
    ldb.close();
    ldb = openDatabase(config);

    const migrationCountAfter = (
      ldb.db
        .prepare('SELECT COUNT(*) as count FROM _migrations')
        .get() as { count: number }
    ).count;

    expect(migrationCountAfter).toBe(migrationCountBefore);
  });

  it('preserves data across close/reopen', () => {
    ldb = openDatabase(config);

    // Insert data
    ldb.db
      .prepare(
        "INSERT INTO observations (project_hash, content, source) VALUES ('testhash', 'persistent data', 'test')",
      )
      .run();

    ldb.db
      .prepare(
        "INSERT INTO sessions (id, project_hash) VALUES ('sess-1', 'testhash')",
      )
      .run();

    // Close and reopen
    ldb.close();
    ldb = openDatabase(config);

    // Verify observations persisted
    const obs = ldb.db
      .prepare("SELECT content FROM observations WHERE project_hash = 'testhash'")
      .all() as { content: string }[];
    expect(obs.length).toBe(1);
    expect(obs[0].content).toBe('persistent data');

    // Verify sessions persisted
    const sess = ldb.db
      .prepare("SELECT id FROM sessions WHERE project_hash = 'testhash'")
      .all() as { id: string }[];
    expect(sess.length).toBe(1);
    expect(sess[0].id).toBe('sess-1');

    // Verify FTS still works after reopen
    const ftsResults = ldb.db
      .prepare(
        "SELECT * FROM observations_fts WHERE content MATCH 'persistent'",
      )
      .all();
    expect(ftsResults.length).toBe(1);
  });

  it('creates vec0 table when vector support is available', () => {
    ldb = openDatabase(config);
    if (!ldb.hasVectorSupport) {
      // Skip if sqlite-vec not available
      return;
    }

    const vec = ldb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_embeddings'",
      )
      .get() as { name: string } | undefined;
    expect(vec).toBeDefined();
    expect(vec!.name).toBe('observation_embeddings');

    // Verify migration 4 was recorded
    const m4 = ldb.db
      .prepare('SELECT name FROM _migrations WHERE version = 4')
      .get() as { name: string } | undefined;
    expect(m4).toBeDefined();
    expect(m4!.name).toBe('create_vec0_embeddings');
  });
});
