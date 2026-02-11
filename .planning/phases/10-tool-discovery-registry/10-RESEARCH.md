# Phase 10: Tool Discovery and Registry - Research

**Researched:** 2026-02-10
**Domain:** File-based configuration parsing, SQLite schema design, Claude Code hook integration
**Confidence:** HIGH

## Summary

Phase 10 builds a tool registry that gives Laminark awareness of every tool available to Claude Code -- MCP servers, slash commands, skills, and plugins -- across both project and global scopes. The implementation requires two complementary discovery mechanisms: (1) **config scanning** at SessionStart to enumerate tools from filesystem configuration files (`.mcp.json`, `~/.claude.json`, command/skill directories, `installed_plugins.json`), and (2) **organic discovery** via the existing PostToolUse hook to capture tool names that appear during actual usage, even if they were missed during config scanning.

All discovery data flows into a new `tool_registry` SQLite table (migration 16) that stores tool name, type, description, scope origin, and timestamps. The existing hook handler in `src/hooks/handler.ts` already receives `tool_name` on every PostToolUse event -- the organic discovery path is a lightweight side-effect (single INSERT OR IGNORE) added to the existing pipeline before the self-referential filter. The config scanning runs during the SessionStart hook, which is synchronous but has a 10-second timeout and currently completes in under 100ms, leaving ample budget for filesystem reads.

The existing codebase provides strong infrastructure: the migration system (`src/storage/migrations.ts`, currently at version 15) handles schema additions cleanly. The repository pattern used by `ObservationRepository` and `ResearchBufferRepository` provides the exact template for a new `ToolRegistryRepository`. The hook handler's `processPostToolUseFiltered` already routes different events and would gain a single additional call at its entry point.

**Primary recommendation:** Add migration 16 for `tool_registry` table, create `src/storage/tool-registry.ts` as a repository class following the existing pattern, add config scanning to `handleSessionStart` in `session-lifecycle.ts`, and add organic tool recording to `processPostToolUseFiltered` in `handler.ts`.

## Standard Stack

### Core (No New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | ^12.6.2 | Database for tool_registry table | Already in use -- single database for all Laminark data |
| `zod` | ^4.3.6 | Input validation for registry types | Already in use for all Laminark schemas |
| Node.js `fs` | built-in | Read config files (.mcp.json, etc.) | Zero dependency -- `readFileSync`/`readdirSync` for synchronous hook context |
| Node.js `path` | built-in | Resolve config file paths | Zero dependency -- `join`, `resolve`, `basename` |
| Node.js `os` | built-in | `homedir()` for global config paths | Already used in `src/shared/config.ts` |

### Supporting (Already Present)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@modelcontextprotocol/sdk` | ^1.26.0 | Only if exposing registry as MCP tool | Future phase (discover_tools); not needed for Phase 10 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `readFileSync` for config parsing | `readFile` (async) | SessionStart hook is synchronous -- stdout must be written before exit. Async would require restructuring the hook handler. `readFileSync` is the correct choice for the sync hook context and matches the existing pattern in `config.ts`. |
| Single `tool_registry` table | Separate tables per tool type | Single table with `tool_type` column is simpler, matches the flat querying pattern used in `observations`, and avoids JOIN complexity for multi-type queries. |
| SQLite FTS5 on tool_registry | Plain LIKE queries | The registry will have hundreds of entries, not thousands. FTS5 overhead is not justified. LIKE with indexes suffices. |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure (Additions Only)

```
src/
  storage/
    tool-registry.ts        # NEW: ToolRegistryRepository (CRUD, scoped queries)
  hooks/
    handler.ts              # MODIFIED: add organic discovery call at pipeline entry
    session-lifecycle.ts    # MODIFIED: add config scanning to handleSessionStart
    config-scanner.ts       # NEW: filesystem config scanning logic
  shared/
    tool-types.ts           # NEW: ToolScope, ToolType, ToolRegistryRow types
```

### Pattern 1: ToolRegistryRepository (following ObservationRepository pattern)

**What:** A repository class that encapsulates all tool_registry CRUD operations with prepared statements.
**When to use:** Every interaction with the tool_registry table.

