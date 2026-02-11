# Research Summary: Global Tool Discovery & Routing

**Domain:** Claude Code plugin global installation, tool discovery, scope-aware registry
**Researched:** 2026-02-10
**Overall confidence:** HIGH

## Executive Summary

This research investigated what stack additions and changes are needed for Laminark to transition from project-scoped MCP server to globally-installed plugin with tool discovery, scope-aware registry, and conversation-driven routing.

The primary finding is that **zero new npm dependencies are required**. Claude Code's configuration system is entirely file-based JSON at deterministic filesystem paths. Tool provenance (which scope a tool comes from) is embedded in the tool_name string that arrives in hook payloads. The existing Laminark database architecture with project_hash scoping already supports global operation -- the database path `~/.claude/plugins/cache/laminark/data/data.db` is already global, and per-project isolation comes from the `project_hash` column.

The Claude Code plugin system provides the infrastructure for global installation. Plugins bundle MCP servers (via `.mcp.json` at plugin root or inline in `plugin.json`), hooks (via `hooks/hooks.json`), and skills (via `skills/` directory). When a plugin is enabled in `~/.claude/settings.json` -> `enabledPlugins`, its MCP servers start automatically and its hooks merge with user/project hooks.

Tool naming follows a deterministic taxonomy: built-in tools have bare names (`Read`, `Write`), project/user MCP tools use `mcp__{server}__{tool}`, and plugin MCP tools use `mcp__plugin_{marketplace}_{plugin}__{tool}`. This prefix structure allows reliable scope detection from the `tool_name` field alone, with config file lookup needed only to disambiguate project-mcp from user-mcp for regular MCP servers.

## Key Findings

**Stack:** Zero new dependencies. Node.js `fs` + `path` + `os` for config parsing, existing SQLite for tool registry, existing Zod for schema validation.

**Architecture:** New `ConfigResolver` reads Claude Code config files once per SessionStart. New `ToolRegistryRepository` stores tool provenance in existing SQLite database. Hook handler extended to upsert tool registry on each PostToolUse event.

**Critical pitfall:** The transition from project-scoped to plugin-scoped changes the MCP tool name prefix from `mcp__laminark__*` to `mcp__plugin_laminark_laminark__*`. The self-referential filter in the hook handler must match both patterns during migration.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Config Discovery** - Parse Claude Code config files, build ConfigResolver
   - Addresses: Reading settings.json, .mcp.json, installed_plugins.json
   - Avoids: Over-engineering with file watchers (read once per session is sufficient)

2. **Tool Registry** - Add SQLite table, ToolRegistryRepository, tool provenance parsing
   - Addresses: Scope-aware tool tracking, tool_name prefix parsing
   - Avoids: Trying to use MCP list_tools (Laminark is a server, not a client)

3. **Global Installation** - Plugin manifest, hooks.json, ${CLAUDE_PLUGIN_ROOT} paths
   - Addresses: Moving from .mcp.json to plugin system
   - Avoids: Breaking existing project-scoped installations (dual-prefix support)

4. **Context Enhancement** - Extend SessionStart injection with tool landscape
   - Addresses: Conversation-driven routing via context
   - Avoids: Complex routing logic (let Claude reason about available tools from context)

5. **Scope-Aware Recall** - Add scope filter to recall MCP tool
   - Addresses: Filtering memories by tool provenance
   - Avoids: Over-complicating the search API

**Phase ordering rationale:**
- Config Discovery must come first because tool registry needs config data to disambiguate scopes
- Tool Registry depends on config discovery for scope resolution
- Global Installation can happen in parallel with tool registry (independent file changes)
- Context Enhancement and Scope-Aware Recall depend on tool registry being populated

**Research flags for phases:**
- Phase 3 (Global Installation): Needs testing with actual `claude plugin install` workflow. Plugin caching behavior must be verified.
- Phase 1-2, 4-5: Standard patterns, unlikely to need additional research.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new deps. All capabilities verified against live system and official docs. |
| Config parsing | HIGH | All file paths verified from live ~/.claude/ directory and official docs. |
| Tool naming | HIGH | Verified from live SKILL.md, official hook docs, and existing code. |
| Plugin system | HIGH | Verified from installed_plugins.json, plugin cache structure, official docs. |
| Migration path | MEDIUM | Dual-prefix support is straightforward but needs testing with actual Claude Code. |

## Gaps to Address

- The exact behavior when a plugin MCP server name collides with a project .mcp.json server name is undocumented. Likely resolved by Claude Code's precedence rules but should be tested.
- MCP Tool Search feature (`ENABLE_TOOL_SEARCH`) interaction with Laminark's tool registry is not fully understood. When tool search is active, tools may be loaded lazily and not all appear in PostToolUse events. This affects completeness of the registry but not correctness.
- Whether `${CLAUDE_PLUGIN_ROOT}` is available in hook command strings (confirmed for plugin MCP servers, needs verification for plugin hooks -- the official docs show it used in hook commands within plugins, so HIGH confidence it works).
