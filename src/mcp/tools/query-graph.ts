/**
 * MCP tool handler for knowledge graph queries.
 *
 * Allows Claude to search the knowledge graph for entities by name or type,
 * traverse relationships to a configurable depth, and see linked observation
 * excerpts. Results use progressive disclosure: entity list with connection
 * counts, then relationships, then observation excerpts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import {
  type EntityType,
  type RelationshipType,
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  isEntityType,
  isRelationshipType,
} from '../../graph/types.js';
import type { GraphNode, GraphEdge } from '../../graph/types.js';
import {
  initGraphSchema,
  traverseFrom,
  getNodeByNameAndType,
  getEdgesForNode,
  type TraversalResult,
} from '../../graph/schema.js';

// =============================================================================
// Types
// =============================================================================

export interface QueryGraphInput {
  query: string;
  entity_type?: EntityType;
  depth?: number;
  relationship_types?: RelationshipType[];
  limit?: number;
}

export interface QueryGraphOutput {
  entities: Array<{
    node: GraphNode;
    connectionCount: number;
    relationships: Array<{
      direction: 'outgoing' | 'incoming';
      type: RelationshipType;
      targetName: string;
      targetType: EntityType;
    }>;
  }>;
  observations: Array<{
    text: string;
    createdAt: string;
  }>;
  totalFound: number;
}

// =============================================================================
// Internal Row Types
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

interface ObsSnippetRow {
  content: string;
  created_at: string;
}

// =============================================================================
// Formatting Helpers
// =============================================================================

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '...';
}

function formatEntityType(type: EntityType): string {
  return `[${type}]`;
}

/**
 * Formats query results as readable text for Claude consumption.
 * Uses progressive disclosure: entity list -> relationships -> observations.
 */
function formatResults(
  rootNodes: GraphNode[],
  traversalsByNode: Map<string, TraversalResult[]>,
  observations: Array<{ text: string; createdAt: string }>,
  query: string,
): string {
  const lines: string[] = [];

  // Section: Entities Found
  lines.push('## Entities Found');
  lines.push('');

  for (const node of rootNodes) {
    const traversals = traversalsByNode.get(node.id) ?? [];
    const connectionCount = traversals.length;

    lines.push(
      `- ${formatEntityType(node.type)} ${node.name} (${connectionCount} connection${connectionCount !== 1 ? 's' : ''})`,
    );

    // Show relationships
    for (const t of traversals) {
      if (!t.edge) continue;
      const direction = t.edge.source_id === node.id ? '->' : '<-';
      lines.push(
        `  ${direction} ${t.edge.type} ${formatEntityType(t.node.type)} ${t.node.name}`,
      );
    }

    lines.push('');
  }

  // Section: Related Observations
  if (observations.length > 0) {
    lines.push('## Related Observations');
    lines.push('');

    for (const obs of observations) {
      const age = formatAge(obs.createdAt);
      const snippet = truncateText(obs.text.replace(/\n/g, ' '), 200);
      lines.push(`- "${snippet}" (${age})`);
    }
  }

  return lines.join('\n').trim();
}

/**
 * Simple relative time formatting.
 */
