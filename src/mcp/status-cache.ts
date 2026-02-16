/**
 * Pre-built status cache for the Laminark MCP status tool.
 *
 * Queries the database once at construction, stores the formatted markdown
 * string, and only re-queries when explicitly marked dirty (after writes).
 * The tool handler returns the cached string with zero SQL overhead.
 */

import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import type { ProjectHashRef } from '../shared/types.js';
import { getDbPath } from '../shared/config.js';
import { estimateTokens } from './token-budget.js';

// =============================================================================
// Uptime formatting
// =============================================================================

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// =============================================================================
// StatusCache
// =============================================================================

export class StatusCache {
  private db: BetterSqlite3.Database;
  private projectHashRef: ProjectHashRef;
  private projectPath: string;
  private hasVectorSupport: boolean;
  private isWorkerReady: () => boolean;

  /** Pre-built markdown string (everything except the uptime line). */
  private cachedBody = '';
  /** Uptime snapshot at the time cachedBody was built. */
  private builtAtUptime = 0;
  private dirty = false;

  constructor(
    db: BetterSqlite3.Database,
    projectHashRef: ProjectHashRef,
    projectPath: string,
    hasVectorSupport: boolean,
    isWorkerReady: () => boolean,
  ) {
    this.db = db;
    this.projectHashRef = projectHashRef;
    this.projectPath = projectPath;
    this.hasVectorSupport = hasVectorSupport;
    this.isWorkerReady = isWorkerReady;

    this.rebuild();
  }

  /** Flag that underlying data has changed (cheap -- no queries). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Re-query and rebuild if dirty. Call from a background timer. */
  refreshIfDirty(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.rebuild();
  }

  /**
   * Return the formatted status string instantly.
   * Patches the uptime line inline so it's always current.
   */
  getFormatted(): string {
    const currentUptime = formatUptime(Math.floor(process.uptime()));
    const workerReady = this.isWorkerReady();
    return this.cachedBody
      .replace(
        `Uptime: ${formatUptime(this.builtAtUptime)}`,
        `Uptime: ${currentUptime}`,
      )
      .replace(
        /Embedding worker: (?:ready|degraded)/,
        `Embedding worker: ${workerReady ? 'ready' : 'degraded'}`,
      );
  }

  // ---------------------------------------------------------------------------
  // Internal: query + format
  // ---------------------------------------------------------------------------

  private rebuild(): void {
    try {
      const ph = this.projectHashRef.current;

      const totalObs = (
        this.db.prepare(
          'SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL',
        ).get(ph) as { cnt: number }
      ).cnt;

      const embeddedObs = (
        this.db.prepare(
          'SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NULL AND embedding_model IS NOT NULL',
        ).get(ph) as { cnt: number }
      ).cnt;

      const deletedObs = (
        this.db.prepare(
          'SELECT COUNT(*) as cnt FROM observations WHERE project_hash = ? AND deleted_at IS NOT NULL',
        ).get(ph) as { cnt: number }
      ).cnt;

      const sessions = (
        this.db.prepare(
          'SELECT COUNT(DISTINCT session_id) as cnt FROM observations WHERE project_hash = ? AND session_id IS NOT NULL AND deleted_at IS NULL',
        ).get(ph) as { cnt: number }
      ).cnt;

      let stashes = 0;
      try {
        stashes = (
          this.db.prepare(
            "SELECT COUNT(*) as cnt FROM context_stashes WHERE project_hash = ? AND status = 'stashed'",
          ).get(ph) as { cnt: number }
        ).cnt;
      } catch {
        // Table may not exist
      }

      const totalChars = (
        this.db.prepare(
          'SELECT COALESCE(SUM(LENGTH(content)), 0) as chars FROM observations WHERE project_hash = ? AND deleted_at IS NULL',
        ).get(ph) as { chars: number }
      ).chars;

      let graphNodes = 0;
      let graphEdges = 0;
      try {
        graphNodes = (
          this.db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as { cnt: number }
        ).cnt;
        graphEdges = (
          this.db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as { cnt: number }
        ).cnt;
      } catch {
        // Graph tables may not exist
      }

      const uptimeNow = Math.floor(process.uptime());
      const tokenEstimate = estimateTokens(String('x').repeat(totalChars));
      const workerReady = this.isWorkerReady();

      // Build markdown
      const lines: string[] = [];
      lines.push('## Laminark Status');
      lines.push('');
      lines.push('### Connection');
      lines.push(`Project: ${this.projectPath}`);
      lines.push(`Project hash: ${ph}`);
      lines.push(`Database: ${getDbPath()}`);
      lines.push(`Uptime: ${formatUptime(uptimeNow)}`);
      lines.push('');
      lines.push('### Capabilities');
      lines.push(`Vector search: ${this.hasVectorSupport ? 'active' : 'unavailable (keyword-only)'}`);
      lines.push(`Embedding worker: ${workerReady ? 'ready' : 'degraded'}`);
      lines.push('');
      lines.push('### Memories');
      lines.push(`Observations: ${totalObs} (${embeddedObs} embedded, ${deletedObs} deleted)`);
      lines.push(`Sessions: ${sessions}`);
      lines.push(`Stashed threads: ${stashes}`);
      lines.push('');
      lines.push('### Tokens');
      lines.push(`Estimated total: ~${tokenEstimate.toLocaleString()} tokens across all memories`);
      lines.push('');
      lines.push('### Knowledge Graph');
      lines.push(`Nodes: ${graphNodes} | Edges: ${graphEdges}`);

      this.cachedBody = lines.join('\n');
      this.builtAtUptime = uptimeNow;

      debug('mcp', 'status-cache: rebuilt', { memories: totalObs, tokens: tokenEstimate });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('mcp', 'status-cache: rebuild error', { error: msg });
      // Keep previous cached body on failure
    }
  }
}
