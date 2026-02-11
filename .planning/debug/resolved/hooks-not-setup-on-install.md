---
status: resolved
trigger: "hooks-not-setup-on-install: After install, no hooks exist in .claude/hooks* and memory system stays empty"
created: 2026-02-09T00:00:00Z
updated: 2026-02-09T00:02:00Z
---

## Current Focus

hypothesis: RESOLVED - package.json files field was missing hooks/, scripts/, .claude-plugin/
test: npm pack --dry-run confirmed all 22 files now included (was 18)
expecting: N/A - fix verified
next_action: Archive session

## Symptoms

expected: After installing Laminark, Claude Code hooks should be configured in .claude/ directory so memories are automatically captured from conversations
actual: After install, .claude/settings.json only has enabledPlugins. No hooks file exists. No automatic memory capture happens.
errors: No errors — missing feature/setup step
reproduction: Install Laminark fresh, start a conversation, work for a while, check recall — zero memories saved
started: Appears to have never worked — hook setup was likely planned but not implemented

## Eliminated

- hypothesis: hooks.json file doesn't exist at all
  evidence: hooks/hooks.json DOES exist in repo root with proper Claude Code hook definitions for PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, Stop
  timestamp: 2026-02-09T00:00:30Z

- hypothesis: handler.ts source code is missing
  evidence: src/hooks/handler.ts exists with full implementation (filter pipeline, stdin reading, event dispatch). dist/hooks/handler.js also built successfully.
  timestamp: 2026-02-09T00:00:30Z

- hypothesis: ensure-deps.sh script is missing
  evidence: scripts/ensure-deps.sh exists with proper npm install logic
  timestamp: 2026-02-09T00:00:30Z

## Evidence

- timestamp: 2026-02-09T00:00:10Z
  checked: package.json files field
  found: files array is ["dist"] — only dist/ directory is included in npm package
  implication: hooks/hooks.json, scripts/ensure-deps.sh, .claude-plugin/ are all EXCLUDED from npm installs

- timestamp: 2026-02-09T00:00:15Z
  checked: hooks/hooks.json content
  found: Proper hooks.json with PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, Stop events. All point to bash "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-deps.sh" node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/handler.js"
  implication: Hook configuration is well-formed and should work IF the file is present in the installed plugin

- timestamp: 2026-02-09T00:00:20Z
  checked: npm pack --dry-run output
  found: Only 18 files included, ALL from dist/. No hooks/, scripts/, or .claude-plugin/ files
  implication: npm-based installs completely lack the hook configuration

- timestamp: 2026-02-09T00:00:25Z
  checked: Claude Code plugin convention
  found: Claude Code v2.1+ auto-loads hooks/hooks.json from installed plugin root by convention. No need to declare in plugin.json.
  implication: The convention-based approach is correct, but the files must actually BE in the installed plugin directory

- timestamp: 2026-02-09T00:00:35Z
  checked: .claude-plugin/plugin.json and marketplace.json
  found: Plugin manifest exists but does NOT reference hooks.json (correct per convention). However these files are also excluded from npm package.
  implication: Both npm and marketplace install paths have packaging issues

- timestamp: 2026-02-09T00:00:40Z
  checked: dist/hooks/handler.js shebang
  found: No shebang line (#!/usr/bin/env node). Listed as bin entry "laminark-hook" in package.json but has no shebang.
  implication: bin entry won't work as CLI, but hooks.json invokes it via "node ..." so the missing shebang is cosmetic for hook operation

- timestamp: 2026-02-09T00:01:30Z
  checked: npm pack --dry-run AFTER fix
  found: 22 files included. Now includes: .claude-plugin/marketplace.json, .claude-plugin/plugin.json, hooks/hooks.json, scripts/ensure-deps.sh
  implication: Fix verified — all required plugin files now ship in the npm package

- timestamp: 2026-02-09T00:01:45Z
  checked: test suite (vitest run)
  found: 621/622 tests pass. 1 pre-existing failure in .mcp.json test (unrelated — expects manifest.laminark but structure is manifest.mcpServers.laminark)
  implication: No regressions from fix

## Resolution

root_cause: package.json "files" field only included "dist" — the hooks/hooks.json, scripts/ensure-deps.sh, and .claude-plugin/ directory were excluded from the npm package. Claude Code auto-loads hooks from hooks/hooks.json by convention at the plugin root, but since the file was missing from installed packages, no hooks were ever registered. The hook infrastructure was fully implemented (handler.ts, capture.ts, admission-filter.ts, privacy-filter.ts, session-lifecycle.ts, topic-shift-handler.ts, ensure-deps.sh, hooks.json) but never shipped.
fix: Added "hooks", "scripts", ".claude-plugin" to package.json files array. npm pack now includes all 22 files needed for the plugin to function.
verification: npm pack --dry-run confirms hooks/hooks.json, scripts/ensure-deps.sh, .claude-plugin/plugin.json, .claude-plugin/marketplace.json all present. 621/622 tests pass (1 pre-existing failure unrelated to this change).
files_changed: [package.json]
