/**
 * Tool type classification based on how the tool is provided.
 */
export type ToolType = 'mcp_server' | 'mcp_tool' | 'slash_command' | 'skill' | 'plugin' | 'builtin' | 'unknown';

/**
 * Scope origin of a tool -- where it was discovered from.
 */
export type ToolScope = 'global' | 'project' | 'plugin';

/**
 * A tool discovered during config scanning (SessionStart).
 * Used as input to ToolRegistryRepository.upsert().
 */
export interface DiscoveredTool {
  name: string;
  toolType: ToolType;
  scope: ToolScope;
  source: string;        // e.g., 'config:.mcp.json', 'config:~/.claude.json', 'hook:PostToolUse'
  projectHash: string | null;
  description: string | null;
  serverName: string | null;  // for MCP servers/tools: the server name key
}

/**
 * Raw database row from the tool_registry table (snake_case).
 */
export interface ToolRegistryRow {
  id: number;
  name: string;
  tool_type: string;
  scope: string;
  source: string;
  project_hash: string | null;
  description: string | null;
  server_name: string | null;
  usage_count: number;
  last_used_at: string | null;
  discovered_at: string;
  updated_at: string;
}
