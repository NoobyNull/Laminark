import type BetterSqlite3 from 'better-sqlite3';

/**
 * A versioned schema migration.
 * Migrations are applied in order and tracked in the _migrations table.
 */
export interface Migration {
  version: number;
  name: string;
  up: string; // SQL to execute
}

/**
 * All schema migrations in order.
 *
 * Migration 001: Observations table with INTEGER PRIMARY KEY AUTOINCREMENT
 *   (critical for FTS5 content_rowid stability across VACUUM).
 * Migration 002: Sessions table for session lifecycle tracking.
 * Migration 003: FTS5 external content table with porter+unicode61 tokenizer
 *   and three sync triggers (INSERT, UPDATE, DELETE).
 * Migration 004: sqlite-vec vec0 table for 384-dim embeddings (conditional).
 * Migration 005: Add title column to observations and rebuild FTS5 with
 *   title+content dual-column indexing.
 * Migration 006: Recreate vec0 table with cosine distance metric (conditional).
 * Migration 007: Context stashes table for topic detection thread snapshots.
 * Migration 008: Threshold history table for EWMA adaptive threshold seeding.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_observations',
    up: `
      CREATE TABLE observations (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
        project_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        session_id TEXT,
        embedding BLOB,
        embedding_model TEXT,
        embedding_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );

      CREATE INDEX idx_observations_project ON observations(project_hash);
      CREATE INDEX idx_observations_session ON observations(session_id);
      CREATE INDEX idx_observations_created ON observations(created_at);
      CREATE INDEX idx_observations_deleted ON observations(deleted_at) WHERE deleted_at IS NOT NULL;
    `,
  },
  {
    version: 2,
    name: 'create_sessions',
    up: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_hash TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        summary TEXT
      );

      CREATE INDEX idx_sessions_project ON sessions(project_hash);
      CREATE INDEX idx_sessions_started ON sessions(started_at);
    `,
  },
  {
    version: 3,
    name: 'create_fts5_observations',
    up: `
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        content,
        content='observations',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Sync trigger: INSERT
      CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, content)
          VALUES (new.rowid, new.content);
      END;

      -- Sync trigger: UPDATE (delete old entry, insert new)
      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
        INSERT INTO observations_fts(rowid, content)
          VALUES (new.rowid, new.content);
      END;

      -- Sync trigger: DELETE
      CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
      END;
    `,
  },
  {
    version: 4,
    name: 'create_vec0_embeddings',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
        observation_id TEXT PRIMARY KEY,
        embedding float[384]
      );
    `,
  },
  {
    version: 5,
    name: 'add_observation_title',
    up: `
      ALTER TABLE observations ADD COLUMN title TEXT;

      DROP TRIGGER observations_ai;
      DROP TRIGGER observations_au;
      DROP TRIGGER observations_ad;
      DROP TABLE observations_fts;

      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title,
        content,
        content='observations',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;

      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content)
          VALUES('delete', old.rowid, old.title, old.content);
        INSERT INTO observations_fts(rowid, title, content)
          VALUES (new.rowid, new.title, new.content);
      END;

      CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content)
          VALUES('delete', old.rowid, old.title, old.content);
      END;

      INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
    `,
  },
  {
    version: 6,
    name: 'recreate_vec0_cosine_distance',
    up: `
      DROP TABLE IF EXISTS observation_embeddings;
      CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
        observation_id TEXT PRIMARY KEY,
        embedding float[384] distance_metric=cosine
      );
    `,
  },
  {
    version: 7,
    name: 'create_context_stashes',
    up: `
      CREATE TABLE context_stashes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        topic_label TEXT NOT NULL,
        summary TEXT NOT NULL,
        observation_snapshots TEXT NOT NULL,
        observation_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'stashed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resumed_at TEXT
      );

      CREATE INDEX idx_stashes_project_status_created
        ON context_stashes(project_id, status, created_at DESC);

      CREATE INDEX idx_stashes_session
        ON context_stashes(session_id);
    `,
  },
  {
    version: 8,
    name: 'create_threshold_history',
    up: `
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
    `,
  },
];

/**
 * Applies unapplied schema migrations in order.
 *
 * Creates a _migrations tracking table if it does not exist, then applies
 * each migration whose version exceeds the current max applied version.
 * Each migration runs inside a transaction for atomicity.
 *
 * Migrations 004 and 006 (vec0 tables) are only applied when hasVectorSupport
 * is true. If sqlite-vec is not available, they are silently skipped and will
 * be applied on a future run when the extension becomes available.
 *
 * @param db - An open better-sqlite3 database connection
 * @param hasVectorSupport - Whether sqlite-vec loaded successfully
 */
export function runMigrations(
  db: BetterSqlite3.Database,
  hasVectorSupport: boolean,
): void {
  // Create tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get current max applied version
  const maxVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) FROM _migrations',
  ).pluck().get() as number;

  // Prepare insert statement
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)',
  );

  // Apply each unapplied migration in a transaction
  const applyMigration = db.transaction((m: Migration) => {
    db.exec(m.up);
    insertMigration.run(m.version, m.name);
  });

  for (const migration of MIGRATIONS) {
    if (migration.version <= maxVersion) {
      continue;
    }

    // Skip vec0 migrations if sqlite-vec is not available
    if ((migration.version === 4 || migration.version === 6) && !hasVectorSupport) {
      continue;
    }

    applyMigration(migration);
  }
}
