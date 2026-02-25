/**
 * MCP tool handler for bulk-registering available tools reported by Claude.
 *
 * At session start, Claude is prompted to call this tool with every tool it
 * has access to (built-in + MCP). This lets Laminark dynamically discover
 * the full tool surface without hardcoding names or relying on organic
 * PostToolUse discovery.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { ProjectHashRef } from '../../shared/types.js';
import type { ToolRegistryRepository } from '../../storage/tool-registry.js';
import { inferToolType, inferScope, extractServerName } from '../../hooks/tool-name-parser.js';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Registers the report_available_tools MCP tool on the server.
 *
 * Accepts an array of tool names (with optional descriptions) and upserts
 * each into the tool registry. Tool type, scope, and server name are inferred
 * from the tool name using the same parser as PostToolUse organic discovery.
 */
export function registerReportTools(
  server: McpServer,
  toolRegistry: ToolRegistryRepository,
  projectHashRef: ProjectHashRef,
): void {
  server.registerTool(
    'report_available_tools',
    {
      title: 'Report Available Tools',
      description:
        'Register all tools available in this session with Laminark. Call this once at session start with every tool name you have access to (built-in and MCP). This populates the tool registry for discovery and routing.',
      inputSchema: {
        tools: z
          .array(
            z.object({
              name: z.string().min(1).describe('Tool name exactly as it appears (e.g., "Read", "mcp__playwright__browser_click")'),
              description: z.string().optional().describe('Brief description of the tool'),
            }),
          )
          .min(1)
          .describe('Array of tools available in this session'),
      },
    },
    async (args) => {
      const projectHash = projectHashRef.current;
      try {
        let registered = 0;
        let skipped = 0;

        for (const tool of args.tools) {
          // Skip Laminark's own tools — they're already registered
          if (
            tool.name.startsWith('mcp__plugin_laminark_') ||
            tool.name.startsWith('mcp__laminark__')
          ) {
            skipped++;
            continue;
          }

          const toolType = inferToolType(tool.name);
          const scope = inferScope(tool.name);
          const serverName = extractServerName(tool.name);

          toolRegistry.upsert({
            name: tool.name,
            toolType,
            scope,
            source: 'config:session-report',
            projectHash: scope === 'global' ? null : projectHash,
            description: tool.description ?? null,
            serverName,
            triggerHints: null,
          });
          registered++;
        }

        debug('mcp', 'report_available_tools: completed', {
          total: args.tools.length,
          registered,
          skipped,
        });

        return textResponse(
          `Registered ${registered} tools in the tool registry.${skipped > 0 ? ` Skipped ${skipped} Laminark tools (already known).` : ''}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debug('mcp', 'report_available_tools: error', { error: message });
        return {
          content: [{ type: 'text' as const, text: `Report tools error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
