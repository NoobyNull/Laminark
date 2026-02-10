import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import type { ThresholdState } from '../intelligence/adaptive-threshold.js';

/**
 * Result of loading historical seed data for cold start.
 */
export interface HistoricalSeed {
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
export class ThresholdStore {
  private readonly db: BetterSqlite3.Database;

  // Prepared statements
  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtLoadSeed: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO threshold_history (project_id, session_id, final_ewma_distance, final_ewma_variance, observation_count)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtLoadSeed = db.prepare(`
      SELECT
        AVG(final_ewma_distance) AS avg_distance,
        AVG(final_ewma_variance) AS avg_variance
      FROM (
        SELECT final_ewma_distance, final_ewma_variance
        FROM threshold_history
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      )
    `);

    debug('db', 'ThresholdStore initialized');
  }

  /**
   * Persist the final EWMA state of a session for future seeding.
   */
  saveSessionThreshold(
    projectId: string,
    sessionId: string,
    state: ThresholdState,
  ): void {
    this.stmtInsert.run(
      projectId,
      sessionId,
      state.ewmaDistance,
      state.ewmaVariance,
      state.observationCount,
    );

    debug('db', 'Threshold saved', {
      projectId,
      sessionId,
      ewmaDistance: state.ewmaDistance,
      observations: state.observationCount,
    });
  }

  /**
   * Load historical seed by averaging the last 10 sessions for a project.
   *
   * Returns null if no history exists for this project.
   */
  loadHistoricalSeed(projectId: string): HistoricalSeed | null {
    const row = this.stmtLoadSeed.get(projectId) as {
      avg_distance: number | null;
      avg_variance: number | null;
    };

    if (row.avg_distance === null || row.avg_variance === null) {
      debug('db', 'No threshold history found', { projectId });
      return null;
    }

    debug('db', 'Threshold seed loaded', {
      projectId,
      avgDistance: row.avg_distance,
      avgVariance: row.avg_variance,
    });

    return {
      averageDistance: row.avg_distance,
      averageVariance: row.avg_variance,
    };
  }
}
