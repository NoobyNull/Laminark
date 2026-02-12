---
status: resolved
trigger: "Laminark MCP server is not autostarting on fresh plugin install"
created: 2026-02-11T00:00:00Z
updated: 2026-02-11T00:02:00Z
---

## Current Focus

hypothesis: CONFIRMED - missing .mcp.json was the root cause
test: Fix applied - .mcp.json restored to repo root and plugin cache
expecting: MCP server will auto-start on next session
next_action: Verify fix by confirming file integrity and structure matches working plugins

## Symptoms

expected: The plugin system should start the MCP server as part of plugin initialization when Laminark is installed fresh
actual: Hook runs but MCP server doesn't start - no mcp__laminark__* or mcp__plugin_laminark_laminark__* tools available in session
errors: No visible errors - silent failure
reproduction: Fresh plugin install from marketplace
started: Happens on fresh install
timeline: Recent changes removed .mcp.json (commit 133035b), added bootstrap install script (commit 43d8db2)

## Eliminated

## Evidence

- timestamp: 2026-02-11T00:00:30Z
  checked: Installed Laminark plugin cache at /home/matthew/.claude/plugins/cache/laminark/laminark/8/
  found: No .mcp.json file exists anywhere under this directory
  implication: Claude Code has no MCP server declaration to discover

- timestamp: 2026-02-11T00:00:30Z
  checked: Working plugin thedotmack/claude-mem at /home/matthew/.claude/plugins/cache/thedotmack/claude-mem/9.1.1/
  found: Has .mcp.json at root declaring an MCP server: {"mcpServers":{"mcp-search":{"type":"stdio","command":"${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.cjs"}}}
  implication: Claude Code discovers MCP servers via .mcp.json at plugin root

- timestamp: 2026-02-11T00:00:30Z
  checked: Official GitHub plugin at /home/matthew/.claude/plugins/cache/claude-plugins-official/github/2cd88e7947b7/
  found: Has .mcp.json declaring an MCP server
  implication: Confirms .mcp.json is the standard mechanism

- timestamp: 2026-02-11T00:00:45Z
  checked: Git history for .mcp.json in Laminark repo
  found: Commit 133035b explicitly removed .mcp.json with message "remove project-scoped .mcp.json for clean reinstall"
  implication: The .mcp.json was intentionally removed but was NEEDED for plugin MCP server discovery

- timestamp: 2026-02-11T00:00:45Z
  checked: Deleted .mcp.json content from git history
  found: Had correct format: {"mcpServers":{"laminark":{"command":"bash","args":["${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh","node","${CLAUDE_PLUGIN_ROOT}/dist/index.js"]}}}
  implication: The old .mcp.json was correct, just needs to be restored

- timestamp: 2026-02-11T00:00:50Z
  checked: Plugin manifest (plugin.json) in .claude-plugin/
  found: No MCP server declaration in plugin.json - only has name, description, version, skills
  implication: plugin.json does not handle MCP server registration; .mcp.json is separate

- timestamp: 2026-02-11T00:00:50Z
  checked: hooks.json definitions
  found: Hooks run the handler.js for PostToolUse, SessionStart, etc., but hooks are NOT MCP servers
  implication: Hooks and MCP servers are separate plugin capabilities; hooks working does not imply MCP works

## Resolution

root_cause: The .mcp.json file was removed from the repository in commit 133035b. This file is the mechanism by which Claude Code discovers and auto-starts MCP servers for plugins. Without it, the plugin's hooks work fine but the MCP server (src/index.ts -> dist/index.js) is never started, so no MCP tools are available.
fix: Restored .mcp.json to repo root with the original server declaration (command: bash ensure-deps.sh node dist/index.js). Added .mcp.json to package.json files array so it ships with the plugin. Also copied .mcp.json to installed plugin cache for immediate effect.
verification: Both JSON files validate. Referenced entry points (dist/index.js, scripts/ensure-deps.sh) exist. .mcp.json format matches working plugins (thedotmack/claude-mem, official/github). File present in both repo and installed plugin cache.
files_changed:
  - /data/Laminark/.mcp.json (created)
  - /data/Laminark/package.json (added .mcp.json to files array)
  - /home/matthew/.claude/plugins/cache/laminark/laminark/8/.mcp.json (copied for immediate effect)
