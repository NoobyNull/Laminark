---
phase: 11-scope-resolution
plan: 01
subsystem: context
tags: [scope-resolution, tool-registry, session-context, sql, mcp]

# Dependency graph
requires:
  - phase: 10-tool-discovery-registry
    provides: "ToolRegistryRepository with upsert/recordOrCreate, tool_registry table with scope column"
provides:
  - "getAvailableForSession(projectHash) method for scope-filtered tool queries"
  - "formatToolSection() for rendering tool list in session context"
  - "assembleSessionContext integration with toolRegistry parameter"
  - "SCOP-01 (scope classification), SCOP-02 (session context filtering), SCOP-03 (cross-project isolation)"
affects: [12-conversation-routing, context-injection, session-lifecycle]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Scope resolution SQL with per-scope WHERE clauses (global always, project by hash, plugin by NULL-or-hash)"
    - "Tool section as lowest-priority context budget item (dropped before observations)"
    - "MCP server deduplication over individual MCP tools in display"

key-files:
  created: []
  modified:
    - src/storage/tool-registry.ts
    - src/context/injection.ts
    - src/hooks/session-lifecycle.ts

key-decisions:
  - "Scope resolution uses explicit per-scope SQL conditions rather than a generic scope hierarchy"
  - "Tool section is appended after observations and dropped first on budget overflow"
  - "formatToolSection is module-internal (not exported) to keep it as an implementation detail"
  - "Built-in tools excluded from display since Claude already knows them"

patterns-established:
  - "Budget trimming priority: tool section first, then references, findings, changes"
  - "Optional parameter pattern: toolRegistry? flows from handler through session-lifecycle to injection"

# Metrics
duration: 3min
completed: 2026-02-11
---

# Phase 11 Plan 01: Scope Resolution Summary

**Scope-filtered tool queries with per-scope SQL and session context Available Tools section with budget-aware trimming**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-11T04:27:08Z
- **Completed:** 2026-02-11T04:30:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- getAvailableForSession() method with scope-correct SQL implementing SCOP-01/02/03 (global always included, project-scoped by hash, plugins by NULL-or-hash)
- formatToolSection() deduplicating MCP servers vs individual tools, excluding built-ins, limiting to 10 entries
- Session context now includes "## Available Tools" section with scope tags and usage counts
- Budget trimming drops tool section first before trimming observation sections

## Task Commits

Each task was committed atomically:

1. **Task 1: Add getAvailableForSession() to ToolRegistryRepository** - `5ac1eb4` (feat)
2. **Task 2: Add formatToolSection() and wire tools into session context** - `e1f1ea9` (feat)

## Files Created/Modified
- `src/storage/tool-registry.ts` - Added stmtGetAvailableForSession prepared statement and getAvailableForSession() method
- `src/context/injection.ts` - Added formatToolSection(), MAX_TOOLS_IN_CONTEXT, toolRegistry parameter to assembleSessionContext, budget-first tool section trimming
- `src/hooks/session-lifecycle.ts` - Threaded toolRegistry into assembleSessionContext call (one-line change)

## Decisions Made
- Scope resolution uses explicit per-scope SQL conditions (scope='global' OR scope='project' AND hash=? OR scope='plugin' AND hash IS NULL OR hash=?) rather than a generic scope hierarchy -- clearer intent, easier to reason about
- formatToolSection is NOT exported -- it is an internal implementation detail of injection.ts
- Tool section is lowest priority in budget trimming -- observations are more valuable than tool listings
- Built-in tools (Read, Write, Edit, Bash) are excluded from the display since Claude already knows about them

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test failures (8/22) in injection.test.ts due to earlier kind-aware refactor of formatContextIndex that changed the function signature from flat observations array to sections object. These failures are NOT caused by this plan's changes. Session-lifecycle tests (6/6) pass cleanly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Scope resolution complete (SCOP-01 through SCOP-04)
- Tool registry now has full read path (getAvailableForSession) complementing write path (upsert/recordOrCreate from Phase 10)
- Session context surfaces available tools to Claude at session start
- Ready for Phase 12 (conversation-driven routing) which will use the resolved tool set for routing decisions

## Self-Check: PASSED

All files verified present. All commit hashes verified in git log. Key artifacts (getAvailableForSession, formatToolSection, toolRegistry threading, scope SQL) confirmed.

---
*Phase: 11-scope-resolution*
*Completed: 2026-02-11*
