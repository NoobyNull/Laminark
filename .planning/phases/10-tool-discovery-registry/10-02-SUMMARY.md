---
phase: 10-tool-discovery-registry
plan: 02
subsystem: hooks
tags: [tool-discovery, config-scanning, organic-discovery, mcp-tools, slash-commands, skills, plugins]

# Dependency graph
requires:
  - phase: 10-tool-discovery-registry/10-01
    provides: tool_registry table, ToolRegistryRepository with upsert/recordOrCreate, DiscoveredTool types
provides:
  - Config scanner reading 5 config surfaces (DISC-01 through DISC-04)
  - Tool name parser for organic discovery metadata inference
  - Organic PostToolUse discovery wired before self-referential filter (DISC-05)
  - Config scanning integrated into SessionStart lifecycle
affects: [context-injection, tool-routing, conversation-routing]

# Tech tracking
tech-stack:
  added: []
  patterns: [synchronous-config-scanning, organic-discovery-before-filter, non-fatal-registry-writes]

key-files:
  created:
    - src/hooks/config-scanner.ts
    - src/hooks/tool-name-parser.ts
  modified:
    - src/hooks/handler.ts
    - src/hooks/session-lifecycle.ts

key-decisions:
  - "Organic discovery runs BEFORE self-referential filter -- Laminark's own tools are registered in the registry"
  - "Config scanning uses only synchronous fs operations -- SessionStart hook is synchronous"
  - "All discovery writes wrapped in try/catch -- tool registry is supplementary, never blocks core pipeline"
  - "projectHash passed from main() to processPostToolUseFiltered to avoid redundant realpathSync"

patterns-established:
  - "Non-fatal supplementary feature: try/catch around all registry operations, failures logged but never block"
  - "Config scanning at SessionStart: proactive discovery runs after session create, before context assembly"
  - "Organic discovery at PostToolUse: records every tool invocation including self-referential ones"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 10 Plan 02: Tool Discovery Pipeline Summary

**Config scanning across 5 Claude Code surfaces at SessionStart plus organic PostToolUse discovery recording every tool invocation into the registry**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T03:19:10Z
- **Completed:** 2026-02-11T03:21:54Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Created tool name parser with inferToolType(), inferScope(), extractServerName() for organic discovery metadata
- Created config scanner reading .mcp.json, ~/.claude.json, commands dirs, skills dirs, and installed_plugins.json
- Wired organic discovery into handler.ts BEFORE self-referential filter -- all tools including Laminark's own are registered
- Integrated config scanning into session-lifecycle.ts with 200ms performance budget monitoring

## Task Commits

Each task was committed atomically:

1. **Task 1: Create config scanner and tool name parser** - `7387f56` (feat)
2. **Task 2: Wire discovery into handler.ts and session-lifecycle.ts** - `0d44ec5` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `src/hooks/tool-name-parser.ts` - Three pure functions: inferToolType(), inferScope(), extractServerName() for MCP/builtin/unknown classification
- `src/hooks/config-scanner.ts` - scanConfigForTools() with 5 internal scanners for all Claude Code config surfaces
- `src/hooks/handler.ts` - ToolRegistryRepository instantiation, organic discovery block, projectHash threading
- `src/hooks/session-lifecycle.ts` - Config scanning integration with ToolRegistryRepository and performance timing

## Decisions Made
- Organic discovery runs BEFORE self-referential filter: ensures Laminark's own MCP tools (both prefix variants) are registered in the registry even though they are filtered from observation capture
- projectHash passed from main() to processPostToolUseFiltered: avoids calling getProjectHash(cwd) again which involves expensive realpathSync
- All discovery is non-fatal: try/catch around every registry operation ensures core observation pipeline is never blocked by registry failures
- Config scanning performance budget: 200ms threshold with debug logging for slow scans

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 10 (Tool Discovery and Registry) is complete: storage foundation (10-01) + discovery pipeline (10-02)
- Tool registry populates proactively via config scanning and reactively via organic PostToolUse discovery
- Ready for Phase 11+ to build on tool awareness for context injection and routing
- No blockers

## Self-Check: PASSED

- FOUND: src/hooks/config-scanner.ts
- FOUND: src/hooks/tool-name-parser.ts
- FOUND: src/hooks/handler.ts
- FOUND: src/hooks/session-lifecycle.ts
- FOUND: commit 7387f56
- FOUND: commit 0d44ec5

---
*Phase: 10-tool-discovery-registry*
*Completed: 2026-02-11*
