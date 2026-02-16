/**
 * MCP tool handlers for debug resolution path management.
 *
 * Provides four tools for explicit user control over debug path lifecycle:
 *   - path_start:   Manually start tracking a debug path (UI-01)
 *   - path_resolve: Manually resolve the active debug path (UI-02)
 *   - path_show:    Show a debug path with waypoints and KISS summary (UI-03)
 *   - path_list:    List recent debug paths with optional status filter (UI-04)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { NotificationStore } from '../../storage/notifications.js';
import type { PathRepository } from '../../paths/path-repository.js';
import type { PathTracker } from '../../paths/path-tracker.js';
import { loadToolVerbosityConfig, verboseResponse } from '../../config/tool-verbosity-config.js';

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
// KISS Summary Formatting
// =============================================================================

interface KissSummary {
  kiss_summary: string;
  root_cause: string;
  what_fixed_it: string;
  dimensions: {
    logical: string;
    programmatic: string;
    development: string;
  };
}

function formatKissSummary(raw: string | null): string {
  if (!raw) return 'KISS summary not yet generated';

  try {
    const kiss = JSON.parse(raw) as KissSummary;
    const lines: string[] = [];
    lines.push(`**Next time:** ${kiss.kiss_summary}`);
    lines.push(`**Root cause:** ${kiss.root_cause}`);
    lines.push(`**What fixed it:** ${kiss.what_fixed_it}`);
    lines.push(`**Logical:** ${kiss.dimensions.logical}`);
    lines.push(`**Programmatic:** ${kiss.dimensions.programmatic}`);
    lines.push(`**Development:** ${kiss.dimensions.development}`);
    return lines.join('\n');
  } catch {
    return 'KISS summary not yet generated';
  }
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Registers four debug path MCP tools on the server.
 *
 * Tools: path_start, path_resolve, path_show, path_list
 */
