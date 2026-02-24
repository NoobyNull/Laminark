import { t as ObservationRepository } from "../observations-CorAAc1A.mjs";
import * as better_sqlite30 from "better-sqlite3";
import Database from "better-sqlite3";

//#region src/storage/research-buffer.d.ts
/**
 * Lightweight buffer for exploration tool events (Read, Glob, Grep).
 *
 * Instead of creating full observations for these low-signal tools,
 * they are stored in a temporary buffer. When a Write/Edit observation
 * is created, the recent buffer entries are attached as research context,
 * creating provenance links between exploration and changes.
 *
 * Buffer entries are flushed after 30 minutes.
 */
declare class ResearchBufferRepository {
  private readonly db;
  private readonly projectHash;
  private readonly stmtInsert;
  private readonly stmtGetRecent;
  private readonly stmtFlush;
  constructor(db: Database.Database, projectHash: string);
  /**
   * Records a research tool event in the buffer.
   */
  add(entry: {
    sessionId: string | null;
    toolName: string;
    target: string;
  }): void;
  /**
   * Returns recent buffer entries for a session within a time window.
   */
  getRecent(sessionId: string, windowMinutes?: number): Array<{
    toolName: string;
    target: string;
    createdAt: string;
  }>;
  /**
   * Deletes buffer entries older than the specified number of minutes.
   */
  flush(olderThanMinutes?: number): number;
}
//#endregion
//#region src/shared/tool-types.d.ts
/**
 * Tool type classification based on how the tool is provided.
 */
type ToolType = 'mcp_server' | 'mcp_tool' | 'slash_command' | 'skill' | 'plugin' | 'builtin' | 'unknown';
/**
 * Scope origin of a tool -- where it was discovered from.
 */
type ToolScope = 'global' | 'project' | 'plugin';
/**
 * A tool discovered during config scanning (SessionStart).
 * Used as input to ToolRegistryRepository.upsert().
 */
interface DiscoveredTool {
  name: string;
  toolType: ToolType;
  scope: ToolScope;
  source: string;
  projectHash: string | null;
  description: string | null;
  serverName: string | null;
  triggerHints: string | null;
}
/**
 * Raw database row from the tool_registry table (snake_case).
 */
interface ToolRegistryRow {
  id: number;
  name: string;
  tool_type: string;
  scope: string;
  source: string;
  project_hash: string | null;
  description: string | null;
  server_name: string | null;
  trigger_hints: string | null;
  usage_count: number;
  last_used_at: string | null;
  discovered_at: string;
  updated_at: string;
  status: string;
}
/**
 * Aggregated usage stats for temporal queries.
 */
interface ToolUsageStats {
  tool_name: string;
  usage_count: number;
  last_used: string;
}
/**
 * A search result from hybrid tool search (FTS5 + vector via RRF).
 */