```typescript
// src/storage/tool-registry.ts
// Source: follows pattern from src/storage/observations.ts (ObservationRepository)
import type BetterSqlite3 from 'better-sqlite3';
import { debug } from '../shared/debug.js';

export class ToolRegistryRepository {
  private readonly db: BetterSqlite3.Database;

  // Prepared statements (prepared once, reused)
  private readonly stmtUpsert: BetterSqlite3.Statement;
  private readonly stmtRecordUsage: BetterSqlite3.Statement;
  private readonly stmtGetByScope: BetterSqlite3.Statement;
  private readonly stmtGetByName: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;

    this.stmtUpsert = db.prepare(`
      INSERT INTO tool_registry (name, tool_type, scope, source, project_hash, description, server_name, discovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (name, COALESCE(project_hash, '')) DO UPDATE SET
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
      WHERE (scope = 'global' OR project_hash = ?)
      ORDER BY usage_count DESC, discovered_at DESC
    `);

    this.stmtGetByName = db.prepare(`
      SELECT * FROM tool_registry WHERE name = ?
      ORDER BY usage_count DESC LIMIT 1
    `);
  }

  upsert(tool: {
    name: string;
    toolType: string;
    scope: string;
    source: string;
    projectHash: string | null;
    description: string | null;
    serverName: string | null;
  }): void {
    this.stmtUpsert.run(
      tool.name,
      tool.toolType,
      tool.scope,
      tool.source,
      tool.projectHash,
      tool.description,
      tool.serverName,
    );
  }

  recordUsage(name: string, projectHash: string | null): void {
    this.stmtRecordUsage.run(name, projectHash);
  }

  getForProject(projectHash: string): ToolRegistryRow[] {
    return this.stmtGetByScope.all(projectHash) as ToolRegistryRow[];
  }
}
```

**Key design decisions:**
- **No project_hash scoping in constructor** (unlike ObservationRepository) -- the tool registry is queried across scopes, so it needs access to both global and project-specific tools.
- **Upsert semantics** -- `INSERT ... ON CONFLICT DO UPDATE` because the same tool may be discovered from config scanning AND organic usage. The first discovery creates the row; subsequent discoveries update metadata.
- **`usage_count` and `last_used_at`** -- incremented via organic discovery (PostToolUse), never by config scanning.

### Pattern 2: Config Scanner (SessionStart-Compatible)

**What:** A synchronous function that reads Claude Code config files and returns discovered tool entries.
**When to use:** Called from `handleSessionStart` after session creation, before context assembly.

```typescript
// src/hooks/config-scanner.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface DiscoveredTool {
  name: string;
  toolType: 'mcp_server' | 'slash_command' | 'skill' | 'plugin';
  scope: 'global' | 'project';
  source: string;      // e.g., 'config:.mcp.json', 'config:~/.claude.json'
  projectHash: string | null;
  description: string | null;
  serverName: string | null;  // for MCP servers: the server name key
}

/**
 * Scans all Claude Code configuration surfaces for available tools.
 * MUST be synchronous -- called from synchronous SessionStart hook.
 *
 * Catches all errors per-source to prevent one failing scan from
 * blocking the entire discovery process. Returns partial results on error.
 */
export function scanConfigForTools(cwd: string, projectHash: string): DiscoveredTool[] {
  const tools: DiscoveredTool[] = [];

  // DISC-01: MCP servers from project .mcp.json
  scanMcpJson(join(cwd, '.mcp.json'), 'project', projectHash, tools);

  // DISC-01: MCP servers from ~/.claude.json
  scanClaudeJson(join(homedir(), '.claude.json'), tools);

  // DISC-02: Slash commands
  scanCommands(join(cwd, '.claude', 'commands'), 'project', projectHash, tools);
  scanCommands(join(homedir(), '.claude', 'commands'), 'global', null, tools);

  // DISC-03: Skills
  scanSkills(join(cwd, '.claude', 'skills'), 'project', projectHash, tools);
  scanSkills(join(homedir(), '.claude', 'skills'), 'global', null, tools);

  // DISC-04: Installed plugins
  scanInstalledPlugins(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), tools);

  return tools;
}
```

**Critical constraint:** All filesystem operations MUST be synchronous (`readFileSync`, `readdirSync`, `existsSync`). The SessionStart hook is synchronous -- stdout output is injected into Claude's context window. The hook handler cannot use `await`.

### Pattern 3: Organic Discovery via PostToolUse

**What:** A lightweight side-effect at the top of the PostToolUse pipeline that records every tool name seen.
**When to use:** On every PostToolUse/PostToolUseFailure event, BEFORE the self-referential filter.

```typescript
// In handler.ts processPostToolUseFiltered(), at the very top:
const toolName = input.tool_name as string | undefined;
if (!toolName) return;

// Organic discovery: record tool name regardless of other filters.
// This captures tools that were not found during config scanning.
// Uses INSERT OR IGNORE so it's a no-op for already-known tools.
if (toolRegistry) {
  toolRegistry.recordOrCreate(toolName, {
    toolType: inferToolType(toolName),
    scope: inferScope(toolName),
    source: 'hook:PostToolUse',
    projectHash: projectHash,
    serverName: extractServerName(toolName),
  });
}

// Then continue with existing self-referential filter, etc.
if (isLaminarksOwnTool(toolName)) { ... }
```

**Key design decisions:**
- Runs BEFORE self-referential filter -- we want to record Laminark's own tools in the registry too (they are valid tools, even if we don't create observations for them).
- Uses `INSERT OR IGNORE` or upsert to avoid duplicates with config-scanned entries.
- Tool type inference from name patterns: `mcp__*` -> mcp_tool, `/` prefix -> slash_command, etc.

