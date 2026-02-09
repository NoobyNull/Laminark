/**
 * Migration 001: Create graph_nodes and graph_edges tables.
 *
 * Graph tables are managed separately from the main observation/session tables
 * because the knowledge graph is a distinct subsystem (Phase 7) that operates
 * on extracted entities rather than raw observations.
 *
 * Tables:
 *   - graph_nodes: entities with type-checked taxonomy (7 types)
 *   - graph_edges: directed relationships with type-checked taxonomy (7 types),
 *     weight confidence, and unique constraint on (source_id, target_id, type)
 *
 * Indexes:
 *   - Nodes: type, name
 *   - Edges: source_id, target_id, type, unique(source_id, target_id, type)
 */

export const up = `
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('Project','File','Decision','Problem','Solution','Tool','Person')),
    name TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    observation_ids TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('uses','depends_on','decided_by','related_to','part_of','caused_by','solved_by')),
    weight REAL NOT NULL DEFAULT 1.0 CHECK(weight >= 0.0 AND weight <= 1.0),
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(name);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique ON graph_edges(source_id, target_id, type);
`;

export const down = `
  DROP INDEX IF EXISTS idx_graph_edges_unique;
  DROP INDEX IF EXISTS idx_graph_edges_type;
  DROP INDEX IF EXISTS idx_graph_edges_target;
  DROP INDEX IF EXISTS idx_graph_edges_source;
  DROP INDEX IF EXISTS idx_graph_nodes_name;
  DROP INDEX IF EXISTS idx_graph_nodes_type;
  DROP TABLE IF EXISTS graph_edges;
  DROP TABLE IF EXISTS graph_nodes;
`;
