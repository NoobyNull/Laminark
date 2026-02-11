import type { ToolType, ToolScope } from '../shared/tool-types.js';

/**
 * Infers the tool type from a tool name seen in PostToolUse.
 *
 * - MCP tools have the `mcp__` prefix
 * - Built-in tools are PascalCase single words (Write, Edit, Bash, Read, etc.)
 * - Anything else is unknown
 */
export function inferToolType(toolName: string): ToolType {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool';
  }
  if (/^[A-Z][a-zA-Z]+$/.test(toolName)) {
    return 'builtin';
  }
  return 'unknown';
}

/**
 * Infers the scope of a tool from its name.
 *
 * - Plugin MCP tools (mcp__plugin_*) are plugin-scoped
 * - Other MCP tools default to project-scoped (conservative; may be global but unknown from name alone)
 * - Non-MCP tools (builtins) are always global
 */
export function inferScope(toolName: string): ToolScope {
  if (toolName.startsWith('mcp__plugin_')) {
    return 'plugin';
  }
  if (toolName.startsWith('mcp__')) {
    return 'project';
  }
  return 'global';
}

/**
 * Extracts the MCP server name from a tool name.
 *
 * Plugin MCP tools: `mcp__plugin_<pluginName>_<serverName>__<tool>`
 *   Example: `mcp__plugin_laminark_laminark__recall` -> server is `laminark`
 *
 * Project MCP tools: `mcp__<serverName>__<tool>`
 *   Example: `mcp__playwright__browser_screenshot` -> server is `playwright`
 *
 * Returns null for non-MCP tools.
 */
export function extractServerName(toolName: string): string | null {
  // Plugin MCP tools: mcp__plugin_<pluginName>_<serverName>__<tool>
  const pluginMatch = toolName.match(
    /^mcp__plugin_([^_]+(?:_[^_]+)*)_([^_]+(?:_[^_]+)*)__/,
  );
  if (pluginMatch) {
    return pluginMatch[2];
  }

  // Project MCP tools: mcp__<serverName>__<tool>
  const projectMatch = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
  if (projectMatch) {
    return projectMatch[1];
  }

  return null;
}