export function registerDebugPathTools(
  server: McpServer,
  pathRepo: PathRepository,
  pathTracker: PathTracker,
  notificationStore: NotificationStore | null,
  projectHashRef: ProjectHashRef,
): void {
  // ---------------------------------------------------------------------------
  // path_start (UI-01)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'path_start',
    {
      title: 'Start Debug Path',
      description:
        "Explicitly start tracking a debug path. Use when auto-detection hasn't triggered but you're actively debugging.",
      inputSchema: {
        trigger: z
          .string()
          .describe('Brief description of the issue being debugged'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(
          prependNotifications(notificationStore, projectHash, text),
        );

      try {
        debug('mcp', 'path_start: request', { trigger: args.trigger });

        const existingPathId = pathTracker.getActivePathId();
        const pathId = pathTracker.startManually(args.trigger);

        if (!pathId) {
          return errorResponse('Failed to start debug path');
        }

        if (existingPathId && existingPathId === pathId) {
          return withNotifications(`Debug path already active: ${pathId}`);
        }

        return withNotifications(verboseResponse(
          'Debug path started.',
          `Debug path started: ${pathId}`,
          `Debug path started: ${pathId}\nTracking: ${args.trigger}`,
        ));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'path_start: error', { error: message });
        return errorResponse(`path_start error: ${message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // path_resolve (UI-02)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'path_resolve',
    {
      title: 'Resolve Debug Path',
      description:
        "Explicitly resolve the active debug path with a resolution summary. Use when auto-detection hasn't detected resolution.",
      inputSchema: {
        resolution: z
          .string()
          .describe('What fixed the issue'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(
          prependNotifications(notificationStore, projectHash, text),
        );

      try {
        debug('mcp', 'path_resolve: request', { resolution: args.resolution });

        const pathId = pathTracker.getActivePathId();
        if (!pathId) {
          return errorResponse('No active debug path to resolve');
        }

        pathTracker.resolveManually(args.resolution);

        return withNotifications(verboseResponse(
          'Debug path resolved.',
          `Debug path resolved: ${pathId}`,
          `Debug path resolved: ${pathId}\nResolution: ${args.resolution}\nKISS summary generating in background...`,
        ));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'path_resolve: error', { error: message });
        return errorResponse(`path_resolve error: ${message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // path_show (UI-03)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'path_show',
    {
      title: 'Show Debug Path',
      description:
        'Show a debug path with its waypoints and KISS summary.',
      inputSchema: {
        path_id: z
          .string()
          .optional()
          .describe('Path ID to show. Omit for active path.'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(
          prependNotifications(notificationStore, projectHash, text),
        );

      try {
        debug('mcp', 'path_show: request', { path_id: args.path_id });

        let pathData;
        if (args.path_id) {
          pathData = pathRepo.getPath(args.path_id);
          if (!pathData) {
            return errorResponse(`Debug path not found: ${args.path_id}`);
          }
        } else {
          pathData = pathRepo.getActivePath();
          if (!pathData) {
            return errorResponse('No active debug path');
          }
        }

        const verbosity = loadToolVerbosityConfig().level;

        if (verbosity === 1) {
          return withNotifications(`Showing debug path: ${pathData.status}`);
        }

        const waypoints = pathRepo.getWaypoints(pathData.id);

        if (verbosity === 2) {
          // Standard: key fields
          const lines: string[] = [];
          lines.push(`## Debug Path: ${pathData.id}`);
          lines.push(`**Status:** ${pathData.status} | **Trigger:** ${pathData.trigger_summary}`);
          lines.push(`Waypoints: ${waypoints.length}`);
          if (pathData.resolution_summary) lines.push(`Resolution: ${pathData.resolution_summary}`);
          return withNotifications(lines.join('\n'));
        }

        // Verbose: full output
        const lines: string[] = [];
        lines.push(`## Debug Path: ${pathData.id}`);
        lines.push(`Status: ${pathData.status}`);
        lines.push(`Started: ${pathData.started_at}`);
        lines.push(`Trigger: ${pathData.trigger_summary}`);
        lines.push('');

        // Waypoints section
        lines.push(`### Waypoints (${waypoints.length})`);
        for (let i = 0; i < waypoints.length; i++) {
          const wp = waypoints[i];
          lines.push(
            `${i + 1}. [${wp.waypoint_type}] ${wp.summary} (${wp.created_at})`,
          );
        }
        lines.push('');

        // Resolution section
        lines.push('### Resolution');
        lines.push(pathData.resolution_summary ?? 'Still active');
        lines.push('');

        // KISS summary section
        lines.push('### KISS Summary');
        lines.push(formatKissSummary(pathData.kiss_summary));

        return withNotifications(lines.join('\n'));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'path_show: error', { error: message });
        return errorResponse(`path_show error: ${message}`);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // path_list (UI-04)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'path_list',
    {
      title: 'List Debug Paths',
      description:
        'List recent debug paths, optionally filtered by status.',
      inputSchema: {
        status: z
          .enum(['active', 'resolved', 'abandoned'])
          .optional()
          .describe('Filter by status'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Max paths to return'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      const withNotifications = (text: string) =>
        textResponse(
          prependNotifications(notificationStore, projectHash, text),
        );

      try {
        debug('mcp', 'path_list: request', {
          status: args.status,
          limit: args.limit,
        });

        let paths = pathRepo.listPaths(args.limit);

        // In-memory status filter
        if (args.status) {
          paths = paths.filter((p) => p.status === args.status);
        }

        if (paths.length === 0) {
          return withNotifications('No debug paths found');
        }

        const verbosity = loadToolVerbosityConfig().level;

        if (verbosity === 1) {
          return withNotifications(`${paths.length} debug paths found`);
        }

        const lines: string[] = [];
        lines.push('## Debug Paths');
        lines.push('');

        if (verbosity === 2) {
          // Standard: compact table
          lines.push('| Status | Trigger |');
          lines.push('|--------|---------|');
          for (const p of paths) {
            const trigger = p.trigger_summary.length > 60
              ? p.trigger_summary.slice(0, 60) + '...'
              : p.trigger_summary;
            lines.push(`| ${p.status} | ${trigger} |`);
          }
        } else {
          // Verbose: full table
          lines.push(
            '| ID (short) | Status | Trigger | Started | Resolved |',
          );
          lines.push(
            '|------------|--------|---------|---------|----------|',
          );
          for (const p of paths) {
            const shortId = p.id.slice(0, 8);
            const trigger = p.trigger_summary.length > 50
              ? p.trigger_summary.slice(0, 50) + '...'
              : p.trigger_summary;
            const resolved = p.resolved_at ?? '-';
            lines.push(
              `| ${shortId} | ${p.status} | ${trigger} | ${p.started_at} | ${resolved} |`,
            );
          }
        }

        return withNotifications(lines.join('\n'));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'path_list: error', { error: message });
        return errorResponse(`path_list error: ${message}`);
      }
    },
  );
}
