/**
 * MCP tool handler for discovering available tools by keyword or semantic search.
 *
 * Allows Claude to search the tool registry for MCP servers, slash commands,
 * skills, and plugins. Supports hybrid search (FTS5 keyword + vec0 vector)
 * with scope filtering and deduplication of server-level vs individual tool entries.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { ToolSearchResult } from '../../shared/tool-types.js';
import type { ToolRegistryRepository } from '../../storage/tool-registry.js';
import type { AnalysisWorker } from '../../analysis/worker-bridge.js';
import type { NotificationStore } from '../../storage/notifications.js';
import { enforceTokenBudget, TOKEN_BUDGET } from '../token-budget.js';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function prependNotifications(
  notificationStore: NotificationStore | null,
  projectHash: string,
  responseText: string,
): string {
  if (!notificationStore) return responseText;
  const pending = notificationStore.consumePending(projectHash);
  if (pending.length === 0) return responseText;
  const banner = pending.map(n => `[Laminark] ${n.message}`).join('\n');
  return banner + '\n\n' + responseText;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatToolResult(result: ToolSearchResult, index: number): string {
  const { tool, score } = result;
  const description = tool.description ? ` -- ${tool.description}` : '';
  const statusTag = tool.status !== 'active' ? ` [${tool.status}]` : '';
  const usageStr = tool.usage_count > 0 ? `${tool.usage_count} uses` : 'never used';
  const lastUsedStr = tool.last_used_at ? `last: ${tool.last_used_at.slice(0, 10)}` : 'never';
  return `${index}. ${tool.name}${statusTag}${description}\n   [${tool.scope}] | ${usageStr} | ${lastUsedStr} | score: ${score.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Registers the discover_tools MCP tool on the server.
 *
 * Allows Claude to search the tool registry by keyword or semantic description,
 * with optional scope filtering. Returns ranked results with scope, usage count,
 * and last used timestamp metadata.
 */
export function registerDiscoverTools(
  server: McpServer,
  toolRegistry: ToolRegistryRepository,
  worker: AnalysisWorker | null,
  hasVectorSupport: boolean,
  notificationStore: NotificationStore | null,
  projectHashRef: ProjectHashRef,
): void {
  server.registerTool(
    'discover_tools',
    {
      title: 'Discover Tools',
      description:
        'Search the tool registry to find available tools by keyword or description. Supports semantic search -- "file manipulation" finds tools described as "read and write files". Returns scope, usage count, and last used timestamp for each result.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Search query: keywords or natural language description'),
        scope: z
          .enum(['global', 'project', 'plugin'])
          .optional()
          .describe('Optional scope filter. Omit to search all scopes.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Maximum results to return (default: 20)'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(prependNotifications(notificationStore, projectHash, text));

      try {
        debug('mcp', 'discover_tools: request', {
          query: args.query,
          scope: args.scope,
          limit: args.limit,
        });

        // Search the tool registry (hybrid FTS5 + vector via RRF)
        const searchResults = await toolRegistry.searchTools(args.query, {
          scope: args.scope,
          limit: args.limit,
          worker,
          hasVectorSupport,
        });

        // Zero results
        if (searchResults.length === 0) {
          const scopeContext = args.scope ? ` in scope "${args.scope}"` : '';
          return withNotifications(
            `No tools found matching "${args.query}"${scopeContext}.`,
          );
        }

        // Deduplicate: prefer mcp_server entries over individual mcp_tool entries
        const seenServers = new Set<string>();
        for (const result of searchResults) {
          if (result.tool.tool_type === 'mcp_server') {
            seenServers.add(result.tool.server_name ?? result.tool.name);
          }
        }
        const deduped = searchResults.filter(result => {
          if (
            result.tool.tool_type === 'mcp_tool' &&
            result.tool.server_name &&
            seenServers.has(result.tool.server_name)
          ) {
            return false;
          }
          return true;
        });

        // Format results with token budget enforcement
        const budgetResult = enforceTokenBudget(
          deduped,
          (r) => formatToolResult(r, deduped.indexOf(r) + 1),
          TOKEN_BUDGET,
        );

        const body = budgetResult.items
          .map((r, i) => formatToolResult(r, i + 1))
          .join('\n');

        // Metadata footer
        const scopeLabel = args.scope ?? 'all';
        let footer = `---\n${deduped.length} result(s) | query: "${args.query}" | scope: ${scopeLabel}`;
        if (budgetResult.truncated) {
          footer += ' | truncated';
        }

        debug('mcp', 'discover_tools: returning', {
          total: searchResults.length,
          deduped: deduped.length,
          displayed: budgetResult.items.length,
          truncated: budgetResult.truncated,
        });

        return withNotifications(`${body}\n${footer}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'discover_tools: error', { error: message });
        return errorResponse(`Discover tools error: ${message}`);
      }
    },
  );
}
