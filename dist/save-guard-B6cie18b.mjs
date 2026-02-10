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
      INSERT INTO observations (id, project_hash, content, title, source, session_id, embedding, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
		this.stmtInsert.run(id, this.projectHash, validated.content, validated.title, validated.source, validated.sessionId, embeddingBuffer, validated.embeddingModel, validated.embeddingVersion);
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
		if (!includeUnclassified) sql += " AND classification IS NOT NULL AND classification != 'noise'";
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
export { rowToObservation as a, runMigrations as c, ObservationRepository as i, debug as l, jaccardSimilarity as n, openDatabase as o, SessionRepository as r, MIGRATIONS as s, SaveGuard as t, debugTimed as u };
//# sourceMappingURL=save-guard-B6cie18b.mjs.map