function formatAge(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;

  const months = Math.floor(days / 30);
  return `${months} month${months !== 1 ? 's' : ''} ago`;
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

function errorResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Registers the query_graph MCP tool on the server.
 *
 * Allows Claude to search entities by name (exact or fuzzy), filter by type,
 * traverse relationships to configurable depth, and see linked observations.
 */
export function registerQueryGraph(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHashRef: ProjectHashRef,
  notificationStore: NotificationStore | null = null,
): void {
  // Ensure graph schema is initialized
  initGraphSchema(db);

  server.registerTool(
    'query_graph',
    {
      title: 'Query Knowledge Graph',
      description:
        "Query the knowledge graph to find entities and their relationships. Use to answer questions like 'what files does this decision affect?' or 'what references informed this change?'",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Entity name or search text to look for'),
        entity_type: z
          .string()
          .optional()
          .describe(
            `Filter to entity type: ${ENTITY_TYPES.join(', ')}`,
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(2)
          .describe('Traversal depth (default: 2, max: 4)'),
        relationship_types: z
          .array(z.string())
          .optional()
          .describe(
            `Filter to relationship types: ${RELATIONSHIP_TYPES.join(', ')}`,
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Max root entities to return (default: 20, max: 50)'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(
          prependNotifications(notificationStore, projectHash, text),
        );

      try {
        debug('mcp', 'query_graph: request', {
          query: args.query,
          entity_type: args.entity_type,
          depth: args.depth,
        });

        // Validate entity_type if provided
        if (args.entity_type !== undefined && !isEntityType(args.entity_type)) {
          return errorResponse(
            `Invalid entity_type "${args.entity_type}". Valid types: ${ENTITY_TYPES.join(', ')}`,
          );
        }
        const entityType = args.entity_type as EntityType | undefined;

        // Validate relationship_types if provided
        if (args.relationship_types) {
          for (const rt of args.relationship_types) {
            if (!isRelationshipType(rt)) {
              return errorResponse(
                `Invalid relationship_type "${rt}". Valid types: ${RELATIONSHIP_TYPES.join(', ')}`,
              );
            }
          }
        }
        const relationshipTypes = args.relationship_types as
          | RelationshipType[]
          | undefined;

        // Search strategy: exact match first, then fuzzy LIKE search
        const rootNodes: GraphNode[] = [];

        // 1. Try exact name match (optionally filtered by type)
        if (entityType) {
          const exact = getNodeByNameAndType(db, args.query, entityType);
          if (exact) rootNodes.push(exact);
        } else {
          // Try exact match across all types
          for (const t of ENTITY_TYPES) {
            const exact = getNodeByNameAndType(db, args.query, t);
            if (exact) {
              rootNodes.push(exact);
              break; // Take first exact match
            }
          }
        }

        // 2. If no exact match, try case-insensitive LIKE search
        if (rootNodes.length === 0) {
          const likePattern = `%${args.query}%`;
          let sql: string;
          const params: unknown[] = [likePattern];

          if (entityType) {
            sql =
              'SELECT * FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE AND type = ? LIMIT ?';
            params.push(entityType, args.limit);
          } else {
            sql =
              'SELECT * FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE LIMIT ?';
            params.push(args.limit);
          }

          const rows = db.prepare(sql).all(...params) as NodeRow[];
          for (const row of rows) {
            rootNodes.push({
              id: row.id,
              type: row.type as EntityType,
              name: row.name,
              metadata: JSON.parse(row.metadata) as Record<string, unknown>,
              observation_ids: JSON.parse(row.observation_ids) as string[],
              created_at: row.created_at,
              updated_at: row.updated_at,
            });
          }
        }

        // No results found
        if (rootNodes.length === 0) {
          const suggestions = entityType
            ? `Try searching without the entity_type filter, or try a different name.`
            : `Try: entity types ${ENTITY_TYPES.join(', ')}`;
          return withNotifications(
            `No entities matching "${args.query}" found. ${suggestions}`,
          );
        }

        // 3. Traverse from each root node
        const traversalsByNode = new Map<string, TraversalResult[]>();

        for (const node of rootNodes) {
          const results = traverseFrom(db, node.id, {
            depth: args.depth,
            edgeTypes: relationshipTypes,
            direction: 'both',
          });
          traversalsByNode.set(node.id, results);
        }

        // 4. Collect observation snippets from root nodes
        const allObsIds = new Set<string>();
        for (const node of rootNodes) {
          for (const obsId of node.observation_ids) {
            allObsIds.add(obsId);
          }
        }

        const observations: Array<{ text: string; createdAt: string }> = [];
        if (allObsIds.size > 0) {
          const obsIdList = [...allObsIds];
          const placeholders = obsIdList.map(() => '?').join(', ');
          const obsRows = db
            .prepare(
              `SELECT content, created_at FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
            )
            .all(...obsIdList) as ObsSnippetRow[];

          for (const row of obsRows) {
            observations.push({
              text: row.content,
              createdAt: row.created_at,
            });
          }
        }

        // 5. Format and return
        const formatted = formatResults(
          rootNodes,
          traversalsByNode,
          observations,
          args.query,
        );

        debug('mcp', 'query_graph: returning', {
          rootNodes: rootNodes.length,
          totalTraversals: [...traversalsByNode.values()].reduce(
            (sum, arr) => sum + arr.length,
            0,
          ),
          observations: observations.length,
        });

        return withNotifications(formatted);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'query_graph: error', { error: message });
        return errorResponse(`Graph query error: ${message}`);
      }
    },
  );
}
