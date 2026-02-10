/**
 * Graph constraint enforcement.
 *
 * Maintains graph health through:
 *   - Entity type taxonomy validation (defense-in-depth with SQL CHECK)
 *   - Relationship type taxonomy validation
 *   - Max degree enforcement (prune lowest-weight edges when cap exceeded)
 *   - Entity deduplication detection and merging
 *   - Graph health dashboard metrics
 *
 * All enforcement functions use transactions for atomicity.
 * Significant actions (pruning, merging) are logged with [laminark:graph] prefix.
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { EntityType, RelationshipType, GraphNode, GraphEdge } from './types.js';
import {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  MAX_NODE_DEGREE,
} from './types.js';
import {
  getEdgesForNode,
  countEdgesForNode,
  getNodesByType,
} from './schema.js';

// =============================================================================
// Type Validation
// =============================================================================

/**
 * Runtime validation for entity types. Defense-in-depth alongside SQL CHECK.
 */
export function validateEntityType(type: string): type is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(type);
}

/**
 * Runtime validation for relationship types. Defense-in-depth alongside SQL CHECK.
 */
export function validateRelationshipType(type: string): type is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(type);
}

// =============================================================================
// Max Degree Enforcement
// =============================================================================

/**
 * Enforces maximum edge count on a node by pruning lowest-weight edges.
 *
 * When a node exceeds maxDegree edges:
 *   1. Get all edges for the node
 *   2. Sort by weight ascending (lowest first)
 *   3. Delete lowest-weight edges until count <= maxDegree
 *   4. Log pruned count with [laminark:graph] prefix
 *
 * Runs in a transaction to prevent race conditions.
 *
 * @param db - Database handle
 * @param nodeId - The node to enforce degree cap on
 * @param maxDegree - Maximum allowed edges (default: MAX_NODE_DEGREE = 50)
 * @returns Object with pruned count and remaining count
 */
export function enforceMaxDegree(
  db: BetterSqlite3.Database,
  nodeId: string,
  maxDegree: number = MAX_NODE_DEGREE,
): { pruned: number; remaining: number } {
  const enforce = db.transaction(() => {
    const currentCount = countEdgesForNode(db, nodeId);

    if (currentCount <= maxDegree) {
      return { pruned: 0, remaining: currentCount };
    }

    // Get all edges, sorted by weight ascending (lowest first)
    const edges = getEdgesForNode(db, nodeId);
    edges.sort((a, b) => a.weight - b.weight);

    const toPrune = currentCount - maxDegree;
    const edgesToDelete = edges.slice(0, toPrune);

    const deleteStmt = db.prepare('DELETE FROM graph_edges WHERE id = ?');
    for (const edge of edgesToDelete) {
      deleteStmt.run(edge.id);
    }

    const remaining = currentCount - toPrune;

    process.stderr.write(
      `[laminark:graph] Pruned ${toPrune} lowest-weight edges from node ${nodeId} (${remaining} remaining)\n`,
    );

    return { pruned: toPrune, remaining };
  });

  return enforce();
}

// =============================================================================
// Entity Merging
// =============================================================================

/**
 * Merges one entity node into another. The keepId node survives.
 *
 * Steps:
 *   1. Union observation_ids from both nodes (no duplicates)
 *   2. Reroute all edges from mergeId to keepId
 *   3. Handle duplicate edge conflicts (keep higher weight)
 *   4. Delete the mergeId node
 *
 * Runs in a transaction for atomicity.
 *
 * @param db - Database handle
 * @param keepId - The node to keep (survives merge)
 * @param mergeId - The node to merge and delete
 */
