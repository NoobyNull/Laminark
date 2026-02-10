import { a as SearchResult, i as ObservationInsert, n as DatabaseConfig, o as Session, r as Observation, t as ObservationRepository } from "./observations-B62-p18e.mjs";
import Database from "better-sqlite3";

//#region src/storage/database.d.ts
/**
 * Wrapper around a configured better-sqlite3 database instance.
 * Provides lifecycle methods (close, checkpoint) and tracks whether
 * the sqlite-vec extension loaded successfully.
 */
interface LaminarkDatabase {
  db: Database.Database;
  hasVectorSupport: boolean;
  close(): void;
  checkpoint(): void;
}
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
declare function openDatabase(config: DatabaseConfig): LaminarkDatabase;
//#endregion
//#region src/storage/migrations.d.ts
/**
 * A versioned schema migration.
 * Migrations are applied in order and tracked in the _migrations table.
 */
interface Migration {
  version: number;
  name: string;
  up: string | ((db: Database.Database) => void);
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
 */
declare const MIGRATIONS: Migration[];
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
declare function runMigrations(db: Database.Database, hasVectorSupport: boolean): void;
//#endregion
//#region src/storage/sessions.d.ts
/**
 * Repository for session lifecycle management.
 *
 * Every query is scoped to the projectHash provided at construction time.
 * All SQL statements are prepared once in the constructor.
 */
declare class SessionRepository {
  private readonly db;
  private readonly projectHash;
  private readonly stmtCreate;
  private readonly stmtGetById;
  private readonly stmtGetActive;
  constructor(db: Database.Database, projectHash: string);
  /**
   * Creates a new session with the given ID, scoped to this project.
   */
  create(id: string): Session;
  /**
   * Ends a session by setting ended_at and optionally a summary.
   * Returns the updated session or null if not found.
   */
  end(id: string, summary?: string): Session | null;
  /**
   * Gets a session by ID, scoped to this project.
   */
  getById(id: string): Session | null;
  /**
   * Gets the most recent sessions for this project, ordered by started_at DESC.
   */
  getLatest(limit?: number): Session[];
  /**
   * Gets the currently active (not ended) session for this project.
   * Returns the most recently started active session, or null if none.
   */
  getActive(): Session | null;
  /**
   * Updates the summary column on an existing session row.
   * Sets updated_at (via ended_at preservation) to track when the summary was written.
   *
   * Used by the curation module after compressing session observations.
   */
  updateSessionSummary(sessionId: string, summary: string): void;
}
//#endregion
//#region src/storage/search.d.ts
/**
 * FTS5 search engine with BM25 ranking, snippet extraction, and strict project scoping.
 *
 * All queries are scoped to the projectHash provided at construction time.
 * Queries are sanitized to prevent FTS5 syntax errors and injection.
 */
declare class SearchEngine {
  private readonly db;
  private readonly projectHash;
  constructor(db: Database.Database, projectHash: string);
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
  searchKeyword(query: string, options?: {
    limit?: number;
    sessionId?: string;
  }): SearchResult[];
  /**
   * Prefix search for autocomplete-style matching.
   * Appends `*` to each word for prefix matching.
   */
  searchByPrefix(prefix: string, limit?: number): SearchResult[];
  /**
   * Rebuild the FTS5 index if it gets out of sync.
   */
  rebuildIndex(): void;
  /**
   * Sanitizes a user query for safe FTS5 MATCH usage.
   * Removes FTS5 operators and special characters.
   * Returns null if the query is empty after sanitization.
   */
  private sanitizeQuery;
  /**
   * Sanitizes a single word for FTS5 safety.
   * Removes quotes, parentheses, asterisks, and FTS5 operator keywords.
   */
  private sanitizeWord;
}
//#endregion
//#region src/storage/embeddings.d.ts
/** A single search result with observation ID and cosine distance. */
interface EmbeddingSearchResult {
  observationId: string;
  distance: number;
}
/**
 * Data layer for vector insert/query against the cosine-distance vec0 table.
 *
 * All methods catch errors internally and return empty/default values for
 * graceful degradation (DQ-03). Uses debug('embed', ...) logging.
 */
declare class EmbeddingStore {
  private db;
  private projectHash;
  private stmtInsert;
  private stmtSearch;
  private stmtDelete;
  private stmtExists;
  private stmtFindUnembedded;
  constructor(db: Database.Database, projectHash: string);
  /**
   * Stores an embedding for an observation.
   *
   * Uses INSERT OR REPLACE so re-embedding an observation overwrites
   * the old vector.
   */
  store(observationId: string, embedding: Float32Array): void;
  /**
   * Project-scoped KNN search using cosine distance.
   *
   * Returns the nearest observations ordered by distance (ascending).
   * Only returns observations belonging to this store's project that
   * have not been soft-deleted.
   */
  search(queryEmbedding: Float32Array, limit?: number): EmbeddingSearchResult[];
  /**
   * Removes the embedding for a deleted observation.
   */
  delete(observationId: string): void;
  /**
   * Checks if an observation has an embedding stored.
   */
  has(observationId: string): boolean;
  /**
   * Finds observation IDs that need embeddings generated.
   *
   * Returns IDs of observations belonging to this project that are
   * not soft-deleted and have no entry in the embeddings table.
   */
  findUnembedded(limit?: number): string[];
}
//#endregion
//#region src/types/stash.d.ts
/**
 * Type definitions for context stashing.
 *
 * Context stashing is the persistence mechanism for topic detection (Phase 6).
 * When a topic shift is detected, the current thread's observations and summary
 * are snapshotted into a stash record so the user can resume later.
 */
/**
 * A snapshot of a single observation stored within a stash.
 * Captures the observation's content at the time of stashing so the stash
 * remains self-contained even if the original observation is later modified.
 */
interface StashObservation {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  embedding: number[] | null;
}
/**
 * A stashed context thread -- a frozen snapshot of observations and their
 * summary at the moment a topic shift was detected.
 */
interface ContextStash {
  id: string;
  projectId: string;
  sessionId: string;
  topicLabel: string;
  summary: string;
  observationIds: string[];
  observationSnapshots: StashObservation[];
  createdAt: string;
  resumedAt: string | null;
  status: 'stashed' | 'resumed' | 'expired';
}
/**
 * Input for creating a new stash record.
 * Omits generated fields (id, createdAt, resumedAt, status, observationIds)
 * since those are derived during creation.
 */
interface CreateStashInput {
  projectId: string;
  sessionId: string;
  topicLabel: string;
  summary: string;
  observations: StashObservation[];
}
//#endregion
//#region src/storage/stash-manager.d.ts
/**
 * Repository for context stash CRUD operations.
 *
 * Manages the lifecycle of stashed context threads: creating snapshots
 * when topic shifts are detected, listing available stashes, retrieving
 * full stash records, resuming stashes, and deleting them.
 *
 * All SQL statements are prepared once in the constructor and reused
 * for every call (better-sqlite3 performance best practice).
 */
declare class StashManager {
  private readonly db;
  private readonly stmtInsert;
  private readonly stmtGetById;
  private readonly stmtResume;
  private readonly stmtDelete;
  constructor(db: Database.Database);
  /**
   * Creates a new stash record from a context thread snapshot.
   * JSON-serializes observation snapshots and IDs for TEXT column storage.
   * Uses randomBytes(16) hex for ID generation (matches ObservationRepository pattern).
   */
  createStash(input: CreateStashInput): ContextStash;
  /**
   * Lists stashes for a project, ordered by created_at DESC.
   * Supports optional filtering by session_id and status.
   */
  listStashes(projectId: string, options?: {
    sessionId?: string;
    status?: string;
    limit?: number;
  }): ContextStash[];
  /**
   * Retrieves a single stash by ID with full observation snapshot data.
   * Returns null for nonexistent IDs.
   */
  getStash(id: string): ContextStash | null;
  /**
   * Marks a stash as resumed and sets resumed_at timestamp.
   * Returns the updated record.
   * Throws if the stash does not exist.
   */
  resumeStash(id: string): ContextStash;
  /**
   * Hard-deletes a stash record.
   */
  deleteStash(id: string): void;
  /**
   * Returns stashes with status='stashed' (excludes resumed) for a project,
   * ordered by created_at DESC.
   */
  getRecentStashes(projectId: string, limit?: number): ContextStash[];
}
//#endregion
//#region src/intelligence/adaptive-threshold.d.ts
/**
 * Internal state of the adaptive threshold computation.
 */
interface ThresholdState {
  /** Exponentially weighted moving average of observed distances */
  ewmaDistance: number;
  /** Exponentially weighted variance of observed distances */
  ewmaVariance: number;
  /** Decay factor for EWMA (0 < alpha <= 1) */
  alpha: number;
  /** Standard deviations above the mean for threshold */
  sensitivityMultiplier: number;
  /** Number of distance observations processed */
  observationCount: number;
}
//#endregion
//#region src/storage/threshold-store.d.ts
/**
 * Result of loading historical seed data for cold start.
 */
interface HistoricalSeed {
  /** Average EWMA distance across recent sessions */
  averageDistance: number;
  /** Average EWMA variance across recent sessions */
  averageVariance: number;
}
/**
 * Persists and loads EWMA threshold history for session seeding.
 *
 * At the end of each session, the final EWMA state is saved via
 * saveSessionThreshold(). When a new session starts, loadHistoricalSeed()
 * computes averages from the last 10 sessions to bootstrap the EWMA
 * without cold-start problems.
 *
 * All SQL statements are prepared once in the constructor and reused
 * for every call (better-sqlite3 performance best practice).
 */
declare class ThresholdStore {
  private readonly db;
  private readonly stmtInsert;
  private readonly stmtLoadSeed;
  constructor(db: Database.Database);
  /**
   * Persist the final EWMA state of a session for future seeding.
   */
  saveSessionThreshold(projectId: string, sessionId: string, state: ThresholdState): void;
  /**
   * Load historical seed by averaging the last 10 sessions for a project.
   *
   * Returns null if no history exists for this project.
   */
  loadHistoricalSeed(projectId: string): HistoricalSeed | null;
}
//#endregion
//#region src/shared/config.d.ts
/**
 * Returns whether debug logging is enabled for this process.
 *
 * Resolution order:
 * 1. `LAMINARK_DEBUG` env var -- `"1"` or `"true"` enables debug mode
 * 2. `~/.laminark/config.json` -- `{ "debug": true }` enables debug mode
 * 3. Default: disabled
 *
 * The result is cached after the first call.
 */
declare function isDebugEnabled(): boolean;
/**
 * Returns the path to the single Laminark database file.
 * User decision: single database at ~/.laminark/data.db for ALL projects.
 */
declare function getDbPath(): string;
/**
 * Creates a deterministic SHA-256 hash of a project directory path.
 * Uses realpathSync to canonicalize (resolves symlinks) to prevent
 * multiple hashes for the same directory via different paths.
 *
 * @param projectDir - The project directory path to hash
 * @returns First 16 hex characters of the SHA-256 hash
 */
declare function getProjectHash(projectDir: string): string;
/**
 * Returns the default database configuration.
 */
declare function getDatabaseConfig(): DatabaseConfig;
//#endregion
//#region src/shared/debug.d.ts
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
declare function debug(category: string, message: string, data?: Record<string, unknown>): void;
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
declare function debugTimed<T>(category: string, message: string, fn: () => T): T;
//#endregion
export { type DatabaseConfig, type EmbeddingSearchResult, EmbeddingStore, type HistoricalSeed, type LaminarkDatabase, MIGRATIONS, type Migration, type Observation, type ObservationInsert, ObservationRepository, SearchEngine, type SearchResult, type Session, SessionRepository, StashManager, ThresholdStore, debug, debugTimed, getDatabaseConfig, getDbPath, getProjectHash, isDebugEnabled, openDatabase, runMigrations };
//# sourceMappingURL=index.d.ts.map