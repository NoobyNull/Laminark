import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import type { DiscoveredTool, ToolRegistryRow, ToolSearchResult, ToolUsageStats } from '../shared/tool-types.js';
import { reciprocalRankFusion } from '../search/hybrid.js';

/**
 * Repository for tool registry CRUD operations.
 *
 * Unlike ObservationRepository, this is NOT scoped to a single project --
 * the tool registry spans all scopes (global, project, plugin) and is
 * queried cross-project for tool discovery and routing.
 *
 * All SQL statements are prepared once in the constructor and reused for
 * every call (better-sqlite3 performance best practice).
 */
export class ToolRegistryRepository {
  private readonly db: BetterSqlite3.Database;

  // Prepared statements (prepared once, reused for every call)
  private readonly stmtUpsert: BetterSqlite3.Statement;
  private readonly stmtRecordUsage: BetterSqlite3.Statement;
  private readonly stmtGetByScope: BetterSqlite3.Statement;
  private readonly stmtGetByName: BetterSqlite3.Statement;
  private readonly stmtGetAll: BetterSqlite3.Statement;
  private readonly stmtCount: BetterSqlite3.Statement;
  private readonly stmtGetAvailableForSession: BetterSqlite3.Statement;
  private readonly stmtInsertEvent: BetterSqlite3.Statement;
  private readonly stmtGetUsageForTool: BetterSqlite3.Statement;
  private readonly stmtGetUsageForSession: BetterSqlite3.Statement;
  private readonly stmtGetUsageSince: BetterSqlite3.Statement;
  private readonly stmtGetRecentUsage: BetterSqlite3.Statement;
  private readonly stmtMarkStale: BetterSqlite3.Statement;
  private readonly stmtMarkDemoted: BetterSqlite3.Statement;
  private readonly stmtMarkActive: BetterSqlite3.Statement;
  private readonly stmtGetConfigSourced: BetterSqlite3.Statement;
  private readonly stmtGetRecentEventsForTool: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;

    try {
      this.stmtUpsert = db.prepare(`
        INSERT INTO tool_registry (name, tool_type, scope, source, project_hash, description, server_name, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (name, COALESCE(project_hash, ''))
        DO UPDATE SET
          description = COALESCE(excluded.description, tool_registry.description),
          source = excluded.source,
          status = 'active',
          updated_at = datetime('now')
      `);

      this.stmtRecordUsage = db.prepare(`
        UPDATE tool_registry
        SET usage_count = usage_count + 1,
            last_used_at = datetime('now'),
            updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
      `);

      this.stmtGetByScope = db.prepare(`
        SELECT * FROM tool_registry
        WHERE scope = 'global' OR project_hash = ?
        ORDER BY usage_count DESC, discovered_at DESC
      `);

      this.stmtGetByName = db.prepare(`
        SELECT * FROM tool_registry
        WHERE name = ?
        ORDER BY usage_count DESC
        LIMIT 1
      `);

      this.stmtGetAll = db.prepare(`
        SELECT * FROM tool_registry
        ORDER BY usage_count DESC, discovered_at DESC
      `);

      this.stmtCount = db.prepare(`
        SELECT COUNT(*) AS count FROM tool_registry
      `);

      this.stmtGetAvailableForSession = db.prepare(`
        SELECT * FROM tool_registry
        WHERE
          scope = 'global'
          OR (scope = 'project' AND project_hash = ?)
          OR (scope = 'plugin' AND (project_hash IS NULL OR project_hash = ?))
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'stale' THEN 1
            WHEN 'demoted' THEN 2
            ELSE 3
          END,
          CASE tool_type
            WHEN 'mcp_server' THEN 0
            WHEN 'slash_command' THEN 1
            WHEN 'skill' THEN 2
            WHEN 'plugin' THEN 3
            ELSE 4
          END,
          usage_count DESC,
          discovered_at DESC
      `);

      this.stmtInsertEvent = db.prepare(`
        INSERT INTO tool_usage_events (tool_name, session_id, project_hash, success)
        VALUES (?, ?, ?, ?)
      `);

      this.stmtGetUsageForTool = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM tool_usage_events
        WHERE tool_name = ? AND project_hash = ?
          AND created_at >= datetime('now', ?)
        GROUP BY tool_name
      `);

      this.stmtGetUsageForSession = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM tool_usage_events
        WHERE session_id = ?
        GROUP BY tool_name
        ORDER BY usage_count DESC
      `);

