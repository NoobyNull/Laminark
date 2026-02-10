import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import { StashManager } from '../../storage/stash-manager.js';
import type { NotificationStore } from '../../storage/notifications.js';
import type { ContextStash } from '../../types/stash.js';
import { timeAgo } from '../../commands/resume.js';

// ---------------------------------------------------------------------------
// Formatting helpers (progressive disclosure)
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/**
 * Compact format: numbered list of topic labels with relative time.
 */
function formatCompact(stashes: ContextStash[]): string {
  return stashes
    .map(
      (s, i) =>
        `${i + 1}. ${s.topicLabel} (${timeAgo(s.createdAt)})`,
    )
    .join('\n');
}

/**
 * Detail format: topic labels with summaries.
 */
function formatDetail(stashes: ContextStash[]): string {
  return stashes
    .map(
      (s, i) =>
        `${i + 1}. **${s.topicLabel}** (${timeAgo(s.createdAt)})\n   ${truncate(s.summary, 120)}`,
    )
    .join('\n\n');
}

/**
 * Full format: topic labels, summaries, observation count, and first few observation snippets.
 */
function formatFull(stashes: ContextStash[]): string {
  return stashes
    .map((s, i) => {
      const lines = [
        `${i + 1}. **${s.topicLabel}** (${timeAgo(s.createdAt)})`,
        `   ${s.summary}`,
        `   Observations: ${s.observationSnapshots.length}`,
      ];

      // Show first 3 observation snippets
      const previews = s.observationSnapshots.slice(0, 3);
      for (const obs of previews) {
        lines.push(`   - ${truncate(obs.content.replace(/\n/g, ' '), 80)}`);
      }
      if (s.observationSnapshots.length > 3) {
        lines.push(
          `   ... and ${s.observationSnapshots.length - 3} more`,
        );
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Formats stashes using progressive disclosure based on count.
 * - 1-3 stashes: full detail
 * - 4-8 stashes: detail (summaries)
 * - 9+: compact (labels only)
 */
export function formatStashes(stashes: ContextStash[]): string {
  if (stashes.length <= 3) return formatFull(stashes);
  if (stashes.length <= 8) return formatDetail(stashes);
  return formatCompact(stashes);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

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

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ---------------------------------------------------------------------------
// registerTopicContext
// ---------------------------------------------------------------------------

/**
 * Registers the topic_context MCP tool.
 *
 * Shows recently stashed context threads. Used when the user asks
 * "where was I?" or wants to see abandoned conversation threads.
 */
export function registerTopicContext(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHash: string,
  notificationStore: NotificationStore | null = null,
): void {
  const stashManager = new StashManager(db);

  server.registerTool(
    'topic_context',
    {
      title: 'Topic Context',
      description:
        "Shows recently stashed context threads. Use when the user asks 'where was I?' or wants to see abandoned conversation threads.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional search query to filter threads by topic label or summary'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('Max threads to return'),
      },
    },
    async (args) => {
      // Helper to wrap textResponse with pending notifications
      const withNotifications = (text: string) =>
        textResponse(prependNotifications(notificationStore, projectHash, text));

      try {
        debug('mcp', 'topic_context: request', { query: args.query, limit: args.limit });

        let stashes = stashManager.getRecentStashes(projectHash, args.limit);

        // Filter by query if provided (case-insensitive match on topicLabel or summary)
        if (args.query) {
          const q = args.query.toLowerCase();
          stashes = stashes.filter(
            (s) =>
              s.topicLabel.toLowerCase().includes(q) ||
              s.summary.toLowerCase().includes(q),
          );
        }

        if (stashes.length === 0) {
          return withNotifications(
            'No stashed context threads found. You\'re working in a single thread.',
          );
        }

        const formatted = formatStashes(stashes);
        const footer = `\n---\n${stashes.length} stashed thread(s) | Use /laminark:resume {id} to restore`;

        debug('mcp', 'topic_context: returning', { count: stashes.length });

        return withNotifications(formatted + footer);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'topic_context: error', { error: message });
        return textResponse(`Error retrieving context threads: ${message}`);
      }
    },
  );
}