export function mergeEntities(
  db: BetterSqlite3.Database,
  keepId: string,
  mergeId: string,
): void {
  const merge = db.transaction(() => {
    // Step 1: Get both nodes and merge observation_ids
    const keepRow = db
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get(keepId) as { observation_ids: string; metadata: string } | undefined;
    const mergeRow = db
      .prepare('SELECT * FROM graph_nodes WHERE id = ?')
      .get(mergeId) as { observation_ids: string; metadata: string } | undefined;

    if (!keepRow || !mergeRow) {
      throw new Error(`Cannot merge: one or both nodes not found (keep=${keepId}, merge=${mergeId})`);
    }

    const keepObsIds = JSON.parse(keepRow.observation_ids) as string[];
    const mergeObsIds = JSON.parse(mergeRow.observation_ids) as string[];
    const mergedObsIds = [...new Set([...keepObsIds, ...mergeObsIds])];

    // Merge metadata (merge node values fill gaps, keep node values take priority)
    const keepMeta = JSON.parse(keepRow.metadata) as Record<string, unknown>;
    const mergeMeta = JSON.parse(mergeRow.metadata) as Record<string, unknown>;
    const mergedMeta = { ...mergeMeta, ...keepMeta };

    db.prepare(
      `UPDATE graph_nodes SET observation_ids = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(mergedObsIds), JSON.stringify(mergedMeta), keepId);

    // Step 2: Get all edges connected to the merge node
    const mergeEdges = getEdgesForNode(db, mergeId);

    // Step 3: Reroute edges from mergeId to keepId
    for (const edge of mergeEdges) {
      let newSourceId = edge.source_id;
      let newTargetId = edge.target_id;

      if (edge.source_id === mergeId) {
        newSourceId = keepId;
      }
      if (edge.target_id === mergeId) {
        newTargetId = keepId;
      }

      // Skip self-loops (would happen if both source and target are the merge/keep pair)
      if (newSourceId === newTargetId) {
        db.prepare('DELETE FROM graph_edges WHERE id = ?').run(edge.id);
        continue;
      }

      // Check if rerouted edge would create a duplicate
      const existing = db
        .prepare(
          'SELECT id, weight FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?',
        )
        .get(newSourceId, newTargetId, edge.type) as
        | { id: string; weight: number }
        | undefined;

      if (existing && existing.id !== edge.id) {
        // Duplicate: keep higher weight, delete the lower one
        if (edge.weight > existing.weight) {
          db.prepare('UPDATE graph_edges SET weight = ? WHERE id = ?').run(
            edge.weight,
            existing.id,
          );
        }
        db.prepare('DELETE FROM graph_edges WHERE id = ?').run(edge.id);
      } else if (!existing) {
        // No duplicate: update the edge to point to keepId
        db.prepare(
          'UPDATE graph_edges SET source_id = ?, target_id = ? WHERE id = ?',
        ).run(newSourceId, newTargetId, edge.id);
      }
      // If existing.id === edge.id, it's already correct (no-op)
    }

    // Step 4: Delete the merged node
    db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(mergeId);

    process.stderr.write(
      `[laminark:graph] Merged entity ${mergeId} into ${keepId} (${mergeEdges.length} edges rerouted)\n`,
    );
  });

  merge();
}

// =============================================================================
// Duplicate Detection
// =============================================================================

/**
 * Common abbreviation mappings for duplicate detection.
 * Maps lowercase abbreviation -> lowercase full name.
 */
const ABBREVIATION_MAP: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  pg: 'postgresql',
  postgres: 'postgresql',
  mongo: 'mongodb',
  k8s: 'kubernetes',
  tf: 'terraform',
  gh: 'github',
  gl: 'gitlab',
  ci: 'circleci',
  gql: 'graphql',
  tw: 'tailwind',
  tailwindcss: 'tailwind',
  sw: 'swc',
  np: 'numpy',
  pd: 'pandas',
  wp: 'webpack',
  nx: 'next',
};

/**
 * Finds potential duplicate entities in the graph.
 *
 * Detection strategies:
 *   a. Case-insensitive name match (e.g., "React" and "react")
 *   b. Common abbreviation match (e.g., "TS" and "TypeScript")
 *   c. Path normalization for Files (strip ./, normalize separators)
 *
 * Returns grouped duplicate candidates with reasons. This is a
 * SUGGESTION function -- use mergeEntities() to act on results.
 *
 * @param db - Database handle
 * @param opts - Optional filter by entity type
 * @returns Array of duplicate groups with entities and reason
 */
export function findDuplicateEntities(
  db: BetterSqlite3.Database,
  opts?: { type?: EntityType },
): Array<{ entities: GraphNode[]; reason: string }> {
  // Get all nodes, optionally filtered by type
  let nodes: GraphNode[];
  if (opts?.type) {
    nodes = getNodesByType(db, opts.type);
  } else {
    const allTypes = ENTITY_TYPES;
    nodes = [];
    for (const type of allTypes) {
      nodes.push(...getNodesByType(db, type));
    }
  }

  const duplicates: Array<{ entities: GraphNode[]; reason: string }> = [];
  const seen = new Set<string>(); // Track already-grouped node IDs

  // Strategy A: Case-insensitive name match within same type
  const byTypeAndLowerName = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = `${node.type}:${node.name.toLowerCase()}`;
    const group = byTypeAndLowerName.get(key) ?? [];
    group.push(node);
    byTypeAndLowerName.set(key, group);
  }

  for (const [, group] of byTypeAndLowerName) {
    if (group.length > 1) {
      const ids = group.map((n) => n.id).sort().join(',');
      if (!seen.has(ids)) {
        seen.add(ids);
        duplicates.push({
          entities: group,
          reason: `Case-insensitive name match: "${group[0].name}" and "${group[1].name}"`,
        });
      }
    }
  }

  // Strategy B: Common abbreviation match within same type
  const byTypeAndCanonical = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const lower = node.name.toLowerCase();
    const canonical = ABBREVIATION_MAP[lower] ?? lower;
    const key = `${node.type}:${canonical}`;
    const group = byTypeAndCanonical.get(key) ?? [];
    group.push(node);
    byTypeAndCanonical.set(key, group);
  }

  for (const [, group] of byTypeAndCanonical) {
    if (group.length > 1) {
      // Check if this is a genuine abbreviation match (not just case match already found)
      const names = new Set(group.map((n) => n.name.toLowerCase()));
      if (names.size > 1) {
        const ids = group.map((n) => n.id).sort().join(',');
        if (!seen.has(ids)) {
          seen.add(ids);
          duplicates.push({
            entities: group,
            reason: `Common abbreviation match: "${group[0].name}" and "${group[1].name}"`,
          });
        }
      }
    }
  }

  // Strategy C: Path normalization for File type
  if (!opts?.type || opts.type === 'File') {
    const fileNodes = nodes.filter((n) => n.type === 'File');
    const byNormalizedPath = new Map<string, GraphNode[]>();

    for (const node of fileNodes) {
      let normalized = node.name;
      // Strip leading ./
      if (normalized.startsWith('./')) normalized = normalized.slice(2);
      // Normalize separators
      normalized = normalized.replace(/\\/g, '/');
      // Collapse double slashes
      normalized = normalized.replace(/\/\//g, '/');
      // Lowercase for comparison
      normalized = normalized.toLowerCase();

      const key = `File:${normalized}`;
      const group = byNormalizedPath.get(key) ?? [];
      group.push(node);
      byNormalizedPath.set(key, group);
    }

    for (const [, group] of byNormalizedPath) {
      if (group.length > 1) {
        const ids = group.map((n) => n.id).sort().join(',');
        if (!seen.has(ids)) {
          seen.add(ids);
          duplicates.push({
            entities: group,
            reason: `Path normalization match: "${group[0].name}" and "${group[1].name}"`,
          });
        }
      }
    }
  }

  return duplicates;
}

// =============================================================================
// Graph Health Dashboard
// =============================================================================

interface NodeRow {
  id: string;
  type: string;
  name: string;
  metadata: string;
  observation_ids: string;
  created_at: string;
  updated_at: string;
}

/**
 * Returns dashboard-style health metrics for the knowledge graph.
 *
 * Metrics:
 *   - totalNodes: total entity count
 *   - totalEdges: total relationship count
 *   - avgDegree: average edges per node
 *   - maxDegree: highest edge count on any single node
 *   - hotspots: nodes with degree > 0.8 * MAX_NODE_DEGREE
 *   - duplicateCandidates: number of detected duplicate groups
 */
export function getGraphHealth(db: BetterSqlite3.Database): {
  totalNodes: number;
  totalEdges: number;
  avgDegree: number;
  maxDegree: number;
  hotspots: Array<{ node: GraphNode; degree: number }>;
  duplicateCandidates: number;
} {
  const totalNodes =
    (db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }).cnt;
  const totalEdges =
    (db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }).cnt;

  const avgDegree = totalNodes > 0 ? (totalEdges * 2) / totalNodes : 0;

  // Find max degree and hotspot nodes
  const hotspotThreshold = Math.floor(0.8 * MAX_NODE_DEGREE);
  let maxDeg = 0;
  const hotspots: Array<{ node: GraphNode; degree: number }> = [];

  if (totalNodes > 0) {
    // Get degree for each node using a correlated subquery
    const degreeRows = db
      .prepare(
        `SELECT n.*,
          (SELECT COUNT(*) FROM graph_edges WHERE source_id = n.id OR target_id = n.id) as degree
        FROM graph_nodes n
        WHERE (SELECT COUNT(*) FROM graph_edges WHERE source_id = n.id OR target_id = n.id) > 0
        ORDER BY degree DESC`,
      )
      .all() as Array<NodeRow & { degree: number }>;

    for (const row of degreeRows) {
      if (row.degree > maxDeg) maxDeg = row.degree;

      if (row.degree > hotspotThreshold) {
        hotspots.push({
          node: {
            id: row.id,
            type: row.type as EntityType,
            name: row.name,
            metadata: JSON.parse(row.metadata) as Record<string, unknown>,
            observation_ids: JSON.parse(row.observation_ids) as string[],
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
          degree: row.degree,
        });
      }
    }
  }

  // Count duplicate candidates
  const dupes = findDuplicateEntities(db);

  return {
    totalNodes,
    totalEdges,
    avgDegree,
    maxDegree: maxDeg,
    hotspots,
    duplicateCandidates: dupes.length,
  };
}
