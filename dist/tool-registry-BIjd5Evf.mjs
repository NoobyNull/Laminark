import { a as isDebugEnabled } from "./config-t8LZeB-u.mjs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

//#region src/shared/debug.ts
/**
* Internal cached state for debug mode.
* Resolved on first call and never changes (debug mode is process-lifetime).
*/
let _enabled = null;
function enabled() {
	if (_enabled === null) _enabled = isDebugEnabled();
	return _enabled;
}
/**
* Logs a debug message to stderr when debug mode is active.
*
* When debug is disabled (the default), this is a near-zero-cost no-op after the
* first call -- the cached flag short-circuits immediately.
*
* Format: `[ISO_TIMESTAMP] [LAMINARK:category] message {json_data}`
*
* @param category - Debug category (e.g., 'db', 'obs', 'search', 'session')
* @param message - Human-readable log message
* @param data - Optional structured data to include (keep lightweight -- no large payloads)
*/
function debug(category, message, data) {
	if (!enabled()) return;
	let line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [LAMINARK:${category}] ${message}`;
	if (data !== void 0) line += ` ${JSON.stringify(data)}`;
	process.stderr.write(line + "\n");
}
/**
* Wraps a synchronous function with timing instrumentation.
*
* When debug is disabled, calls `fn()` directly with zero overhead --
* no timing measurement, no wrapping.
*
* @param category - Debug category for the log line
* @param message - Description of the operation being timed
* @param fn - Synchronous function to execute and time
* @returns The return value of `fn()`
*/
function debugTimed(category, message, fn) {
	if (!enabled()) return fn();
	const start = performance.now();
	const result = fn();
	debug(category, `${message} (${(performance.now() - start).toFixed(2)}ms)`);
	return result;
}

//#endregion
//#region src/storage/migrations.ts
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
* Migration 019: Add status column (active/stale/demoted) to tool_registry for staleness management.
*/
const MIGRATIONS = [
	{
		version: 1,
		name: "create_observations",
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
    `
	},
	{
		version: 2,
		name: "create_sessions",
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
    `
	},
	{
		version: 3,
		name: "create_fts5_observations",
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
    `
	},
	{
		version: 4,
		name: "create_vec0_embeddings",
		up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
        observation_id TEXT PRIMARY KEY,
        embedding float[384]
      );
    `
	},
	{
		version: 5,
		name: "add_observation_title",
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
    `
	},
	{
		version: 6,
		name: "recreate_vec0_cosine_distance",
		up: `
      DROP TABLE IF EXISTS observation_embeddings;
      CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
        observation_id TEXT PRIMARY KEY,
        embedding float[384] distance_metric=cosine
      );
    `
	},
	{
		version: 7,
		name: "create_context_stashes",
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
    `
	},
	{
		version: 8,
		name: "create_threshold_history",
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
    `
	},
	{
		version: 9,
		name: "create_shift_decisions",
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
    `
	},
	{
		version: 10,
		name: "create_project_metadata",
		up: `
      CREATE TABLE IF NOT EXISTS project_metadata (
        project_hash TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        display_name TEXT,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `
	},
	{
		version: 11,
		name: "add_project_hash_to_graph_tables",
		up: (db) => {
			const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
			const columnExists = (table, column) => {
				return db.prepare(`PRAGMA table_info('${table}')`).all().some((c) => c.name === column);
			};
			if (tableExists("graph_nodes") && !columnExists("graph_nodes", "project_hash")) {
				db.exec("ALTER TABLE graph_nodes ADD COLUMN project_hash TEXT");
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
			if (tableExists("graph_edges") && !columnExists("graph_edges", "project_hash")) {
				db.exec("ALTER TABLE graph_edges ADD COLUMN project_hash TEXT");
				db.exec(`
          UPDATE graph_edges SET project_hash = (
            SELECT gn.project_hash FROM graph_nodes gn
            WHERE gn.id = graph_edges.source_id
          ) WHERE project_hash IS NULL
        `);
			}
			if (tableExists("graph_nodes")) db.exec("CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_hash)");
			if (tableExists("graph_edges")) db.exec("CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_hash)");
		}
	},
	{
		version: 12,
		name: "add_observation_classification",
		up: `
      ALTER TABLE observations ADD COLUMN classification TEXT;
      ALTER TABLE observations ADD COLUMN classified_at TEXT;
      CREATE INDEX idx_observations_classification
        ON observations(classification) WHERE classification IS NOT NULL;
    `
	},
	{
		version: 13,
		name: "create_research_buffer",
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
    `
	},
	{
		version: 14,
		name: "add_observation_kind",
		up: (db) => {
			db.exec("ALTER TABLE observations ADD COLUMN kind TEXT DEFAULT 'finding'");
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
			db.exec(`
        UPDATE observations
        SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE (source LIKE 'hook:Read' OR source LIKE 'hook:Glob' OR source LIKE 'hook:Grep')
          AND deleted_at IS NULL
      `);
			db.exec("CREATE INDEX idx_observations_kind ON observations(kind)");
		}
	},
	{
		version: 15,
		name: "update_graph_taxonomy",
		up: (db) => {
			const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
			if (!tableExists("graph_nodes")) return;
			db.exec("DELETE FROM graph_nodes WHERE type IN ('Tool', 'Person')");
			db.exec("DELETE FROM graph_edges WHERE type IN ('uses', 'depends_on', 'decided_by', 'part_of')");
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
		}
	},
	{
		version: 16,
		name: "create_tool_registry",
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
    `
	},
	{
		version: 17,
		name: "create_tool_usage_events",
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
    `
	},
	{
		version: 18,
		name: "create_tool_registry_search",
		up: (db) => {
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
			try {
				db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS tool_registry_embeddings USING vec0(
            tool_id INTEGER PRIMARY KEY,
            embedding float[384] distance_metric=cosine
          );
        `);
			} catch {}
		}
	},
	{
		version: 19,
		name: "add_tool_registry_status",
		up: `
      ALTER TABLE tool_registry ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      CREATE INDEX idx_tool_registry_status ON tool_registry(status);
    `
	}
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
function runMigrations(db, hasVectorSupport) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
	const maxVersion = db.prepare("SELECT COALESCE(MAX(version), 0) FROM _migrations").pluck().get();
	const insertMigration = db.prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)");
	const applyMigration = db.transaction((m) => {
		if (typeof m.up === "function") m.up(db);
		else db.exec(m.up);
		insertMigration.run(m.version, m.name);
	});
	for (const migration of MIGRATIONS) {
		if (migration.version <= maxVersion) continue;
		if ((migration.version === 4 || migration.version === 6) && !hasVectorSupport) continue;
		applyMigration(migration);
	}
}

//#endregion
//#region src/storage/database.ts
/**
* Opens a SQLite database with WAL mode, correct PRAGMA order,
* optional sqlite-vec extension loading, and schema migrations.
*
* Single connection per process by design -- better-sqlite3 is synchronous,
* so connection pooling adds zero benefit.
*
* @param config - Database path and busy timeout configuration
* @returns A configured LaminarkDatabase instance
*/
function openDatabase(config) {
	mkdirSync(dirname(config.dbPath), { recursive: true });
	const db = new Database(config.dbPath);
	const journalMode = db.pragma("journal_mode = WAL", { simple: true });
	if (journalMode !== "wal") console.warn(`WARNING: WAL mode not active (got '${journalMode}'). Database may be on a read-only filesystem or otherwise restricted.`);
	db.pragma(`busy_timeout = ${config.busyTimeout}`);
	db.pragma("synchronous = NORMAL");
	db.pragma("cache_size = -64000");
	db.pragma("foreign_keys = ON");
	db.pragma("temp_store = MEMORY");
	db.pragma("wal_autocheckpoint = 1000");
	debug("db", "PRAGMAs configured", {
		journalMode,
		busyTimeout: config.busyTimeout
	});
	let hasVectorSupport = false;
	try {
		sqliteVec.load(db);
		hasVectorSupport = true;
	} catch {}
	debug("db", hasVectorSupport ? "sqlite-vec loaded" : "sqlite-vec unavailable, keyword-only mode");
	runMigrations(db, hasVectorSupport);
	debug("db", "Database opened", {
		path: config.dbPath,
		hasVectorSupport
	});
	return {
		db,
		hasVectorSupport,
		close() {
			try {
				db.pragma("wal_checkpoint(PASSIVE)");
			} catch {}
			debug("db", "Database closed");
			db.close();
		},
		checkpoint() {
			db.pragma("wal_checkpoint(PASSIVE)");
		}
	};
}

//#endregion
//#region src/shared/types.ts
/**
* ObservationRow -- the raw database row shape.
* Uses snake_case to match SQL column names directly.
* rowid is INTEGER PRIMARY KEY AUTOINCREMENT for FTS5 content_rowid compatibility.
*/
const ObservationRowSchema = z.object({
	rowid: z.number(),
	id: z.string(),
	project_hash: z.string(),
	content: z.string(),
	title: z.string().nullable(),
	source: z.string(),
	session_id: z.string().nullable(),
	embedding: z.instanceof(Buffer).nullable(),
	embedding_model: z.string().nullable(),
	embedding_version: z.string().nullable(),
	kind: z.string().default("finding"),
	classification: z.string().nullable(),
	classified_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	deleted_at: z.string().nullable()
});
/**
* ObservationInsert -- input for creating observations.
* Validated at runtime via Zod schema.
*/
const ObservationInsertSchema = z.object({
	content: z.string().min(1).max(1e5),
	title: z.string().max(200).nullable().default(null),
	source: z.string().default("unknown"),
	kind: z.string().default("finding"),
	sessionId: z.string().nullable().default(null),
	embedding: z.instanceof(Float32Array).nullable().default(null),
	embeddingModel: z.string().nullable().default(null),
	embeddingVersion: z.string().nullable().default(null)
});
/**
* Maps a snake_case ObservationRow (from SQLite) to a camelCase Observation.
* Converts embedding Buffer to Float32Array for application use.
*/
function rowToObservation(row) {
	return {
		rowid: row.rowid,
		id: row.id,
		projectHash: row.project_hash,
		content: row.content,
		title: row.title,
		source: row.source,
		sessionId: row.session_id,
		kind: row.kind ?? "finding",
		embedding: row.embedding ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4) : null,
		embeddingModel: row.embedding_model,
		embeddingVersion: row.embedding_version,
		classification: row.classification,
		classifiedAt: row.classified_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deletedAt: row.deleted_at
	};
}

//#endregion
//#region src/storage/observations.ts
/**
* Repository for observation CRUD operations.
*
* Every query is scoped to the projectHash provided at construction time.
* Callers cannot accidentally query the wrong project -- project isolation
* is baked into every prepared statement.
*
* All SQL statements are prepared once in the constructor and reused for
* every call (better-sqlite3 performance best practice).
*/
var ObservationRepository = class {
	db;
	projectHash;
	stmtInsert;
	stmtGetById;
	stmtGetByIdIncludingDeleted;
	stmtSoftDelete;
	stmtRestore;
	stmtCount;
	constructor(db, projectHash) {
		this.db = db;
		this.projectHash = projectHash;
		this.stmtInsert = db.prepare(`
      INSERT INTO observations (id, project_hash, content, title, source, kind, session_id, embedding, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
		this.stmtGetById = db.prepare(`
      SELECT * FROM observations
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `);
		this.stmtGetByIdIncludingDeleted = db.prepare(`
      SELECT * FROM observations
      WHERE id = ? AND project_hash = ?
    `);
		this.stmtSoftDelete = db.prepare(`
      UPDATE observations
      SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `);
		this.stmtRestore = db.prepare(`
      UPDATE observations
      SET deleted_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `);
		this.stmtCount = db.prepare(`
      SELECT COUNT(*) AS count FROM observations
      WHERE project_hash = ? AND deleted_at IS NULL
    `);
		debug("obs", "ObservationRepository initialized", { projectHash });
	}
	/**
	* Creates a new observation scoped to this repository's project.
	* Validates input with Zod at runtime.
	*/
	create(input) {
		const validated = ObservationInsertSchema.parse(input);
		const id = randomBytes(16).toString("hex");
		const embeddingBuffer = validated.embedding ? Buffer.from(validated.embedding.buffer, validated.embedding.byteOffset, validated.embedding.byteLength) : null;
		debug("obs", "Creating observation", {
			source: validated.source,
			contentLength: validated.content.length
		});
		this.stmtInsert.run(id, this.projectHash, validated.content, validated.title, validated.source, validated.kind, validated.sessionId, embeddingBuffer, validated.embeddingModel, validated.embeddingVersion);
		const row = this.stmtGetById.get(id, this.projectHash);
		if (!row) throw new Error("Failed to retrieve newly created observation");
		debug("obs", "Observation created", { id });
		return rowToObservation(row);
	}
	/**
	* Gets an observation by ID, scoped to this project.
	* Returns null if not found or soft-deleted.
	*/
	getById(id) {
		const row = this.stmtGetById.get(id, this.projectHash);
		return row ? rowToObservation(row) : null;
	}
	/**
	* Lists observations for this project, ordered by created_at DESC.
	* Excludes soft-deleted observations.
	*/
	list(options) {
		debug("obs", "Listing observations", { ...options });
		const limit = options?.limit ?? 50;
		const offset = options?.offset ?? 0;
		const includeUnclassified = options?.includeUnclassified ?? false;
		let sql = "SELECT * FROM observations WHERE project_hash = ? AND deleted_at IS NULL";
		const params = [this.projectHash];
		if (!includeUnclassified) sql += " AND ((classification IS NOT NULL AND classification != 'noise') OR created_at >= datetime('now', '-60 seconds'))";
		if (options?.kind) {
			sql += " AND kind = ?";
			params.push(options.kind);
		}
		if (options?.sessionId) {
			sql += " AND session_id = ?";
			params.push(options.sessionId);
		}
		if (options?.since) {
			sql += " AND created_at >= ?";
			params.push(options.since);
		}
		sql += " ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?";
		params.push(limit, offset);
		const rows = this.db.prepare(sql).all(...params);
		debug("obs", "Listed observations", { count: rows.length });
		return rows.map(rowToObservation);
	}
	/**
	* Updates an observation's content, embedding fields, or both.
	* Always sets updated_at to current time.
	* Scoped to this project; returns null if not found or soft-deleted.
	*/
	update(id, updates) {
		debug("obs", "Updating observation", { id });
		const setClauses = ["updated_at = datetime('now')"];
		const params = [];
		if (updates.content !== void 0) {
			setClauses.push("content = ?");
			params.push(updates.content);
		}
		if (updates.embedding !== void 0) {
			setClauses.push("embedding = ?");
			params.push(updates.embedding ? Buffer.from(updates.embedding.buffer, updates.embedding.byteOffset, updates.embedding.byteLength) : null);
		}
		if (updates.embeddingModel !== void 0) {
			setClauses.push("embedding_model = ?");
			params.push(updates.embeddingModel);
		}
		if (updates.embeddingVersion !== void 0) {
			setClauses.push("embedding_version = ?");
			params.push(updates.embeddingVersion);
		}
		params.push(id, this.projectHash);
		const sql = `UPDATE observations SET ${setClauses.join(", ")} WHERE id = ? AND project_hash = ? AND deleted_at IS NULL`;
		if (this.db.prepare(sql).run(...params).changes === 0) {
			debug("obs", "Observation not found for update", { id });
			return null;
		}
		debug("obs", "Observation updated", { id });
		return this.getById(id);
	}
	/**
	* Soft-deletes an observation by setting deleted_at.
	* Returns true if the observation was found and deleted.
	*/
	softDelete(id) {
		debug("obs", "Soft-deleting observation", { id });
		const result = this.stmtSoftDelete.run(id, this.projectHash);
		debug("obs", result.changes > 0 ? "Observation soft-deleted" : "Observation not found for delete", { id });
		return result.changes > 0;
	}
	/**
	* Restores a soft-deleted observation by clearing deleted_at.
	* Returns true if the observation was found and restored.
	*/
	restore(id) {
		return this.stmtRestore.run(id, this.projectHash).changes > 0;
	}
	/**
	* Updates the classification of an observation.
	* Sets classified_at to current time. Returns true if found and updated.
	*/
	updateClassification(id, classification) {
		debug("obs", "Updating classification", {
			id,
			classification
		});
		return this.db.prepare(`
      UPDATE observations
      SET classification = ?, classified_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `).run(classification, id, this.projectHash).changes > 0;
	}
	/**
	* Creates an observation with an initial classification (bypasses classifier).
	* Used for explicit user saves that should be immediately visible.
	*/
	createClassified(input, classification) {
		const obs = this.create(input);
		this.updateClassification(obs.id, classification);
		return this.getById(obs.id);
	}
	/**
	* Fetches unclassified observations for the background classifier.
	* Returns observations ordered by created_at ASC (oldest first).
	*/
	listUnclassified(limit = 20) {
		return this.db.prepare(`
      SELECT * FROM observations
      WHERE project_hash = ? AND classification IS NULL AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all(this.projectHash, limit).map(rowToObservation);
	}
	/**
	* Fetches observations surrounding a given timestamp for classification context.
	* Returns observations regardless of classification status.
	*/
	listContext(aroundTime, windowSize = 5) {
		const beforeRows = this.db.prepare(`
      SELECT * FROM observations
      WHERE project_hash = ? AND deleted_at IS NULL AND created_at <= ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(this.projectHash, aroundTime, windowSize + 1);
		const afterRows = this.db.prepare(`
      SELECT * FROM observations
      WHERE project_hash = ? AND deleted_at IS NULL AND created_at > ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `).all(this.projectHash, aroundTime, windowSize);
		const allRows = [...beforeRows.reverse(), ...afterRows];
		const seen = /* @__PURE__ */ new Set();
		return allRows.filter((r) => {
			if (seen.has(r.id)) return false;
			seen.add(r.id);
			return true;
		}).map(rowToObservation);
	}
	/**
	* Counts non-deleted observations for this project.
	*/
	count() {
		return this.stmtCount.get(this.projectHash).count;
	}
	/**
	* Gets an observation by ID, including soft-deleted observations.
	* Used by the recall tool for restore operations (must find purged items).
	*/
	getByIdIncludingDeleted(id) {
		debug("obs", "Getting observation including deleted", { id });
		const row = this.stmtGetByIdIncludingDeleted.get(id, this.projectHash);
		return row ? rowToObservation(row) : null;
	}
	/**
	* Lists observations for this project, including soft-deleted ones.
	* Used by recall with include_purged: true to show all items.
	*/
	listIncludingDeleted(options) {
		const limit = options?.limit ?? 50;
		const offset = options?.offset ?? 0;
		debug("obs", "Listing observations including deleted", {
			limit,
			offset
		});
		const rows = this.db.prepare("SELECT * FROM observations WHERE project_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?").all(this.projectHash, limit, offset);
		debug("obs", "Listed observations including deleted", { count: rows.length });
		return rows.map(rowToObservation);
	}
	/**
	* Searches observations by title substring (partial match via LIKE).
	* Optionally includes soft-deleted items.
	*/
	getByTitle(title, options) {
		const limit = options?.limit ?? 20;
		const includePurged = options?.includePurged ?? false;
		debug("obs", "Searching by title", {
			title,
			limit,
			includePurged
		});
		let sql = "SELECT * FROM observations WHERE project_hash = ? AND title LIKE ?";
		if (!includePurged) sql += " AND deleted_at IS NULL";
		sql += " AND classification IS NOT NULL AND classification != 'noise'";
		sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?";
		const rows = this.db.prepare(sql).all(this.projectHash, `%${title}%`, limit);
		debug("obs", "Title search completed", { count: rows.length });
		return rows.map(rowToObservation);
	}
};

//#endregion
//#region src/storage/sessions.ts
/**
* Maps a snake_case SessionRow to a camelCase Session interface.
*/
function rowToSession(row) {
	return {
		id: row.id,
		projectHash: row.project_hash,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		summary: row.summary
	};
}
/**
* Repository for session lifecycle management.
*
* Every query is scoped to the projectHash provided at construction time.
* All SQL statements are prepared once in the constructor.
*/
var SessionRepository = class {
	db;
	projectHash;
	stmtCreate;
	stmtGetById;
	stmtGetActive;
	constructor(db, projectHash) {
		this.db = db;
		this.projectHash = projectHash;
		this.stmtCreate = db.prepare(`
      INSERT INTO sessions (id, project_hash)
      VALUES (?, ?)
    `);
		this.stmtGetById = db.prepare(`
      SELECT * FROM sessions
      WHERE id = ? AND project_hash = ?
    `);
		this.stmtGetActive = db.prepare(`
      SELECT * FROM sessions
      WHERE ended_at IS NULL AND project_hash = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
		debug("session", "SessionRepository initialized", { projectHash });
	}
	/**
	* Creates a new session with the given ID, scoped to this project.
	*/
	create(id) {
		this.stmtCreate.run(id, this.projectHash);
		const row = this.stmtGetById.get(id, this.projectHash);
		if (!row) throw new Error("Failed to retrieve newly created session");
		debug("session", "Session created", { id });
		return rowToSession(row);
	}
	/**
	* Ends a session by setting ended_at and optionally a summary.
	* Returns the updated session or null if not found.
	*/
	end(id, summary) {
		const setClauses = ["ended_at = datetime('now')"];
		const params = [];
		if (summary !== void 0) {
			setClauses.push("summary = ?");
			params.push(summary);
		}
		params.push(id, this.projectHash);
		const sql = `UPDATE sessions SET ${setClauses.join(", ")} WHERE id = ? AND project_hash = ?`;
		if (this.db.prepare(sql).run(...params).changes === 0) return null;
		debug("session", "Session ended", {
			id,
			hasSummary: !!summary
		});
		return this.getById(id);
	}
	/**
	* Gets a session by ID, scoped to this project.
	*/
	getById(id) {
		const row = this.stmtGetById.get(id, this.projectHash);
		return row ? rowToSession(row) : null;
	}
	/**
	* Gets the most recent sessions for this project, ordered by started_at DESC.
	*/
	getLatest(limit) {
		const effectiveLimit = limit ?? 10;
		return this.db.prepare(`SELECT * FROM sessions WHERE project_hash = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(this.projectHash, effectiveLimit).map(rowToSession);
	}
	/**
	* Gets the currently active (not ended) session for this project.
	* Returns the most recently started active session, or null if none.
	*/
	getActive() {
		const row = this.stmtGetActive.get(this.projectHash);
		return row ? rowToSession(row) : null;
	}
	/**
	* Updates the summary column on an existing session row.
	* Sets updated_at (via ended_at preservation) to track when the summary was written.
	*
	* Used by the curation module after compressing session observations.
	*/
	updateSessionSummary(sessionId, summary) {
		if (this.db.prepare(`UPDATE sessions SET summary = ? WHERE id = ? AND project_hash = ?`).run(summary, sessionId, this.projectHash).changes === 0) {
			debug("session", "Session not found for summary update", { sessionId });
			return;
		}
		debug("session", "Session summary updated", {
			sessionId,
			summaryLength: summary.length
		});
	}
};

//#endregion
//#region src/storage/search.ts
/**
* FTS5 search engine with BM25 ranking, snippet extraction, and strict project scoping.
*
* All queries are scoped to the projectHash provided at construction time.
* Queries are sanitized to prevent FTS5 syntax errors and injection.
*/
var SearchEngine = class {
	db;
	projectHash;
	constructor(db, projectHash) {
		this.db = db;
		this.projectHash = projectHash;
	}
	/**
	* Full-text search with BM25 ranking and snippet extraction.
	*
	* bm25() returns NEGATIVE values where more negative = more relevant.
	* ORDER BY rank (ascending) puts best matches first.
	*
	* @param query - User's search query (sanitized for FTS5 safety)
	* @param options - Optional limit and sessionId filter
	* @returns SearchResult[] ordered by relevance (best match first)
	*/
	searchKeyword(query, options) {
		const sanitized = this.sanitizeQuery(query);
		if (!sanitized) return [];
		const limit = options?.limit ?? 20;
		let sql = `
      SELECT
        o.*,
        bm25(observations_fts, 2.0, 1.0) AS rank,
        snippet(observations_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project_hash = ?
        AND o.deleted_at IS NULL
        AND (o.classification IS NULL OR o.classification != 'noise')
    `;
		const params = [sanitized, this.projectHash];
		if (options?.sessionId) {
			sql += " AND o.session_id = ?";
			params.push(options.sessionId);
		}
		sql += " ORDER BY rank LIMIT ?";
		params.push(limit);
		const results = debugTimed("search", "FTS5 keyword search", () => {
			return this.db.prepare(sql).all(...params).map((row) => ({
				observation: rowToObservation(row),
				score: Math.abs(row.rank),
				matchType: "fts",
				snippet: row.snippet
			}));
		});
		debug("search", "Keyword search completed", {
			query: sanitized,
			resultCount: results.length
		});
		return results;
	}
	/**
	* Prefix search for autocomplete-style matching.
	* Appends `*` to each word for prefix matching.
	*/
	searchByPrefix(prefix, limit) {
		const words = prefix.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return [];
		const sanitizedWords = words.map((w) => this.sanitizeWord(w)).filter(Boolean);
		if (sanitizedWords.length === 0) return [];
		const ftsQuery = sanitizedWords.map((w) => `${w}*`).join(" ");
		const effectiveLimit = limit ?? 20;
		const sql = `
      SELECT
        o.*,
        bm25(observations_fts, 2.0, 1.0) AS rank,
        snippet(observations_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project_hash = ?
        AND o.deleted_at IS NULL
        AND (o.classification IS NULL OR o.classification != 'noise')
      ORDER BY rank
      LIMIT ?
    `;
		const results = debugTimed("search", "FTS5 prefix search", () => {
			return this.db.prepare(sql).all(ftsQuery, this.projectHash, effectiveLimit).map((row) => ({
				observation: rowToObservation(row),
				score: Math.abs(row.rank),
				matchType: "fts",
				snippet: row.snippet
			}));
		});
		debug("search", "Prefix search completed", {
			prefix,
			resultCount: results.length
		});
		return results;
	}
	/**
	* Rebuild the FTS5 index if it gets out of sync.
	*/
	rebuildIndex() {
		debug("search", "Rebuilding FTS5 index");
		this.db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
	}
	/**
	* Sanitizes a user query for safe FTS5 MATCH usage.
	* Removes FTS5 operators and special characters.
	* Returns null if the query is empty after sanitization.
	*/
	sanitizeQuery(query) {
		const words = query.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return null;
		const sanitizedWords = words.map((w) => this.sanitizeWord(w)).filter(Boolean);
		if (sanitizedWords.length === 0) return null;
		return sanitizedWords.join(" ");
	}
	/**
	* Sanitizes a single word for FTS5 safety.
	* Removes quotes, parentheses, asterisks, and FTS5 operator keywords.
	*/
	sanitizeWord(word) {
		let cleaned = word.replace(/["*()^{}[\]]/g, "");
		if (/^(NEAR|OR|AND|NOT)$/i.test(cleaned)) return "";
		cleaned = cleaned.replace(/[^\w\-]/g, "");
		return cleaned;
	}
};

//#endregion
//#region src/search/hybrid.ts
/**
* Hybrid search combining FTS5 keyword results and vec0 vector results
* using reciprocal rank fusion (RRF).
*
* When both keyword and vector results are available, RRF merges the two
* ranked lists into a single score-sorted list. When only keyword results
* are available (worker not ready, no embeddings), falls back transparently.
*/
/**
* Merges multiple ranked lists into a single fused ranking using RRF.
*
* For each document across all lists, computes:
*   fusedScore = sum(1 / (k + rank + 1))
* where rank is the 0-based position in each list.
*
* @param rankedLists - Arrays of ranked items, each with an `id` field
* @param k - Smoothing constant (default 60, standard RRF value)
* @returns Fused results sorted by fusedScore descending
*/
function reciprocalRankFusion(rankedLists, k = 60) {
	const scores = /* @__PURE__ */ new Map();
	for (const list of rankedLists) for (let rank = 0; rank < list.length; rank++) {
		const item = list[rank];
		const current = scores.get(item.id) ?? 0;
		scores.set(item.id, current + 1 / (k + rank + 1));
	}
	const results = [];
	for (const [id, fusedScore] of scores) results.push({
		id,
		fusedScore
	});
	results.sort((a, b) => b.fusedScore - a.fusedScore);
	return results;
}
/**
* Combines FTS5 keyword search and vec0 vector search using RRF.
*
* Falls back to keyword-only when:
* - Worker is null or not ready
* - Query embedding fails
* - No vector results returned
*
* @returns SearchResult[] with matchType indicating source(s)
*/
async function hybridSearch(params) {
	const { searchEngine, embeddingStore, worker, query, db, projectHash, options } = params;
	const limit = options?.limit ?? 20;
	return debugTimed("search", "Hybrid search", async () => {
		const keywordResults = searchEngine.searchKeyword(query, {
			limit,
			sessionId: options?.sessionId
		});
		debug("search", "Keyword results", { count: keywordResults.length });
		let vectorResults = [];
		if (worker && worker.isReady()) {
			const queryEmbedding = await worker.embed(query);
			if (queryEmbedding) {
				vectorResults = embeddingStore.search(queryEmbedding, limit * 2);
				debug("search", "Vector results", { count: vectorResults.length });
			} else debug("search", "Query embedding failed, keyword-only");
		} else debug("search", "Worker not ready, keyword-only");
		if (vectorResults.length === 0) {
			debug("search", "Returning keyword-only results", { count: keywordResults.length });
			return keywordResults;
		}
		const fused = reciprocalRankFusion([keywordResults.map((r) => ({ id: r.observation.id })), vectorResults.map((r) => ({ id: r.observationId }))]);
		const keywordMap = /* @__PURE__ */ new Map();
		for (const r of keywordResults) keywordMap.set(r.observation.id, r);
		const vectorIdSet = new Set(vectorResults.map((r) => r.observationId));
		const obsRepo = new ObservationRepository(db, projectHash);
		const merged = [];
		for (const item of fused) {
			if (merged.length >= limit) break;
			const fromKeyword = keywordMap.get(item.id);
			const fromVector = vectorIdSet.has(item.id);
			if (fromKeyword && fromVector) merged.push({
				observation: fromKeyword.observation,
				score: item.fusedScore,
				matchType: "hybrid",
				snippet: fromKeyword.snippet
			});
			else if (fromKeyword) merged.push({
				observation: fromKeyword.observation,
				score: item.fusedScore,
				matchType: "fts",
				snippet: fromKeyword.snippet
			});
			else if (fromVector) {
				const obs = obsRepo.getById(item.id);
				if (obs) {
					const snippet = (obs.content ?? "").replace(/\n/g, " ").slice(0, 100);
					merged.push({
						observation: obs,
						score: item.fusedScore,
						matchType: "vector",
						snippet
					});
				}
			}
		}
		debug("search", "Hybrid search complete", {
			keyword: keywordResults.length,
			vector: vectorResults.length,
			fused: merged.length,
			hybrid: merged.filter((r) => r.matchType === "hybrid").length
		});
		return merged;
	});
}

//#endregion
//#region src/shared/similarity.ts
/**
* Text similarity utilities shared across modules.
*/
/**
* Computes Jaccard similarity between two texts based on tokenized words.
* Words are lowercased and split on whitespace/punctuation.
*/
function jaccardSimilarity(textA, textB) {
	const tokenize = (t) => new Set(t.toLowerCase().split(/[\s,.!?;:'"()\[\]{}<>\/\\|@#$%^&*+=~`]+/).filter((w) => w.length > 0));
	const setA = tokenize(textA);
	const setB = tokenize(textB);
	if (setA.size === 0 && setB.size === 0) return 1;
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const w of setA) if (setB.has(w)) intersection++;
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

//#endregion
//#region src/hooks/save-guard.ts
var SaveGuard = class {
	obsRepo;
	worker;
	embeddingStore;
	duplicateThreshold;
	vectorDistanceThreshold;
	recentWindow;
	/**
	* Construct from db + projectHash (creates internal ObservationRepository),
	* or from an existing ObservationRepository.
	*/
	constructor(dbOrRepo, projectHashOrOpts, opts) {
		if (dbOrRepo instanceof ObservationRepository) {
			this.obsRepo = dbOrRepo;
			const resolvedOpts = projectHashOrOpts ?? {};
			this.worker = resolvedOpts.worker ?? null;
			this.embeddingStore = resolvedOpts.embeddingStore ?? null;
			this.duplicateThreshold = resolvedOpts.duplicateThreshold ?? .85;
			this.vectorDistanceThreshold = resolvedOpts.vectorDistanceThreshold ?? .08;
			this.recentWindow = resolvedOpts.recentWindow ?? 20;
		} else {
			this.obsRepo = new ObservationRepository(dbOrRepo, projectHashOrOpts);
			this.worker = opts?.worker ?? null;
			this.embeddingStore = opts?.embeddingStore ?? null;
			this.duplicateThreshold = opts?.duplicateThreshold ?? .85;
			this.vectorDistanceThreshold = opts?.vectorDistanceThreshold ?? .08;
			this.recentWindow = opts?.recentWindow ?? 20;
		}
	}
	/**
	* Synchronous evaluation for the hook path (text-only, no embeddings).
	* Only checks for duplicates — relevance is handled by the background classifier.
	*/
	evaluateSync(content, _source) {
		const dupResult = this.checkTextDuplicates(content);
		if (dupResult) return dupResult;
		return {
			save: true,
			reason: "ok"
		};
	}
	/**
	* Async evaluation for the MCP path (embeddings + text fallback).
	* Only checks for duplicates — relevance is handled by the background classifier.
	*/
	async evaluate(content, _source) {
		if (this.worker?.isReady() && this.embeddingStore) {
			const embedding = await this.worker.embed(content);
			if (embedding) {
				const results = this.embeddingStore.search(embedding, 5);
				for (const result of results) if (result.distance < this.vectorDistanceThreshold) {
					debug("save-guard", "Vector duplicate detected", {
						distance: result.distance,
						duplicateOf: result.observationId
					});
					return {
						save: false,
						reason: "duplicate",
						duplicateOf: result.observationId
					};
				}
			}
		}
		const dupResult = this.checkTextDuplicates(content);
		if (dupResult) return dupResult;
		return {
			save: true,
			reason: "ok"
		};
	}
	checkTextDuplicates(content) {
		const recent = this.obsRepo.list({
			limit: this.recentWindow,
			includeUnclassified: true
		});
		for (const obs of recent) {
			const sim = jaccardSimilarity(content, obs.content);
			if (sim >= this.duplicateThreshold) {
				debug("save-guard", "Text duplicate detected", {
					similarity: sim,
					duplicateOf: obs.id
				});
				return {
					save: false,
					reason: "duplicate",
					duplicateOf: obs.id
				};
			}
		}
		return null;
	}
};

//#endregion
//#region src/graph/migrations/001-graph-tables.ts
/**
* Migration 001: Create graph_nodes and graph_edges tables.
*
* Graph tables are managed separately from the main observation/session tables
* because the knowledge graph is a distinct subsystem that operates
* on extracted entities rather than raw observations.
*
* Tables:
*   - graph_nodes: entities with type-checked taxonomy (6 types)
*   - graph_edges: directed relationships with type-checked taxonomy (8 types),
*     weight confidence, and unique constraint on (source_id, target_id, type)
*
* Indexes:
*   - Nodes: type, name
*   - Edges: source_id, target_id, type, unique(source_id, target_id, type)
*/
const up = `
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('Project','File','Decision','Problem','Solution','Reference')),
    name TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    observation_ids TEXT DEFAULT '[]',
    project_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('related_to','solved_by','caused_by','modifies','informed_by','references','verified_by','preceded_by')),
    weight REAL NOT NULL DEFAULT 1.0 CHECK(weight >= 0.0 AND weight <= 1.0),
    metadata TEXT DEFAULT '{}',
    project_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique ON graph_edges(source_id, target_id, type);
`;

//#endregion
//#region src/graph/schema.ts
function rowToNode(row) {
	return {
		id: row.id,
		type: row.type,
		name: row.name,
		metadata: JSON.parse(row.metadata),
		observation_ids: JSON.parse(row.observation_ids),
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}
function rowToEdge(row) {
	return {
		id: row.id,
		source_id: row.source_id,
		target_id: row.target_id,
		type: row.type,
		weight: row.weight,
		metadata: JSON.parse(row.metadata),
		created_at: row.created_at
	};
}
/**
* Initializes graph tables if they do not exist.
* Uses CREATE TABLE IF NOT EXISTS so it is safe to call multiple times.
*/
function initGraphSchema(db) {
	db.exec(up);
}
/**
* Traverses the graph from a starting node using a recursive CTE.
*
* Supports directional traversal:
*   - 'outgoing': follows edges where source_id matches (default)
*   - 'incoming': follows edges where target_id matches
*   - 'both': follows edges in either direction
*
* Returns nodes and the edges that connect them, up to the specified depth.
* The starting node itself is NOT included in results (depth > 0 filter).
*
* @param db - better-sqlite3 Database handle
* @param nodeId - starting node ID
* @param opts - traversal options (depth, edgeTypes, direction)
* @returns Array of { node, edge, depth } for each reachable node
*/
function traverseFrom(db, nodeId, opts = {}) {
	const maxDepth = opts.depth ?? 2;
	const direction = opts.direction ?? "outgoing";
	let edgeTypeFilter = "";
	if (opts.edgeTypes && opts.edgeTypes.length > 0) edgeTypeFilter = `AND e.type IN (${opts.edgeTypes.map(() => "?").join(", ")})`;
	let recursiveStep;
	if (direction === "outgoing") recursiveStep = `
      SELECT e.target_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.source_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
    `;
	else if (direction === "incoming") recursiveStep = `
      SELECT e.source_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.target_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
    `;
	else recursiveStep = `
      SELECT e.target_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.source_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
      UNION ALL
      SELECT e.source_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.target_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
    `;
	const sql = `
    WITH RECURSIVE traverse(node_id, depth, edge_id) AS (
      SELECT ?, 0, NULL
      UNION ALL
      ${recursiveStep}
    )
    SELECT DISTINCT
      n.id AS n_id, n.type AS n_type, n.name AS n_name,
      n.metadata AS n_metadata, n.observation_ids AS n_observation_ids,
      n.created_at AS n_created_at, n.updated_at AS n_updated_at,
      e.id AS e_id, e.source_id AS e_source_id, e.target_id AS e_target_id,
      e.type AS e_type, e.weight AS e_weight, e.metadata AS e_metadata,
      e.created_at AS e_created_at,
      t.depth
    FROM traverse t
    JOIN graph_nodes n ON n.id = t.node_id
    LEFT JOIN graph_edges e ON e.id = t.edge_id
    WHERE t.depth > 0
  `;
	const queryParams = [nodeId];
	if (direction === "both") {
		queryParams.push(maxDepth);
		if (opts.edgeTypes) queryParams.push(...opts.edgeTypes);
		queryParams.push(maxDepth);
		if (opts.edgeTypes) queryParams.push(...opts.edgeTypes);
	} else {
		queryParams.push(maxDepth);
		if (opts.edgeTypes) queryParams.push(...opts.edgeTypes);
	}
	return db.prepare(sql).all(...queryParams).map((row) => ({
		node: {
			id: row.n_id,
			type: row.n_type,
			name: row.n_name,
			metadata: JSON.parse(row.n_metadata),
			observation_ids: JSON.parse(row.n_observation_ids),
			created_at: row.n_created_at,
			updated_at: row.n_updated_at
		},
		edge: row.e_id ? {
			id: row.e_id,
			source_id: row.e_source_id,
			target_id: row.e_target_id,
			type: row.e_type,
			weight: row.e_weight,
			metadata: JSON.parse(row.e_metadata),
			created_at: row.e_created_at
		} : null,
		depth: row.depth
	}));
}
/**
* Returns all nodes of a given entity type.
*/
function getNodesByType(db, type) {
	return db.prepare("SELECT * FROM graph_nodes WHERE type = ?").all(type).map(rowToNode);
}
/**
* Looks up a node by name and type (composite natural key).
* Returns null if no matching node exists.
*/
function getNodeByNameAndType(db, name, type) {
	const row = db.prepare("SELECT * FROM graph_nodes WHERE name = ? AND type = ?").get(name, type);
	return row ? rowToNode(row) : null;
}
/**
* Returns edges connected to a node, filtered by direction.
*
* @param direction - 'outgoing' (source), 'incoming' (target), or 'both' (default: 'both')
*/
function getEdgesForNode(db, nodeId, opts) {
	const direction = opts?.direction ?? "both";
	let sql;
	let params;
	if (direction === "outgoing") {
		sql = "SELECT * FROM graph_edges WHERE source_id = ?";
		params = [nodeId];
	} else if (direction === "incoming") {
		sql = "SELECT * FROM graph_edges WHERE target_id = ?";
		params = [nodeId];
	} else {
		sql = "SELECT * FROM graph_edges WHERE source_id = ? OR target_id = ?";
		params = [nodeId, nodeId];
	}
	return db.prepare(sql).all(...params).map(rowToEdge);
}
/**
* Returns the total number of edges connected to a node (both directions).
* Used for degree enforcement (MAX_NODE_DEGREE constraint).
*/
function countEdgesForNode(db, nodeId) {
	return db.prepare("SELECT COUNT(*) as cnt FROM graph_edges WHERE source_id = ? OR target_id = ?").get(nodeId, nodeId).cnt;
}
/**
* Inserts or updates a node by name+type composite key.
*
* If a node with the same name and type already exists, updates its metadata
* and merges observation_ids. Otherwise, inserts a new node with a generated UUID.
*
* @returns The upserted GraphNode
*/
function upsertNode(db, node) {
	const existing = getNodeByNameAndType(db, node.name, node.type);
	if (existing) {
		const mergedObsIds = [...new Set([...existing.observation_ids, ...node.observation_ids])];
		const mergedMetadata = {
			...existing.metadata,
			...node.metadata
		};
		db.prepare(`UPDATE graph_nodes
       SET metadata = ?, observation_ids = ?, updated_at = datetime('now')
       WHERE id = ?`).run(JSON.stringify(mergedMetadata), JSON.stringify(mergedObsIds), existing.id);
		return rowToNode(db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(existing.id));
	}
	const id = node.id ?? randomBytes(16).toString("hex");
	db.prepare(`INSERT INTO graph_nodes (id, type, name, metadata, observation_ids, project_hash)
     VALUES (?, ?, ?, ?, ?, ?)`).run(id, node.type, node.name, JSON.stringify(node.metadata), JSON.stringify(node.observation_ids), node.project_hash ?? null);
	return rowToNode(db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id));
}
/**
* Inserts an edge. On conflict (same source_id, target_id, type),
* updates the weight to the maximum of existing and new values.
*
* @returns The inserted or updated GraphEdge
*/
function insertEdge(db, edge) {
	const id = edge.id ?? randomBytes(16).toString("hex");
	db.prepare(`INSERT INTO graph_edges (id, source_id, target_id, type, weight, metadata, project_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, target_id, type) DO UPDATE SET
       weight = MAX(graph_edges.weight, excluded.weight),
       metadata = excluded.metadata`).run(id, edge.source_id, edge.target_id, edge.type, edge.weight, JSON.stringify(edge.metadata), edge.project_hash ?? null);
	return rowToEdge(db.prepare("SELECT * FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?").get(edge.source_id, edge.target_id, edge.type));
}

//#endregion
//#region src/hooks/tool-name-parser.ts
/**
* Infers the tool type from a tool name seen in PostToolUse.
*
* - MCP tools have the `mcp__` prefix
* - Built-in tools are PascalCase single words (Write, Edit, Bash, Read, etc.)
* - Anything else is unknown
*/
function inferToolType(toolName) {
	if (toolName.startsWith("mcp__")) return "mcp_tool";
	if (/^[A-Z][a-zA-Z]+$/.test(toolName)) return "builtin";
	return "unknown";
}
/**
* Infers the scope of a tool from its name.
*
* - Plugin MCP tools (mcp__plugin_*) are plugin-scoped
* - Other MCP tools default to project-scoped (conservative; may be global but unknown from name alone)
* - Non-MCP tools (builtins) are always global
*/
function inferScope(toolName) {
	if (toolName.startsWith("mcp__plugin_")) return "plugin";
	if (toolName.startsWith("mcp__")) return "project";
	return "global";
}
/**
* Extracts the MCP server name from a tool name.
*
* Plugin MCP tools: `mcp__plugin_<pluginName>_<serverName>__<tool>`
*   Example: `mcp__plugin_laminark_laminark__recall` -> server is `laminark`
*
* Project MCP tools: `mcp__<serverName>__<tool>`
*   Example: `mcp__playwright__browser_screenshot` -> server is `playwright`
*
* Returns null for non-MCP tools.
*/
function extractServerName(toolName) {
	const pluginMatch = toolName.match(/^mcp__plugin_([^_]+(?:_[^_]+)*)_([^_]+(?:_[^_]+)*)__/);
	if (pluginMatch) return pluginMatch[2];
	const projectMatch = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
	if (projectMatch) return projectMatch[1];
	return null;
}

//#endregion
//#region src/storage/research-buffer.ts
/**
* Lightweight buffer for exploration tool events (Read, Glob, Grep).
*
* Instead of creating full observations for these low-signal tools,
* they are stored in a temporary buffer. When a Write/Edit observation
* is created, the recent buffer entries are attached as research context,
* creating provenance links between exploration and changes.
*
* Buffer entries are flushed after 30 minutes.
*/
var ResearchBufferRepository = class {
	db;
	projectHash;
	stmtInsert;
	stmtGetRecent;
	stmtFlush;
	constructor(db, projectHash) {
		this.db = db;
		this.projectHash = projectHash;
		this.stmtInsert = db.prepare(`
      INSERT INTO research_buffer (project_hash, session_id, tool_name, target)
      VALUES (?, ?, ?, ?)
    `);
		this.stmtGetRecent = db.prepare(`
      SELECT tool_name, target, created_at FROM research_buffer
      WHERE session_id = ? AND project_hash = ?
        AND created_at >= datetime('now', '-' || ? || ' minutes')
      ORDER BY created_at DESC
    `);
		this.stmtFlush = db.prepare(`
      DELETE FROM research_buffer
      WHERE created_at < datetime('now', '-' || ? || ' minutes')
    `);
		debug("research-buffer", "ResearchBufferRepository initialized", { projectHash });
	}
	/**
	* Records a research tool event in the buffer.
	*/
	add(entry) {
		this.stmtInsert.run(this.projectHash, entry.sessionId, entry.toolName, entry.target);
		debug("research-buffer", "Buffered research event", {
			tool: entry.toolName,
			target: entry.target
		});
	}
	/**
	* Returns recent buffer entries for a session within a time window.
	*/
	getRecent(sessionId, windowMinutes = 5) {
		return this.stmtGetRecent.all(sessionId, this.projectHash, windowMinutes).map((r) => ({
			toolName: r.tool_name,
			target: r.target,
			createdAt: r.created_at
		}));
	}
	/**
	* Deletes buffer entries older than the specified number of minutes.
	*/
	flush(olderThanMinutes = 30) {
		const result = this.stmtFlush.run(olderThanMinutes);
		if (result.changes > 0) debug("research-buffer", "Flushed old entries", { deleted: result.changes });
		return result.changes;
	}
};

//#endregion
//#region src/storage/notifications.ts
var NotificationStore = class {
	stmtInsert;
	stmtConsume;
	stmtSelect;
	constructor(db) {
		db.exec(`
      CREATE TABLE IF NOT EXISTS pending_notifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
		this.stmtInsert = db.prepare("INSERT INTO pending_notifications (id, project_id, message) VALUES (?, ?, ?)");
		this.stmtSelect = db.prepare("SELECT * FROM pending_notifications WHERE project_id = ? ORDER BY created_at ASC LIMIT 10");
		this.stmtConsume = db.prepare("DELETE FROM pending_notifications WHERE project_id = ?");
		debug("db", "NotificationStore initialized");
	}
	add(projectId, message) {
		const id = randomBytes(16).toString("hex");
		this.stmtInsert.run(id, projectId, message);
		debug("db", "Notification added", { projectId });
	}
	/** Fetch and delete all pending notifications for a project (consume pattern). */
	consumePending(projectId) {
		const rows = this.stmtSelect.all(projectId);
		if (rows.length > 0) this.stmtConsume.run(projectId);
		return rows.map((r) => ({
			id: r.id,
			projectId: r.project_id,
			message: r.message,
			createdAt: r.created_at
		}));
	}
};

//#endregion
//#region src/storage/tool-registry.ts
/**
* Repository for tool registry CRUD operations.
*
* Unlike ObservationRepository, this is NOT scoped to a single project --
* the tool registry spans all scopes (global, project, plugin) and is
* queried cross-project for tool discovery and routing.
*
* All SQL statements are prepared once in the constructor and reused for
* every call (better-sqlite3 performance best practice).
*/
var ToolRegistryRepository = class {
	db;
	stmtUpsert;
	stmtRecordUsage;
	stmtGetByScope;
	stmtGetByName;
	stmtGetAll;
	stmtCount;
	stmtGetAvailableForSession;
	stmtInsertEvent;
	stmtGetUsageForTool;
	stmtGetUsageForSession;
	stmtGetUsageSince;
	stmtGetRecentUsage;
	stmtMarkStale;
	stmtMarkDemoted;
	stmtMarkActive;
	stmtGetConfigSourced;
	stmtGetRecentEventsForTool;
	constructor(db) {
		this.db = db;
		try {
			this.stmtUpsert = db.prepare(`
        INSERT INTO tool_registry (name, tool_type, scope, source, project_hash, description, server_name, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (name, COALESCE(project_hash, ''))
        DO UPDATE SET
          description = COALESCE(excluded.description, tool_registry.description),
          source = excluded.source,
          status = 'active',
          updated_at = datetime('now')
      `);
			this.stmtRecordUsage = db.prepare(`
        UPDATE tool_registry
        SET usage_count = usage_count + 1,
            last_used_at = datetime('now'),
            updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
      `);
			this.stmtGetByScope = db.prepare(`
        SELECT * FROM tool_registry
        WHERE scope = 'global' OR project_hash = ?
        ORDER BY usage_count DESC, discovered_at DESC
      `);
			this.stmtGetByName = db.prepare(`
        SELECT * FROM tool_registry
        WHERE name = ?
        ORDER BY usage_count DESC
        LIMIT 1
      `);
			this.stmtGetAll = db.prepare(`
        SELECT * FROM tool_registry
        ORDER BY usage_count DESC, discovered_at DESC
      `);
			this.stmtCount = db.prepare(`
        SELECT COUNT(*) AS count FROM tool_registry
      `);
			this.stmtGetAvailableForSession = db.prepare(`
        SELECT * FROM tool_registry
        WHERE
          scope = 'global'
          OR (scope = 'project' AND project_hash = ?)
          OR (scope = 'plugin' AND (project_hash IS NULL OR project_hash = ?))
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'stale' THEN 1
            WHEN 'demoted' THEN 2
            ELSE 3
          END,
          CASE tool_type
            WHEN 'mcp_server' THEN 0
            WHEN 'slash_command' THEN 1
            WHEN 'skill' THEN 2
            WHEN 'plugin' THEN 3
            ELSE 4
          END,
          usage_count DESC,
          discovered_at DESC
      `);
			this.stmtInsertEvent = db.prepare(`
        INSERT INTO tool_usage_events (tool_name, session_id, project_hash, success)
        VALUES (?, ?, ?, ?)
      `);
			this.stmtGetUsageForTool = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM tool_usage_events
        WHERE tool_name = ? AND project_hash = ?
          AND created_at >= datetime('now', ?)
        GROUP BY tool_name
      `);
			this.stmtGetUsageForSession = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM tool_usage_events
        WHERE session_id = ?
        GROUP BY tool_name
        ORDER BY usage_count DESC
      `);
			this.stmtGetUsageSince = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM tool_usage_events
        WHERE project_hash = ?
          AND created_at >= datetime('now', ?)
        GROUP BY tool_name
        ORDER BY usage_count DESC
      `);
			this.stmtGetRecentUsage = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM (
          SELECT tool_name, created_at
          FROM tool_usage_events
          WHERE project_hash = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
        GROUP BY tool_name
        ORDER BY usage_count DESC
      `);
			this.stmtMarkStale = db.prepare(`
        UPDATE tool_registry
        SET status = 'stale', updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
          AND status != 'stale'
      `);
			this.stmtMarkDemoted = db.prepare(`
        UPDATE tool_registry
        SET status = 'demoted', updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
      `);
			this.stmtMarkActive = db.prepare(`
        UPDATE tool_registry
        SET status = 'active', updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
          AND status != 'active'
      `);
			this.stmtGetConfigSourced = db.prepare(`
        SELECT * FROM tool_registry
        WHERE source LIKE 'config:%'
          AND status = 'active'
          AND (project_hash = ? OR project_hash IS NULL)
      `);
			this.stmtGetRecentEventsForTool = db.prepare(`
        SELECT success FROM tool_usage_events
        WHERE tool_name = ? AND project_hash = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
			debug("tool-registry", "ToolRegistryRepository initialized");
		} catch (err) {
			throw err;
		}
	}
	/**
	* Inserts or updates a discovered tool in the registry.
	* On conflict (same name + project_hash), updates description and source.
	*/
	upsert(tool) {
		try {
			this.stmtUpsert.run(tool.name, tool.toolType, tool.scope, tool.source, tool.projectHash, tool.description, tool.serverName);
			debug("tool-registry", "Upserted tool", {
				name: tool.name,
				scope: tool.scope
			});
		} catch (err) {
			debug("tool-registry", "Failed to upsert tool", {
				name: tool.name,
				error: String(err)
			});
		}
	}
	/**
	* Increments usage_count and updates last_used_at for a tool.
	* Called from organic PostToolUse discovery to track usage.
	*/
	recordUsage(name, projectHash) {
		try {
			this.stmtRecordUsage.run(name, projectHash);
			debug("tool-registry", "Recorded usage", { name });
		} catch (err) {
			debug("tool-registry", "Failed to record usage", {
				name,
				error: String(err)
			});
		}
	}
	/**
	* Records usage for an existing tool, or creates it if not yet in the registry.
	* This is the entry point for organic discovery -- an upsert-and-increment-if-exists pattern.
	*
	* First tries recordUsage. If the tool is not in the registry (changes === 0),
	* calls upsert with the full tool info, which initializes it with usage_count = 0.
	*/
	recordOrCreate(name, defaults, sessionId, success) {
		try {
			const result = this.stmtRecordUsage.run(name, defaults.projectHash);
			if (result.changes === 0) this.upsert({
				name,
				...defaults
			});
			if (sessionId !== void 0) this.stmtInsertEvent.run(name, sessionId, defaults.projectHash, success === false ? 0 : 1);
			debug("tool-registry", "recordOrCreate completed", {
				name,
				created: result.changes === 0
			});
		} catch (err) {
			debug("tool-registry", "Failed recordOrCreate", {
				name,
				error: String(err)
			});
		}
	}
	/**
	* Returns global tools plus project-specific tools for the given project.
	*/
	getForProject(projectHash) {
		return this.stmtGetByScope.all(projectHash);
	}
	/**
	* Returns tools available in the resolved scope for a given project.
	* Implements SCOP-01/SCOP-02/SCOP-03 scope resolution rules.
	*/
	getAvailableForSession(projectHash) {
		return this.stmtGetAvailableForSession.all(projectHash, projectHash);
	}
	/**
	* Returns the top-usage entry for a given tool name.
	*/
	getByName(name) {
		return this.stmtGetByName.get(name) ?? null;
	}
	/**
	* Returns all tools in the registry (for debugging/admin).
	*/
	getAll() {
		return this.stmtGetAll.all();
	}
	/**
	* Returns total number of tools in the registry.
	*/
	count() {
		return this.stmtCount.get().count;
	}
	/**
	* Returns usage stats for a specific tool within a time window.
	* @param timeModifier - SQLite datetime modifier, e.g., '-7 days', '-30 days'
	*/
	getUsageForTool(toolName, projectHash, timeModifier = "-7 days") {
		return this.stmtGetUsageForTool.get(toolName, projectHash, timeModifier) ?? null;
	}
	/**
	* Returns per-tool usage stats for a specific session.
	*/
	getUsageForSession(sessionId) {
		return this.stmtGetUsageForSession.all(sessionId);
	}
	/**
	* Returns per-tool usage stats since a time offset for a project.
	* @param timeModifier - SQLite datetime modifier, e.g., '-7 days', '-30 days'
	*/
	getUsageSince(projectHash, timeModifier = "-7 days") {
		return this.stmtGetUsageSince.all(projectHash, timeModifier);
	}
	/**
	* Returns per-tool usage stats from the last N events for a project.
	* Event-count-based window instead of time-based — immune to usage gaps.
	* @param limit - Number of recent events to consider (default 200)
	*/
	getRecentUsage(projectHash, limit = 200) {
		return this.stmtGetRecentUsage.all(projectHash, limit);
	}
	/**
	* Marks a tool as stale (no longer in config but still in registry).
	* Idempotent -- no-op if already stale.
	*/
	markStale(name, projectHash) {
		try {
			this.stmtMarkStale.run(name, projectHash);
			debug("tool-registry", "Marked tool stale", { name });
		} catch (err) {
			debug("tool-registry", "Failed to mark tool stale", {
				name,
				error: String(err)
			});
		}
	}
	/**
	* Marks a tool as demoted (high failure rate detected).
	*/
	markDemoted(name, projectHash) {
		try {
			this.stmtMarkDemoted.run(name, projectHash);
			debug("tool-registry", "Marked tool demoted", { name });
		} catch (err) {
			debug("tool-registry", "Failed to mark tool demoted", {
				name,
				error: String(err)
			});
		}
	}
	/**
	* Marks a tool as active (restored from stale/demoted).
	* Idempotent -- no-op if already active.
	*/
	markActive(name, projectHash) {
		try {
			this.stmtMarkActive.run(name, projectHash);
			debug("tool-registry", "Marked tool active", { name });
		} catch (err) {
			debug("tool-registry", "Failed to mark tool active", {
				name,
				error: String(err)
			});
		}
	}
	/**
	* Returns all config-sourced active tools for a given project (or global).
	* Used by staleness detection to compare against current config state.
	*/
	getConfigSourcedTools(projectHash) {
		try {
			return this.stmtGetConfigSourced.all(projectHash);
		} catch (err) {
			debug("tool-registry", "Failed to get config-sourced tools", { error: String(err) });
			return [];
		}
	}
	/**
	* Returns recent success/failure events for a specific tool.
	* Used by failure-driven demotion to check failure rate.
	* @param limit - Number of recent events to check (default 5)
	*/
	getRecentEventsForTool(toolName, projectHash, limit = 5) {
		try {
			return this.stmtGetRecentEventsForTool.all(toolName, projectHash, limit);
		} catch (err) {
			debug("tool-registry", "Failed to get recent events for tool", {
				toolName,
				error: String(err)
			});
			return [];
		}
	}
	/**
	* Sanitizes a user query for safe FTS5 MATCH usage.
	* Removes FTS5 operators and special characters to prevent syntax errors.
	* Returns null if the query is empty after sanitization.
	*/
	sanitizeQuery(query) {
		const words = query.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return null;
		const sanitized = words.map((w) => {
			let cleaned = w.replace(/["*()^{}[\]]/g, "");
			if (/^(NEAR|OR|AND|NOT)$/i.test(cleaned)) return "";
			cleaned = cleaned.replace(/[^\w\-]/g, "");
			return cleaned;
		}).filter(Boolean);
		if (sanitized.length === 0) return null;
		return sanitized.join(" ");
	}
	/**
	* FTS5 keyword search on tool_registry_fts (name + description).
	* Returns ranked results using BM25 with name weighted 2x over description.
	*/
	searchByKeyword(query, options) {
		const sanitized = this.sanitizeQuery(query);
		if (!sanitized) return [];
		const limit = options?.limit ?? 20;
		let sql = `
      SELECT tr.*, bm25(tool_registry_fts, 2.0, 1.0) AS rank
      FROM tool_registry_fts
      JOIN tool_registry tr ON tr.id = tool_registry_fts.rowid
      WHERE tool_registry_fts MATCH ?
    `;
		const params = [sanitized];
		if (options?.scope) {
			sql += " AND tr.scope = ?";
			params.push(options.scope);
		}
		sql += " ORDER BY rank LIMIT ?";
		params.push(limit);
		try {
			return this.db.prepare(sql).all(...params).map(({ rank, ...toolFields }) => ({
				tool: toolFields,
				score: Math.abs(rank),
				matchType: "fts"
			}));
		} catch (err) {
			debug("tool-registry", "FTS5 search failed", { error: String(err) });
			return [];
		}
	}
	/**
	* Vector similarity search on tool_registry_embeddings using vec0 KNN.
	* Returns tool IDs and distances sorted by cosine similarity.
	*/
	searchByVector(queryEmbedding, options) {
		const limit = options?.limit ?? 40;
		try {
			let sql;
			const params = [queryEmbedding];
			if (options?.scope) {
				sql = `
          SELECT tre.tool_id, tre.distance
          FROM tool_registry_embeddings tre
          JOIN tool_registry tr ON tr.id = tre.tool_id
          WHERE tre.embedding MATCH ? AND tr.scope = ?
          ORDER BY tre.distance LIMIT ?
        `;
				params.push(options.scope);
			} else sql = `
          SELECT tre.tool_id, tre.distance
          FROM tool_registry_embeddings tre
          WHERE tre.embedding MATCH ?
          ORDER BY tre.distance LIMIT ?
        `;
			params.push(limit);
			return this.db.prepare(sql).all(...params);
		} catch (err) {
			debug("tool-registry", "Vector search failed", { error: String(err) });
			return [];
		}
	}
	/**
	* Hybrid search combining FTS5 keyword and vec0 vector results via
	* reciprocal rank fusion (RRF). Falls back to FTS5-only when vector
	* search is unavailable (no worker, no sqlite-vec, no embeddings).
	*/
	async searchTools(query, options) {
		const limit = options?.limit ?? 20;
		const ftsResults = this.searchByKeyword(query, {
			scope: options?.scope,
			limit
		});
		let vectorResults = [];
		if (options?.worker?.isReady() && options?.hasVectorSupport) {
			const queryEmbedding = await options.worker.embed(query);
			if (queryEmbedding) vectorResults = this.searchByVector(queryEmbedding, {
				scope: options?.scope,
				limit: limit * 2
			});
		}
		if (vectorResults.length === 0) return ftsResults.slice(0, limit);
		const fused = reciprocalRankFusion([ftsResults.map((r) => ({ id: String(r.tool.id) })), vectorResults.map((r) => ({ id: String(r.tool_id) }))]);
		const ftsMap = /* @__PURE__ */ new Map();
		for (const r of ftsResults) ftsMap.set(String(r.tool.id), r);
		const vecIds = new Set(vectorResults.map((r) => String(r.tool_id)));
		const results = [];
		for (const item of fused) {
			if (results.length >= limit) break;
			const fromFts = ftsMap.get(item.id);
			const fromVec = vecIds.has(item.id);
			if (fromFts) results.push({
				tool: fromFts.tool,
				score: item.fusedScore,
				matchType: fromFts && fromVec ? "hybrid" : "fts"
			});
			else if (fromVec) {
				const toolRow = this.db.prepare("SELECT * FROM tool_registry WHERE id = ?").get(Number(item.id));
				if (toolRow) results.push({
					tool: toolRow,
					score: item.fusedScore,
					matchType: "vector"
				});
			}
		}
		return results;
	}
	/**
	* Stores an embedding vector for a tool in tool_registry_embeddings.
	* Used by the background embedding loop to index tool descriptions.
	*/
	storeEmbedding(toolId, embedding) {
		try {
			this.db.prepare("INSERT OR REPLACE INTO tool_registry_embeddings(tool_id, embedding) VALUES (?, ?)").run(toolId, embedding);
		} catch (err) {
			debug("tool-registry", "Failed to store tool embedding", {
				toolId,
				error: String(err)
			});
		}
	}
	/**
	* Returns tools that have descriptions but no embedding yet.
	* Used by the background embedding loop to find work.
	*/
	findUnembeddedTools(limit = 5) {
		try {
			return this.db.prepare(`
        SELECT id, name, description FROM tool_registry
        WHERE description IS NOT NULL
          AND id NOT IN (SELECT tool_id FROM tool_registry_embeddings)
        LIMIT ?
      `).all(limit);
		} catch (err) {
			debug("tool-registry", "Failed to find unembedded tools", { error: String(err) });
			return [];
		}
	}
};

//#endregion
export { MIGRATIONS as C, debugTimed as E, openDatabase as S, debug as T, hybridSearch as _, inferScope as a, ObservationRepository as b, getEdgesForNode as c, initGraphSchema as d, insertEdge as f, jaccardSimilarity as g, SaveGuard as h, extractServerName as i, getNodeByNameAndType as l, upsertNode as m, NotificationStore as n, inferToolType as o, traverseFrom as p, ResearchBufferRepository as r, countEdgesForNode as s, ToolRegistryRepository as t, getNodesByType as u, SearchEngine as v, runMigrations as w, rowToObservation as x, SessionRepository as y };
//# sourceMappingURL=tool-registry-BIjd5Evf.mjs.map