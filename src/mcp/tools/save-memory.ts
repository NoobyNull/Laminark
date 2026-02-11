import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import { ObservationRepository } from '../../storage/observations.js';
import type { NotificationStore } from '../../storage/notifications.js';
import type { AnalysisWorker } from '../../analysis/worker-bridge.js';
import type { EmbeddingStore } from '../../storage/embeddings.js';
import { SaveGuard } from '../../hooks/save-guard.js';

/**
 * Generates a title from observation content.
 * Extracts the first sentence (up to 100 chars) or first 80 chars with ellipsis.
 */
export function generateTitle(content: string): string {
  const firstSentence = content.match(/^[^.!?\n]+[.!?]?/);
  if (firstSentence && firstSentence[0].length <= 100) {
    return firstSentence[0].trim();
  }
  if (content.length <= 80) return content.trim();
  return content.slice(0, 80).trim() + '...';
}

/**
 * Registers the save_memory tool on the MCP server.
 *
 * save_memory persists user-provided text as a new observation with an optional title.
 * If title is omitted, one is auto-generated from the text content.
 */
export function registerSaveMemory(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHash: string,
  notificationStore: NotificationStore | null = null,
  worker: AnalysisWorker | null = null,
  embeddingStore: EmbeddingStore | null = null,
): void {
  server.registerTool(
    'save_memory',
    {
      title: 'Save Memory',
      description:
        'Save a new memory observation. Provide text content and an optional title. If title is omitted, one is auto-generated from the text.',
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(10000)
          .describe('The text content to save as a memory'),
        title: z
          .string()
          .max(200)
          .optional()
          .describe(
            'Optional title for the memory. Auto-generated from text if omitted.',
          ),
        source: z
          .string()
          .default('manual')
          .describe("Source identifier (e.g., manual, hook:PostToolUse)"),
        kind: z
          .enum(['change', 'reference', 'finding', 'decision', 'verification'])
          .default('finding')
          .describe('Observation kind: change, reference, finding, decision, or verification'),
      },
    },
    async (args) => {
      try {
        const repo = new ObservationRepository(db, projectHash);

        // Pre-save gate: duplicate detection + relevance scoring
        const guard = new SaveGuard(repo, { worker, embeddingStore });
        const decision = await guard.evaluate(args.text, args.source);
        if (!decision.save) {
          debug('mcp', 'save_memory: rejected by save guard', {
            reason: decision.reason,
            duplicateOf: decision.duplicateOf,
          });
          return {
            content: [{
              type: 'text' as const,
              text: `Memory not saved: ${decision.reason}` +
                (decision.duplicateOf ? ` (similar to existing observation ${decision.duplicateOf})` : ''),
            }],
          };
        }

        const resolvedTitle = args.title ?? generateTitle(args.text);
        const obs = repo.createClassified({
          content: args.text,
          title: resolvedTitle,
          source: args.source,
          kind: args.kind,
        }, 'discovery');

        debug('mcp', 'save_memory: saved', {
          id: obs.id,
          title: resolvedTitle,
        });

        // Prepend any pending notifications to the response
        let responseText = `Saved memory "${resolvedTitle}" (id: ${obs.id})`;
        if (notificationStore) {
          const pending = notificationStore.consumePending(projectHash);
          if (pending.length > 0) {
            const banner = pending.map(n => `[Laminark] ${n.message}`).join('\n');
            responseText = banner + '\n\n' + responseText;
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: responseText,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [
            { type: 'text' as const, text: `Failed to save: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
