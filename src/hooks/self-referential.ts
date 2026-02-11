/**
 * Self-referential tool detection for Laminark.
 *
 * Laminark's MCP tools appear with different prefixes depending on
 * how Claude Code discovers the server:
 *
 * - Project-scoped (.mcp.json): `mcp__laminark__<tool>`
 * - Global plugin (~/.claude/plugins/): `mcp__plugin_laminark_laminark__<tool>`
 *
 * Both prefixes must be detected to prevent Laminark from capturing
 * its own tool calls as observations, which would create a feedback loop.
 */

/**
 * All known prefixes for Laminark's own MCP tools.
 * Order: project-scoped first (most common), plugin-scoped second.
 */
export const LAMINARK_PREFIXES = [
  'mcp__laminark__',
  'mcp__plugin_laminark_laminark__',
] as const;

/**
 * Returns true if the given tool name belongs to Laminark.
 *
 * Checks against all known Laminark MCP prefixes to detect self-referential
 * tool calls regardless of installation method (project-scoped or global plugin).
 */
export function isLaminarksOwnTool(toolName: string): boolean {
  return LAMINARK_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}
