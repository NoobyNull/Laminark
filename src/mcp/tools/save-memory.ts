import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import { ObservationRepository } from '../../storage/observations.js';

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
      },
    },
    async (args) => {
      try {
        const repo = new ObservationRepository(db, projectHash);
        const resolvedTitle = args.title ?? generateTitle(args.text);
        const obs = repo.create({
          content: args.text,
          title: resolvedTitle,
          source: args.source,
        });

        debug('mcp', 'save_memory: saved', {
          id: obs.id,
          title: resolvedTitle,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved memory "${resolvedTitle}" (id: ${obs.id})`,
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