interface ToolSearchResult {
  tool: ToolRegistryRow;
  score: number;
  matchType: 'fts' | 'vector' | 'hybrid';
}
//#endregion
//#region src/storage/tool-registry.d.ts
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
declare class ToolRegistryRepository {
  private readonly db;
  private readonly stmtUpsert;
  private readonly stmtRecordUsage;
  private readonly stmtGetByScope;
  private readonly stmtGetByName;
  private readonly stmtGetAll;
  private readonly stmtCount;
  private readonly stmtGetAvailableForSession;
  private readonly stmtInsertEvent;
  private readonly stmtGetUsageForTool;
  private readonly stmtGetUsageForSession;
  private readonly stmtGetUsageSince;
  private readonly stmtGetRecentUsage;
  private readonly stmtMarkStale;
  private readonly stmtMarkDemoted;
  private readonly stmtMarkActive;
  private readonly stmtGetConfigSourced;
  private readonly stmtGetRecentEventsForTool;
  constructor(db: Database.Database);
  /**
   * Inserts or updates a discovered tool in the registry.
   * On conflict (same name + project_hash), updates description and source.
   */
  upsert(tool: DiscoveredTool): void;
  /**
   * Increments usage_count and updates last_used_at for a tool.
   * Called from organic PostToolUse discovery to track usage.
   */
  recordUsage(name: string, projectHash: string | null): void;
  /**
   * Records usage for an existing tool, or creates it if not yet in the registry.
   * This is the entry point for organic discovery -- an upsert-and-increment-if-exists pattern.
   *
   * First tries recordUsage. If the tool is not in the registry (changes === 0),
   * calls upsert with the full tool info, which initializes it with usage_count = 0.
   */
  recordOrCreate(name: string, defaults: Omit<DiscoveredTool, 'name'>, sessionId?: string | null, success?: boolean): void;
  /**
   * Returns global tools plus project-specific tools for the given project.
   */
  getForProject(projectHash: string): ToolRegistryRow[];
  /**
   * Returns tools available in the resolved scope for a given project.
   * Implements SCOP-01/SCOP-02/SCOP-03 scope resolution rules.
   */
  getAvailableForSession(projectHash: string): ToolRegistryRow[];
  /**
   * Returns the top-usage entry for a given tool name.
   */
  getByName(name: string): ToolRegistryRow | null;
  /**
   * Returns all tools in the registry (for debugging/admin).
   */
  getAll(): ToolRegistryRow[];
  /**
   * Returns total number of tools in the registry.
   */
  count(): number;
  /**
   * Returns usage stats for a specific tool within a time window.
   * @param timeModifier - SQLite datetime modifier, e.g., '-7 days', '-30 days'
   */
  getUsageForTool(toolName: string, projectHash: string, timeModifier?: string): ToolUsageStats | null;
  /**
   * Returns per-tool usage stats for a specific session.
   */
  getUsageForSession(sessionId: string): ToolUsageStats[];
  /**
   * Returns per-tool usage stats since a time offset for a project.
   * @param timeModifier - SQLite datetime modifier, e.g., '-7 days', '-30 days'
   */
  getUsageSince(projectHash: string, timeModifier?: string): ToolUsageStats[];
  /**
   * Returns per-tool usage stats from the last N events for a project.
   * Event-count-based window instead of time-based — immune to usage gaps.
   * @param limit - Number of recent events to consider (default 200)
   */
  getRecentUsage(projectHash: string, limit?: number): ToolUsageStats[];
  /**
   * Marks a tool as stale (no longer in config but still in registry).
   * Idempotent -- no-op if already stale.
   */
  markStale(name: string, projectHash: string | null): void;
  /**
   * Marks a tool as demoted (high failure rate detected).
   */
  markDemoted(name: string, projectHash: string | null): void;
  /**
   * Marks a tool as active (restored from stale/demoted).
   * Idempotent -- no-op if already active.
   */
  markActive(name: string, projectHash: string | null): void;
  /**
   * Returns all config-sourced active tools for a given project (or global).
   * Used by staleness detection to compare against current config state.
   */
  getConfigSourcedTools(projectHash: string): ToolRegistryRow[];
  /**
   * Returns recent success/failure events for a specific tool.
   * Used by failure-driven demotion to check failure rate.
   * @param limit - Number of recent events to check (default 5)
   */
  getRecentEventsForTool(toolName: string, projectHash: string, limit?: number): Array<{
    success: number;
  }>;
  /**
   * Sanitizes a user query for safe FTS5 MATCH usage.
   * Removes FTS5 operators and special characters to prevent syntax errors.
   * Returns null if the query is empty after sanitization.
   */
  private sanitizeQuery;
  /**
   * FTS5 keyword search on tool_registry_fts (name + description).
   * Returns ranked results using BM25 with name weighted 2x over description.
   */
  searchByKeyword(query: string, options?: {
    scope?: string;
    limit?: number;
  }): ToolSearchResult[];
  /**
   * Vector similarity search on tool_registry_embeddings using vec0 KNN.
   * Returns tool IDs and distances sorted by cosine similarity.
   */
  searchByVector(queryEmbedding: Float32Array, options?: {
    scope?: string;
    limit?: number;
  }): Array<{
    tool_id: number;
    distance: number;
  }>;
  /**
   * Hybrid search combining FTS5 keyword and vec0 vector results via
   * reciprocal rank fusion (RRF). Falls back to FTS5-only when vector
   * search is unavailable (no worker, no sqlite-vec, no embeddings).
   */
  searchTools(query: string, options?: {
    scope?: string;
    limit?: number;
    worker?: {
      isReady(): boolean;
      embed(text: string): Promise<Float32Array | null>;
    } | null;
    hasVectorSupport?: boolean;
  }): Promise<ToolSearchResult[]>;
  /**
   * Stores an embedding vector for a tool in tool_registry_embeddings.
   * Used by the background embedding loop to index tool descriptions.
   */
  storeEmbedding(toolId: number, embedding: Float32Array): void;
  /**
   * Returns tools that have descriptions but no embedding yet.
   * Used by the background embedding loop to find work.
   */
  findUnembeddedTools(limit?: number): Array<{
    id: number;
    name: string;
    description: string;
  }>;
}
//#endregion
//#region src/hooks/handler.d.ts
/**
 * Processes a PostToolUse or PostToolUseFailure event through the full
 * filter pipeline: route research tools -> extract -> privacy -> admission -> store.
 *
 * Exported for unit testing of the pipeline logic.
 */
declare function processPostToolUseFiltered(input: Record<string, unknown>, obsRepo: ObservationRepository, researchBuffer?: ResearchBufferRepository, toolRegistry?: ToolRegistryRepository, projectHash?: string, db?: better_sqlite30.Database): void;
//#endregion
export { processPostToolUseFiltered };
//# sourceMappingURL=handler.d.ts.map