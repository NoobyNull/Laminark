/**
 * Knowledge graph schema initialization and query builders.
 *
 * All functions accept a better-sqlite3 Database handle and use prepared
 * statements for performance. Metadata and observation_ids are stored as
 * JSON TEXT in SQLite and parsed on read.
 *
 * Traversal uses recursive CTEs for efficient subgraph extraction up to
 * a configurable depth.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import type {
  EntityType,
  RelationshipType,
  GraphNode,
  GraphEdge,
} from './types.js';
import { up as graphTablesDDL } from './migrations/001-graph-tables.js';
import { up as projectHashIndexDDL } from './migrations/002-project-hash-index.js';

// =============================================================================
// Raw Row Types (snake_case, matches SQL columns)
// =============================================================================

interface NodeRow {
  id: string;
  type: string;
  name: string;
  metadata: string; // JSON string
  observation_ids: string; // JSON string
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  metadata: string; // JSON string
  created_at: string;
}

interface TraversalRow {
  // Node columns (prefixed n_)
  n_id: string;
  n_type: string;
  n_name: string;
  n_metadata: string;
  n_observation_ids: string;
  n_created_at: string;
  n_updated_at: string;
  // Edge columns (prefixed e_) -- nullable for starting node
  e_id: string | null;
  e_source_id: string | null;
  e_target_id: string | null;
  e_type: string | null;
  e_weight: number | null;
  e_metadata: string | null;
  e_created_at: string | null;
  // Traversal depth
  depth: number;
}

// =============================================================================
// Row Mapping
// =============================================================================

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    observation_ids: JSON.parse(row.observation_ids) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    type: row.type as RelationshipType,
    weight: row.weight,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

// =============================================================================
// Traversal Result
// =============================================================================

export interface TraversalResult {
  node: GraphNode;
  edge: GraphEdge | null;
  depth: number;
}

// =============================================================================
// Schema Initialization
// =============================================================================

/**
 * Initializes graph tables if they do not exist.
 * Uses CREATE TABLE IF NOT EXISTS so it is safe to call multiple times.
 */
export function initGraphSchema(db: BetterSqlite3.Database): void {
  db.exec(graphTablesDDL);
  db.exec(projectHashIndexDDL);
}

// =============================================================================
// Traversal Queries
// =============================================================================

/**
 * Traverses the graph from a starting node using a recursive CTE.
 *
 * Supports directional traversal:
 *   - 'outgoing': follows edges where source_id matches (default)
 *   - 'incoming': follows edges where target_id matches
 *   - 'both': follows edges in either direction
 *
 * Returns nodes and the edges that connect them, up to the specified depth.
 * The starting node itself is NOT included in results (depth > 0 filter).
 *
 * @param db - better-sqlite3 Database handle
 * @param nodeId - starting node ID
 * @param opts - traversal options (depth, edgeTypes, direction)
 * @returns Array of { node, edge, depth } for each reachable node
 */
