/**
 * Debug path schema initialization.
 *
 * Creates debug_paths and path_waypoints tables with indexes.
 * Uses CREATE TABLE IF NOT EXISTS for idempotent initialization
 * (same pattern as graph/schema.ts initGraphSchema).
 */

import type BetterSqlite3 from 'better-sqlite3';

const PATH_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS debug_paths (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'abandoned')),
    trigger_summary TEXT NOT NULL,
    resolution_summary TEXT,
    kiss_summary TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    project_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS path_waypoints (
    id TEXT PRIMARY KEY,
    path_id TEXT NOT NULL REFERENCES debug_paths(id) ON DELETE CASCADE,
    observation_id TEXT,
    waypoint_type TEXT NOT NULL CHECK(waypoint_type IN ('error', 'attempt', 'failure', 'success', 'pivot', 'revert', 'discovery', 'resolution')),
    sequence_order INTEGER NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_debug_paths_project_status
    ON debug_paths(project_hash, status);

  CREATE INDEX IF NOT EXISTS idx_debug_paths_started
    ON debug_paths(started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_path_waypoints_path_order
    ON path_waypoints(path_id, sequence_order);
`;

/**
 * Initializes debug path tables if they do not exist.
 * Safe to call multiple times (all statements use IF NOT EXISTS).
 */
export function initPathSchema(db: BetterSqlite3.Database): void {
  db.exec(PATH_SCHEMA_DDL);
}