      this.stmtGetUsageSince = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM tool_usage_events
        WHERE project_hash = ?
          AND created_at >= datetime('now', ?)
        GROUP BY tool_name
        ORDER BY usage_count DESC
      `);

      this.stmtGetRecentUsage = db.prepare(`
        SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
        FROM (
          SELECT tool_name, created_at
          FROM tool_usage_events
          WHERE project_hash = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
        GROUP BY tool_name
        ORDER BY usage_count DESC
      `);

      this.stmtMarkStale = db.prepare(`
        UPDATE tool_registry
        SET status = 'stale', updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
          AND status != 'stale'
      `);

      this.stmtMarkDemoted = db.prepare(`
        UPDATE tool_registry
        SET status = 'demoted', updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
      `);

      this.stmtMarkActive = db.prepare(`
        UPDATE tool_registry
        SET status = 'active', updated_at = datetime('now')
        WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
          AND status != 'active'
      `);

      this.stmtGetConfigSourced = db.prepare(`
        SELECT * FROM tool_registry
        WHERE source LIKE 'config:%'
          AND status = 'active'
          AND (project_hash = ? OR project_hash IS NULL)
      `);

      this.stmtGetRecentEventsForTool = db.prepare(`
        SELECT success FROM tool_usage_events
        WHERE tool_name = ? AND project_hash = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);

