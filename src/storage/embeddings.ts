/**
 * EmbeddingStore for sqlite-vec vec0 table operations.
 *
 * Provides store/search/delete/has/findUnembedded methods against the
 * cosine-distance vec0 table (observation_embeddings). All operations
 * are project-scoped via subquery join on the observations table.
 *
 * Float32Array passes directly to better-sqlite3 for vec0 operations
 * (per research Finding 7 -- no Buffer conversion needed).
 */

import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';

/** A single search result with observation ID and cosine distance. */
export interface EmbeddingSearchResult {
  observationId: string;
  distance: number;
}

/**
 * Data layer for vector insert/query against the cosine-distance vec0 table.
 *
 * All methods catch errors internally and return empty/default values for
 * graceful degradation (DQ-03). Uses debug('embed', ...) logging.
 */
export class EmbeddingStore {
  private stmtInsert: BetterSqlite3.Statement;
  private stmtSearch: BetterSqlite3.Statement;
  private stmtDelete: BetterSqlite3.Statement;
  private stmtExists: BetterSqlite3.Statement;
  private stmtFindUnembedded: BetterSqlite3.Statement;

  constructor(
    private db: BetterSqlite3.Database,
    private projectHash: string,
  ) {
    this.stmtInsert = db.prepare(
      'INSERT OR REPLACE INTO observation_embeddings(observation_id, embedding) VALUES (?, ?)',
    );

    this.stmtSearch = db.prepare(`
      SELECT observation_id, distance
      FROM observation_embeddings
      WHERE embedding MATCH ?
        AND observation_id IN (
          SELECT id FROM observations WHERE project_hash = ? AND deleted_at IS NULL
        )
      ORDER BY distance
      LIMIT ?
    `);

    this.stmtDelete = db.prepare(
      'DELETE FROM observation_embeddings WHERE observation_id = ?',
    );

    this.stmtExists = db.prepare(
      'SELECT 1 FROM observation_embeddings WHERE observation_id = ?',
    );

    this.stmtFindUnembedded = db.prepare(`
      SELECT id FROM observations
      WHERE project_hash = ?
        AND deleted_at IS NULL
        AND id NOT IN (SELECT observation_id FROM observation_embeddings)
      LIMIT ?
    `);
  }

  /**
   * Stores an embedding for an observation.
   *
   * Uses INSERT OR REPLACE so re-embedding an observation overwrites
   * the old vector.
   */
  store(observationId: string, embedding: Float32Array): void {
    try {
      this.stmtInsert.run(observationId, embedding);
      debug('embed', 'Stored embedding', { observationId, dimensions: embedding.length });
    } catch (err) {
      debug('embed', 'Failed to store embedding', {
        observationId,
        error: String(err),
      });
    }
  }

  /**
   * Project-scoped KNN search using cosine distance.
   *
   * Returns the nearest observations ordered by distance (ascending).
   * Only returns observations belonging to this store's project that
   * have not been soft-deleted.
   */
  search(queryEmbedding: Float32Array, limit = 20): EmbeddingSearchResult[] {
    try {
      const rows = this.stmtSearch.all(
        queryEmbedding,
        this.projectHash,
        limit,
      ) as Array<{ observation_id: string; distance: number }>;

      debug('embed', 'Search completed', {
        results: rows.length,
        limit,
      });

      return rows.map((row) => ({
        observationId: row.observation_id,
        distance: row.distance,
      }));
    } catch (err) {
      debug('embed', 'Search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Removes the embedding for a deleted observation.
   */
  delete(observationId: string): void {
    try {
      this.stmtDelete.run(observationId);
      debug('embed', 'Deleted embedding', { observationId });
    } catch (err) {
      debug('embed', 'Failed to delete embedding', {
        observationId,
        error: String(err),
      });
    }
  }

  /**
   * Checks if an observation has an embedding stored.
   */
  has(observationId: string): boolean {
    try {
      const row = this.stmtExists.get(observationId);
      return row !== undefined;
    } catch (err) {
      debug('embed', 'Failed to check embedding existence', {
        observationId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Finds observation IDs that need embeddings generated.
   *
   * Returns IDs of observations belonging to this project that are
   * not soft-deleted and have no entry in the embeddings table.
   */
  findUnembedded(limit = 50): string[] {
    try {
      const rows = this.stmtFindUnembedded.all(
        this.projectHash,
        limit,
      ) as Array<{ id: string }>;

      debug('embed', 'Found unembedded observations', { count: rows.length, limit });

      return rows.map((row) => row.id);
    } catch (err) {
      debug('embed', 'Failed to find unembedded observations', {
        error: String(err),
      });
      return [];
    }
  }
}
