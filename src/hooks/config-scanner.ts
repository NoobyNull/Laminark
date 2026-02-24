import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

import { debug } from '../shared/debug.js';
import type { DiscoveredTool, ToolScope } from '../shared/tool-types.js';

/**
 * Extracts a description from YAML frontmatter in a Markdown file.
 * Reads only the first 2000 bytes for performance.
 */
function extractDescription(filePath: string): string | null {
  try {
    const fd = readFileSync(filePath, { encoding: 'utf-8', flag: 'r' });
    const head = fd.slice(0, 2000);
    const fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const descMatch = fmMatch[1].match(/description:\s*(.+)/);
    return descMatch ? descMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extracts trigger hints from a command/skill file for proactive suggestion matching.
 * Reads YAML frontmatter `description` + content from `<objective>` blocks.
 * Returns a concatenated string or null if nothing found.
 */
export function extractTriggerHints(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, { encoding: 'utf-8', flag: 'r' });
    const head = content.slice(0, 2000);
    const parts: string[] = [];

    // Extract description from YAML frontmatter
    const fmMatch = head.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*(.+)/);
      if (descMatch) parts.push(descMatch[1].trim());
    }

    // Extract content from <objective> blocks
    const objMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
    if (objMatch) parts.push(objMatch[1].trim());

    return parts.length > 0 ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

/**
 * Scans an .mcp.json file for MCP server entries.
 * Each server key becomes a wildcard tool entry (individual tool names are not in config).
 */
function scanMcpJson(
  filePath: string,
  scope: ToolScope,
  projectHash: string | null,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const mcpServers = config.mcpServers as Record<string, unknown> | undefined;

    if (!mcpServers || typeof mcpServers !== 'object') return;

    for (const serverName of Object.keys(mcpServers)) {
      tools.push({
        name: `mcp__${serverName}__*`,
        toolType: 'mcp_server',
        scope,
        source: `config:${filePath}`,
        projectHash,
        description: null,
        serverName,
        triggerHints: null,
      });
    }
  } catch (err) {
    debug('scanner', 'Failed to scan MCP config', { filePath, error: String(err) });
  }
}

/**
 * Scans ~/.claude.json for MCP servers (top-level and per-project).
 */
function scanClaudeJson(filePath: string, tools: DiscoveredTool[]): void {
  try {
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    // Top-level mcpServers (user-scope global servers)
    const topServers = config.mcpServers as Record<string, unknown> | undefined;
    if (topServers && typeof topServers === 'object') {
      for (const serverName of Object.keys(topServers)) {
        tools.push({
          name: `mcp__${serverName}__*`,
          toolType: 'mcp_server',
          scope: 'global',
          source: 'config:~/.claude.json',
          projectHash: null,
          description: null,
          serverName,
          triggerHints: null,
        });
      }
    }

    // Per-project mcpServers (projects.*.mcpServers)
    const projects = config.projects as Record<string, Record<string, unknown>> | undefined;
    if (projects && typeof projects === 'object') {
      for (const projectEntry of Object.values(projects)) {
        const projServers = projectEntry.mcpServers as Record<string, unknown> | undefined;
        if (projServers && typeof projServers === 'object') {
          for (const serverName of Object.keys(projServers)) {
            tools.push({
              name: `mcp__${serverName}__*`,
              toolType: 'mcp_server',
              scope: 'global',
              source: 'config:~/.claude.json',
              projectHash: null,
              description: null,
              serverName,
              triggerHints: null,
            });
          }
        }
      }
    }
  } catch (err) {
    debug('scanner', 'Failed to scan claude.json', { filePath, error: String(err) });
  }
}

/**
 * Scans a commands directory for slash command .md files.
 * Supports one level of subdirectory nesting for namespaced commands.
 */
