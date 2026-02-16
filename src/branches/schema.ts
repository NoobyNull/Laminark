/**
 * DDL for thought branch tables.
 *
 * Used by migration 021 to create thought_branches and branch_observations
 * tables with proper indexes and constraints.
 */

export const THOUGHT_BRANCH_DDL = `
  CREATE TABLE IF NOT EXISTS thought_branches (
    id TEXT PRIMARY KEY,
    project_hash TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'completed', 'abandoned', 'merged')),
    branch_type TEXT NOT NULL DEFAULT 'unknown'
      CHECK(branch_type IN ('investigation', 'bug_fix', 'feature', 'refactor', 'research', 'unknown')),
    arc_stage TEXT NOT NULL DEFAULT 'investigation'
      CHECK(arc_stage IN ('investigation', 'diagnosis', 'planning', 'execution', 'verification', 'completed')),
    title TEXT,
    summary TEXT,
    parent_branch_id TEXT REFERENCES thought_branches(id),
    linked_debug_path_id TEXT,
    trigger_source TEXT,
    trigger_observation_id TEXT,
    observation_count INTEGER NOT NULL DEFAULT 0,
    tool_pattern TEXT DEFAULT '{}',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS branch_observations (
    branch_id TEXT NOT NULL REFERENCES thought_branches(id) ON DELETE CASCADE,
    observation_id TEXT NOT NULL,
    sequence_order INTEGER NOT NULL,
    tool_name TEXT,
    arc_stage_at_add TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (branch_id, observation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_thought_branches_project_status
    ON thought_branches(project_hash, status);

  CREATE INDEX IF NOT EXISTS idx_thought_branches_session
    ON thought_branches(session_id);

  CREATE INDEX IF NOT EXISTS idx_thought_branches_started
    ON thought_branches(started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_branch_observations_obs
    ON branch_observations(observation_id);
`;
