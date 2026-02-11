# Phase 9: Global Installation - Research

**Researched:** 2026-02-10
**Domain:** Claude Code plugin system, global MCP server installation, hook configuration
**Confidence:** HIGH

## Summary

Phase 9 transforms Laminark from a project-scoped MCP server (configured via `.mcp.json` per project) into a globally-installed Claude Code plugin available in every session. The Claude Code plugin system is mature and well-documented, providing a clear path: create a `.claude-plugin/plugin.json` manifest (already partially exists), configure hooks in `hooks/hooks.json`, declare the MCP server in `.mcp.json` at plugin root, and distribute via a marketplace (GitHub repository) since npm source is not yet fully implemented.

The critical migration concern is the MCP tool prefix change. In project-scoped mode, tools appear as `mcp__laminark__<tool>`. When installed as a plugin, tools appear as `mcp__plugin_laminark_laminark__<tool>`. The self-referential filter in `handler.ts`, `capture.ts`, and `admission-filter.ts` currently only checks for the `mcp__laminark__` prefix. This must be updated to also check the plugin prefix, or Laminark will capture its own tool calls as observations -- creating a feedback loop. Additionally, the `cwd` field in hook events provides the current project directory, which Laminark already uses via `getProjectHash(cwd)` in the hook handler, so project detection is already functional.

**Primary recommendation:** Use the existing Claude Code plugin structure with `hooks/hooks.json` for hook declarations, `.mcp.json` for MCP server configuration, keep `${CLAUDE_PLUGIN_ROOT}` paths for portability, distribute via GitHub marketplace (not npm), and update the self-referential filter to handle both prefix patterns.

## Standard Stack

### Core (No New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Claude Code plugin system | Current | Plugin manifest, hooks, MCP integration | Official Anthropic system -- the only way to achieve global installation |
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server implementation | Already in use, no change needed |
| `better-sqlite3` | ^12.6.2 | Database engine | Already in use, no change needed |
| `tsdown` | ^0.20.3 | Build toolchain | Already in use, bundles dist/ for npm publish |

### Supporting (Already Present)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^4.3.6 | Schema validation | Already in use for MCP tool schemas |
| `hono` | ^4.11.9 | Web visualization server | Already in use, runs alongside MCP |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| GitHub marketplace | npm source | npm source is not yet fully implemented in Claude Code plugin system -- use GitHub |
| Separate hook binary | Single handler.ts entry | Current architecture already works -- single entry handles all events |
| Per-project config | Global plugin | Global is the entire point of this phase |

**Installation (for end users):**
```bash
# Add Laminark marketplace
/plugin marketplace add NoobyNull/Laminark

# Install the plugin
/plugin install laminark@laminark
```

## Architecture Patterns

### Plugin Directory Structure (Final)

```
Laminark/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest (already exists, needs update)
│   └── marketplace.json     # Marketplace catalog (already exists, needs update)
├── hooks/
│   └── hooks.json           # Hook event configuration (NEW)
├── skills/                  # Future: skill definitions (Phase 10+)
├── .mcp.json                # MCP server definition (needs update for plugin paths)
├── scripts/
│   └── ensure-deps.sh       # Dependency bootstrapper (already exists)
├── dist/
│   ├── index.js             # MCP server entry point
│   └── hooks/
│       └── handler.js       # Hook handler entry point
├── ui/                      # Web visualization assets
├── package.json             # npm package definition (already correct)
└── tsdown.config.ts         # Build config
```

### Pattern 1: Plugin MCP Server Configuration

**What:** The `.mcp.json` at plugin root defines how Claude Code starts the MCP server.
**When to use:** Required for every plugin that provides MCP tools.

```json
// .mcp.json at plugin root
{
  "mcpServers": {
    "laminark": {
      "command": "bash",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh",
        "node",
        "${CLAUDE_PLUGIN_ROOT}/dist/index.js"
      ]
    }
  }
}
```