### Pattern 4: Tool Name Parsing (Extracting Metadata from Tool Names)

**What:** Tool names from PostToolUse contain embedded metadata about their origin.
**When to use:** During organic discovery to populate scope, server_name, and tool_type.

```typescript
// src/hooks/tool-name-parser.ts

/**
 * Tool name patterns observed in Claude Code:
 *
 * Built-in tools:       "Write", "Edit", "Bash", "Read", "Glob", "Grep"
 *                       "WebFetch", "WebSearch", "NotebookEdit", "Skill", "TaskCreate", etc.
 *
 * Project MCP tools:    "mcp__<server>__<tool>"
 *                       e.g., "mcp__laminark__recall"
 *
 * Plugin MCP tools:     "mcp__plugin_<plugin>_<server>__<tool>"
 *                       e.g., "mcp__plugin_laminark_laminark__recall"
 *
 * Slash commands:       Invoked via "Skill" tool with args, not directly visible
 *                       in PostToolUse as their own tool_name.
 */

export function inferToolType(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'mcp_tool';
  // Built-in tools are PascalCase single words
  if (/^[A-Z][a-zA-Z]+$/.test(toolName)) return 'builtin';
  return 'unknown';
}

export function inferScope(toolName: string): string {
  if (toolName.startsWith('mcp__plugin_')) return 'plugin';
  if (toolName.startsWith('mcp__')) return 'project'; // may be global, but unknown from name alone
  return 'global'; // built-in tools are always global
}

export function extractServerName(toolName: string): string | null {
  // mcp__<server>__<tool> -> server
  const projectMatch = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
  if (projectMatch) return projectMatch[1];
  return null;
}
```

**Important limitation:** From PostToolUse alone, we cannot distinguish a project-scoped MCP server from a global one -- both use `mcp__<server>__<tool>`. Config scanning is needed to set the correct scope. Organic discovery defaults to a conservative guess and gets corrected when config scanning runs.

### Pattern 5: Migration 16 (tool_registry table)

**What:** New migration adding the `tool_registry` table to the existing migration chain.
**When to use:** Applied automatically on database open (existing `runMigrations` handles this).

```sql
-- Migration 16: create_tool_registry
CREATE TABLE tool_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,              -- tool name (e.g., "mcp__laminark__recall", "Write", "/gsd:plan-phase")
  tool_type TEXT NOT NULL,         -- 'mcp_tool', 'slash_command', 'skill', 'plugin', 'builtin', 'unknown'
  scope TEXT NOT NULL,             -- 'global', 'project', 'plugin'
  source TEXT NOT NULL,            -- discovery source: 'config:.mcp.json', 'config:~/.claude.json', 'hook:PostToolUse', etc.
  project_hash TEXT,               -- NULL for global tools, specific hash for project-scoped
  description TEXT,                -- human-readable description (from config, SKILL.md, etc.)
  server_name TEXT,                -- MCP server name (e.g., "laminark", "playwright") -- NULL for non-MCP tools
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unique constraint: same tool name + project scope = one row
-- Global tools (project_hash IS NULL) use COALESCE to create a virtual unique key
CREATE UNIQUE INDEX idx_tool_registry_name_project
  ON tool_registry(name, COALESCE(project_hash, ''));

-- Fast scope-based queries (used by session context assembly)
CREATE INDEX idx_tool_registry_scope
  ON tool_registry(scope);

-- Fast project-based queries
CREATE INDEX idx_tool_registry_project
  ON tool_registry(project_hash) WHERE project_hash IS NOT NULL;

-- Usage-based ordering
CREATE INDEX idx_tool_registry_usage
  ON tool_registry(usage_count DESC, last_used_at DESC);
```

