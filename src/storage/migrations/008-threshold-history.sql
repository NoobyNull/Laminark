-- Migration 008: Threshold history table for EWMA adaptive threshold (Phase 6)
-- Stores per-session EWMA state at session end for cold-start seeding.
-- loadHistoricalSeed() averages the last 10 sessions per project.

CREATE TABLE threshold_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  final_ewma_distance REAL NOT NULL,
  final_ewma_variance REAL NOT NULL,
  observation_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary query: last N sessions for a project ordered by recency
CREATE INDEX idx_threshold_history_project
  ON threshold_history(project_id, created_at DESC);