**Key details:**
- `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin cache directory (NOT the original repo)
- Plugins are copied to `~/.claude/plugins/cache/` on install -- all paths must be relative or use `${CLAUDE_PLUGIN_ROOT}`
- The server name "laminark" becomes part of the MCP tool prefix

### Pattern 2: Plugin Hook Configuration via hooks/hooks.json

**What:** Plugin hooks are declared in `hooks/hooks.json` at plugin root. They merge with user and project hooks.
**When to use:** Required for Laminark's hook-based observation capture.

```json
// hooks/hooks.json
{
  "description": "Laminark memory: automatic observation capture and session context injection",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

**Key details:**
- SessionStart is synchronous (stdout injected into context) -- do NOT set `async: true`
- PostToolUse, PostToolUseFailure, Stop, SessionEnd should be `async: true` to avoid blocking Claude
- The hook handler reads `hook_event_name` from stdin JSON to dispatch internally
- Plugin hooks appear as `[Plugin]` in the `/hooks` menu and are read-only

### Pattern 3: Dual-Prefix Self-Referential Filter

**What:** Update the self-referential filter to recognize both the legacy project-scoped prefix and the new plugin-scoped prefix.
**When to use:** In handler.ts, capture.ts, and admission-filter.ts -- everywhere tool names are checked.

```typescript
// src/hooks/self-referential.ts (centralized constant)
/**
 * Prefixes for Laminark's own MCP tools.
 *
 * Project-scoped (.mcp.json): mcp__laminark__
 * Plugin-scoped (claude plugin install): mcp__plugin_laminark_laminark__
 *
 * Both must be filtered to prevent self-referential observation capture.
 */
const LAMINARK_PREFIXES = [
  'mcp__laminark__',                    // project-scoped (.mcp.json)
  'mcp__plugin_laminark_laminark__',    // plugin-scoped (global install)
];

export function isLaminarksOwnTool(toolName: string): boolean {
  return LAMINARK_PREFIXES.some(prefix => toolName.startsWith(prefix));
}
```

### Pattern 4: Project Detection from cwd

**What:** The hook handler already receives `cwd` from Claude Code via stdin JSON. This is the user's current project directory.
**When to use:** On every hook event to scope memory operations to the correct project.

```typescript
// Already implemented in handler.ts main():
const cwd = input.cwd as string;
const projectHash = getProjectHash(cwd);
```

**Key detail:** This pattern already works correctly. The MCP server `index.ts` uses `process.cwd()` which, when launched by the plugin system, is set to the user's project directory. No changes needed for project detection.

### Pattern 5: Plugin Manifest with Component Paths

**What:** The `plugin.json` manifest declares metadata and component locations.
**When to use:** Required for every plugin.

```json
// .claude-plugin/plugin.json
{
  "name": "laminark",
  "description": "Persistent adaptive memory for Claude Code. Automatic observation capture, semantic search, topic detection, knowledge graph, and web visualization.",
  "version": "1.0.0",
  "author": {
    "name": "NoobyNull"
  },
  "homepage": "https://github.com/NoobyNull/Laminark",
  "repository": "https://github.com/NoobyNull/Laminark",
  "license": "ISC",
  "keywords": ["memory", "mcp", "sqlite", "knowledge-graph", "semantic-search"],
  "skills": "./skills/"
}
```

### Anti-Patterns to Avoid

- **Absolute paths in plugin config:** Never use absolute paths like `/home/matthew/...` in `.mcp.json` or `hooks.json`. Always use `${CLAUDE_PLUGIN_ROOT}`. Plugins are copied to cache; absolute paths break.
- **npm source in marketplace:** npm source is documented as "not yet fully implemented" in Claude Code. Use GitHub source instead.
- **Blocking PostToolUse hooks:** Setting hooks to synchronous for PostToolUse/Stop/SessionEnd would block Claude's responses. Use `"async": true` for all non-SessionStart hooks.
- **Hardcoding single prefix:** Only checking `mcp__laminark__` will miss the plugin prefix. Always check both.
- **Modifying process.cwd():** The MCP server gets cwd from the Claude Code process environment. Do not attempt to change it; read it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Plugin discovery/installation | Custom installer script | `claude plugin install` via marketplace | Claude Code handles caching, versioning, updates |
| Hook event dispatching | Custom IPC or socket system | Claude Code hooks system (stdin JSON) | Hooks are the official integration point; fully documented |
| Global configuration | Custom `~/.laminark/` config files | Plugin cache at `~/.claude/plugins/cache/laminark/` | Claude Code manages plugin lifecycle automatically |
| Dependency installation | Manual npm install docs | `scripts/ensure-deps.sh` bootstrapper | Already implemented; runs on first invocation |
| MCP server lifecycle | Custom process manager | Plugin system auto-start | Plugin MCP servers start automatically when plugin is enabled |

**Key insight:** The Claude Code plugin system handles the entire installation, caching, lifecycle management, and hook registration. Laminark's job is to declare what it provides (MCP server, hooks) and let the plugin system orchestrate it.

## Common Pitfalls

### Pitfall 1: Plugin Cache Path Traversal
**What goes wrong:** Plugins are copied to `~/.claude/plugins/cache/<plugin-name>/`. Files outside the plugin directory are not copied. If scripts reference `../` or absolute paths, they break silently.
**Why it happens:** During development, paths work because you're running from source. After `plugin install`, the context is the cache directory.
**How to avoid:** Use `${CLAUDE_PLUGIN_ROOT}` for all paths in hooks.json and .mcp.json. Test by installing the plugin from a clean marketplace, not just running locally.
**Warning signs:** Hooks that work in development but fail silently after installation.

### Pitfall 2: Self-Referential Feedback Loop
**What goes wrong:** When installed as a plugin, MCP tool names change from `mcp__laminark__recall` to `mcp__plugin_laminark_laminark__recall`. If the self-referential filter only checks the old prefix, Laminark captures its own tool calls, creating an infinite observation loop.
**Why it happens:** The prefix format depends on whether the server is project-scoped (.mcp.json) or plugin-scoped (global install).
**How to avoid:** Check both prefixes. Extract the check into a shared utility function `isLaminarksOwnTool()`. Unit test both prefix patterns.
**Warning signs:** After global install, observations table fills with self-referential entries like `[mcp__plugin_laminark_laminark__recall]`.

### Pitfall 3: SessionStart Hook Blocking Startup
**What goes wrong:** If the SessionStart hook is slow (>2s) or errors, it blocks Claude Code startup for the user. The hook must exit 0 quickly.
**Why it happens:** SessionStart is synchronous -- stdout is context-injected. If the database is corrupted or migrations take too long, the hook stalls.
**How to avoid:** The hook handler already wraps in `.catch()` and always exits 0. Maintain this pattern. Keep the context assembly under 500ms (already monitored). Set a conservative `timeout: 10` in hooks.json.
**Warning signs:** Users report slow Claude Code startup in new projects.

### Pitfall 4: npm Source Not Implemented
**What goes wrong:** Attempting to distribute via npm marketplace source results in: "Plugin 'x' uses npm source which is not yet fully implemented."
**Why it happens:** Claude Code plugin marketplace npm source type is documented but not functional (as of Feb 2026).
**How to avoid:** Use GitHub source type in marketplace.json. The npm package can still be published for direct use, but plugin installation must go through GitHub marketplace.
**Warning signs:** Warning message during plugin installation.

### Pitfall 5: ensure-deps.sh on First Plugin Boot
**What goes wrong:** When a user installs the plugin, `node_modules` are not present in the plugin cache (only `dist/`, `scripts/`, `ui/`, `hooks/`, `.claude-plugin/` are copied from npm files). The first MCP server start will fail if `better-sqlite3` (native addon) is not installed.
**Why it happens:** npm publish includes what's in `"files"` array. `node_modules` is never included.
**How to avoid:** The `ensure-deps.sh` script already handles this: it checks for `node_modules/better-sqlite3` and runs `npm install --production` if missing. The `.mcp.json` command chain (`bash ensure-deps.sh node dist/index.js`) ensures deps are installed before the server starts. Verify this works from the plugin cache directory by testing with `--plugin-dir`.
**Warning signs:** MCP server fails on first start with "Cannot find module 'better-sqlite3'" error.

### Pitfall 6: 64-Character Tool Name Limit
**What goes wrong:** Claude Code enforces a 64-character limit for MCP tool names. Plugin prefix adds significant overhead.
**Why it happens:** `mcp__plugin_laminark_laminark__` is 32 characters, leaving only 32 for tool names.
**How to avoid:** Current tool names are all short (max: `topic_context` = 13 chars, total = 47 chars). Keep future tool names under 32 characters. Audit tool names when adding new ones.
**Warning signs:** Tool not appearing in Claude's available tools; 64-char truncation errors.

### Pitfall 7: Data Directory Assumptions
**What goes wrong:** The MCP server currently stores data at `~/.claude/plugins/cache/laminark/data/`. This path depends on `getConfigDir()` in `config.ts`. When running from plugin cache vs development, the paths must resolve correctly.
**Why it happens:** The data directory is independent of the plugin installation directory. It uses `homedir()` so it works regardless of where the server binary runs from.
**How to avoid:** The current implementation at `~/.claude/plugins/cache/laminark/data/data.db` already uses an absolute path derived from `os.homedir()`. No change needed. Verify the path works from both development and installed contexts.
**Warning signs:** Separate databases appearing for the same project.

## Code Examples

### Complete hooks/hooks.json for Plugin

```json
{
  "description": "Laminark: persistent adaptive memory for Claude Code",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "timeout": 10,
            "statusMessage": "Loading Laminark memory context..."
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### Updated .mcp.json for Plugin Mode

```json
{
  "mcpServers": {
    "laminark": {
      "command": "bash",
      "args": [
        "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh",
        "node",
        "${CLAUDE_PLUGIN_ROOT}/dist/index.js"
      ]
    }
  }
}
```

### Dual-Prefix Self-Referential Filter

```typescript
// Centralized self-referential tool detection
const LAMINARK_PREFIXES = [
  'mcp__laminark__',
  'mcp__plugin_laminark_laminark__',
] as const;

export function isLaminarksOwnTool(toolName: string): boolean {
  return LAMINARK_PREFIXES.some(prefix => toolName.startsWith(prefix));
}

// Usage in handler.ts processPostToolUseFiltered():
if (isLaminarksOwnTool(toolName)) {
  debug('hook', 'Skipping self-referential tool', { tool: toolName });
  return;
}

// Usage in admission-filter.ts shouldAdmit():
if (isLaminarksOwnTool(toolName)) {
  debug('hook', 'Observation rejected', { tool: toolName, reason: 'self-referential' });
  return false;
}
```

### Updated marketplace.json

```json
{
  "name": "laminark",
  "owner": {
    "name": "NoobyNull"
  },
  "plugins": [
    {
      "name": "laminark",
      "source": "./",
      "description": "Persistent adaptive memory for Claude Code. Automatic observation capture, semantic search, topic detection, knowledge graph, and web visualization.",
      "version": "1.0.0",
      "category": "productivity"
    }
  ]
}
```

### Testing Plugin Mode Locally

```bash
# Test from plugin directory without installing
claude --plugin-dir /data/Laminark

# Verify hooks are registered
/hooks
# Should show [Plugin] entries for SessionStart, PostToolUse, etc.

# Verify MCP tools are available
/mcp
# Should show laminark server with tools
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-project `.mcp.json` | Global plugin install | Claude Code plugins public beta (2025) | Eliminates per-project configuration |
| Manual hook setup in `~/.claude/settings.json` | Plugin `hooks/hooks.json` | Claude Code plugins system | Hooks bundled with plugin, auto-registered |
| npm install -g + manual config | `claude plugin install` from marketplace | Claude Code plugin marketplace | One-command installation |
| Single `mcp__laminark__` prefix | Dual prefix support (project + plugin) | Plugin naming convention | Must handle both for backward compat |

**Deprecated/outdated:**
- npm marketplace source: Documented but "not yet fully implemented" as of Feb 2026. Use GitHub source.
- SSE transport for MCP: Deprecated in favor of HTTP transport. Laminark uses stdio (unaffected).

## Open Questions

1. **Plugin MCP server cwd behavior**
   - What we know: Hook handler receives `cwd` via stdin JSON (the user's project directory). This already works for project hashing.
   - What's unclear: When the MCP server (`index.ts`) is started by the plugin system, what is `process.cwd()` set to? It might be the plugin cache dir, not the user's project. The server currently does `getProjectHash(process.cwd())` on startup.
   - Recommendation: Test this explicitly with `--plugin-dir`. If `process.cwd()` is wrong, the MCP server can read the project directory from the hook system or environment. Claude Code likely sets it to the user's project directory since that's where the session is active, but this must be verified.

2. **Exact plugin prefix format confirmation**
   - What we know: Multiple sources indicate `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`. For Laminark: `mcp__plugin_laminark_laminark__recall`.
   - What's unclear: This format comes from community documentation and blog posts, not official Anthropic docs. The official docs describe the `mcp__<server>__<tool>` pattern but don't explicitly document the plugin prefix variant.
   - Recommendation: Verify empirically by installing a test plugin with `--plugin-dir` and checking tool names in `/mcp`. Build the filter with the expected prefix pattern but make it easy to adjust.

3. **ensure-deps.sh behavior in plugin cache**
   - What we know: The script checks for `node_modules/better-sqlite3` and runs `npm install --production` if missing. The plugin system copies `scripts/`, `dist/`, `ui/`, `hooks/` to cache.
   - What's unclear: Whether `package.json` is also copied to the cache (it's not in the `files` array but might be included automatically by the plugin copier). If not, `npm install` in the cache dir would fail.
   - Recommendation: Add `package.json` to the npm `files` array if not already included by default. Test the full install -> first-run flow from scratch. The npm publish `files` list already includes `dist`, `hooks`, `scripts`, `ui`, `.claude-plugin` -- `package.json` is always included by npm regardless.

4. **Backward compatibility during migration**
   - What we know: Some users may continue using `.mcp.json` project-scoped setup after v2.0. Both modes should work.
   - What's unclear: Whether a project-scoped `.mcp.json` and the global plugin can coexist (would the server run twice?). Claude Code's scope hierarchy resolves conflicts by prioritizing local > project > user.
   - Recommendation: Document migration clearly. If both are configured, Claude Code scope resolution should pick the project-scoped one. But the user should remove `.mcp.json` after installing the plugin. Do not attempt to handle this programmatically.

## Sources

### Primary (HIGH confidence)
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) - Complete plugin.json schema, hook configuration, MCP server configuration, plugin caching behavior, CLI commands, installation scopes
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) - Complete hooks lifecycle, event schemas, JSON input/output, async hooks, matcher patterns, `${CLAUDE_PLUGIN_ROOT}` variable
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) - MCP scopes, plugin-provided MCP servers, tool naming `mcp__<server>__<tool>`
- [Claude Code Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) - Marketplace schema, source types (GitHub recommended, npm not implemented), distribution

### Secondary (MEDIUM confidence)
- [Claude Code GitHub Plugins README](https://github.com/anthropics/claude-code/blob/main/plugins/README.md) - Plugin structure examples, official plugin directory
- [Plugin MCP Integration SKILL.md](https://github.com/fcakyon/claude-codex-settings/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md) - Plugin MCP tool naming format `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`
- [Naming Claude Plugins blog](https://blog.fsck.com/2025/10/23/naming-claude-plugins/) - Plugin naming impacts on tool selection, `mcp__plugin_` prefix confirmed

### Tertiary (LOW confidence)
- Exact `mcp__plugin_laminark_laminark__` prefix format needs empirical verification via `--plugin-dir` test (based on community docs, not official Anthropic docs)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies needed; Claude Code plugin system is well-documented
- Architecture: HIGH - Plugin structure, hooks.json, .mcp.json formats confirmed from official docs
- Pitfalls: HIGH - Self-referential filter, plugin cache paths, npm source limitation all verified from multiple sources
- Plugin prefix format: MEDIUM - Community sources consistent but not in official docs

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (plugin system is stable, unlikely to change rapidly)
