# Technology Stack: Global Tool Discovery & Routing

**Project:** Laminark -- Global Installation, Tool Discovery, Scope-Aware Registry, Conversation-Driven Routing
**Researched:** 2026-02-10
**Scope:** NEW capabilities only. Existing validated stack (SQLite/WAL, MCP SDK, Hono, Cytoscape, tsdown, etc.) is NOT re-researched.

## Executive Summary

This milestone requires **zero new npm dependencies**. Every capability needed for global installation, tool discovery, scope-aware registry, and conversation-driven routing can be built with Node.js standard library (`fs`, `path`, `os`, `crypto`) and the existing Laminark stack. The work is primarily:

1. Parsing JSON config files at known filesystem paths (Node.js `fs.readFileSync`)
2. Adding new SQLite tables/queries to the existing database
3. Modifying the hook handler to extract tool provenance from `tool_name` prefixes
4. Adjusting the plugin manifest and build for global installation

**Key insight from research:** Claude Code's config system is fully file-based (JSON files at deterministic paths). No API calls, no service discovery, no dynamic protocol needed. The "discovery" is just reading files.

## Recommended Stack Additions

### NO new npm packages needed

| Capability | Implementation | Why No New Package |
|------------|---------------|-------------------|
| Parse Claude Code config JSON files | `fs.readFileSync` + `JSON.parse` | Config files are plain JSON at known paths. Zod (already installed) handles validation. |
| Determine config file paths | `os.homedir()` + `path.join()` | All paths are deterministic: `~/.claude/settings.json`, `.claude/settings.json`, `.mcp.json`, etc. |
| Tool name parsing (scope detection) | String matching / regex | Tool names follow known patterns: `Read`, `mcp__server__tool`, `mcp__plugin_market_name__tool` |
| Tool registry storage | New SQLite table in existing database | Already using better-sqlite3 with WAL. Just add a migration. |
| Conversation routing | Extend existing hook handler + context injection | SessionStart hook and PostToolUse hook already capture all needed data. |
| Global installation | Modify `.claude-plugin/plugin.json` + marketplace config | File-based configuration, no runtime dependency. |

## Detailed Technology Decisions

### 1. Claude Code Config File Parsing

**Decision:** Use Node.js `fs.readFileSync` + `JSON.parse` with Zod schema validation.

**Config file locations discovered from official docs (HIGH confidence):**

| File | Path | Scope | Contains |
|------|------|-------|----------|
| Global user settings | `~/.claude/settings.json` | User-wide | `hooks`, `statusLine`, `enabledPlugins`, `env` |
| Global personal settings | `~/.claude/settings.local.json` | User-wide, private | `permissions`, `enableAllProjectMcpServers` |
| Project team settings | `{cwd}/.claude/settings.json` | Per-project, committed | `permissions`, `enabledPlugins` |
| Project local settings | `{cwd}/.claude/settings.local.json` | Per-project, private | `permissions` |
| Project MCP servers | `{cwd}/.mcp.json` | Per-project, committed | `mcpServers` config |
| User/local MCP servers | `~/.claude.json` | User-wide | `mcpServers` in `projects[path]` entries |
| Plugin registry | `~/.claude/plugins/installed_plugins.json` | User-wide | Plugin install records with scopes/paths |
| Known marketplaces | `~/.claude/plugins/known_marketplaces.json` | User-wide | Marketplace source+install paths |

**Implementation pattern:**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

// Zod schemas for each config format
const SettingsSchema = z.object({
  hooks: z.record(z.array(z.unknown())).optional(),
  enabledPlugins: z.record(z.boolean()).optional(),
  statusLine: z.unknown().optional(),
}).passthrough();

