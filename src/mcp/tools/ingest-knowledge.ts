import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import { KnowledgeIngester } from '../../ingestion/knowledge-ingester.js';
import type { StatusCache } from '../status-cache.js';
import { verboseResponse } from '../../config/tool-verbosity-config.js';

/**
 * Registers the ingest_knowledge tool on the MCP server.
 *
 * ingest_knowledge transforms structured markdown documents into per-project
 * reference observations. Supports optional directory path; auto-detects
 * .planning/codebase/ or .laminark/codebase/ from project metadata when
 * directory is omitted.
 */
export function registerIngestKnowledge(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHashRef: ProjectHashRef,
  notificationStore: NotificationStore | null = null,
  statusCache: StatusCache | null = null,
): void {
  server.registerTool(
    'ingest_knowledge',
    {
      title: 'Ingest Knowledge',
      description:
        'Ingest structured markdown documents from a directory into queryable per-project memories. Reads .md files, splits by ## headings, and stores each section as a reference observation. Supports .planning/codebase/ (GSD output) and .laminark/codebase/.',
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe(
            'Directory containing .md files to ingest. If omitted, auto-detects .planning/codebase/ or .laminark/codebase/ using the project path from project_metadata.',
          ),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      try {
        let resolvedDir = args.directory;

        // If directory not provided, resolve from project_metadata
        if (!resolvedDir) {
          const row = db
            .prepare(
              'SELECT project_path FROM project_metadata WHERE project_hash = ? ORDER BY last_seen_at DESC LIMIT 1',
            )
            .get(projectHash) as { project_path: string } | undefined;

          if (!row) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Could not determine project path. Please provide the directory parameter explicitly.',
                },
              ],
              isError: true,
            };
          }

          resolvedDir = await KnowledgeIngester.detectKnowledgeDir(row.project_path);
          if (!resolvedDir) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'No knowledge directory found. Expected .planning/codebase/ or .laminark/codebase/ in the project root. Run /gsd:map-codebase first or provide a directory path.',
                },
              ],
              isError: true,
            };
          }
        }

        const ingester = new KnowledgeIngester(db, projectHash);
        const stats = await ingester.ingestDirectory(resolvedDir);

        debug('mcp', 'ingest_knowledge: completed', {
          directory: resolvedDir,
          stats,
        });

        statusCache?.markDirty();

        const responseText = verboseResponse(
          `Ingested ${stats.filesProcessed} files: ${stats.sectionsCreated} sections created, ${stats.sectionsRemoved} stale sections removed.`,
          `Ingested ${stats.filesProcessed} file(s): ${stats.sectionsCreated} sections created, ${stats.sectionsRemoved} removed.`,
          `Ingested ${stats.filesProcessed} file(s) from ${resolvedDir}: ${stats.sectionsCreated} sections created, ${stats.sectionsRemoved} stale sections removed.`,
        );

        // Prepend any pending notifications to the response
        let finalResponse = responseText;
        if (notificationStore) {
          const pending = notificationStore.consumePending(projectHash);
          if (pending.length > 0) {
            const banner = pending.map(n => `[Laminark] ${n.message}`).join('\n');
            finalResponse = banner + '\n\n' + finalResponse;
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: finalResponse,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to ingest knowledge: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
