/**
 * Repository for debug path CRUD operations.
 *
 * Every query is scoped to the projectHash provided at construction time.
 * All SQL statements are prepared once in the constructor and reused for
 * every call (same pattern as ObservationRepository).
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type { DebugPath, PathWaypoint, WaypointType } from './types.js';

export class PathRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  // Prepared statements — path lifecycle
  private readonly stmtCreatePath: BetterSqlite3.Statement;
  private readonly stmtResolvePath: BetterSqlite3.Statement;
  private readonly stmtAbandonPath: BetterSqlite3.Statement;
  private readonly stmtGetActivePath: BetterSqlite3.Statement;
  private readonly stmtGetPath: BetterSqlite3.Statement;
  private readonly stmtListPaths: BetterSqlite3.Statement;

  // Prepared statements — waypoint management
  private readonly stmtAddWaypoint: BetterSqlite3.Statement;
  private readonly stmtGetWaypoints: BetterSqlite3.Statement;
  private readonly stmtCountWaypoints: BetterSqlite3.Statement;
  private readonly stmtMaxSequence: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;

    // --- Path lifecycle statements ---

    this.stmtCreatePath = db.prepare(`
      INSERT INTO debug_paths (id, status, trigger_summary, started_at, project_hash)
      VALUES (?, 'active', ?, datetime('now'), ?)
    `);

    this.stmtResolvePath = db.prepare(`
      UPDATE debug_paths
      SET status = 'resolved', resolution_summary = ?, resolved_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtAbandonPath = db.prepare(`
      UPDATE debug_paths
      SET status = 'abandoned', resolved_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtGetActivePath = db.prepare(`
      SELECT * FROM debug_paths
      WHERE project_hash = ? AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `);

    this.stmtGetPath = db.prepare(`
      SELECT * FROM debug_paths
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtListPaths = db.prepare(`
      SELECT * FROM debug_paths
      WHERE project_hash = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);

    // --- Waypoint statements ---

    this.stmtAddWaypoint = db.prepare(`
      INSERT INTO path_waypoints (id, path_id, observation_id, waypoint_type, sequence_order, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    this.stmtGetWaypoints = db.prepare(`
      SELECT * FROM path_waypoints
      WHERE path_id = ?
      ORDER BY sequence_order ASC
    `);

    this.stmtCountWaypoints = db.prepare(`
      SELECT COUNT(*) AS count FROM path_waypoints
      WHERE path_id = ?
    `);

    this.stmtMaxSequence = db.prepare(`
      SELECT COALESCE(MAX(sequence_order), 0) AS max_seq FROM path_waypoints
      WHERE path_id = ?
    `);
  }

  // ===========================================================================
  // Path Lifecycle
  // ===========================================================================

  /**
   * Creates a new active debug path.
   * Generates a UUID id, sets status='active' and started_at=now.
   */
  createPath(triggerSummary: string): DebugPath {
    const id = randomBytes(16).toString('hex');
    this.stmtCreatePath.run(id, triggerSummary, this.projectHash);
    return this.getPath(id)!;
  }

  /**
   * Resolves a debug path with a resolution summary.
   * Sets status='resolved', resolved_at=now.
   */
  resolvePath(pathId: string, resolutionSummary: string): void {
    this.stmtResolvePath.run(resolutionSummary, pathId, this.projectHash);
  }

  /**
   * Abandons a debug path.
   * Sets status='abandoned', resolved_at=now.
   */
  abandonPath(pathId: string): void {
    this.stmtAbandonPath.run(pathId, this.projectHash);
  }

  /**
   * Returns the active path for this project (at most one active at a time).
   * Returns null if no active path exists.
   */
  getActivePath(): DebugPath | null {
    const row = this.stmtGetActivePath.get(this.projectHash) as DebugPathRow | undefined;
    return row ? rowToDebugPath(row) : null;
  }

  /**
   * Gets a debug path by ID, scoped to this project.
   * Returns null if not found.
   */
  getPath(pathId: string): DebugPath | null {
    const row = this.stmtGetPath.get(pathId, this.projectHash) as DebugPathRow | undefined;
    return row ? rowToDebugPath(row) : null;
  }

  /**
   * Lists recent paths for this project, ordered by started_at DESC.
   * Default limit is 20.
   */
  listPaths(limit: number = 20): DebugPath[] {
    const rows = this.stmtListPaths.all(this.projectHash, limit) as DebugPathRow[];
    return rows.map(rowToDebugPath);
  }

  // ===========================================================================
  // Waypoint Management
  // ===========================================================================

  /**
   * Adds a waypoint to a debug path.
   * Auto-increments sequence_order based on existing waypoints.
   */
  addWaypoint(
    pathId: string,
    type: WaypointType,
    summary: string,
    observationId?: string,
  ): PathWaypoint {
    const id = randomBytes(16).toString('hex');
    const { max_seq } = this.stmtMaxSequence.get(pathId) as { max_seq: number };
    const sequenceOrder = max_seq + 1;

    this.stmtAddWaypoint.run(
      id,
      pathId,
      observationId ?? null,
      type,
      sequenceOrder,
      summary,
    );

    return this.getWaypoints(pathId).find(w => w.id === id)!;
  }

  /**
   * Returns all waypoints for a path, ordered by sequence_order ASC.
   */
  getWaypoints(pathId: string): PathWaypoint[] {
    const rows = this.stmtGetWaypoints.all(pathId) as PathWaypointRow[];
    return rows.map(rowToPathWaypoint);
  }

  /**
   * Counts waypoints for a path. Used for cap enforcement (max 30 per path).
   */
  countWaypoints(pathId: string): number {
    const row = this.stmtCountWaypoints.get(pathId) as { count: number };
    return row.count;
  }
}

// =============================================================================
// Raw Row Types (snake_case, matches SQL columns)
// =============================================================================

interface DebugPathRow {
  id: string;
  status: string;
  trigger_summary: string;
  resolution_summary: string | null;
  kiss_summary: string | null;
  started_at: string;
  resolved_at: string | null;
  project_hash: string;
}

interface PathWaypointRow {
  id: string;
  path_id: string;
  observation_id: string | null;
  waypoint_type: string;
  sequence_order: number;
  summary: string;
  created_at: string;
}

// =============================================================================
// Row Mapping
// =============================================================================

function rowToDebugPath(row: DebugPathRow): DebugPath {
  return {
    id: row.id,
    status: row.status as DebugPath['status'],
    trigger_summary: row.trigger_summary,
    resolution_summary: row.resolution_summary,
    kiss_summary: row.kiss_summary,
    started_at: row.started_at,
    resolved_at: row.resolved_at,
    project_hash: row.project_hash,
  };
}

function rowToPathWaypoint(row: PathWaypointRow): PathWaypoint {
  return {
    id: row.id,
    path_id: row.path_id,
    observation_id: row.observation_id,
    waypoint_type: row.waypoint_type as PathWaypoint['waypoint_type'],
    sequence_order: row.sequence_order,
    summary: row.summary,
    created_at: row.created_at,
  };
}