function readConfigSafe<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    return schema.parse(JSON.parse(raw));
  } catch {
    return null; // File missing or invalid -- graceful degradation
  }
}
```

**Why NOT use chokidar/fs.watch for file watching:** Config files change rarely (user edits settings, installs a plugin). Laminark already reads config at startup via SessionStart hook. Re-reading on each SessionStart is sufficient. File watching adds complexity and resource overhead for zero benefit in a tool that restarts each session.

**Confidence: HIGH** -- Verified against live system files at `/home/matthew/.claude/settings.json`, `/home/matthew/.claude.json`, `/home/matthew/.claude/plugins/installed_plugins.json`, and official Claude Code docs.

### 2. Tool Name Parsing & Scope Detection

**Decision:** Pattern-match tool_name strings using a deterministic prefix taxonomy. No external library needed.

**Tool naming taxonomy discovered from official docs + live observation (HIGH confidence):**

| Pattern | Scope | Example | Source |
|---------|-------|---------|--------|
| No prefix (bare name) | Built-in | `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Task`, `WebFetch`, `WebSearch` | Claude Code core |
| `mcp__{server}__{tool}` | Project MCP (.mcp.json) or User MCP (~/.claude.json) | `mcp__laminark__recall`, `mcp__github__search_repositories` | .mcp.json or ~/.claude.json mcpServers |
| `mcp__plugin_{marketplace}_{plugin}__{tool}` | Plugin MCP | `mcp__plugin_laminark_laminark__status` | Plugin .mcp.json |

**Critical finding:** The `tool_name` field in PostToolUse hook payloads uses these exact patterns. There is no `tool_scope` or `tool_source` field in the payload. Scope must be inferred from the tool_name prefix.

**Implementation pattern:**

```typescript
interface ToolProvenance {
  scope: 'builtin' | 'project-mcp' | 'user-mcp' | 'plugin-mcp';
  serverName: string | null;     // e.g., 'laminark', 'github'
  toolName: string;              // e.g., 'recall', 'search_repositories'
  marketplace: string | null;    // e.g., 'laminark' (for plugin scope)
  pluginName: string | null;     // e.g., 'laminark' (for plugin scope)
}

const BUILTIN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'Task', 'WebFetch', 'WebSearch', 'MCPSearch',
]);

function parseToolProvenance(toolName: string): ToolProvenance {
  // Built-in tools: no prefix
  if (BUILTIN_TOOLS.has(toolName)) {
    return { scope: 'builtin', serverName: null, toolName, marketplace: null, pluginName: null };
  }

  // Plugin MCP: mcp__plugin_{marketplace}_{plugin}__{tool}
  const pluginMatch = toolName.match(/^mcp__plugin_([^_]+)_([^_]+)__(.+)$/);
  if (pluginMatch) {
    return {
      scope: 'plugin-mcp',
      serverName: `${pluginMatch[1]}_${pluginMatch[2]}`,
      toolName: pluginMatch[3],
      marketplace: pluginMatch[1],
      pluginName: pluginMatch[2],
    };
  }

  // Regular MCP: mcp__{server}__{tool}
  const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpMatch) {
    return {
      scope: 'project-mcp', // Disambiguated later via config file lookup
      serverName: mcpMatch[1],
      toolName: mcpMatch[2],
      marketplace: null,
      pluginName: null,
    };
  }

  // Unknown -- treat as external
  return { scope: 'builtin', serverName: null, toolName, marketplace: null, pluginName: null };
}
```

**Disambiguation note:** To distinguish `project-mcp` from `user-mcp` for regular MCP tools (`mcp__{server}__{tool}`), check whether the server name exists in the project's `.mcp.json` vs `~/.claude.json`. This is the only case requiring config file lookup at tool-capture time.

**Confidence: HIGH** -- Verified tool naming from:
- Live system SKILL.md referencing `mcp__plugin_laminark_laminark__status`
- Official docs showing `mcp__memory__create_entities` pattern
- Hook handler code that matches `mcp__laminark__` prefix
- Official hook reference confirming `tool_name` field in PostToolUse payloads

### 3. Tool Registry (New SQLite Table)

**Decision:** Add a `tool_registry` table to the existing Laminark SQLite database via the migration system.

**Schema:**

```sql
CREATE TABLE tool_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,          -- Full tool_name as seen in hooks (e.g., 'mcp__github__search_repositories')
  canonical_name TEXT NOT NULL,     -- Just the tool part (e.g., 'search_repositories')
  scope TEXT NOT NULL,              -- 'builtin' | 'project-mcp' | 'user-mcp' | 'plugin-mcp'
  server_name TEXT,                 -- MCP server name (null for builtins)
  project_hash TEXT,                -- NULL for global tools, project_hash for project-scoped
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  use_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT DEFAULT '{}'        -- JSON: description, marketplace, plugin name, etc.
);

