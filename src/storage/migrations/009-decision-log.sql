-- Migration 009: shift_decisions table for topic shift decision logging
-- Every topic shift decision (shifted or not) is logged with all inputs
-- for debugging and threshold tuning.

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