export function traverseFrom(
  db: BetterSqlite3.Database,
  nodeId: string,
  opts: {
    depth?: number;
    edgeTypes?: RelationshipType[];
    direction?: 'outgoing' | 'incoming' | 'both';
    projectHash: string | null;
  },
): TraversalResult[] {
  const maxDepth = opts.depth ?? 2;
  const direction = opts.direction ?? 'outgoing';

  // Build edge type filter clause
  let edgeTypeFilter = '';

  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    const placeholders = opts.edgeTypes.map(() => '?').join(', ');
    edgeTypeFilter = `AND e.type IN (${placeholders})`;
  }

  // Project isolation: filter edges by project_hash to prevent cross-project traversal
  const projectFilter = opts.projectHash ? 'AND e.project_hash = ?' : '';

  // Build the recursive step based on direction
  let recursiveStep: string;

  if (direction === 'outgoing') {
    recursiveStep = `
      SELECT e.target_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.source_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
      ${projectFilter}
    `;
  } else if (direction === 'incoming') {
    recursiveStep = `
      SELECT e.source_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.target_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
      ${projectFilter}
    `;
  } else {
    // both directions
    recursiveStep = `
      SELECT e.target_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.source_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
      ${projectFilter}
      UNION ALL
      SELECT e.source_id, t.depth + 1, e.id
      FROM graph_edges e
      JOIN traverse t ON e.target_id = t.node_id
      WHERE t.depth < ?
      ${edgeTypeFilter}
      ${projectFilter}
    `;
  }

  const sql = `
    WITH RECURSIVE traverse(node_id, depth, edge_id) AS (
      SELECT ?, 0, NULL
      UNION ALL
      ${recursiveStep}
    )
    SELECT DISTINCT
      n.id AS n_id, n.type AS n_type, n.name AS n_name,
      n.metadata AS n_metadata, n.observation_ids AS n_observation_ids,
      n.created_at AS n_created_at, n.updated_at AS n_updated_at,
      e.id AS e_id, e.source_id AS e_source_id, e.target_id AS e_target_id,
      e.type AS e_type, e.weight AS e_weight, e.metadata AS e_metadata,
      e.created_at AS e_created_at,
      t.depth
    FROM traverse t
    JOIN graph_nodes n ON n.id = t.node_id
    LEFT JOIN graph_edges e ON e.id = t.edge_id
    WHERE t.depth > 0
  `;

  // Helper to push params for one recursive branch
  const pushBranchParams = (params: unknown[]) => {
    params.push(maxDepth);
    if (opts.edgeTypes) params.push(...opts.edgeTypes);
    if (opts.projectHash) params.push(opts.projectHash);
  };

  // Build parameter list depending on direction
  const queryParams: unknown[] = [nodeId]; // initial SELECT ?

  if (direction === 'both') {
    pushBranchParams(queryParams);
    pushBranchParams(queryParams);
  } else {
    pushBranchParams(queryParams);
  }

  const rows = db.prepare(sql).all(...queryParams) as TraversalRow[];

  return rows.map((row) => ({
    node: {
      id: row.n_id,
      type: row.n_type as EntityType,
      name: row.n_name,
      metadata: JSON.parse(row.n_metadata) as Record<string, unknown>,
      observation_ids: JSON.parse(row.n_observation_ids) as string[],
      created_at: row.n_created_at,
      updated_at: row.n_updated_at,
    },
    edge: row.e_id
      ? {
          id: row.e_id,
          source_id: row.e_source_id!,
          target_id: row.e_target_id!,
          type: row.e_type as RelationshipType,
          weight: row.e_weight!,
          metadata: JSON.parse(row.e_metadata!) as Record<string, unknown>,
          created_at: row.e_created_at!,
        }
      : null,
    depth: row.depth,
  }));
}

// =============================================================================
// Node Queries
// =============================================================================

/**
 * Returns all nodes of a given entity type.
 */
export function getNodesByType(
  db: BetterSqlite3.Database,
  type: EntityType,
  projectHash: string | null,
): GraphNode[] {
  if (projectHash) {
    const rows = db
      .prepare('SELECT * FROM graph_nodes WHERE type = ? AND project_hash = ?')
      .all(type, projectHash) as NodeRow[];
    return rows.map(rowToNode);
  }
  const rows = db
    .prepare('SELECT * FROM graph_nodes WHERE type = ?')
    .all(type) as NodeRow[];
  return rows.map(rowToNode);
}

/**
 * Looks up a node by name and type (composite natural key).
 * Returns null if no matching node exists.
 */
