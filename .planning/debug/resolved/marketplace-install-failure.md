---
status: resolved
trigger: "Installing Laminark as a Claude plugin from GitHub marketplace fails with 'Marketplace file not found' error"
created: 2026-02-14T00:00:00Z
updated: 2026-02-14T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED - .claude-plugin/marketplace.json was deleted in commit dea3a8d, Claude marketplace requires it at repo root
test: Verify all restored files are valid JSON and structurally correct
expecting: Marketplace install should find the files it needs
next_action: Verify fix, then archive

## Symptoms

expected: npm installs the package and Claude recognizes the MCP tools provided by Laminark
actual: Error - "Marketplace file not found at /home/matthew/.claude/plugins/marketplaces/noobynull-laminark/.claude-plugin/marketplace.json"
errors: Marketplace file not found at /home/matthew/.claude/plugins/marketplaces/noobynull-laminark/.claude-plugin/marketplace.json
reproduction: Install from Claude plugin marketplace on GitHub
started: Never worked - first time trying marketplace install

## Eliminated

## Evidence

- timestamp: 2026-02-14
  checked: git log and commit dea3a8d
  found: .claude-plugin/marketplace.json was deleted in commit dea3a8d ("chore: remove .claude-plugin/, plugin hooks.json, and plugin .mcp.json"). Also deleted: plugin/.mcp.json and plugin/hooks/hooks.json
  implication: The marketplace entry point file is missing from the repo

- timestamp: 2026-02-14
  checked: Current directory structure
  found: .claude-plugin/ directory does NOT exist at repo root. plugin/.claude-plugin/plugin.json DOES exist. plugin/.mcp.json and plugin/hooks/hooks.json do NOT exist.
  implication: The marketplace.json at root is gone, and the plugin source directory (./plugin/) is missing its MCP and hooks config

- timestamp: 2026-02-14
  checked: Official Claude Code docs and marketplace examples
  found: Claude marketplace requires .claude-plugin/marketplace.json at repo root. Each plugin source directory needs .claude-plugin/plugin.json (exists), .mcp.json (deleted), and hooks/ config (deleted). Plugin files are copied to cache, so paths outside plugin dir don't work.
  implication: Need to restore all three: marketplace.json at root, .mcp.json and hooks config at plugin source

- timestamp: 2026-02-14
  checked: Current install.sh script
  found: install.sh uses npm install -g + claude mcp add-json + inline node script for hooks. The npm+MCP approach works independently of the plugin marketplace system.
  implication: The two install methods (marketplace vs npm+MCP) can coexist. Marketplace install uses .mcp.json and hooks.json. npm install uses install.sh.

- timestamp: 2026-02-14
  checked: plugin/dist/index.js imports
  found: dist files are NOT bundled -- they import external packages (zod, @modelcontextprotocol/sdk, hono, etc.). Cannot run from plugin cache without node_modules.
  implication: Marketplace .mcp.json and hooks must use npx to pull from npm registry, not ${CLAUDE_PLUGIN_ROOT}/dist/ directly

- timestamp: 2026-02-14
  checked: npm registry
  found: laminark@2.21.8 is published with bins laminark-server and laminark-hook
  implication: npx -y -p laminark laminark-server will work for marketplace installs

- timestamp: 2026-02-14
  checked: plugin/.claude-plugin/plugin.json skills path
  found: skills path was "../skills/" (pointing outside plugin dir) but skills are at plugin/skills/ (inside plugin dir)
  implication: Secondary bug -- fixed to "./skills/"

## Resolution

root_cause: Commit dea3a8d removed .claude-plugin/marketplace.json (repo root), plugin/.mcp.json, and plugin/hooks/hooks.json. These are required by Claude's plugin marketplace system. The refactor to npm+MCP install was correct for the CLI install path but inadvertently broke marketplace install by removing files that marketplace needs. Additionally, plugin.json had an incorrect skills path pointing outside the plugin directory.
fix: |
  1. Created .claude-plugin/marketplace.json at repo root (marketplace entry point)
  2. Created plugin/.mcp.json using npx to run laminark-server from npm
  3. Created plugin/hooks/hooks.json using npx to run laminark-hook from npm
  4. Fixed plugin/.claude-plugin/plugin.json skills path from "../skills/" to "./skills/"
  Using npx instead of ${CLAUDE_PLUGIN_ROOT}/dist/ because the dist files have unbundled external imports requiring node_modules, and plugin cache doesn't include the repo root's node_modules.
verification: All JSON files validated. npm registry confirms laminark@2.21.8 with both binaries available. Full marketplace install requires pushing to GitHub and testing -- returning CHECKPOINT.
files_changed:
  - .claude-plugin/marketplace.json (created)
  - plugin/.mcp.json (created)
  - plugin/hooks/hooks.json (created)
  - plugin/.claude-plugin/plugin.json (fixed skills path)
