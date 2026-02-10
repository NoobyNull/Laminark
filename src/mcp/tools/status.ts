/**
 * MCP tool handler for Laminark system status.
 *
 * Returns a compact dashboard: connection info, memory counts,
 * token estimates, and capability flags. No input parameters.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../../shared/debug.js';
import { getDbPath } from '../../shared/config.js';
import { estimateTokens } from '../token-budget.js';
import type { NotificationStore } from '../../storage/notifications.js';

// =============================================================================
// Types
// =============================================================================

interface StatusOutput {
  project: {
    path: string;
    hash: string;
  };
  database: {
    path: string;
  };
  capabilities: {
    vectorSearch: boolean;
    embeddingWorker: boolean;
  };
  memories: {
    total: number;
    embedded: number;
    deleted: number;
    sessions: number;
    stashes: number;
  };
  tokens: {
    estimatedTotal: number;
  };
  graph: {
    nodes: number;
    edges: number;
  };
  uptime: number;
}

// =============================================================================
// Stats Collection
// =============================================================================

function collectStatus(
  db: BetterSqlite3.Database,
  projectHash: string,
  projectPath: string,
  hasVectorSupport: boolean,
  workerReady: boolean,
): StatusOutput {
  // Memory counts
  const totalObs = (
    db.prepare(
      'SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL',
    ).get(projectHash) as { cnt: number }
  ).cnt;

  const embeddedObs = (
    db.prepare(
      'SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL AND embedding_model IS NOT NULL',
    ).get(projectHash) as { cnt: number }
  ).cnt;

  const deletedObs = (
    db.prepare(
      'SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NOT NULL',
    ).get(projectHash) as { cnt: number }
  ).cnt;

  const sessions = (
    db.prepare(
      'SELECT COUNT(DISTINCT session_id) as cnt FROM observations WHERE project_hash = ? AND session_id IS NOT NULL AND deleted_at IS NULL',
    ).get(projectHash) as { cnt: number }
  ).cnt;

  let stashes = 0;
  try {
    stashes = (
      db.prepare(
        "SELECT COUNT(*) as cnt FROM context_stashes WHERE project_hash = ? AND status = 'stashed'",
      ).get(projectHash) as { cnt: number }
    ).cnt;
  } catch {
    // Table may not exist
  }

  // Token estimate: sum content length, convert
  const totalChars = (
    db.prepare(
      'SELECT COALESCE(SUM(LENGTH(content)), 0) as chars FROM observations WHERE project_hash = ? AND deleted_at IS NULL',
    ).get(projectHash) as { chars: number }
  ).chars;

  // Graph counts
  let graphNodes = 0;
  let graphEdges = 0;
  try {
    graphNodes = (
      db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }
    ).cnt;
    graphEdges = (
      db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }
    ).cnt;
  } catch {
    // Graph tables may not exist
  }

  return {
    project: { path: projectPath, hash: projectHash },
    database: { path: getDbPath() },
    capabilities: {
      vectorSearch: hasVectorSupport,
      embeddingWorker: workerReady,
    },
    memories: {
      total: totalObs,
      embedded: embeddedObs,
      deleted: deletedObs,
      sessions,
      stashes,
    },
    tokens: { estimatedTotal: estimateTokens(String('x').repeat(totalChars)) },
    graph: { nodes: graphNodes, edges: graphEdges },
    uptime: Math.floor(process.uptime()),
  };
}

// =============================================================================
// Formatting
// =============================================================================

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatStatus(status: StatusOutput): string {
  const lines: string[] = [];

  lines.push('## Laminark Status');
  lines.push('');

  // Connection
  lines.push('### Connection');
  lines.push(`Project: ${status.project.path}`);
  lines.push(`Project hash: ${status.project.hash}`);
  lines.push(`Database: ${status.database.path}`);
  lines.push(`Uptime: ${formatUptime(status.uptime)}`);
  lines.push('');

  // Capabilities
  lines.push('### Capabilities');
  lines.push(`Vector search: ${status.capabilities.vectorSearch ? 'active' : 'unavailable (keyword-only)'}`);
  lines.push(`Embedding worker: ${status.capabilities.embeddingWorker ? 'ready' : 'degraded'}`);
  lines.push('');

  // Memories
  lines.push('### Memories');
  lines.push(`Observations: ${status.memories.total} (${status.memories.embedded} embedded, ${status.memories.deleted} deleted)`);
  lines.push(`Sessions: ${status.memories.sessions}`);
  lines.push(`Stashed threads: ${status.memories.stashes}`);
  lines.push('');

  // Tokens
  lines.push('### Tokens');
  lines.push(`Estimated total: ~${status.tokens.estimatedTotal.toLocaleString()} tokens across all memories`);
  lines.push('');

  // Graph
  lines.push('### Knowledge Graph');
  lines.push(`Nodes: ${status.graph.nodes} | Edges: ${status.graph.edges}`);

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

export function registerStatus(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHash: string,
  projectPath: string,
  hasVectorSupport: boolean,
  isWorkerReady: () => boolean,
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
      try {
        debug('mcp', 'status: request');

        const status = collectStatus(
          db,
          projectHash,
          projectPath,
          hasVectorSupport,
          isWorkerReady(),
        );
        const formatted = formatStatus(status);

        debug('mcp', 'status: returning', {
          memories: status.memories.total,
          tokens: status.tokens.estimatedTotal,
        });

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
