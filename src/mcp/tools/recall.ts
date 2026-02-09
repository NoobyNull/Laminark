import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { Observation, SearchResult } from '../../shared/types.js';
import { ObservationRepository } from '../../storage/observations.js';
import { SearchEngine } from '../../storage/search.js';
import type { EmbeddingStore } from '../../storage/embeddings.js';
import type { AnalysisWorker } from '../../analysis/worker-bridge.js';
import { hybridSearch } from '../../search/hybrid.js';
import {
  enforceTokenBudget,
  estimateTokens,
  FULL_VIEW_BUDGET,
  TOKEN_BUDGET,
} from '../token-budget.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.slice(0, 8);
}

function dateStr(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function timeStr(iso: string): string {
  return iso.slice(11, 16); // HH:MM
}

function snippetText(content: string, maxLen: number): string {
  return content.replace(/\n/g, ' ').slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Detail-level formatters
// ---------------------------------------------------------------------------

function formatCompactItem(
  obs: Observation,
  index: number,
  score?: number,
): string {
  const idShort = shortId(obs.id);
  const title = obs.title ?? 'untitled';
  const scoreStr = score !== undefined ? score.toFixed(2) : '-';
  const snippet = snippetText(obs.content, 100);
  const date = dateStr(obs.createdAt);
  return `[${index}] ${idShort} | ${title} | ${scoreStr} | ${snippet} | ${date}`;
}

function formatTimelineGroup(
  date: string,
  items: { obs: Observation; score?: number }[],
): string {
  const lines = [`## ${date}`];
  for (const { obs } of items) {
    const time = timeStr(obs.createdAt);
    const title = obs.title ?? 'untitled';
    const source = obs.source;
    const snippet = snippetText(obs.content, 150);
    lines.push(`${time} | ${title} | ${source} | ${snippet}`);
  }
  return lines.join('\n');
}

function formatFullItem(obs: Observation): string {
  const idShort = shortId(obs.id);
  const title = obs.title ?? 'untitled';
  return `--- ${idShort} | ${title} | ${obs.createdAt} ---\n${obs.content}`;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ---------------------------------------------------------------------------
// registerRecall
// ---------------------------------------------------------------------------

export function registerRecall(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHash: string,
  worker: AnalysisWorker | null = null,
  embeddingStore: EmbeddingStore | null = null,
): void {
  server.registerTool(
    'recall',
    {
      title: 'Recall Memories',
      description:
        'Search, view, purge, or restore memories. Search first to find matches, then act on specific results by ID.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('FTS5 keyword search query'),
        id: z.string().optional().describe('Direct lookup by observation ID'),
        title: z
          .string()
          .optional()
          .describe('Search by title (partial match)'),
        action: z
          .enum(['view', 'purge', 'restore'])
          .default('view')
          .describe(
            'Action to take on results: view (show details), purge (soft-delete), restore (un-delete)',
          ),
        ids: z
          .array(z.string())
          .optional()
          .describe(
            'Specific observation IDs to act on (from a previous search result)',
          ),
        detail: z
          .enum(['compact', 'timeline', 'full'])
          .default('compact')
          .describe(
            'View detail level: compact (index ~80 tokens/result), timeline (date-grouped), full (complete text)',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum results to return'),
        include_purged: z
          .boolean()
          .default(false)
          .describe(
            'Include soft-deleted items in results (needed for restore)',
          ),
      },
    },
    async (args) => {
      try {
        const repo = new ObservationRepository(db, projectHash);
        const searchEngine = new SearchEngine(db, projectHash);

        // -------------------------------------------------------------------
        // PHASE A: Input Validation
        // -------------------------------------------------------------------
        const hasSearch = args.query !== undefined || args.id !== undefined || args.title !== undefined;
        if (args.ids && hasSearch) {
          return errorResponse(
            'Provide either a search query or IDs to act on, not both.',
          );
        }

        if (
          (args.action === 'purge' || args.action === 'restore') &&
          !args.ids &&
          !args.id
        ) {
          return errorResponse(
            `Provide ids array or id to specify which memories to ${args.action}.`,
          );
        }

        // -------------------------------------------------------------------
        // PHASE B: Resolve Observations
        // -------------------------------------------------------------------
        let observations: Observation[] = [];
        let searchResults: SearchResult[] | null = null;

        if (args.ids) {
          // Fetch each ID, track not-found
          const notFound: string[] = [];
          for (const itemId of args.ids) {
            const obs = repo.getByIdIncludingDeleted(itemId);
            if (obs) {
              observations.push(obs);
            } else {
              notFound.push(itemId);
            }
          }
          if (notFound.length > 0 && observations.length === 0) {
            return textResponse(
              `No memories found matching '${notFound.join(', ')}'. Try broader search terms or check the ID.`,
            );
          }
        } else if (args.id) {
          const obs = args.include_purged
            ? repo.getByIdIncludingDeleted(args.id)
            : repo.getById(args.id);
          if (!obs) {
            return textResponse(
              `No memories found matching '${args.id}'. Try broader search terms or check the ID.`,
            );
          }
          observations = [obs];
        } else if (args.query) {
          if (embeddingStore) {
            searchResults = await hybridSearch({
              searchEngine,
              embeddingStore,
              worker,
              query: args.query,
              db,
              projectHash,
              options: { limit: args.limit },
            });
          } else {
            searchResults = searchEngine.searchKeyword(args.query, {
              limit: args.limit,
            });
          }
          observations = searchResults.map((r) => r.observation);
        } else if (args.title) {
          observations = repo.getByTitle(args.title, {
            limit: args.limit,
            includePurged: args.include_purged,
          });
        } else {
          // No query, id, title, or ids -- list recent
          observations = args.include_purged
            ? repo.listIncludingDeleted({ limit: args.limit })
            : repo.list({ limit: args.limit });
        }

        if (observations.length === 0) {
          const searchTerm = args.query ?? args.title ?? args.id ?? '';
          return textResponse(
            `No memories found matching '${searchTerm}'. Try broader search terms or check the ID.`,
          );
        }

        // -------------------------------------------------------------------
        // PHASE C: Execute Action
        // -------------------------------------------------------------------

        // --- VIEW ---
        if (args.action === 'view') {
          return formatViewResponse(
            observations,
            searchResults,
            args.detail,
            args.id !== undefined,
          );
        }

        // --- PURGE ---
        if (args.action === 'purge') {
          const targetIds = args.ids ?? (args.id ? [args.id] : []);
          let success = 0;
          const failures: string[] = [];
          for (const targetId of targetIds) {
            if (repo.softDelete(targetId)) {
              success++;
            } else {
              failures.push(targetId);
            }
          }
          debug('mcp', 'recall: purge', { success, total: targetIds.length });
          let msg = `Purged ${success}/${targetIds.length} memories.`;
          if (failures.length > 0) {
            msg += ` Not found or already purged: ${failures.join(', ')}`;
          }
          return textResponse(msg);
        }

        // --- RESTORE ---
        if (args.action === 'restore') {
          const targetIds = args.ids ?? (args.id ? [args.id] : []);
          let success = 0;
          const failures: string[] = [];
          for (const targetId of targetIds) {
            if (repo.restore(targetId)) {
              success++;
            } else {
              failures.push(targetId);
            }
          }
          debug('mcp', 'recall: restore', {
            success,
            total: targetIds.length,
          });
          let msg = `Restored ${success}/${targetIds.length} memories.`;
          if (failures.length > 0) {
            msg += ` Not found: ${failures.join(', ')}`;
          }
          return textResponse(msg);
        }

        // Should not reach here, but TypeScript exhaustiveness
        return errorResponse(`Unknown action: ${args.action as string}`);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'recall: error', { error: message });
        return errorResponse(`Recall error: ${message}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// View formatting with token budget
// ---------------------------------------------------------------------------

function formatViewResponse(
  observations: Observation[],
  searchResults: SearchResult[] | null,
  detail: 'compact' | 'timeline' | 'full',
  isSingleIdLookup: boolean,
): { content: { type: 'text'; text: string }[] } {
  let body: string;
  let truncated: boolean;
  let tokenEstimate: number;

  if (detail === 'compact') {
    const scoreMap = buildScoreMap(searchResults);
    const result = enforceTokenBudget(
      observations,
      (obs) => formatCompactItem(obs, observations.indexOf(obs) + 1, scoreMap.get(obs.id)),
      TOKEN_BUDGET,
    );
    body = result.items
      .map((obs, i) => formatCompactItem(obs, i + 1, scoreMap.get(obs.id)))
      .join('\n');
    truncated = result.truncated;
    tokenEstimate = result.tokenEstimate;
  } else if (detail === 'timeline') {
    // Group by date
    const groups = new Map<string, { obs: Observation; score?: number }[]>();
    const scoreMap = buildScoreMap(searchResults);
    for (const obs of observations) {
      const date = dateStr(obs.createdAt);
      if (!groups.has(date)) {
        groups.set(date, []);
      }
      groups.get(date)!.push({ obs, score: scoreMap.get(obs.id) });
    }

    const result = enforceTokenBudget(
      observations,
      (obs) => {
        const time = timeStr(obs.createdAt);
        const title = obs.title ?? 'untitled';
        return `${time} | ${title} | ${obs.source} | ${snippetText(obs.content, 150)}`;
      },
      TOKEN_BUDGET,
    );

    // Re-group the budget-enforced items
    const includedIds = new Set(result.items.map((o) => o.id));
    const filteredGroups = new Map<string, { obs: Observation; score?: number }[]>();
    for (const [date, items] of groups) {
      const filtered = items.filter((item) => includedIds.has(item.obs.id));
      if (filtered.length > 0) {
        filteredGroups.set(date, filtered);
      }
    }

    body = Array.from(filteredGroups.entries())
      .map(([date, items]) => formatTimelineGroup(date, items))
      .join('\n\n');
    truncated = result.truncated;
    tokenEstimate = result.tokenEstimate;
  } else {
    // detail === 'full'
    const budget = isSingleIdLookup ? FULL_VIEW_BUDGET : TOKEN_BUDGET;

    if (observations.length === 1) {
      const formatted = formatFullItem(observations[0]);
      tokenEstimate = estimateTokens(formatted);
      if (tokenEstimate > budget) {
        // Truncate single item to fit budget
        const maxChars = budget * 4; // ~4 chars per token
        body =
          formatted.slice(0, maxChars) +
          `\n[...truncated at ~${budget} tokens]`;
        truncated = true;
        tokenEstimate = budget;
      } else {
        body = formatted;
        truncated = false;
      }
    } else {
      const result = enforceTokenBudget(
        observations,
        formatFullItem,
        budget,
      );
      body = result.items.map(formatFullItem).join('\n\n');
      truncated = result.truncated;
      tokenEstimate = result.tokenEstimate;
    }
  }

  // Metadata footer
  let footer = `---\n${observations.length} result(s) | ~${tokenEstimate} tokens | detail: ${detail}`;
  if (truncated) {
    footer += ' | truncated (use id for full view)';
  }

  return textResponse(`${body}\n${footer}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildScoreMap(
  searchResults: SearchResult[] | null,
): Map<string, number> {
  const map = new Map<string, number>();
  if (searchResults) {
    for (const r of searchResults) {
      map.set(r.observation.id, r.score);
    }
  }
  return map;
}
