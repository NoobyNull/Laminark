/**
 * MCP tool handler for graph statistics and health metrics.
 *
 * Provides a dashboard view of the knowledge graph: node/edge counts,
 * entity type distribution, relationship type distribution, degree stats,
 * hotspots (nodes near edge limit), duplicate candidates, and staleness flags.
 *
 * No input parameters -- this is a read-only dashboard.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import {
  type EntityType,
  type RelationshipType,
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  MAX_NODE_DEGREE,
} from '../../graph/types.js';
import { initGraphSchema } from '../../graph/schema.js';
import { initStalenessSchema } from '../../graph/staleness.js';

// =============================================================================
// Types
// =============================================================================

export interface GraphStatsOutput {
  total_nodes: number;
  total_edges: number;
  by_entity_type: Record<string, number>;
  by_relationship_type: Record<string, number>;
  avg_degree: number;
  max_degree: { node_name: string; node_type: EntityType; degree: number } | null;
  hotspots: Array<{ name: string; type: EntityType; degree: number }>;
  duplicate_candidates: number;
  staleness_flags: number;
}

// =============================================================================
// Internal Row Types
// =============================================================================

interface CountRow {
  type: string;
  cnt: number;
}

interface DegreeRow {
  node_id: string;
  node_name: string;
  node_type: string;
  degree: number;
}

// =============================================================================
// Stats Collection
// =============================================================================

/**
 * Collects comprehensive graph statistics directly from the database.
 * Does not depend on constraints module (which may not be built yet).
 */
