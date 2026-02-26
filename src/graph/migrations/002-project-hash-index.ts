/**
 * Migration 002: Add indexes on project_hash for graph tables.
 *
 * Supports project-scoped queries that filter by project_hash.
 */

export const up = `
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_hash);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_project ON graph_edges(project_hash);
`;

export const down = `
  DROP INDEX IF EXISTS idx_graph_edges_project;
  DROP INDEX IF EXISTS idx_graph_nodes_project;
`;