**Key design decisions:**
- **Unique on (name, project_hash):** The same tool name can appear in different projects (a project may have its own `.mcp.json` with a server named "postgres" while another project also has one). Global tools have `project_hash = NULL`, and `COALESCE(project_hash, '')` handles the NULL comparison in the unique index.
- **`usage_count` as integer, not float:** Simple increment. No decay in Phase 10 (usage decay is a future phase concern for staleness detection).
- **`server_name` for MCP tools:** Enables grouping tools by their parent server (e.g., all `mcp__playwright__*` tools belong to server "playwright").

### Anti-Patterns to Avoid

- **Async filesystem reads in SessionStart:** The SessionStart hook is synchronous. Using `readFile` (async) would require restructuring the entire hook flow. Use `readFileSync` -- the config files are small (typically <10KB) and read in under 1ms each.
- **Parsing `~/.claude.json` fully:** This file can be 15KB+ with per-project stats, analytics data, feature flags, etc. Only parse the `projects.*.mcpServers` paths. Use targeted JSON extraction, not full config deserialization.
- **Recording tool usage in config scanning:** Config scanning should only CREATE or UPDATE tool metadata (description, scope). It should NEVER increment `usage_count` -- that metric is exclusively updated by organic PostToolUse events.
- **Blocking on registry errors:** The tool registry is supplementary to Laminark's core memory function. If the registry table doesn't exist (pre-migration), if a JSON config file is malformed, or if a filesystem read fails, the hook handler should continue normally. Wrap all registry operations in try/catch with debug logging.
- **Scanning recursively into deep command trees:** The `~/.claude/commands/` directory may contain deeply nested subdirectories. Limit scanning to 2 levels deep (matching Claude Code's own resolution) to avoid performance issues with large command trees.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Unique tool identity | Custom deduplication logic | SQL UNIQUE INDEX + INSERT OR IGNORE/ON CONFLICT | SQLite handles uniqueness atomically; custom dedup has race conditions |
| Config file watching | `fs.watch` / `chokidar` for live config changes | Re-scan on SessionStart | Config changes between sessions, not mid-session. File watching adds complexity and resource usage for zero benefit in Laminark's hook-based architecture |
| MCP tool name parsing | Full MCP protocol inspection | Regex on tool_name string | Claude Code normalizes all MCP tool names to `mcp__<server>__<tool>` pattern. The name string IS the source of truth |
| Tool type taxonomy | Dynamic type system | Fixed string enum with CHECK constraint | The tool types are known and finite. Dynamic types add query complexity without value |

**Key insight:** The tool registry is a flat index, not a complex relationship store. Most of the intelligence about tools comes from how they are USED (tracked via observations and the knowledge graph), not from what they ARE. The registry just answers "what exists and where did it come from?"

## Common Pitfalls

### Pitfall 1: SessionStart Performance Degradation

**What goes wrong:** Config scanning adds filesystem reads to the synchronous SessionStart hook. If scanning takes too long, it degrades Claude Code startup responsiveness.
**Why it happens:** Reading many files, parsing large JSON, or scanning directories with thousands of entries.
**How to avoid:**
1. Budget: Config scanning gets 200ms MAX within the 2-second SessionStart budget (currently uses ~100ms for context assembly).
2. Use `existsSync` before `readFileSync` to skip missing files (avoids exception overhead).
3. Limit directory scanning depth to 2 levels.
4. Parse only the needed JSON keys from `~/.claude.json` (don't deserialize the entire 15KB object).
5. Add timing instrumentation with debug logging.
**Warning signs:** `debug('session', 'Context assembly slow')` messages in logs; `elapsed` values approaching 500ms.

### Pitfall 2: JSON Parsing Failures from Malformed Config

**What goes wrong:** Users may have malformed `.mcp.json` or `~/.claude.json` files. If `JSON.parse` throws, it could crash the hook handler.
**Why it happens:** Hand-edited config files, partial writes, comments in JSON (not valid but common).
**How to avoid:** Wrap every `JSON.parse` in try/catch. Return empty results for that source. Log the error via `debug()` but never throw from config scanning.
**Warning signs:** Users reporting "Laminark stopped loading context" after editing their claude config.

### Pitfall 3: Duplicate Tools from Multiple Discovery Sources

**What goes wrong:** The same tool is discovered via config scanning AND organic PostToolUse, creating duplicate rows.
**Why it happens:** An MCP server listed in `.mcp.json` is also seen when Claude invokes its tools.
**How to avoid:** The UNIQUE index on `(name, COALESCE(project_hash, ''))` prevents true duplicates at the database level. Use `INSERT ... ON CONFLICT DO UPDATE` (upsert) so the second discovery updates metadata rather than failing.
**Warning signs:** `SQLITE_CONSTRAINT` errors in debug logs during PostToolUse processing.

### Pitfall 4: NULL project_hash in UNIQUE Index

**What goes wrong:** SQLite treats NULL as unique to itself -- `NULL != NULL`. Two global tools with `project_hash = NULL` and the same name would both insert successfully, violating the intended uniqueness.
**Why it happens:** SQL standard NULL semantics in UNIQUE indexes.
**How to avoid:** Use `COALESCE(project_hash, '')` in the UNIQUE index expression. This converts NULL to empty string for uniqueness comparison only. The actual column still stores NULL.
**Warning signs:** Multiple rows with the same tool name and `project_hash IS NULL`.

### Pitfall 5: installed_plugins.json Schema Instability

**What goes wrong:** The `installed_plugins.json` format may change between Claude Code versions. Hard-coding assumptions about the JSON structure leads to parsing failures.
**Why it happens:** This is an internal Claude Code file, not a public API. The schema has already changed (version 1 to version 2).
**How to avoid:** Parse defensively: check for `version` field, handle both known structures, skip unknown structures with a debug warning. Only extract the minimum needed: plugin name, scope, and install path.
**Warning signs:** `debug('scanner', 'Unknown installed_plugins.json version')` messages.

### Pitfall 6: Organic Discovery Creating Noise Entries

**What goes wrong:** Every tool call creates a registry entry, including internal/debugging tools, one-off Task* tools, and other noise.
**Why it happens:** PostToolUse fires for ALL tool calls, including Claude's internal task management tools.
**How to avoid:** The registry SHOULD capture all tools -- this is by design. The registry is a complete inventory, not a curated list. Filtering for relevance happens at query time (e.g., "show tools with usage_count > 1") or in future phases (staleness detection).
**Warning signs:** None -- this is expected behavior. Do NOT add noise filtering to organic discovery.

## Code Examples

### Complete Migration 16

```typescript
// In src/storage/migrations.ts, add to MIGRATIONS array:
{
  version: 16,
  name: 'create_tool_registry',
  up: `
    CREATE TABLE tool_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tool_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      project_hash TEXT,
      description TEXT,
      server_name TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX idx_tool_registry_name_project
      ON tool_registry(name, COALESCE(project_hash, ''));

    CREATE INDEX idx_tool_registry_scope
      ON tool_registry(scope);

    CREATE INDEX idx_tool_registry_project
      ON tool_registry(project_hash) WHERE project_hash IS NOT NULL;

    CREATE INDEX idx_tool_registry_usage
      ON tool_registry(usage_count DESC, last_used_at DESC);
  `,
},
```

### Config Scanner: MCP Server Discovery (DISC-01)

```typescript
// src/hooks/config-scanner.ts

function scanMcpJson(
  filePath: string,
  scope: 'global' | 'project',
  projectHash: string | null,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    // .mcp.json has { mcpServers: { <name>: { command, args } } }
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== 'object') return;

    for (const serverName of Object.keys(servers)) {
      tools.push({
        name: `mcp__${serverName}__*`,  // wildcard -- we don't know individual tool names from config
        toolType: 'mcp_server',
        scope,
        source: `config:${filePath}`,
        projectHash,
        description: null,  // .mcp.json doesn't include descriptions
        serverName,
      });
    }
  } catch {
    debug('scanner', 'Failed to scan MCP config', { filePath });
  }
}

function scanClaudeJson(filePath: string, tools: DiscoveredTool[]): void {
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;

    // ~/.claude.json may have global mcpServers at top level
    const globalServers = config.mcpServers as Record<string, unknown> | undefined;
    if (globalServers && typeof globalServers === 'object') {
      for (const serverName of Object.keys(globalServers)) {
        tools.push({
          name: `mcp__${serverName}__*`,
          toolType: 'mcp_server',
          scope: 'global',
          source: 'config:~/.claude.json',
          projectHash: null,
          description: null,
          serverName,
        });
      }
    }

    // Per-project mcpServers in projects.<path>.mcpServers
    const projects = config.projects as Record<string, Record<string, unknown>> | undefined;
    if (projects && typeof projects === 'object') {
      for (const [, projectData] of Object.entries(projects)) {
        const pServers = projectData.mcpServers as Record<string, unknown> | undefined;
        if (pServers && typeof pServers === 'object') {
          for (const serverName of Object.keys(pServers)) {
            tools.push({
              name: `mcp__${serverName}__*`,
              toolType: 'mcp_server',
              scope: 'global',  // user-scope MCP servers are global
              source: 'config:~/.claude.json',
              projectHash: null,
              description: null,
              serverName,
            });
          }
        }
      }
    }
  } catch {
    debug('scanner', 'Failed to scan ~/.claude.json');
  }
}
```

### Config Scanner: Command Discovery (DISC-02)

```typescript
function scanCommands(
  dirPath: string,
  scope: 'global' | 'project',
  projectHash: string | null,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(dirPath)) return;

    // Scan up to 2 levels deep for .md files
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const cmdName = basename(entry.name, '.md');
        tools.push({
          name: `/${cmdName}`,
          toolType: 'slash_command',
          scope,
          source: `config:${dirPath}`,
          projectHash,
          description: extractFrontmatterDescription(join(dirPath, entry.name)),
          serverName: null,
        });
      } else if (entry.isDirectory()) {
        // One level deeper for namespaced commands (e.g., gsd/plan-phase.md -> /gsd:plan-phase)
        const subDir = join(dirPath, entry.name);
        try {
          const subEntries = readdirSync(subDir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isFile() && subEntry.name.endsWith('.md')) {
              const subCmdName = basename(subEntry.name, '.md');
              tools.push({
                name: `/${entry.name}:${subCmdName}`,
                toolType: 'slash_command',
                scope,
                source: `config:${subDir}`,
                projectHash,
                description: extractFrontmatterDescription(join(subDir, subEntry.name)),
                serverName: null,
              });
            }
          }
        } catch {
          // Skip unreadable subdirectories
        }
      }
    }
  } catch {
    debug('scanner', 'Failed to scan commands directory', { dirPath });
  }
}

/**
 * Extracts the description from a command file's YAML frontmatter.
 * Returns null if no frontmatter or no description found.
 * Keeps read small -- only reads first 500 bytes.
 */
function extractFrontmatterDescription(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf-8').slice(0, 500);
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const descMatch = match[1].match(/description:\s*(.+)/);
    return descMatch ? descMatch[1].trim() : null;
  } catch {
    return null;
  }
}
```

### Config Scanner: Skill Discovery (DISC-03)

```typescript
function scanSkills(
  dirPath: string,
  scope: 'global' | 'project',
  projectHash: string | null,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(dirPath)) return;

    // Skills live in <skills-dir>/<skill-name>/SKILL.md
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMdPath = join(dirPath, entry.name, 'SKILL.md');
        if (existsSync(skillMdPath)) {
          tools.push({
            name: entry.name,  // skill name is the directory name
            toolType: 'skill',
            scope,
            source: `config:${dirPath}`,
            projectHash,
            description: extractFrontmatterDescription(skillMdPath),
            serverName: null,
          });
        }
      }
    }
  } catch {
    debug('scanner', 'Failed to scan skills directory', { dirPath });
  }
}
```

### Config Scanner: Plugin Discovery (DISC-04)

```typescript
function scanInstalledPlugins(
  filePath: string,
  tools: DiscoveredTool[],
): void {
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf-8');
    const manifest = JSON.parse(raw) as Record<string, unknown>;

    // installed_plugins.json structure (version 2):
    // { version: 2, plugins: { "<name>@<marketplace>": [{ scope, installPath, version, ... }] } }
    const plugins = manifest.plugins as Record<string, Array<Record<string, unknown>>> | undefined;
    if (!plugins || typeof plugins !== 'object') return;

    for (const [pluginKey, installations] of Object.entries(plugins)) {
      if (!Array.isArray(installations)) continue;

      for (const install of installations) {
        const installScope = install.scope as string | undefined;
        const installPath = install.installPath as string | undefined;
        const version = install.version as string | undefined;

        // Extract plugin name from key (format: "name@marketplace")
        const pluginName = pluginKey.split('@')[0];

        tools.push({
          name: pluginName,
          toolType: 'plugin',
          scope: installScope === 'user' ? 'global' : 'project',
          source: 'config:installed_plugins.json',
          projectHash: null,  // plugins are tracked globally; project scope is by install.projectPath
          description: `Plugin ${pluginName} v${version ?? 'unknown'}`,
          serverName: null,
        });

        // If the plugin has an .mcp.json, scan it for MCP servers
        if (installPath) {
          scanMcpJson(
            join(installPath, '.mcp.json'),
            installScope === 'user' ? 'global' : 'plugin',
            null,
            tools,
          );
        }
      }
    }
  } catch {
    debug('scanner', 'Failed to scan installed_plugins.json');
  }
}
```

### Integration into handleSessionStart

```typescript
// In src/hooks/session-lifecycle.ts handleSessionStart():

export function handleSessionStart(
  input: Record<string, unknown>,
  sessionRepo: SessionRepository,
  db: BetterSqlite3.Database,
  projectHash: string,
): string | null {
  const sessionId = input.session_id as string | undefined;
  if (!sessionId) return null;

  sessionRepo.create(sessionId);

  // Tool discovery: scan config files for available tools
  const cwd = input.cwd as string;
  try {
    const toolRegistry = new ToolRegistryRepository(db);
    const tools = scanConfigForTools(cwd, projectHash);
    for (const tool of tools) {
      toolRegistry.upsert(tool);
    }
    debug('session', 'Config scan completed', { toolsFound: tools.length });
  } catch {
    // Tool registry is supplementary -- never block session start
    debug('session', 'Config scan failed (non-fatal)');
  }

  // Assemble context (existing behavior)
  const context = assembleSessionContext(db, projectHash);
  return context;
}
```

### Integration into processPostToolUseFiltered

```typescript
// In src/hooks/handler.ts processPostToolUseFiltered(), add at the top:

export function processPostToolUseFiltered(
  input: Record<string, unknown>,
  obsRepo: ObservationRepository,
  researchBuffer?: ResearchBufferRepository,
  toolRegistry?: ToolRegistryRepository,
): void {
  const toolName = input.tool_name as string | undefined;
  if (!toolName) return;

  // DISC-05: Organic tool discovery -- record every tool we see
  if (toolRegistry) {
    try {
      toolRegistry.recordOrCreate(toolName, {
        toolType: inferToolType(toolName),
        scope: inferScope(toolName),
        source: 'hook:PostToolUse',
        projectHash: /* from input.cwd */ null,
        serverName: extractServerName(toolName),
      });
    } catch {
      // Non-fatal: registry is supplementary
    }
  }

  // Existing pipeline continues unchanged:
  if (isLaminarksOwnTool(toolName)) { ... }
  // ...
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No tool awareness | Observe tool_name in PostToolUse only | Laminark V1 (2026) | Tool names captured but not indexed |
| Manual tool listing | Automatic config scanning | Phase 10 (new) | Proactive discovery eliminates manual tracking |
| Single-project scope | Global + project scope awareness | Phase 9 -> 10 | Cross-project tool visibility |

**Not applicable to Phase 10:**
- Tool capability search (future: Phase D-2)
- Conversation-driven routing (future: Phase D-1)
- Staleness detection (future: Phase D-5)

## Open Questions

1. **MCP server tool names from config vs actual names**
   - What we know: Config files (`.mcp.json`) list server NAMES (e.g., "laminark", "playwright"), not individual tool names. The actual tool names (e.g., `mcp__playwright__browser_screenshot`) are only known when Claude invokes them.
   - What's unclear: Should we store server-level entries (e.g., `mcp__laminark__*`) from config scanning and individual tool entries from organic discovery? Or wait for organic discovery for individual tools?
   - Recommendation: Store both. Config scanning creates a server-level entry (`mcp__<server>__*` with `tool_type = 'mcp_server'`). Organic discovery creates individual tool entries (`mcp__<server>__<tool>` with `tool_type = 'mcp_tool'`). Both are valid registry entries representing different granularity levels. The server-level entry confirms the server is configured; the tool-level entries confirm which tools actually get used.

2. **Slash commands and skills: how they appear in PostToolUse**
   - What we know: Slash commands are invoked by the user typing `/command-name`. Claude Code translates these into a `Skill` tool call. In PostToolUse, the tool_name is "Skill" with the skill name in `tool_input.skill`.
   - What's unclear: Whether the organic discovery path can extract the actual command/skill name from the `Skill` tool's input to link it to config-scanned entries.
   - Recommendation: Yes. When `tool_name === 'Skill'`, extract `tool_input.skill` as the actual skill/command name and record THAT in the registry alongside the generic "Skill" tool entry. This links organic usage to config-discovered commands/skills.

3. **Registry table scope: global singleton vs project-partitioned**
   - What we know: The `observations` table uses `project_hash` partitioning. Global tools have `project_hash = NULL`.
   - What's unclear: Whether querying "all tools available to project X" (global + project-specific) will perform well as the registry grows across many projects.
   - Recommendation: The expected registry size is small (tens to low hundreds of entries per project, maybe thousands globally). A single table with the `COALESCE(project_hash, '')` unique index and a scope index will perform fine. No partitioning needed.

4. **`~/.claude.json` mcpServers at project level vs user level**
   - What we know: From examining the actual `~/.claude.json`, the `mcpServers` field appears nested inside `projects.<path>` objects, not at the top level. User-scoped MCP servers would be at the top level.
   - What's unclear: Whether any user-scoped MCP servers exist at the top level of `~/.claude.json` in practice.
   - Recommendation: Scan both: check top-level `mcpServers` (user scope) and `projects.*.mcpServers` (project scope). The per-project entries in `~/.claude.json` are distinct from project `.mcp.json` files -- they represent user-configured servers via `claude mcp add`.

## Sources

### Primary (HIGH confidence)
- Laminark codebase analysis: `src/hooks/handler.ts`, `src/hooks/session-lifecycle.ts`, `src/storage/migrations.ts`, `src/storage/observations.ts`, `src/shared/config.ts`, `src/context/injection.ts` -- all read and analyzed directly
- Actual file inspection: `~/.claude.json` (15KB, contains projects with mcpServers), `~/.claude/plugins/installed_plugins.json` (version 2 format with plugin scopes), `.mcp.json` (standard mcpServers format), `.claude-plugin/plugin.json` (plugin manifest)
- Claude Code plugin ecosystem: Examined installed plugins (frontend-design, clangd-lsp, agent-sdk-dev) to understand `.claude-plugin/plugin.json` schema, skill directory structure (`skills/<name>/SKILL.md`), and `.mcp.json` within plugins

### Secondary (MEDIUM confidence)
- Phase 9 research (`09-RESEARCH.md`) -- plugin prefix patterns, hook configuration, plugin cache behavior
- V2 feature research (`FEATURES.md`) -- tool_registry schema design, scope hierarchy, discovery source ranking
- V2 architecture research (`ARCHITECTURE.md`) -- component map, data flow patterns

### Tertiary (LOW confidence)
- Slash command/skill appearance in PostToolUse: Based on inference from the `Skill` tool's known behavior pattern. Needs empirical verification that `tool_input.skill` contains the command name during PostToolUse hook events.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Zero new dependencies; uses only existing libraries
- Architecture: HIGH - Follows established repository pattern; migration system is well-proven
- Config scanning: HIGH - All config file formats verified by reading actual files on disk
- Organic discovery: HIGH - PostToolUse tool_name field is already captured; adding a write is trivial
- Pitfalls: HIGH - All identified from actual codebase analysis and real config file inspection

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (Claude Code plugin system stable; config file formats unlikely to change)