CREATE UNIQUE INDEX idx_tool_registry_name_project
  ON tool_registry(tool_name, project_hash);
CREATE INDEX idx_tool_registry_scope
  ON tool_registry(scope);
CREATE INDEX idx_tool_registry_server
  ON tool_registry(server_name);
```

**Why this belongs in the existing SQLite database:**
- WAL mode already handles concurrent access from hook handler + MCP server
- Migration system already exists (`src/storage/migrations.ts`)
- Same `project_hash` scoping pattern used by observations, sessions, graph tables
- No new connection management needed

**Integration with existing code:** New migration (version 16) in `MIGRATIONS` array. New `ToolRegistryRepository` class following the same pattern as `ObservationRepository`.

**Confidence: HIGH** -- This is a straightforward extension of the existing storage pattern.

### 4. Global Installation Configuration

**Decision:** Laminark transitions from project-scoped (.mcp.json) to user-scoped plugin installation. The plugin system handles this.

**Current state (project-scoped):**
- `.mcp.json` in project root defines the MCP server
- Hook handler runs from project-relative path
- Tool names appear as `mcp__laminark__*`

**Target state (global plugin):**
- Plugin installed via marketplace to `~/.claude/plugins/cache/laminark/`
- Enabled in `~/.claude/settings.json` -> `enabledPlugins`
- MCP server defined in `.claude-plugin/plugin.json` or plugin `.mcp.json`
- Hooks defined in plugin `hooks/hooks.json`
- Tool names appear as `mcp__plugin_laminark_laminark__*`

**Changes required to existing files:**

| File | Change | Rationale |
|------|--------|-----------|
| `.claude-plugin/plugin.json` | Add `mcpServers` or reference `.mcp.json` | Plugin system auto-starts MCP servers when plugin is enabled |
| `.claude-plugin/plugin.json` | Add `hooks` field referencing hooks config | Plugin hooks merge with user/project hooks automatically |
| `hooks/hooks.json` (new) | Move hook config from project `.claude/settings.json` to plugin | Hooks travel with the plugin, not with each project |
| `src/hooks/handler.ts` | Update self-referential filter prefix | Change from `mcp__laminark__` to `mcp__plugin_laminark_laminark__` |
| `src/shared/config.ts` | Use `${CLAUDE_PLUGIN_ROOT}` for paths | Plugin runs from cache dir, not project root |
| `skills/status/SKILL.md` | Already references `mcp__plugin_laminark_laminark__status` | Already correct for plugin scope |

**Plugin `.mcp.json` format for global installation:**

```json
{
  "mcpServers": {
    "laminark": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"],
      "env": {}
    }
  }
}
```

**Hook migration for global scope:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js"
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js"
          }
        ]
      }
    ]
  }
}
```

**Critical constraint discovered:** Plugin MCP servers start automatically when the plugin is enabled, but "you must restart Claude Code to apply MCP server changes (enabling or disabling)." This means installing/enabling the plugin requires a Claude Code restart -- acceptable for a one-time setup.

**Confidence: HIGH** -- Verified from official plugin docs, live `installed_plugins.json`, `known_marketplaces.json`, and the working `frontend-design` plugin structure.

### 5. Conversation-Driven Routing

**Decision:** Extend the SessionStart context injection (`src/context/injection.ts`) to include tool-awareness context. Extend PostToolUse hook to update tool registry.

