import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import type { DiscoveredTool, ToolRegistryRow } from '../shared/tool-types.js';

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
  recordOrCreate(name: string, defaults: Omit<DiscoveredTool, 'name'>): void {
    try {
      const result = this.stmtRecordUsage.run(name, defaults.projectHash);
      if (result.changes === 0) {
        // Tool not yet in registry -- create it
        this.upsert({ name, ...defaults });
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
}
