---
phase: 12-usage-tracking
plan: 01
subsystem: database
tags: [sqlite, usage-tracking, temporal-queries, tool-events]

# Dependency graph
requires:
  - phase: 10-tool-discovery-registry
    provides: "tool_registry table and ToolRegistryRepository with recordOrCreate"
  - phase: 11-scope-resolution
    provides: "Scope-filtered tool queries and session context"
provides:
  - "tool_usage_events table for granular per-event usage tracking"
  - "ToolUsageEvent and ToolUsageStats type interfaces"
  - "Session-aware event recording on every PostToolUse/PostToolUseFailure"
  - "Three temporal query methods: getUsageForTool, getUsageForSession, getUsageSince"
  - "Success/failure distinction via success column (enables Phase 16 demotion)"
affects: [13-context-enhancement, 14-conversation-routing, 16-failure-driven-demotion]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Event-sourcing supplement to aggregate counters", "Temporal SQL queries with datetime modifiers"]

key-files:
  created: []
  modified:
    - src/storage/migrations.ts
    - src/shared/tool-types.ts
    - src/storage/tool-registry.ts
    - src/hooks/handler.ts

key-decisions:
  - "Event insert inside existing try/catch -- non-fatal, supplementary to aggregate counters"
  - "sessionId=undefined skips event insert -- backward compatible with any callers not providing session"
  - "No transaction wrapping aggregate+event -- independent rows, acceptable if event fails alone"

patterns-established:
  - "Temporal query pattern: datetime('now', ?) with SQLite modifier strings like '-7 days'"
  - "Success/failure as INTEGER 0/1 column for boolean storage in SQLite"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 12 Plan 01: Usage Event Tracking Summary

**Per-event tool usage recording with session/project context and temporal query methods for downstream routing intelligence**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T05:16:30Z
- **Completed:** 2026-02-11T05:19:01Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Migration 17 creates tool_usage_events table with tool_name, session_id, project_hash, success, and created_at columns plus three performance indexes
- Every PostToolUse and PostToolUseFailure hook event now inserts a granular event row alongside the existing aggregate counter update
- Three temporal query methods enable downstream phases to answer "how often in what period" and "which tools in this session"
- PostToolUseFailure events recorded with success=0, providing the data foundation for Phase 16 failure-driven demotion

## Task Commits

Each task was committed atomically:

1. **Task 1: Add tool_usage_events schema and event recording** - `b60666f` (feat)
2. **Task 2: Wire handler session_id threading and temporal query methods** - `255ad24` (feat)

## Files Created/Modified
- `src/storage/migrations.ts` - Migration 17: tool_usage_events table with 3 indexes
- `src/shared/tool-types.ts` - ToolUsageEvent and ToolUsageStats interfaces
- `src/storage/tool-registry.ts` - stmtInsertEvent, extended recordOrCreate, 3 temporal query methods
- `src/hooks/handler.ts` - session_id extraction and success/failure threading to recordOrCreate

## Decisions Made
- Event insert placed inside existing try/catch in recordOrCreate -- failures are non-fatal and logged, consistent with existing error handling pattern
- sessionId=undefined check skips event insert entirely -- callers without session context (e.g., direct recordOrCreate calls) do not create events
- No transaction wrapping aggregate update + event insert -- they are independent rows in different tables, and the event is supplementary analytics data

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- tool_usage_events table provides the granular data layer Phase 13 (context enhancement) needs for relevance ranking
- Temporal query methods (getUsageForTool, getUsageForSession, getUsageSince) are ready for Phase 14 (conversation routing)
- Success/failure column enables Phase 16 failure-driven demotion without additional schema changes

## Self-Check: PASSED

All files verified present. All commit hashes found in git log.

---
*Phase: 12-usage-tracking*
*Completed: 2026-02-11*
