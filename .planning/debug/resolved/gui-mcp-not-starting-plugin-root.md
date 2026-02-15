---
status: resolved
trigger: "The Laminark GUI MCP server is not starting. claude_code_plugin_root variable appears undefined/missing."
created: 2026-02-14T00:00:00Z
updated: 2026-02-14T00:02:00Z
---

## Current Focus

hypothesis: CONFIRMED - project-level .mcp.json used ${CLAUDE_PLUGIN_ROOT} which is not resolved for project-level configs
test: Reverted to relative paths, tested MCP server startup
expecting: Server starts successfully
next_action: Archive session

## Symptoms

expected: The Laminark GUI MCP should start correctly, with claude_code_plugin_root resolving to the plugin installation directory
actual: GUI MCP is not starting. claude_code_plugin_root is undefined or missing.
errors: MCP server fails to start - bash receives literal "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh" as path
reproduction: Attempt to start/use the Laminark GUI MCP from within the Laminark dev project
started: Has always been an issue - never fully worked

## Eliminated

- hypothesis: Variable needs to be loaded from external preferences file
  evidence: ${CLAUDE_PLUGIN_ROOT} is a Claude Code built-in for plugin configs. The issue is that the project-level .mcp.json should not use it.
  timestamp: 2026-02-14

## Evidence

- timestamp: 2026-02-14
  checked: /data/Laminark/.mcp.json (project-level)
  found: Uses "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh" and "${CLAUDE_PLUGIN_ROOT}/dist/index.js"
  implication: This is a project-level MCP config, not a plugin-level one

- timestamp: 2026-02-14
  checked: Installed plugin at ~/.claude/plugins/cache/laminark/laminark/11/.mcp.json
  found: Uses RELATIVE paths: "./scripts/ensure-deps.sh", "./dist/index.js"
  implication: The installed plugin uses a DIFFERENT .mcp.json with relative paths - that one works

- timestamp: 2026-02-14
  checked: CLAUDE_PLUGIN_ROOT environment variable
  found: UNDEFINED in the current shell
  implication: This variable is only set by Claude Code internally when launching plugin MCP servers

- timestamp: 2026-02-14
  checked: Claude Code docs and GitHub issues
  found: ${CLAUDE_PLUGIN_ROOT} is meant for plugin-level .mcp.json only. Issue #9427 confirms env var expansion bugs in plugin .mcp.json. Project-level .mcp.json should use relative/absolute paths.
  implication: Project-level .mcp.json cannot rely on ${CLAUDE_PLUGIN_ROOT}

- timestamp: 2026-02-14
  checked: hooks/hooks.json
  found: Also uses ${CLAUDE_PLUGIN_ROOT} - but this is the plugin hooks config, which IS read by Claude Code from the plugin dir, so it SHOULD work there
  implication: hooks.json is fine; only the project-level .mcp.json is broken

- timestamp: 2026-02-14
  checked: git history of .mcp.json
  found: HEAD already has relative paths. The ${CLAUDE_PLUGIN_ROOT} version was an uncommitted working-tree modification.
  implication: Fix is simply reverting the uncommitted change

- timestamp: 2026-02-14
  checked: MCP server startup test
  found: "bash ./scripts/ensure-deps.sh node ./dist/index.js" starts successfully (curation agent starts, web server initializes)
  implication: Fix verified - relative paths work correctly

## Resolution

root_cause: The project-level .mcp.json had an uncommitted modification that changed relative paths ("./scripts/ensure-deps.sh") to ${CLAUDE_PLUGIN_ROOT} variable paths ("${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh"). The ${CLAUDE_PLUGIN_ROOT} variable is only resolved by Claude Code when loading configs from the installed plugin cache directory, NOT for project-level .mcp.json files. When Claude Code read the project-level config, the literal unresolved string was passed to bash, which failed because no such path exists.
fix: Reverted .mcp.json to use relative paths ("./scripts/ensure-deps.sh", "./dist/index.js"), matching the committed HEAD version and the installed plugin pattern
verification: Tested MCP server startup with "timeout 3 bash ./scripts/ensure-deps.sh node ./dist/index.js" - server initialized successfully (curation agent started, web server bound to port)
files_changed: [".mcp.json"]
