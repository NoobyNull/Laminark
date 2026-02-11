import type BetterSqlite3 from 'better-sqlite3';

/**
 * A versioned schema migration.
 * Migrations are applied in order and tracked in the _migrations table.
 */
export interface Migration {
  version: number;
  name: string;
  up: string | ((db: BetterSqlite3.Database) => void); // SQL string or function
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
 * Migration 009: Shift decisions table for topic shift decision logging.
 * Migration 010: Project metadata table for project selector UI.
 * Migration 011: Add project_hash to graph tables and backfill from observations.
 * Migration 012: Add classification and classified_at columns for LLM-based observation classification.
 * Migration 013: Research buffer table for exploration tool event buffering.
 * Migration 014: Add kind column to observations with backfill from source field.
 * Migration 015: Update graph taxonomy -- remove Tool/Person nodes, tighten CHECK constraints.
 * Migration 016: Tool registry table for discovered tools with scope-aware uniqueness.
 * Migration 017: Tool usage events table for per-event temporal tracking.
 * Migration 018: Tool registry FTS5 + vec0 tables for hybrid search on tool descriptions.
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
  {
    version: 9,
    name: 'create_shift_decisions',
    up: `
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
    `,
  },
  {
    version: 10,
    name: 'create_project_metadata',
    up: `
      CREATE TABLE IF NOT EXISTS project_metadata (
        project_hash TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        display_name TEXT,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 11,
    name: 'add_project_hash_to_graph_tables',
    up: (db: BetterSqlite3.Database) => {
      // Graph tables are created by initGraphSchema() (separate from main migrations).
      // They may or may not exist, and may or may not already have project_hash.
      const tableExists = (name: string) =>
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

      const columnExists = (table: string, column: string) => {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
        return cols.some(c => c.name === column);
      };

      if (tableExists('graph_nodes') && !columnExists('graph_nodes', 'project_hash')) {
        db.exec('ALTER TABLE graph_nodes ADD COLUMN project_hash TEXT');

        // Backfill from linked observations
        db.exec(`
          UPDATE graph_nodes SET project_hash = (
            SELECT o.project_hash FROM observations o
            WHERE o.id IN (
              SELECT value FROM json_each(graph_nodes.observation_ids)
            )
            LIMIT 1
          ) WHERE project_hash IS NULL
        `);
      }

      if (tableExists('graph_edges') && !columnExists('graph_edges', 'project_hash')) {
        db.exec('ALTER TABLE graph_edges ADD COLUMN project_hash TEXT');

        // Backfill from source node
        db.exec(`
          UPDATE graph_edges SET project_hash = (
            SELECT gn.project_hash FROM graph_nodes gn
            WHERE gn.id = graph_edges.source_id
          ) WHERE project_hash IS NULL
        `);
      }

      // Indexes are safe with IF NOT EXISTS
      if (tableExists('graph_nodes')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_hash)');
      }
      if (tableExists('graph_edges')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_hash)');
      }
    },
  },
  {
    version: 12,
    name: 'add_observation_classification',
    up: `
      ALTER TABLE observations ADD COLUMN classification TEXT;
      ALTER TABLE observations ADD COLUMN classified_at TEXT;
      CREATE INDEX idx_observations_classification
        ON observations(classification) WHERE classification IS NOT NULL;
    `,
  },
  {
    version: 13,
    name: 'create_research_buffer',
    up: `
      CREATE TABLE research_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_hash TEXT NOT NULL,
        session_id TEXT,
        tool_name TEXT NOT NULL,
        target TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_research_buffer_session ON research_buffer(session_id, created_at DESC);
    `,
  },
  {
    version: 14,
    name: 'add_observation_kind',
    up: (db: BetterSqlite3.Database) => {
      // Add kind column
      db.exec("ALTER TABLE observations ADD COLUMN kind TEXT DEFAULT 'finding'");

      // Backfill from source field
      db.exec(`
        UPDATE observations SET kind = 'change'
        WHERE source LIKE 'hook:Write' OR source LIKE 'hook:Edit'
      `);
      db.exec(`
        UPDATE observations SET kind = 'verification'
        WHERE source LIKE 'hook:Bash'
      `);
      db.exec(`
        UPDATE observations SET kind = 'reference'
        WHERE source LIKE 'hook:WebFetch' OR source LIKE 'hook:WebSearch'
      `);
      db.exec(`
        UPDATE observations SET kind = 'finding'
        WHERE source IN ('mcp:save_memory', 'manual', 'slash:remember')
          AND kind = 'finding'
      `);

      // Soft-delete old noise observations from Read/Glob/Grep hooks
      db.exec(`
        UPDATE observations
        SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE (source LIKE 'hook:Read' OR source LIKE 'hook:Glob' OR source LIKE 'hook:Grep')
          AND deleted_at IS NULL
      `);

      // Index for kind-based queries
      db.exec('CREATE INDEX idx_observations_kind ON observations(kind)');
    },
  },
  {
    version: 15,
    name: 'update_graph_taxonomy',
    up: (db: BetterSqlite3.Database) => {
      // Check if graph tables exist
      const tableExists = (name: string) =>
        !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

      if (!tableExists('graph_nodes')) return;

      // Delete old Tool and Person nodes (and their connected edges via CASCADE)
      db.exec("DELETE FROM graph_nodes WHERE type IN ('Tool', 'Person')");

      // Delete old relationship types that no longer exist
      db.exec("DELETE FROM graph_edges WHERE type IN ('uses', 'depends_on', 'decided_by', 'part_of')");

      // Recreate graph_nodes with updated CHECK constraint
      db.exec(`
        CREATE TABLE graph_nodes_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('Project','File','Decision','Problem','Solution','Reference')),
          name TEXT NOT NULL,
          metadata TEXT DEFAULT '{}',
          observation_ids TEXT DEFAULT '[]',
          project_hash TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO graph_nodes_new SELECT * FROM graph_nodes;