      debug('tool-registry', 'ToolRegistryRepository initialized');
    } catch (err) {
      // Table may not exist if database is pre-migration-16.
      // Callers should catch this gracefully.
      throw err;
    }
  }

  /**
   * Inserts or updates a discovered tool in the registry.
   * On conflict (same name + project_hash), updates description and source.
   */
  upsert(tool: DiscoveredTool): void {
    try {
      this.stmtUpsert.run(
        tool.name,
        tool.toolType,
        tool.scope,
        tool.source,
        tool.projectHash,
        tool.description,
        tool.serverName,
      );
      debug('tool-registry', 'Upserted tool', { name: tool.name, scope: tool.scope });
    } catch (err) {
      debug('tool-registry', 'Failed to upsert tool', { name: tool.name, error: String(err) });
    }
  }

  /**
   * Increments usage_count and updates last_used_at for a tool.
   * Called from organic PostToolUse discovery to track usage.
   */
  recordUsage(name: string, projectHash: string | null): void {
    try {
      this.stmtRecordUsage.run(name, projectHash);
      debug('tool-registry', 'Recorded usage', { name });
    } catch (err) {
      debug('tool-registry', 'Failed to record usage', { name, error: String(err) });
    }
  }

  /**
   * Records usage for an existing tool, or creates it if not yet in the registry.
   * This is the entry point for organic discovery -- an upsert-and-increment-if-exists pattern.
   *
   * First tries recordUsage. If the tool is not in the registry (changes === 0),
   * calls upsert with the full tool info, which initializes it with usage_count = 0.
   */
  recordOrCreate(
    name: string,
    defaults: Omit<DiscoveredTool, 'name'>,
    sessionId?: string | null,
    success?: boolean,
  ): void {
    try {
      const result = this.stmtRecordUsage.run(name, defaults.projectHash);
      if (result.changes === 0) {
        // Tool not yet in registry -- create it
        this.upsert({ name, ...defaults });
      }
      // Insert usage event with session context (UTRK-02)
      if (sessionId !== undefined) {
        this.stmtInsertEvent.run(name, sessionId, defaults.projectHash, success === false ? 0 : 1);
      }
      debug('tool-registry', 'recordOrCreate completed', { name, created: result.changes === 0 });
    } catch (err) {
      debug('tool-registry', 'Failed recordOrCreate', { name, error: String(err) });
    }
  }

  /**
   * Returns global tools plus project-specific tools for the given project.
   */
  getForProject(projectHash: string): ToolRegistryRow[] {
    return this.stmtGetByScope.all(projectHash) as ToolRegistryRow[];
  }

  /**
   * Returns tools available in the resolved scope for a given project.
   * Implements SCOP-01/SCOP-02/SCOP-03 scope resolution rules.
   */
  getAvailableForSession(projectHash: string): ToolRegistryRow[] {
    return this.stmtGetAvailableForSession.all(projectHash, projectHash) as ToolRegistryRow[];
  }

  /**
   * Returns the top-usage entry for a given tool name.
   */
  getByName(name: string): ToolRegistryRow | null {
    const row = this.stmtGetByName.get(name) as ToolRegistryRow | undefined;
    return row ?? null;
  }

  /**
   * Returns all tools in the registry (for debugging/admin).
   */
  getAll(): ToolRegistryRow[] {
    return this.stmtGetAll.all() as ToolRegistryRow[];
  }

  /**
   * Returns total number of tools in the registry.
   */
  count(): number {
    const row = this.stmtCount.get() as { count: number };
    return row.count;
  }

  /**
   * Returns usage stats for a specific tool within a time window.
   * @param timeModifier - SQLite datetime modifier, e.g., '-7 days', '-30 days'
   */
  getUsageForTool(toolName: string, projectHash: string, timeModifier: string = '-7 days'): ToolUsageStats | null {
    const row = this.stmtGetUsageForTool.get(toolName, projectHash, timeModifier) as ToolUsageStats | undefined;
    return row ?? null;
  }

  /**
   * Returns per-tool usage stats for a specific session.
   */
  getUsageForSession(sessionId: string): ToolUsageStats[] {
    return this.stmtGetUsageForSession.all(sessionId) as ToolUsageStats[];
  }

  /**
   * Returns per-tool usage stats since a time offset for a project.
   * @param timeModifier - SQLite datetime modifier, e.g., '-7 days', '-30 days'
   */
  getUsageSince(projectHash: string, timeModifier: string = '-7 days'): ToolUsageStats[] {
    return this.stmtGetUsageSince.all(projectHash, timeModifier) as ToolUsageStats[];
  }

  /**
   * Returns per-tool usage stats from the last N events for a project.
   * Event-count-based window instead of time-based — immune to usage gaps.
   * @param limit - Number of recent events to consider (default 200)
   */
  getRecentUsage(projectHash: string, limit: number = 200): ToolUsageStats[] {
    return this.stmtGetRecentUsage.all(projectHash, limit) as ToolUsageStats[];
  }

  // ---------------------------------------------------------------------------
  // Staleness management methods
  // ---------------------------------------------------------------------------

  /**
   * Marks a tool as stale (no longer in config but still in registry).
   * Idempotent -- no-op if already stale.
   */
  markStale(name: string, projectHash: string | null): void {
    try {
      this.stmtMarkStale.run(name, projectHash);
      debug('tool-registry', 'Marked tool stale', { name });
    } catch (err) {
      debug('tool-registry', 'Failed to mark tool stale', { name, error: String(err) });
    }
  }

  /**
   * Marks a tool as demoted (high failure rate detected).
   */
  markDemoted(name: string, projectHash: string | null): void {
    try {
      this.stmtMarkDemoted.run(name, projectHash);
      debug('tool-registry', 'Marked tool demoted', { name });
    } catch (err) {
      debug('tool-registry', 'Failed to mark tool demoted', { name, error: String(err) });
    }
  }

  /**
   * Marks a tool as active (restored from stale/demoted).
   * Idempotent -- no-op if already active.
   */
  markActive(name: string, projectHash: string | null): void {
    try {
      this.stmtMarkActive.run(name, projectHash);
      debug('tool-registry', 'Marked tool active', { name });
    } catch (err) {
      debug('tool-registry', 'Failed to mark tool active', { name, error: String(err) });
    }
  }

  /**
   * Returns all config-sourced active tools for a given project (or global).
   * Used by staleness detection to compare against current config state.
   */
  getConfigSourcedTools(projectHash: string): ToolRegistryRow[] {
    try {
      return this.stmtGetConfigSourced.all(projectHash) as ToolRegistryRow[];
    } catch (err) {
      debug('tool-registry', 'Failed to get config-sourced tools', { error: String(err) });
      return [];
    }
  }

  /**
   * Returns recent success/failure events for a specific tool.
   * Used by failure-driven demotion to check failure rate.
   * @param limit - Number of recent events to check (default 5)
   */
  getRecentEventsForTool(toolName: string, projectHash: string, limit: number = 5): Array<{ success: number }> {
    try {
      return this.stmtGetRecentEventsForTool.all(toolName, projectHash, limit) as Array<{ success: number }>;
    } catch (err) {
      debug('tool-registry', 'Failed to get recent events for tool', { toolName, error: String(err) });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Search methods (FTS5 + vector + hybrid)
  // ---------------------------------------------------------------------------

  /**
   * Sanitizes a user query for safe FTS5 MATCH usage.
   * Removes FTS5 operators and special characters to prevent syntax errors.
   * Returns null if the query is empty after sanitization.
   */
  private sanitizeQuery(query: string): string | null {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const sanitized = words
      .map(w => {
        let cleaned = w.replace(/["*()^{}[\]]/g, '');
        if (/^(NEAR|OR|AND|NOT)$/i.test(cleaned)) return '';
        cleaned = cleaned.replace(/[^\w\-]/g, '');
        return cleaned;
      })
      .filter(Boolean);
    if (sanitized.length === 0) return null;
    return sanitized.join(' ');
  }

  /**
   * FTS5 keyword search on tool_registry_fts (name + description).
   * Returns ranked results using BM25 with name weighted 2x over description.
   */
  searchByKeyword(query: string, options?: { scope?: string; limit?: number }): ToolSearchResult[] {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) return [];
    const limit = options?.limit ?? 20;

    let sql = `
      SELECT tr.*, bm25(tool_registry_fts, 2.0, 1.0) AS rank
      FROM tool_registry_fts
      JOIN tool_registry tr ON tr.id = tool_registry_fts.rowid
      WHERE tool_registry_fts MATCH ?
    `;
    const params: unknown[] = [sanitized];

    if (options?.scope) {
      sql += ' AND tr.scope = ?';
      params.push(options.scope);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as (ToolRegistryRow & { rank: number })[];
      return rows.map(({ rank, ...toolFields }) => ({
        tool: toolFields as ToolRegistryRow,
        score: Math.abs(rank),
        matchType: 'fts' as const,
      }));
    } catch (err) {
      debug('tool-registry', 'FTS5 search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Vector similarity search on tool_registry_embeddings using vec0 KNN.
   * Returns tool IDs and distances sorted by cosine similarity.
   */
  searchByVector(queryEmbedding: Float32Array, options?: { scope?: string; limit?: number }): Array<{ tool_id: number; distance: number }> {
    const limit = options?.limit ?? 40;
    try {
      let sql: string;
      const params: unknown[] = [queryEmbedding];

      if (options?.scope) {
        sql = `
          SELECT tre.tool_id, tre.distance
          FROM tool_registry_embeddings tre
          JOIN tool_registry tr ON tr.id = tre.tool_id
          WHERE tre.embedding MATCH ? AND tr.scope = ?
          ORDER BY tre.distance LIMIT ?
        `;
        params.push(options.scope);
      } else {
        sql = `
          SELECT tre.tool_id, tre.distance
          FROM tool_registry_embeddings tre
          WHERE tre.embedding MATCH ?
          ORDER BY tre.distance LIMIT ?
        `;
      }

      params.push(limit);
      return this.db.prepare(sql).all(...params) as Array<{ tool_id: number; distance: number }>;
    } catch (err) {
      debug('tool-registry', 'Vector search failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Hybrid search combining FTS5 keyword and vec0 vector results via
   * reciprocal rank fusion (RRF). Falls back to FTS5-only when vector
   * search is unavailable (no worker, no sqlite-vec, no embeddings).
   */
  async searchTools(
    query: string,
    options?: {
      scope?: string;
      limit?: number;
      worker?: { isReady(): boolean; embed(text: string): Promise<Float32Array | null> } | null;
      hasVectorSupport?: boolean;
    },
  ): Promise<ToolSearchResult[]> {
    const limit = options?.limit ?? 20;

    // Step 1: FTS5 keyword search
    const ftsResults = this.searchByKeyword(query, { scope: options?.scope, limit });

    // Step 2: Vector search (if available)
    let vectorResults: Array<{ tool_id: number; distance: number }> = [];
    if (options?.worker?.isReady() && options?.hasVectorSupport) {
      const queryEmbedding = await options.worker.embed(query);
      if (queryEmbedding) {
        vectorResults = this.searchByVector(queryEmbedding, { scope: options?.scope, limit: limit * 2 });
      }
    }

    // Step 3: FTS-only fallback
    if (vectorResults.length === 0) {
      return ftsResults.slice(0, limit);
    }

    // Step 4: Fuse with RRF
    const ftsRanked = ftsResults.map(r => ({ id: String(r.tool.id) }));
    const vecRanked = vectorResults.map(r => ({ id: String(r.tool_id) }));
    const fused = reciprocalRankFusion([ftsRanked, vecRanked]);

    // Build lookup maps
    const ftsMap = new Map<string, ToolSearchResult>();
    for (const r of ftsResults) {
      ftsMap.set(String(r.tool.id), r);
    }
    const vecIds = new Set(vectorResults.map(r => String(r.tool_id)));

    // Assemble results
    const results: ToolSearchResult[] = [];
    for (const item of fused) {
      if (results.length >= limit) break;
      const fromFts = ftsMap.get(item.id);
      const fromVec = vecIds.has(item.id);

      if (fromFts) {
        results.push({
          tool: fromFts.tool,
          score: item.fusedScore,
          matchType: fromFts && fromVec ? 'hybrid' : 'fts',
        });
      } else if (fromVec) {
        // Vector-only: look up the full tool row
        const toolRow = this.db.prepare('SELECT * FROM tool_registry WHERE id = ?').get(Number(item.id)) as ToolRegistryRow | undefined;
        if (toolRow) {
          results.push({
            tool: toolRow,
            score: item.fusedScore,
            matchType: 'vector',
          });
        }
      }
    }

    return results;
  }

  /**
   * Stores an embedding vector for a tool in tool_registry_embeddings.
   * Used by the background embedding loop to index tool descriptions.
   */
  storeEmbedding(toolId: number, embedding: Float32Array): void {
    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO tool_registry_embeddings(tool_id, embedding) VALUES (?, ?)'
      ).run(toolId, embedding);
    } catch (err) {
      debug('tool-registry', 'Failed to store tool embedding', { toolId, error: String(err) });
    }
  }

  /**
   * Returns tools that have descriptions but no embedding yet.
   * Used by the background embedding loop to find work.
   */
  findUnembeddedTools(limit: number = 5): Array<{ id: number; name: string; description: string }> {
    try {
      return this.db.prepare(`
        SELECT id, name, description FROM tool_registry
        WHERE description IS NOT NULL
          AND id NOT IN (SELECT tool_id FROM tool_registry_embeddings)
        LIMIT ?
      `).all(limit) as Array<{ id: number; name: string; description: string }>;
    } catch (err) {
      debug('tool-registry', 'Failed to find unembedded tools', { error: String(err) });
      return [];
    }
  }
}
