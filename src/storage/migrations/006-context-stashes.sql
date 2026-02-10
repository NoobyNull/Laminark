-- Migration 007: Context stashes table for topic detection (Phase 6)
-- Stores frozen snapshots of observation threads when a topic shift is detected.

CREATE TABLE context_stashes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  topic_label TEXT NOT NULL,
  summary TEXT NOT NULL,
  observation_snapshots TEXT NOT NULL,  -- JSON blob of StashObservation[]
  observation_ids TEXT NOT NULL,        -- JSON array of original observation IDs
  status TEXT NOT NULL DEFAULT 'stashed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resumed_at TEXT
);

-- Primary listing query: stashes for a project filtered by status, ordered by recency
CREATE INDEX idx_stashes_project_status_created
  ON context_stashes(project_id, status, created_at DESC);

-- Session-scoped queries
CREATE INDEX idx_stashes_session
  ON context_stashes(session_id);