function collectGraphStats(db: BetterSqlite3.Database): GraphStatsOutput {
  // Total counts
  const totalNodes =
    (db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number })
      .cnt;
  const totalEdges =
    (db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number })
      .cnt;

  // By entity type
  const entityCounts = db
    .prepare('SELECT type, COUNT(*) as cnt FROM graph_nodes GROUP BY type')
    .all() as CountRow[];
  const byEntityType: Record<string, number> = {};
  for (const t of ENTITY_TYPES) {
    byEntityType[t] = 0;
  }
  for (const row of entityCounts) {
    byEntityType[row.type] = row.cnt;
  }

  // By relationship type
  const relCounts = db
    .prepare('SELECT type, COUNT(*) as cnt FROM graph_edges GROUP BY type')
    .all() as CountRow[];
  const byRelType: Record<string, number> = {};
  for (const t of RELATIONSHIP_TYPES) {
    byRelType[t] = 0;
  }
  for (const row of relCounts) {
    byRelType[row.type] = row.cnt;
  }

  // Degree statistics
  const avgDegree =
    totalNodes > 0 ? (totalEdges * 2) / totalNodes : 0;

  // Max degree node -- count edges in both directions per node
  const degreeRows = db
    .prepare(
      `SELECT n.id as node_id, n.name as node_name, n.type as node_type,
              (SELECT COUNT(*) FROM graph_edges WHERE source_id = n.id OR target_id = n.id) as degree
       FROM graph_nodes n
       ORDER BY degree DESC
       LIMIT 10`,
    )
    .all() as DegreeRow[];

  let maxDegreeEntry: { node_name: string; node_type: EntityType; degree: number } | null =
    null;
  const hotspots: Array<{ name: string; type: EntityType; degree: number }> = [];
  const hotspotThreshold = Math.floor(MAX_NODE_DEGREE * 0.8); // 80% of limit

  for (const row of degreeRows) {
    if (!maxDegreeEntry || row.degree > maxDegreeEntry.degree) {
      maxDegreeEntry = {
        node_name: row.node_name,
        node_type: row.node_type as EntityType,
        degree: row.degree,
      };
    }
    if (row.degree >= hotspotThreshold) {
      hotspots.push({
        name: row.node_name,
        type: row.node_type as EntityType,
        degree: row.degree,
      });
    }
  }

  // Duplicate candidates: nodes with same name but different type
  const dupCount =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM (
            SELECT name FROM graph_nodes GROUP BY name HAVING COUNT(DISTINCT type) > 1
          )`,
        )
        .get() as { cnt: number }
    ).cnt;

  // Staleness flags count
  let stalenessCount = 0;
  try {
    initStalenessSchema(db);
    stalenessCount =
      (
        db
          .prepare(
            'SELECT COUNT(*) as cnt FROM staleness_flags WHERE resolved = 0',
          )
          .get() as { cnt: number }
      ).cnt;
  } catch {
    // staleness_flags table may not exist yet
    stalenessCount = 0;
  }

  return {
    total_nodes: totalNodes,
    total_edges: totalEdges,
    by_entity_type: byEntityType,
    by_relationship_type: byRelType,
    avg_degree: Math.round(avgDegree * 10) / 10,
    max_degree: maxDegreeEntry,
    hotspots,
    duplicate_candidates: dupCount,
    staleness_flags: stalenessCount,
  };
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * Formats graph stats as a readable dashboard for Claude.
 */
function formatStats(stats: GraphStatsOutput): string {
  const lines: string[] = [];

  // Header
  lines.push('## Knowledge Graph Stats');
  lines.push(
    `Nodes: ${stats.total_nodes} | Edges: ${stats.total_edges} | Avg degree: ${stats.avg_degree}`,
  );
  lines.push('');

  // Entity Distribution
  lines.push('### Entity Distribution');
  const entityParts: string[] = [];
  for (const t of ENTITY_TYPES) {
    const count = stats.by_entity_type[t] ?? 0;
    if (count > 0) {
      entityParts.push(`${t}: ${count}`);
    }
  }
  lines.push(entityParts.length > 0 ? entityParts.join(' | ') : 'No entities yet');
  lines.push('');

  // Relationship Distribution
  lines.push('### Relationship Distribution');
  const relParts: string[] = [];
  for (const t of RELATIONSHIP_TYPES) {
    const count = stats.by_relationship_type[t] ?? 0;
    if (count > 0) {
      relParts.push(`${t}: ${count}`);
    }
  }
  lines.push(relParts.length > 0 ? relParts.join(' | ') : 'No relationships yet');
  lines.push('');

  // Health
  lines.push('### Health');
  if (stats.hotspots.length > 0) {
    const hotspotStr = stats.hotspots
      .map((h) => `${h.name} (${h.degree} edges)`)
      .join(', ');
    lines.push(`Hotspots (near ${MAX_NODE_DEGREE}-edge limit): ${hotspotStr}`);
  } else {
    lines.push('Hotspots: none (all nodes well within edge limits)');
  }
  lines.push(`Duplicate candidates: ${stats.duplicate_candidates} name${stats.duplicate_candidates !== 1 ? 's' : ''}`);
  lines.push(`Stale observations: ${stats.staleness_flags}`);

  if (stats.max_degree) {
    lines.push('');
    lines.push(
      `Most connected: ${stats.max_degree.node_name} (${stats.max_degree.node_type}, ${stats.max_degree.degree} edges)`,
    );
  }

  return lines.join('\n');
}

// =============================================================================
// Response Helpers
// =============================================================================

function prependNotifications(
  notificationStore: NotificationStore | null,
  projectHash: string,
  responseText: string,
): string {
  if (!notificationStore) return responseText;
  const pending = notificationStore.consumePending(projectHash);
  if (pending.length === 0) return responseText;
  const banner = pending.map((n) => `[Laminark] ${n.message}`).join('\n');
  return banner + '\n\n' + responseText;
}

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Registers the graph_stats MCP tool on the server.
 *
 * Returns comprehensive knowledge graph health metrics: entity/relationship
 * type distribution, degree statistics, hotspot nodes, duplicate candidates,
 * and staleness flags. No input parameters -- dashboard view.
 */
export function registerGraphStats(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHashRef: ProjectHashRef,
  notificationStore: NotificationStore | null = null,
): void {
  // Ensure graph schema is initialized
  initGraphSchema(db);

  server.registerTool(
    'graph_stats',
    {
      title: 'Graph Statistics',
      description:
        'Get knowledge graph statistics: entity counts, relationship distribution, health metrics. Use to understand the state of accumulated knowledge.',
      inputSchema: {},
    },
    async () => {
      const projectHash = projectHashRef.current;
      try {
        debug('mcp', 'graph_stats: request');

        const stats = collectGraphStats(db);
        const formatted = formatStats(stats);

        debug('mcp', 'graph_stats: returning', {
          nodes: stats.total_nodes,
          edges: stats.total_edges,
        });

        return textResponse(
          prependNotifications(notificationStore, projectHash, formatted),
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'graph_stats: error', { error: message });
        return textResponse(`Graph stats error: ${message}`);
      }
    },
  );
}