function scanCommands(
  dirPath: string,
  scope: ToolScope,
  projectHash: string | null,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(dirPath)) return;

    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const cmdName = `/${basename(entry.name, '.md')}`;
        const filePath = join(dirPath, entry.name);
        const description = extractDescription(filePath);
        const triggerHints = extractTriggerHints(filePath);
        tools.push({
          name: cmdName,
          toolType: 'slash_command',
          scope,
          source: `config:${dirPath}`,
          projectHash,
          description,
          serverName: null,
          triggerHints,
        });
      } else if (entry.isDirectory()) {
        // One level deep: namespaced commands
        const subDir = join(dirPath, entry.name);
        try {
          const subEntries = readdirSync(subDir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile() && subEntry.name.endsWith('.md')) {
              const cmdName = `/${entry.name}:${basename(subEntry.name, '.md')}`;
              const subFilePath = join(subDir, subEntry.name);
              const description = extractDescription(subFilePath);
              const triggerHints = extractTriggerHints(subFilePath);
              tools.push({
                name: cmdName,
                toolType: 'slash_command',
                scope,
                source: `config:${dirPath}`,
                projectHash,
                description,
                serverName: null,
                triggerHints,
              });
            }
          }
        } catch {
          // Subdirectory unreadable -- skip
        }
      }
    }
  } catch (err) {
    debug('scanner', 'Failed to scan commands directory', { dirPath, error: String(err) });
  }
}

/**
 * Scans a skills directory for skill subdirectories containing SKILL.md.
 */
function scanSkills(
  dirPath: string,
  scope: ToolScope,
  projectHash: string | null,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(dirPath)) return;

    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(dirPath, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          const description = extractDescription(skillMdPath);
          const triggerHints = extractTriggerHints(skillMdPath);
          tools.push({
            name: entry.name,
            toolType: 'skill',
            scope,
            source: `config:${dirPath}`,
            projectHash,
            description,
            serverName: null,
            triggerHints,
          });
        }
      }
    }
  } catch (err) {
    debug('scanner', 'Failed to scan skills directory', { dirPath, error: String(err) });
  }
}

/**
 * Scans installed_plugins.json for installed Claude plugins.
 * Version 2 format: { version: 2, plugins: { "name@marketplace": [{ scope, installPath, version }] } }
 */
function scanInstalledPlugins(filePath: string, tools: DiscoveredTool[]): void {
  try {
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    const plugins = config.plugins as Record<string, unknown[]> | undefined;
    if (!plugins || typeof plugins !== 'object') return;

    for (const [key, installations] of Object.entries(plugins)) {
      const pluginName = key.split('@')[0];
      if (!Array.isArray(installations)) continue;

      for (const install of installations) {
        const inst = install as Record<string, unknown>;
        const instScope: ToolScope = inst.scope === 'user' ? 'global' : 'project';

        tools.push({
          name: pluginName,
          toolType: 'plugin',
          scope: instScope,
          source: 'config:installed_plugins.json',
          projectHash: null,
          description: null,
          serverName: null,
          triggerHints: null,
        });

        // If the installation has an installPath, scan its .mcp.json for MCP servers
        if (typeof inst.installPath === 'string') {
          scanMcpJson(
            join(inst.installPath, '.mcp.json'),
            'plugin',
            null,
            tools,
          );
        }
      }
    }
  } catch (err) {
    debug('scanner', 'Failed to scan installed plugins', { filePath, error: String(err) });
  }
}

/**
 * Scans all Claude Code config surfaces for tool discovery.
 * Called during SessionStart to proactively populate the tool registry.
 *
 * All filesystem operations are synchronous (SessionStart hook is synchronous).
 * Every scanner is wrapped in try/catch -- malformed configs never crash the hook.
 *
 * Config surfaces scanned:
 *   DISC-01: .mcp.json (project) + ~/.claude.json (global)
 *   DISC-02: .claude/commands (project) + ~/.claude/commands (global)
 *   DISC-03: .claude/skills (project) + ~/.claude/skills (global)
 *   DISC-04: installed_plugins.json (global plugins)
 */
export function scanConfigForTools(cwd: string, projectHash: string): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];
  const home = homedir();

  // DISC-01: MCP server configs
  scanMcpJson(join(cwd, '.mcp.json'), 'project', projectHash, tools);
  scanClaudeJson(join(home, '.claude.json'), tools);

  // DISC-02: Slash commands
  scanCommands(join(cwd, '.claude', 'commands'), 'project', projectHash, tools);
  scanCommands(join(home, '.claude', 'commands'), 'global', null, tools);

  // DISC-03: Skills
  scanSkills(join(cwd, '.claude', 'skills'), 'project', projectHash, tools);
  scanSkills(join(home, '.claude', 'skills'), 'global', null, tools);

  // DISC-04: Installed plugins
  scanInstalledPlugins(join(home, '.claude', 'plugins', 'installed_plugins.json'), tools);

  return tools;
}
