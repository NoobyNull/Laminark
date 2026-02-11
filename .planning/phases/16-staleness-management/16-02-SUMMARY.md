---
phase: 16-staleness-management
plan: 02
subsystem: hooks
tags: [staleness, demotion, ranking, routing, tool-lifecycle, session-lifecycle]

# Dependency graph
requires:
  - phase: 16-staleness-management/01
    provides: status column, markStale/markDemoted/markActive methods, getConfigSourcedTools, getRecentEventsForTool
  - phase: 10-tool-discovery-registry
    provides: tool_registry table, ToolRegistryRepository, config scanning, organic discovery
  - phase: 14-conversation-routing
    provides: ConversationRouter with suggestable tool filtering
  - phase: 15-tool-search
    provides: discover_tools MCP tool with formatToolResult
provides:
  - "detectRemovedTools at SessionStart comparing config scan against registry"
  - "Failure-driven demotion (3-of-5 window) in PostToolUse pipeline"
  - "Success restoration (markActive) on any successful tool use"
  - "Status-based 0.25x score penalty in rankToolsByRelevance"
  - "Age-based 0.5x penalty for tools not seen in 30+ days"
  - "Routing exclusion: only active tools in ConversationRouter suggestable set"
  - "Search status display: [stale]/[demoted] markers in discover_tools results"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Config rescan comparison: scannedNames Set vs registeredConfigTools for O(1) staleness detection"
    - "MCP server cascade: removing server also marks individual mcp_tool children stale"
    - "Sliding window failure detection: 3+ failures in last 5 events triggers demotion"
    - "Stacking penalties: status penalty (0.25x) and age penalty (0.5x) multiply independently"

key-files:
  created: []
  modified:
    - src/hooks/session-lifecycle.ts
    - src/hooks/handler.ts
    - src/context/injection.ts
    - src/routing/conversation-router.ts
    - src/mcp/tools/discover-tools.ts

key-decisions:
  - "detectRemovedTools runs inside config scan timing (contributes to scanElapsed) for accurate performance monitoring"
  - "MCP server removal cascades to individual mcp_tool entries from same server_name"
  - "Failure demotion uses same isFailure const already declared in organic discovery block"
  - "Age penalty computed in JS using MAX(last_used_at/discovered_at, updated_at) rather than SQL"
  - "Status filter in router uses strict equality (=== 'active') rather than exclusion list"

patterns-established:
  - "Staleness detection as post-scan phase: upsert (restores) then detect (marks missing)"
  - "Stacking score penalties: independent multipliers for orthogonal quality signals"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 16 Plan 02: Staleness Wiring Summary

**Config removal detection, failure demotion (3-of-5 window), age-based deprioritization, routing exclusion, and search status markers across 5 files**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T07:48:35Z
- **Completed:** 2026-02-11T07:51:19Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- STAL-01: detectRemovedTools at SessionStart marks config-sourced tools missing from scan as stale, cascading to child MCP tools
- STAL-03: PostToolUse checks last 5 events; 3+ failures triggers demotion; any success restores to active
- STAL-02: rankToolsByRelevance applies 0.25x status penalty and 0.5x age penalty (stacking)
- Routing exclusion: ConversationRouter only suggests active tools
- discover_tools shows [stale]/[demoted] status tags in search results

## Task Commits

Each task was committed atomically:

1. **Task 1: Config rescan staleness detection at SessionStart** - `2eb514b` (feat)
2. **Task 2: Failure demotion and success restoration in PostToolUse** - `48ce258` (feat)
3. **Task 3: Ranking deprioritization, routing exclusion, and search status display** - `784e0e6` (feat)

## Files Created/Modified
- `src/hooks/session-lifecycle.ts` - detectRemovedTools function and wiring into handleSessionStart
- `src/hooks/handler.ts` - Failure demotion check (3-of-5) and success restoration in PostToolUse
- `src/context/injection.ts` - Status-based (0.25x) and age-based (0.5x) score penalties in rankToolsByRelevance
- `src/routing/conversation-router.ts` - Stale/demoted tools filtered from suggestable set via status === 'active'
- `src/mcp/tools/discover-tools.ts` - Status indicator [stale]/[demoted] in formatToolResult search output

## Decisions Made
- detectRemovedTools placed inside config scan try/catch block, contributing to scanElapsed timing
- MCP server removal cascades to individual mcp_tool children from the same server_name
- Age penalty uses MAX(last_used_at || discovered_at, updated_at) computed in JS for flexibility
- Router uses strict `t.status === 'active'` rather than exclusion list to be forward-compatible with new statuses
- Failure demotion reuses existing isFailure const; both demotion and restoration are inside the same try/catch

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Complete staleness management system is now operational
- Phase 16 (final phase of v2.0 milestone) is complete
- All STAL requirements implemented: config rescan detection, age-based deprioritization, failure demotion with instant success restoration

## Self-Check: PASSED

- FOUND: src/hooks/session-lifecycle.ts
- FOUND: src/hooks/handler.ts
- FOUND: src/context/injection.ts
- FOUND: src/routing/conversation-router.ts
- FOUND: src/mcp/tools/discover-tools.ts
- FOUND: commit 2eb514b (Task 1)
- FOUND: commit 48ce258 (Task 2)
- FOUND: commit 784e0e6 (Task 3)
- FOUND: 16-02-SUMMARY.md

---
*Phase: 16-staleness-management*
*Completed: 2026-02-11*
