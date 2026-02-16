/**
 * MCP tool handlers for thought branch management.
 *
 * Provides three tools for querying work history:
 *   - query_branches: List/search branches by status or type
 *   - show_branch:    Show branch detail with observation timeline
 *   - branch_summary: Summary of recent work activity
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import type { BranchRepository } from '../../branches/branch-repository.js';
import type { ObservationRepository } from '../../storage/observations.js';
import { loadToolVerbosityConfig } from '../../config/tool-verbosity-config.js';

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

export function registerThoughtBranchTools(
  server: McpServer,
  branchRepo: BranchRepository,
  obsRepo: ObservationRepository,
  notificationStore: NotificationStore | null,
  projectHashRef: ProjectHashRef,
): void {
  // ---------------------------------------------------------------------------
  // query_branches
  // ---------------------------------------------------------------------------

  server.registerTool(
    'query_branches',
    {
      title: 'Query Thought Branches',
      description:
        "Search and list thought branches - coherent units of work (investigations, bug fixes, features). Use to see work history and what was investigated, fixed, or built.",
      inputSchema: {
        status: z
          .enum(['active', 'completed', 'abandoned', 'merged'])
          .optional()
          .describe('Filter by branch status'),
        branch_type: z
          .enum(['investigation', 'bug_fix', 'feature', 'refactor', 'research', 'unknown'])
          .optional()
          .describe('Filter by branch type'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum results to return'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(prependNotifications(notificationStore, projectHash, text));

      try {
        debug('mcp', 'query_branches: request', {
          status: args.status,
          branch_type: args.branch_type,
          limit: args.limit,
        });

        let branches;
        if (args.status) {
          branches = branchRepo.listByStatus(args.status, args.limit);
        } else if (args.branch_type) {
          branches = branchRepo.listByType(args.branch_type, args.limit);
        } else {
          branches = branchRepo.listBranches(args.limit);
        }

        if (branches.length === 0) {
          return withNotifications('No thought branches found');
        }

        const verbosity = loadToolVerbosityConfig().level;

        if (verbosity === 1) {
          return withNotifications(`${branches.length} branches found`);
        }

        const lines: string[] = [];
        lines.push('## Thought Branches');
        lines.push('');

        if (verbosity === 2) {
          // Standard: key columns, no observation timeline
          lines.push('| Status | Type | Title |');
          lines.push('|--------|------|-------|');
          for (const b of branches) {
            const title = b.title
              ? b.title.length > 50 ? b.title.slice(0, 50) + '...' : b.title
              : '-';
            lines.push(`| ${b.status} | ${b.branch_type} | ${title} |`);
          }
        } else {
          // Verbose: full table
          lines.push(
            '| ID (short) | Status | Type | Stage | Title | Observations | Started |',
          );
          lines.push(
            '|------------|--------|------|-------|-------|-------------|---------|',
          );
          for (const b of branches) {
            const shortId = b.id.slice(0, 8);
            const title = b.title
              ? b.title.length > 40
                ? b.title.slice(0, 40) + '...'
                : b.title
              : '-';
            lines.push(
              `| ${shortId} | ${b.status} | ${b.branch_type} | ${b.arc_stage} | ${title} | ${b.observation_count} | ${b.started_at} |`,
            );
          }
        }

        return withNotifications(lines.join('\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'query_branches: error', { error: message });
        return errorResponse(`query_branches error: ${message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // show_branch
  // ---------------------------------------------------------------------------

  server.registerTool(
    'show_branch',
    {
      title: 'Show Thought Branch',
      description:
        'Show detailed view of a thought branch with observation timeline and arc stage annotations. Trace the full arc of a work unit.',
      inputSchema: {
        branch_id: z
          .string()
          .optional()
          .describe('Branch ID to show. Omit for active branch.'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(prependNotifications(notificationStore, projectHash, text));

      try {
        debug('mcp', 'show_branch: request', { branch_id: args.branch_id });

        let branch;
        if (args.branch_id) {
          branch = branchRepo.getBranch(args.branch_id);
          if (!branch) {
            return errorResponse(`Branch not found: ${args.branch_id}`);
          }
        } else {
          branch = branchRepo.getActiveBranch();
          if (!branch) {
            return errorResponse('No active thought branch');
          }
        }

        const verbosity = loadToolVerbosityConfig().level;
        const branchTitle = branch.title ?? branch.id.slice(0, 12);

        if (verbosity === 1) {
          return withNotifications(`Showing "${branchTitle}"`);
        }

        const observations = branchRepo.getObservations(branch.id);

        if (verbosity === 2) {
          // Standard: key fields, no observation timeline
          const lines: string[] = [];
          lines.push(`## ${branchTitle}`);
          lines.push(`**Status:** ${branch.status} | **Type:** ${branch.branch_type} | **Stage:** ${branch.arc_stage}`);
          if (branch.summary) lines.push(branch.summary);
          lines.push(`Observations: ${observations.length}`);
          return withNotifications(lines.join('\n'));
        }

        // Verbose: full output
        const lines: string[] = [];
        lines.push(`## Thought Branch: ${branchTitle}`);
        lines.push(`**ID:** ${branch.id}`);
        lines.push(`**Status:** ${branch.status}`);
        lines.push(`**Type:** ${branch.branch_type}`);
        lines.push(`**Arc Stage:** ${branch.arc_stage}`);
        lines.push(`**Started:** ${branch.started_at}`);
        if (branch.ended_at) lines.push(`**Ended:** ${branch.ended_at}`);
        if (branch.trigger_source) lines.push(`**Trigger:** ${branch.trigger_source}`);
        if (branch.linked_debug_path_id) {
          lines.push(`**Linked Debug Path:** ${branch.linked_debug_path_id}`);
        }
        lines.push('');

        // Tool pattern
        const tools = Object.entries(branch.tool_pattern)
          .sort(([, a], [, b]) => b - a);
        if (tools.length > 0) {
          lines.push('### Tool Usage');
          for (const [tool, count] of tools) {
            lines.push(`- ${tool}: ${count}`);
          }
          lines.push('');
        }

        // Summary
        if (branch.summary) {
          lines.push('### Summary');
          lines.push(branch.summary);
          lines.push('');
        }

        // Observation timeline
        lines.push(`### Observation Timeline (${observations.length})`);
        for (const bo of observations) {
          const obs = obsRepo.getById(bo.observation_id);
          const content = obs
            ? (obs.title ?? obs.content.slice(0, 100))
            : bo.observation_id.slice(0, 8);
          const stageTag = bo.arc_stage_at_add ? `[${bo.arc_stage_at_add}]` : '';
          const toolTag = bo.tool_name ? `(${bo.tool_name})` : '';
          lines.push(
            `${bo.sequence_order}. ${stageTag} ${toolTag} ${content}`,
          );
        }

        return withNotifications(lines.join('\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'show_branch: error', { error: message });
        return errorResponse(`show_branch error: ${message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // branch_summary
  // ---------------------------------------------------------------------------

  server.registerTool(
    'branch_summary',
    {
      title: 'Branch Activity Summary',
      description:
        'Summary of recent work activity grouped by time window. Shows what was investigated, fixed, built, and where work left off.',
      inputSchema: {
        hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .default(24)
          .describe('Time window in hours (default 24)'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(prependNotifications(notificationStore, projectHash, text));

      try {
        debug('mcp', 'branch_summary: request', { hours: args.hours });

        const branches = branchRepo.listRecentBranches(args.hours);

        if (branches.length === 0) {
          return withNotifications(`No work branches in the last ${args.hours} hours`);
        }

        const verbosity = loadToolVerbosityConfig().level;

        if (verbosity === 1) {
          return withNotifications(`${branches.length} branches in ${args.hours}h`);
        }

        // Group by status
        const active = branches.filter(b => b.status === 'active');
        const completed = branches.filter(b => b.status === 'completed');
        const abandoned = branches.filter(b => b.status === 'abandoned');

        const lines: string[] = [];
        lines.push(`## Work Summary (last ${args.hours}h)`);
        lines.push(`**Total branches:** ${branches.length}`);
        lines.push('');

        if (active.length > 0) {
          lines.push('### Active');
          for (const b of active) {
            const title = b.title ?? b.id.slice(0, 8);
            lines.push(verbosity === 2
              ? `- ${title} (${b.branch_type})`
              : `- **${title}** (${b.branch_type}, ${b.arc_stage}) — ${b.observation_count} obs`);
          }
          lines.push('');
        }

        if (completed.length > 0) {
          lines.push('### Completed');
          for (const b of completed) {
            const title = b.title ?? b.id.slice(0, 8);
            const summary = b.summary ? `: ${b.summary.slice(0, 100)}` : '';
            lines.push(verbosity === 2
              ? `- ${title} (${b.branch_type})`
              : `- **${title}** (${b.branch_type})${summary}`);
          }
          lines.push('');
        }

        if (abandoned.length > 0) {
          lines.push('### Abandoned');
          for (const b of abandoned) {
            const title = b.title ?? b.id.slice(0, 8);
            lines.push(verbosity === 2
              ? `- ${title} (${b.branch_type})`
              : `- **${title}** (${b.branch_type}) — ${b.observation_count} obs`);
          }
          lines.push('');
        }

        // Tool distribution only at verbose level
        if (verbosity === 3) {
          const allTools: Record<string, number> = {};
          for (const b of branches) {
            for (const [tool, count] of Object.entries(b.tool_pattern)) {
              allTools[tool] = (allTools[tool] ?? 0) + count;
            }
          }
          const toolEntries = Object.entries(allTools).sort(([, a], [, b]) => b - a);
          if (toolEntries.length > 0) {
            lines.push('### Tool Distribution');
            for (const [tool, count] of toolEntries.slice(0, 10)) {
              lines.push(`- ${tool}: ${count}`);
            }
          }
        }

        return withNotifications(lines.join('\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'branch_summary: error', { error: message });
        return errorResponse(`branch_summary error: ${message}`);
      }
    },
  );
}
