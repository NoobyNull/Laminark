---
phase: 16-staleness-management
plan: 01
subsystem: database
tags: [sqlite, staleness, tool-registry, migration, status-management]

# Dependency graph
requires:
  - phase: 10-tool-discovery-registry
    provides: tool_registry table, ToolRegistryRepository class
  - phase: 12-usage-tracking
    provides: tool_usage_events table with success column
  - phase: 15-tool-search
    provides: tool_registry_fts and tool_registry_embeddings tables
provides:
  - "Migration 19: status column (active/stale/demoted) on tool_registry with index"
  - "markStale, markDemoted, markActive methods for status transitions"
  - "getConfigSourcedTools for staleness comparison against current config"
  - "getRecentEventsForTool for failure rate checking"
  - "Status-aware ordering in getAvailableForSession (active > stale > demoted)"
  - "Upsert auto-restores active status on re-discovered tools"
affects: [16-02-staleness-management]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Three-state tool status: active/stale/demoted with idempotent transitions"
    - "Status-aware query ordering prepended to existing ORDER BY clauses"
    - "Upsert ON CONFLICT restores active status for re-discovered tools"

key-files:
  created: []
  modified:
    - src/storage/migrations.ts
    - src/shared/tool-types.ts
    - src/storage/tool-registry.ts

key-decisions:
  - "Idempotent status transitions: markStale/markActive skip if already in target state"
  - "getConfigSourcedTools returns both project-level and global config tools for complete staleness comparison"
  - "getRecentEventsForTool defaults to 5 events matching small-window failure detection"
  - "Status ordering prepended before tool_type ordering to ensure stale/demoted tools always sort after active"

patterns-established:
  - "Status column with TEXT NOT NULL DEFAULT 'active' pattern for safe migration"
  - "Idempotent mark* methods with AND status != target guard"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 16 Plan 01: Staleness Data Model Summary

**Migration 19 adds status column to tool_registry with 5 staleness query methods on ToolRegistryRepository**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T07:43:13Z
- **Completed:** 2026-02-11T07:45:52Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Migration 19 adds `status TEXT NOT NULL DEFAULT 'active'` column with index to tool_registry
- 5 new methods on ToolRegistryRepository: markStale, markDemoted, markActive, getConfigSourcedTools, getRecentEventsForTool
- getAvailableForSession now sorts active tools first, stale second, demoted third
- Upsert auto-restores active status when a tool is re-discovered via config scan

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration 19 and ToolRegistryRow type update** - `1b8c24e` (feat)
2. **Task 2: Staleness methods on ToolRegistryRepository** - `38dc171` (feat)

## Files Created/Modified
- `src/storage/migrations.ts` - Migration 19: status column + index on tool_registry
- `src/shared/tool-types.ts` - Added status field to ToolRegistryRow interface
- `src/storage/tool-registry.ts` - 5 new prepared statements and methods, status-aware ordering, upsert status restore

## Decisions Made
- Idempotent markStale/markActive: skip update if already in target state (avoids unnecessary writes)
- markDemoted is NOT idempotent (always updates updated_at) since demotion is an active signal worth timestamp refreshing
- getConfigSourcedTools queries both project-hash-specific AND NULL project_hash rows for complete coverage
- getRecentEventsForTool defaults to limit=5 for small-window failure rate detection
- Status ordering prepended (not appended) to existing ORDER BY to ensure absolute priority

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Staleness data model and storage methods complete
- Plan 16-02 can now wire staleness detection into hook handlers and ranking system
- All methods follow existing try/catch + debug logging patterns for non-fatal execution

## Self-Check: PASSED

- FOUND: src/storage/migrations.ts
- FOUND: src/shared/tool-types.ts
- FOUND: src/storage/tool-registry.ts
- FOUND: commit 1b8c24e (Task 1)
- FOUND: commit 38dc171 (Task 2)

---
*Phase: 16-staleness-management*
*Completed: 2026-02-11*
