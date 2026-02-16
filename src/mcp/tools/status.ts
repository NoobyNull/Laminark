/**
 * MCP tool handler for Laminark system status.
 *
 * Returns a compact dashboard: connection info, memory counts,
 * token estimates, and capability flags. No input parameters.
 *
 * The heavy lifting (SQL queries, formatting) lives in StatusCache.
 * This handler just returns the pre-built string.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import type { StatusCache } from '../status-cache.js';

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

export function registerStatus(
  server: McpServer,
  cache: StatusCache,
  projectHashRef: ProjectHashRef,
  notificationStore: NotificationStore | null = null,
): void {
  server.registerTool(
    'status',
    {
      title: 'Laminark Status',
      description:
        'Show Laminark system status: connection info, memory count, token estimates, and capabilities.',
      inputSchema: {},
    },
    async () => {
      const projectHash = projectHashRef.current;
      try {
        debug('mcp', 'status: request (cached)');

        const formatted = cache.getFormatted();

        return textResponse(
          prependNotifications(notificationStore, projectHash, formatted),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'status: error', { error: message });
        return textResponse(`Status error: ${message}`);
      }
    },
  );
}