**What "routing" means in this context:**
1. At SessionStart, inject context about what tools are available and recently used
2. During conversation, the hook handler tags each observation with tool provenance
3. When recalling memories, weight results by tool relevance to current conversation
4. The MCP `recall` tool gets an optional `scope` filter parameter

**No new technology needed.** This is:
- Extending the existing `assembleSessionContext()` function to query the tool registry
- Adding a `scope` parameter to the existing `recall` MCP tool's Zod input schema
- Modifying `processPostToolUseFiltered()` to upsert tool registry entries

**Implementation touches:**

| Existing File | Change |
|---------------|--------|
| `src/context/injection.ts` | Add "Available tools" section to context output |
| `src/hooks/handler.ts` | Call `toolRegistry.upsert()` on each PostToolUse event |
| `src/mcp/tools/recall.ts` | Add optional `scope` filter to search |
| `src/storage/observations.ts` | Add `tool_scope` column or tag in metadata |

**Confidence: HIGH** -- This builds directly on existing patterns.

### 6. Config File Scope Resolution

**Decision:** Implement a `ConfigResolver` class that reads all Claude Code config files and merges them according to the documented precedence hierarchy.

**Precedence (highest to lowest, from official docs):**
1. Managed settings (`/etc/claude-code/managed-settings.json` on Linux)
2. Local settings (`.claude/settings.local.json`)
3. Project settings (`.claude/settings.json`)
4. User settings (`~/.claude/settings.json`)

**MCP server scope resolution:**
1. Local scope: `~/.claude.json` under project path key
2. Project scope: `.mcp.json` in project root
3. User scope: `~/.claude.json` top-level `mcpServers`
4. Plugin scope: plugin `.mcp.json` files

**What Laminark needs from config resolution:**
- List of enabled plugins (to know what plugin MCP tools to expect)
- List of MCP servers per scope (to disambiguate `mcp__{server}__` tool names)
- Project path (from `cwd` in hook payload, already available)

**Implementation:** Single `ConfigResolver` class in `src/config/` that:
1. Reads files once per session (SessionStart hook)
2. Caches results in memory
3. Provides `getServerScope(serverName, projectPath): 'local' | 'project' | 'user' | 'plugin'`
4. Provides `getEnabledPlugins(): string[]`
5. Provides `getAllMcpServers(projectPath): Map<string, {scope, config}>`

**Why a class, not individual functions:** The config files are read once and cached. A class encapsulates the cache lifetime with the session lifetime. When the hook handler creates a `ConfigResolver`, it reads all files once. The MCP server process can also create one at startup.

**Confidence: HIGH** -- All file paths and formats verified from live system.

## Integration Map: Existing Code -> New Code

```
EXISTING                              NEW
-------                               ---
src/hooks/handler.ts                  src/config/resolver.ts (ConfigResolver)
  |-- processPostToolUseFiltered()      |-- reads all Claude Code config files
  |     NOW: captures observations      |-- caches per session
  |     ADD: upserts tool registry      |-- resolves server -> scope mapping
  |                                     |
  |-- handleSessionStart()            src/storage/tool-registry.ts (ToolRegistryRepository)
        NOW: assembles context            |-- upsert(), getByProject(), getByScope()
        ADD: queries tool registry        |-- migration 16 adds table
        ADD: reads config resolver        |
                                      src/hooks/tool-provenance.ts (parseToolProvenance)
src/context/injection.ts                |-- parses tool_name into scope/server/tool
  NOW: recent changes, decisions        |-- uses ConfigResolver for disambiguation
  ADD: tool landscape section
                                      .claude-plugin/plugin.json (updated)
src/mcp/tools/recall.ts                 |-- mcpServers config for global install
  NOW: search by text/vector            |-- hooks reference
  ADD: optional scope filter
                                      hooks/hooks.json (new)
src/storage/migrations.ts                |-- hook config for plugin distribution
  ADD: migration 16 (tool_registry)
```

## What NOT to Add

