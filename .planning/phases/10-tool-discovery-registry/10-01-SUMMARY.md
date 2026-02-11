---
phase: 10-tool-discovery-registry
plan: 01
subsystem: database
tags: [sqlite, tool-registry, migrations, prepared-statements, scope-awareness]

# Dependency graph
requires:
  - phase: 09-global-installation
    provides: global plugin installation enabling cross-project tool awareness
provides:
  - ToolType, ToolScope, DiscoveredTool, ToolRegistryRow type definitions
  - Migration 16 creating tool_registry table with COALESCE unique index
  - ToolRegistryRepository with upsert, recordUsage, recordOrCreate, getForProject, getByName, getAll, count
affects: [10-02, tool-discovery, context-injection, routing]

# Tech tracking
tech-stack:
  added: []
  patterns: [scope-aware-uniqueness-via-coalesce, upsert-then-increment-organic-discovery]

key-files:
  created:
    - src/shared/tool-types.ts
    - src/storage/tool-registry.ts
  modified:
    - src/storage/migrations.ts

key-decisions:
  - "COALESCE(project_hash, '') for NULL-safe unique index -- tools with NULL project_hash (global) treated as unique namespace"
  - "ToolRegistryRepository is NOT project-scoped (unlike ObservationRepository) -- queries span all scopes for cross-project tool discovery"
  - "recordOrCreate uses upsert-then-increment pattern: try usage update first, create on zero changes"

patterns-established:
  - "Scope-aware uniqueness: UNIQUE INDEX on (name, COALESCE(nullable_col, '')) for NULL-safe dedup"
  - "Cross-scope repository: no projectHash in constructor, scope filtering in queries instead"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 10 Plan 01: Tool Registry Storage Foundation Summary

**SQLite tool_registry table with COALESCE unique index and ToolRegistryRepository supporting scope-aware upsert, organic discovery, and cross-project queries**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T03:15:07Z
- **Completed:** 2026-02-11T03:16:57Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Type definitions for tool discovery: ToolType (7 variants), ToolScope (3 variants), DiscoveredTool input interface, ToolRegistryRow DB row
- Migration 16 creates tool_registry table with 4 indexes including NULL-safe unique index via COALESCE
- ToolRegistryRepository with 7 methods and 6 prepared statements following existing repository patterns

## Task Commits

Each task was committed atomically:

1. **Task 1: Create tool type definitions and migration 16** - `71e2ef9` (feat)
2. **Task 2: Create ToolRegistryRepository** - `6dcf983` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `src/shared/tool-types.ts` - ToolType, ToolScope, DiscoveredTool, ToolRegistryRow type exports
- `src/storage/migrations.ts` - Migration 16 added (create_tool_registry with 4 indexes)
- `src/storage/tool-registry.ts` - ToolRegistryRepository class with 7 methods, 6 prepared statements

## Decisions Made
- COALESCE(project_hash, '') for unique index: ensures global tools (NULL project_hash) are properly deduplicated while allowing per-project tool entries
- Repository is NOT project-scoped: unlike ObservationRepository which takes projectHash in constructor, ToolRegistryRepository works cross-scope with per-query filtering
- recordOrCreate pattern: attempts usage increment first, falls back to upsert on zero changes -- avoids unnecessary INSERT attempts for known tools

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- tool_registry table and repository ready for Plan 02 to wire in config scanning and organic PostToolUse discovery
- Types exported for use in hook handler and context injection
- No blockers for Plan 02

## Self-Check: PASSED

- FOUND: src/shared/tool-types.ts
- FOUND: src/storage/tool-registry.ts
- FOUND: src/storage/migrations.ts
- FOUND: 10-01-SUMMARY.md
- FOUND: commit 71e2ef9
- FOUND: commit 6dcf983

---
*Phase: 10-tool-discovery-registry*
*Completed: 2026-02-11*