        DROP TABLE graph_nodes;
        ALTER TABLE graph_nodes_new RENAME TO graph_nodes;

        CREATE INDEX idx_graph_nodes_type ON graph_nodes(type);
        CREATE INDEX idx_graph_nodes_name ON graph_nodes(name);
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_hash);
      `);

      // Recreate graph_edges with updated CHECK constraint
      db.exec(`
        CREATE TABLE graph_edges_new (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('related_to','solved_by','caused_by','modifies','informed_by','references','verified_by','preceded_by')),
          weight REAL NOT NULL DEFAULT 1.0 CHECK(weight >= 0.0 AND weight <= 1.0),
          metadata TEXT DEFAULT '{}',
          project_hash TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO graph_edges_new SELECT * FROM graph_edges;

        DROP TABLE graph_edges;
        ALTER TABLE graph_edges_new RENAME TO graph_edges;

        CREATE INDEX idx_graph_edges_source ON graph_edges(source_id);
        CREATE INDEX idx_graph_edges_target ON graph_edges(target_id);
        CREATE INDEX idx_graph_edges_type ON graph_edges(type);
        CREATE UNIQUE INDEX idx_graph_edges_unique ON graph_edges(source_id, target_id, type);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_hash);
      `);
    },
  },
  {
    version: 16,
    name: 'create_tool_registry',
    up: `
      CREATE TABLE tool_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        tool_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        source TEXT NOT NULL,
        project_hash TEXT,
        description TEXT,
        server_name TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX idx_tool_registry_name_project
        ON tool_registry(name, COALESCE(project_hash, ''));
      CREATE INDEX idx_tool_registry_scope
        ON tool_registry(scope);
      CREATE INDEX idx_tool_registry_project
        ON tool_registry(project_hash) WHERE project_hash IS NOT NULL;
      CREATE INDEX idx_tool_registry_usage
        ON tool_registry(usage_count DESC, last_used_at DESC);
    `,
  },
  {
    version: 17,
    name: 'create_tool_usage_events',
    up: `
      CREATE TABLE tool_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        session_id TEXT,
        project_hash TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_tool_usage_events_tool
        ON tool_usage_events(tool_name, created_at DESC);
      CREATE INDEX idx_tool_usage_events_session
        ON tool_usage_events(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX idx_tool_usage_events_project_time
        ON tool_usage_events(project_hash, created_at DESC);
    `,
  },
  {
    version: 18,
    name: 'create_tool_registry_search',
    up: (db: BetterSqlite3.Database) => {
      // FTS5 external content table for tool registry (always created)
      db.exec(`
        CREATE VIRTUAL TABLE tool_registry_fts USING fts5(
          name,
          description,
          content='tool_registry',
          content_rowid='id',
          tokenize='porter unicode61'
        );

        -- Sync trigger: INSERT
        CREATE TRIGGER tool_registry_ai AFTER INSERT ON tool_registry BEGIN
          INSERT INTO tool_registry_fts(rowid, name, description)
            VALUES (new.id, new.name, new.description);
        END;

        -- Sync trigger: UPDATE (delete old entry, insert new)
        CREATE TRIGGER tool_registry_au AFTER UPDATE ON tool_registry BEGIN
          INSERT INTO tool_registry_fts(tool_registry_fts, rowid, name, description)
            VALUES('delete', old.id, old.name, old.description);
          INSERT INTO tool_registry_fts(rowid, name, description)
            VALUES (new.id, new.name, new.description);
        END;

        -- Sync trigger: DELETE
        CREATE TRIGGER tool_registry_ad AFTER DELETE ON tool_registry BEGIN
          INSERT INTO tool_registry_fts(tool_registry_fts, rowid, name, description)
            VALUES('delete', old.id, old.name, old.description);
        END;

        -- Rebuild to index existing tool_registry rows
        INSERT INTO tool_registry_fts(tool_registry_fts) VALUES('rebuild');
      `);

      // vec0 table for tool embeddings (conditional on sqlite-vec availability)
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS tool_registry_embeddings USING vec0(
            tool_id INTEGER PRIMARY KEY,
            embedding float[384] distance_metric=cosine
          );
        `);
      } catch {
        // sqlite-vec not available -- skip silently, vector search will degrade gracefully
      }
    },
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
    if (typeof m.up === 'function') {
      m.up(db);
    } else {
      db.exec(m.up);
    }
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