export function getNodeByNameAndType(
  db: BetterSqlite3.Database,
  name: string,
  type: EntityType,
  projectHash: string | null,
): GraphNode | null {
  if (projectHash) {
    const row = db
      .prepare('SELECT * FROM graph_nodes WHERE name = ? AND type = ? AND project_hash = ?')
      .get(name, type, projectHash) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }
  const row = db
    .prepare('SELECT * FROM graph_nodes WHERE name = ? AND type = ?')
    .get(name, type) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

// =============================================================================
// Edge Queries
// =============================================================================

/**
 * Returns edges connected to a node, filtered by direction.
 *
 * @param direction - 'outgoing' (source), 'incoming' (target), or 'both' (default: 'both')
 */
export function getEdgesForNode(
  db: BetterSqlite3.Database,
  nodeId: string,
  opts: { direction?: 'outgoing' | 'incoming' | 'both'; projectHash: string | null },
): GraphEdge[] {
  const direction = opts.direction ?? 'both';
  const pFilter = opts.projectHash ? ' AND project_hash = ?' : '';

  let sql: string;
  let params: unknown[];

  if (direction === 'outgoing') {
    sql = `SELECT * FROM graph_edges WHERE source_id = ?${pFilter}`;
    params = opts.projectHash ? [nodeId, opts.projectHash] : [nodeId];
  } else if (direction === 'incoming') {
    sql = `SELECT * FROM graph_edges WHERE target_id = ?${pFilter}`;
    params = opts.projectHash ? [nodeId, opts.projectHash] : [nodeId];
  } else {
    sql = `SELECT * FROM graph_edges WHERE (source_id = ? OR target_id = ?)${pFilter}`;
    params = opts.projectHash ? [nodeId, nodeId, opts.projectHash] : [nodeId, nodeId];
  }

  const rows = db.prepare(sql).all(...params) as EdgeRow[];
  return rows.map(rowToEdge);
}

/**
 * Returns the total number of edges connected to a node (both directions).
 * Used for degree enforcement (MAX_NODE_DEGREE constraint).
 */
export function countEdgesForNode(
  db: BetterSqlite3.Database,
  nodeId: string,
  projectHash: string | null,
): number {
  if (projectHash) {
    const result = db
      .prepare(
        'SELECT COUNT(*) as cnt FROM graph_edges WHERE (source_id = ? OR target_id = ?) AND project_hash = ?',
      )
      .get(nodeId, nodeId, projectHash) as { cnt: number };
    return result.cnt;
  }
  const result = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM graph_edges WHERE source_id = ? OR target_id = ?',
    )
    .get(nodeId, nodeId) as { cnt: number };
  return result.cnt;
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Inserts or updates a node by name+type composite key.
 *
 * If a node with the same name and type already exists, updates its metadata
 * and merges observation_ids. Otherwise, inserts a new node with a generated UUID.
 *
 * @returns The upserted GraphNode
 */
export function upsertNode(
  db: BetterSqlite3.Database,
  node: Omit<GraphNode, 'id' | 'created_at' | 'updated_at'> & { id?: string; project_hash: string | null },
): GraphNode {
  const existing = getNodeByNameAndType(db, node.name, node.type, node.project_hash);

  if (existing) {
    // Merge observation_ids (deduplicated)
    const mergedObsIds = [
      ...new Set([...existing.observation_ids, ...node.observation_ids]),
    ];

    // Merge metadata (new values override existing)
    const mergedMetadata = { ...existing.metadata, ...node.metadata };

    db.prepare(
      `UPDATE graph_nodes
       SET metadata = ?, observation_ids = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      JSON.stringify(mergedMetadata),
      JSON.stringify(mergedObsIds),
      existing.id,
    );

    const updated = db
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get(existing.id) as NodeRow;
    return rowToNode(updated);
  }

  // Insert new node
  const id = node.id ?? randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO graph_nodes (id, type, name, metadata, observation_ids, project_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    node.type,
    node.name,
    JSON.stringify(node.metadata),
    JSON.stringify(node.observation_ids),
    node.project_hash,
  );

  const inserted = db
    .prepare('SELECT * FROM graph_nodes WHERE id = ?')
    .get(id) as NodeRow;
  return rowToNode(inserted);
}

/**
 * Inserts an edge. On conflict (same source_id, target_id, type),
 * updates the weight to the maximum of existing and new values.
 *
 * @returns The inserted or updated GraphEdge
 */
export function insertEdge(
  db: BetterSqlite3.Database,
  edge: Omit<GraphEdge, 'id' | 'created_at'> & { id?: string; project_hash: string | null },
): GraphEdge {
  const id = edge.id ?? randomBytes(16).toString('hex');

  db.prepare(
    `INSERT INTO graph_edges (id, source_id, target_id, type, weight, metadata, project_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, target_id, type) DO UPDATE SET
       weight = MAX(graph_edges.weight, excluded.weight),
       metadata = excluded.metadata`,
  ).run(
    id,
    edge.source_id,
    edge.target_id,
    edge.type,
    edge.weight,
    JSON.stringify(edge.metadata),
    edge.project_hash,
  );

  // Retrieve the actual row (may be the existing row if conflict occurred)
  const inserted = db
    .prepare(
      'SELECT * FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?',
    )
    .get(edge.source_id, edge.target_id, edge.type) as EdgeRow;
  return rowToEdge(inserted);
}