| Temptation | Why Avoid | What to Do Instead |
|------------|-----------|-------------------|
| chokidar / fs.watch for config watching | Config changes are rare. Adds dependency + complexity. | Re-read configs at SessionStart (once per session) |
| A separate config database | Over-engineering. Config is static within a session. | In-memory cache in ConfigResolver, populated from JSON files |
| Tool description scraping via MCP | MCP list_tools is available only to the MCP client (Claude Code), not to MCP servers. Laminark is a server. | Extract descriptions from tool_response metadata if available, or from config files |
| Dynamic plugin scanning | Claude Code already manages plugin lifecycle. Don't duplicate. | Read `installed_plugins.json` and `enabledPlugins` from settings |
| WebSocket/IPC for tool change notifications | Adds complexity. Tool lists change only when user installs/uninstalls. | Refresh registry at SessionStart |
| npm package for JSON schema validation of Claude Code configs | Zod (already installed) does this. Claude Code has no published JSON schemas for config files. | Define Zod schemas inline |
| A process manager for the MCP server | Claude Code plugin system manages process lifecycle (start on enable, stop on disable) | Trust the plugin system |

## Migration Path: Project -> Global

The transition from project-scoped to global plugin must be backwards-compatible:

**Phase 1 (this milestone):** Support both install modes
- Plugin `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}` for paths (works in both contexts)
- Hook handler detects both `mcp__laminark__` and `mcp__plugin_laminark_laminark__` prefixes for self-referential filtering
- `getConfigDir()` already resolves to `~/.claude/plugins/cache/laminark/data/` (correct for global)
- `getProjectHash(process.cwd())` already scopes data per project (correct for global)

**Phase 2 (documentation):** Update marketplace and README
- Remove `.mcp.json` from project root in favor of plugin installation
- Publish to marketplace for `claude plugin install laminark@laminark`

**Key insight:** The existing database path (`~/.claude/plugins/cache/laminark/data/data.db`) is already global-scoped. The `project_hash` column in every table already provides per-project isolation. The global database with project scoping is the correct architecture -- no database migration needed for the global/project transition.

## Version Requirements

| Component | Current Version | Required Changes | Version Change |
|-----------|----------------|------------------|----------------|
| Node.js | >=22.0.0 | None | Same |
| @modelcontextprotocol/sdk | ^1.26.0 | None | Same |
| better-sqlite3 | ^12.6.2 | None (new table only) | Same |
| zod | ^4.3.6 | None (new schemas only) | Same |
| typescript | ^5.9.3 | None | Same |
| hono | ^4.11.9 | None | Same |

**Zero dependency additions. Zero version bumps.**

## Sources

- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- MCP scopes, tool search, plugin MCP servers (HIGH confidence, fetched 2026-02-10)
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) -- Plugin manifest schema, MCP server bundling, hooks config, skills (HIGH confidence, fetched 2026-02-10)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- All hook events, payload schemas, tool_name patterns, MCP tool matching (HIGH confidence, fetched 2026-02-10)
- [Claude Code Settings](https://code.claude.com/docs/en/settings) -- Settings file locations, precedence, MCP config, permissions (HIGH confidence, fetched 2026-02-10)
- Live system files at `/home/matthew/.claude/settings.json`, `/home/matthew/.claude/settings.local.json`, `/home/matthew/.claude.json`, `/home/matthew/.claude/plugins/installed_plugins.json`, `/home/matthew/.claude/plugins/known_marketplaces.json` -- Actual Claude Code config structure (HIGH confidence, direct observation)
- Live Laminark codebase at `/data/Laminark/` -- Existing architecture, hook handler, MCP server, database schema (HIGH confidence, direct observation)
- Plugin structure comparison: `frontend-design@claude-code-plugins` and `clangd-lsp@claude-plugins-official` installed plugins (HIGH confidence, direct observation)

---
*Stack research for: Laminark V2 -- Global Tool Discovery & Routing Milestone*
*Researched: 2026-02-10*
*Result: Zero new dependencies. Pure architectural changes to existing codebase.*
