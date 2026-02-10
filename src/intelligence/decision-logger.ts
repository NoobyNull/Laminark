// ---------------------------------------------------------------------------
// Topic Shift Decision Logger
// ---------------------------------------------------------------------------
// Logs every topic shift decision (shifted or not) with all inputs for
// debugging and threshold tuning. Requirement DQ-05 demands full
// observability of the decision pipeline.
//
// Each decision record captures: distance, threshold, EWMA state,
// sensitivity multiplier, shifted boolean, confidence, and optional
// stash ID (when a shift triggered stashing).
// ---------------------------------------------------------------------------

import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import { debug } from '../shared/debug.js';

/**
 * A single topic shift decision with all inputs recorded.
 */
export interface ShiftDecision {
  /** Project scoping */
  projectId: string;
  /** Session scoping */
  sessionId: string;
  /** The observation that triggered this decision (null for synthetic events) */
  observationId: string | null;
  /** Cosine distance between consecutive embeddings */
  distance: number;
  /** Threshold used for this detection */
  threshold: number;
  /** EWMA distance at decision time (null if adaptive disabled) */
  ewmaDistance: number | null;
  /** EWMA variance at decision time (null if adaptive disabled) */
  ewmaVariance: number | null;
  /** Sensitivity multiplier in effect */
  sensitivityMultiplier: number;
  /** Whether a topic shift was detected */
  shifted: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Stash ID created by this shift (null if not shifted) */
  stashId: string | null;
}

/**
 * Persists topic shift decisions for debugging and threshold tuning.
 *
 * Every call to detect() in the topic shift pipeline should result in
 * a corresponding log() call here, regardless of whether a shift was
 * detected. This provides complete visibility into the decision process.
 *
 * All SQL statements are prepared once in the constructor and reused
 * for every call (better-sqlite3 performance best practice).
 */
export class TopicShiftDecisionLogger {
  private readonly db: BetterSqlite3.Database;

  // Prepared statements
  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtGetSessionDecisions: BetterSqlite3.Statement;
  private readonly stmtGetShiftRate: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO shift_decisions
        (id, project_id, session_id, observation_id, distance, threshold,
         ewma_distance, ewma_variance, sensitivity_multiplier, shifted,
         confidence, stash_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetSessionDecisions = db.prepare(`
      SELECT * FROM shift_decisions
      WHERE project_id = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    this.stmtGetShiftRate = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(shifted) AS shifted_count
      FROM (
        SELECT shifted
        FROM shift_decisions
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `);

    debug('db', 'TopicShiftDecisionLogger initialized');
  }

  /**
   * Log a topic shift decision with all inputs.
   *
   * Should be called after every detect() call, regardless of outcome.
   */
  log(decision: ShiftDecision): void {
    const id = randomBytes(16).toString('hex');

    this.stmtInsert.run(
      id,
      decision.projectId,
      decision.sessionId,
      decision.observationId,
      decision.distance,
      decision.threshold,
      decision.ewmaDistance,
      decision.ewmaVariance,
      decision.sensitivityMultiplier,
      decision.shifted ? 1 : 0,
      decision.confidence,
      decision.stashId,
    );

    debug('db', 'Shift decision logged', {
      shifted: decision.shifted,
      distance: decision.distance,
      threshold: decision.threshold,
    });
  }

  /**
   * Retrieve decisions for a specific session, ordered by recency.
   *
   * Useful for debugging: "What happened in this session?"
   */
  getSessionDecisions(
    projectId: string,
    sessionId: string,
    limit: number = 50,
  ): ShiftDecision[] {
    const rows = this.stmtGetSessionDecisions.all(
      projectId,
      sessionId,
      limit,
    ) as DecisionRow[];

    return rows.map(rowToDecision);
  }

  /**
   * Compute shift rate statistics across recent decisions for a project.
   *
   * Returns the total number of decisions, how many were shifts, and
   * the rate (0-1). Useful for tuning: a rate of 0.3 means 30% of
   * observations triggered a topic shift.
   */
  getShiftRate(
    projectId: string,
    lastN: number = 100,
  ): { total: number; shifted: number; rate: number } {
    const row = this.stmtGetShiftRate.get(projectId, lastN) as {
      total: number;
      shifted_count: number | null;
    };

    const total = row.total;
    const shifted = row.shifted_count ?? 0;
    const rate = total > 0 ? shifted / total : 0;

    return { total, shifted, rate };
  }
}

// ---------------------------------------------------------------------------
// Internal row mapping
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: string;
  project_id: string;
  session_id: string;
  observation_id: string | null;
  distance: number;
  threshold: number;
  ewma_distance: number | null;
  ewma_variance: number | null;
  sensitivity_multiplier: number;
  shifted: number; // 0 or 1
  confidence: number;
  stash_id: string | null;
  created_at: string;
}

function rowToDecision(row: DecisionRow): ShiftDecision {
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    observationId: row.observation_id,
    distance: row.distance,
    threshold: row.threshold,
    ewmaDistance: row.ewma_distance,
    ewmaVariance: row.ewma_variance,
    sensitivityMultiplier: row.sensitivity_multiplier,
    shifted: row.shifted === 1,
    confidence: row.confidence,
    stashId: row.stash_id,
  };
}
