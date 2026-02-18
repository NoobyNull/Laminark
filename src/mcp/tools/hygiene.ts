/**
 * MCP tool handler for database hygiene analysis and cleanup.
 *
 * Analyzes observations for deletion signals, scores candidates, and
 * optionally purges them. Default mode is simulate (dry-run).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import {
  analyzeObservations,
  executePurge,
  type HygieneCandidate,
  type HygieneReport,
} from '../../graph/hygiene-analyzer.js';

// =============================================================================
// Formatting
// =============================================================================

function formatReport(report: HygieneReport, mode: string, tier: string): string {
  const lines: string[] = [];

  lines.push('## Database Hygiene Report');
  lines.push(`Analyzed ${report.totalObservations.toLocaleString()} observations`);
  lines.push('');

  // Summary table
  lines.push('### Summary');
  lines.push('| Tier | Count | Action |');
  lines.push('|------|-------|--------|');
  lines.push(`| High (>= 0.7) | ${report.summary.high} | Safe to purge |`);
  lines.push(`| Medium (0.5-0.69) | ${report.summary.medium} | Review recommended |`);
  if (report.summary.low > 0) {
    lines.push(`| Low (< 0.5) | ${report.summary.low} | Kept |`);
  }
  lines.push(`| Orphan graph nodes | ${report.summary.orphanNodeCount} | Dead references |`);
  lines.push('');

  if (report.candidates.length === 0) {
    lines.push('No candidates found matching the selected tier.');
    return lines.join('\n');
  }

  // Group candidates by session
  const bySession = new Map<string, HygieneCandidate[]>();
  for (const c of report.candidates) {
    const key = c.sessionId ?? '(no session)';
    const list = bySession.get(key) ?? [];
    list.push(c);
    bySession.set(key, list);
  }

  const tierLabel = tier === 'all' ? 'All' : tier === 'medium' ? 'Medium+' : 'High';
  lines.push(`### ${tierLabel} Confidence Candidates (showing ${report.candidates.length})`);
  lines.push('');

  for (const [sessionId, candidates] of bySession) {
    const sessionDate = candidates[0]?.createdAt?.substring(0, 10) ?? '';
    lines.push(`#### Session: ${sessionId.substring(0, 8)} (${sessionDate}, ${candidates.length} obs)`);
    lines.push('| ID | Kind | Source | Confidence | Signals | Preview |');
    lines.push('|----|------|--------|------------|---------|---------|');

    for (const c of candidates) {
      const signals: string[] = [];
      if (c.signals.orphaned) signals.push('orphaned');
      if (c.signals.islandNode) signals.push('island');
      if (c.signals.noiseClassified) signals.push('noise');
      if (c.signals.shortContent) signals.push('short');
      if (c.signals.autoCaptured) signals.push('auto');
      if (c.signals.stale) signals.push('stale');

      const preview = c.contentPreview
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');

      lines.push(
        `| ${c.shortId} | ${c.kind} | ${c.source} | ${c.confidence.toFixed(2)} | ${signals.join(',') || '-'} | ${preview} |`,
      );
    }
    lines.push('');
  }

  if (mode === 'simulate') {
    lines.push(`_Dry run — no data modified. Use \`hygiene(mode="purge", tier="${tier}")\` to execute._`);
  }

  return lines.join('\n');
}

function formatPurgeResult(
  observationsPurged: number,
  orphanNodesRemoved: number,
  tier: string,
): string {
  const lines: string[] = [];
  lines.push('## Hygiene Purge Complete');
  lines.push(`- Tier: ${tier}`);
  lines.push(`- Observations soft-deleted: ${observationsPurged}`);
  lines.push(`- Orphan graph nodes removed: ${orphanNodesRemoved}`);
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

export function registerHygiene(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHashRef: ProjectHashRef,
  notificationStore: NotificationStore | null = null,
): void {
  server.registerTool(
    'hygiene',
    {
      title: 'Database Hygiene',
      description:
        'Analyze observations for deletion candidates with confidence scoring. ' +
        'Simulate mode (default) produces a dry-run report. Purge mode soft-deletes candidates and removes dead orphan graph nodes.',
      inputSchema: {
        mode: z.enum(['simulate', 'purge']).default('simulate')
          .describe('simulate = dry-run report, purge = execute deletions'),
        tier: z.enum(['high', 'medium', 'all']).default('high')
          .describe('Which confidence tier to act on'),
        session_id: z.string().optional()
          .describe('Optional: scope analysis to a single session'),
        limit: z.number().int().min(1).max(200).default(50)
          .describe('Max results to return'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      try {
        const mode = args.mode ?? 'simulate';
        const tier = args.tier ?? 'high';
        const sessionId = args.session_id;
        const limit = args.limit ?? 50;

        debug('hygiene', 'Request', { mode, tier, sessionId, limit });

        // Determine minimum tier for analysis
        const minTier = tier === 'all' ? 'low' as const : tier;

        const report = analyzeObservations(db, projectHash, {
          sessionId,
          limit,
          minTier,
        });

        if (mode === 'purge') {
          const result = executePurge(db, projectHash, report, tier);
          const formatted = formatPurgeResult(
            result.observationsPurged,
            result.orphanNodesRemoved,
            tier,
          );
          return textResponse(
            prependNotifications(notificationStore, projectHash, formatted),
          );
        }

        const formatted = formatReport(report, mode, tier);
        return textResponse(
          prependNotifications(notificationStore, projectHash, formatted),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('hygiene', 'Error', { error: message });
        return textResponse(`Hygiene analysis error: ${message}`);
      }
    },
  );
}
