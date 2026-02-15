---
status: resolved
trigger: "The Laminark MCP server is not starting. It has never worked."
created: 2026-02-14T00:00:00Z
updated: 2026-02-14T00:05:00Z
---

## Current Focus

hypothesis: CONFIRMED and FIXED
test: N/A
expecting: N/A
next_action: Archive session

## Symptoms

expected: MCP server should start and be available for Claude Code to call tools
actual: MCP server doesn't start
errors: npx -y -p laminark laminark-server hangs for 60+ seconds then times out
reproduction: Attempting to use the MCP server via Claude Code plugin
started: Has never worked (marketplace install)

## Eliminated

- hypothesis: Missing .mcp.json in plugin cache
  evidence: .mcp.json exists at /home/matthew/.claude/plugins/cache/laminark/laminark/2.21.8/.mcp.json
  timestamp: 2026-02-14

- hypothesis: dist files not built
  evidence: plugin/dist/index.js exists and is 203KB, all dist files present
  timestamp: 2026-02-14

## Evidence

- timestamp: 2026-02-14T00:01:00Z
  checked: Plugin cache .mcp.json command
  found: Uses "npx -y -p laminark laminark-server" which downloads from npm and compiles better-sqlite3 native addon
  implication: Very slow startup, times out, may fail entirely

- timestamp: 2026-02-14T00:01:30Z
  checked: Running "npx -y -p laminark laminark-server" from /tmp
  found: Hangs for 60+ seconds downloading/compiling, never starts
  implication: The npx approach is non-functional for a package with native addons

- timestamp: 2026-02-14T00:01:45Z
  checked: Running "node dist/index.js" from plugin cache
  found: "Cannot find package 'better-sqlite3'" - no node_modules in plugin cache
  implication: Plugin cache has no dependencies; needs npm install on first run

- timestamp: 2026-02-14T00:02:00Z
  checked: npm-published package vs git repo
  found: npm package has ensure-deps.sh and uses ${CLAUDE_PLUGIN_ROOT} in .mcp.json; git repo removed ensure-deps.sh and uses npx
  implication: Commit f81340b introduced the broken npx approach

- timestamp: 2026-02-14T00:02:30Z
  checked: Plugin cache has no package.json
  found: Marketplace copies plugin/ dir contents. No package.json means ensure-deps.sh's "npm install --prefix" has nothing to install
  implication: Need a package.json inside plugin/ with runtime deps for ensure-deps.sh to work

- timestamp: 2026-02-14T00:03:00Z
  checked: npm install --production in plugin dir
  found: sharp (dep of @huggingface/transformers) fails to build without node-addon-api
  implication: Must use --ignore-scripts then selectively rebuild better-sqlite3

- timestamp: 2026-02-14T00:04:00Z
  checked: Full MCP server startup from clean plugin cache copy
  found: ensure-deps.sh installs deps, server starts, MCP initialize handshake returns valid JSON-RPC with tool capabilities
  implication: Fix verified working

- timestamp: 2026-02-14T00:04:30Z
  checked: Second run performance
  found: Sub-second startup (deps already installed, skips npm install)
  implication: No startup penalty after first run

## Resolution

root_cause: |
  Commit f81340b changed plugin/.mcp.json from using "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh"
  to "npx -y -p laminark laminark-server". The npx approach fails because:
  (1) it must download the full package and compile better-sqlite3 native addon on every start,
  (2) this takes 60+ seconds and times out before the server can start,
  (3) the plugin cache already has the dist files but lacks node_modules.
  Additionally, ensure-deps.sh was removed from the repo, and there was no package.json in
  plugin/ for npm install to use when running from the marketplace plugin cache.

fix: |
  1. Created plugin/scripts/ensure-deps.sh - installs deps on first run using --ignore-scripts
     (avoids sharp build failure) then rebuilds better-sqlite3 selectively
  2. Created plugin/package.json - minimal package with runtime dependencies so npm install
     knows what to install in the plugin cache directory
  3. Updated plugin/.mcp.json - changed from npx to ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh
     which installs deps on first run then executes node dist/index.js
  4. Updated plugin/hooks/hooks.json - changed from npx to ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh
     with node dist/hooks/handler.js
  5. Copied all fixed files to installed plugin cache for immediate effect
  6. Ran npm install in plugin cache to pre-install dependencies

verification: |
  - Clean test: copied plugin/ to temp dir, ran ensure-deps.sh -> deps installed, server started
  - MCP initialize handshake returns valid JSON-RPC: {"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}}}
  - Hooks handler runs cleanly via ensure-deps.sh
  - Second run is fast (<1s, deps already installed)
  - Actual plugin cache: deps installed, server starts, MCP handshake succeeds
  - Test suite: 728/738 pass (10 pre-existing failures unrelated to changes)

files_changed:
  - plugin/scripts/ensure-deps.sh (created)
  - plugin/package.json (created)
  - plugin/.mcp.json (updated)
  - plugin/hooks/hooks.json (updated)
