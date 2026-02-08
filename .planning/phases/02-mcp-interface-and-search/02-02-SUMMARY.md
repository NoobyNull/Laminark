---
phase: 02-mcp-interface-and-search
plan: 02
subsystem: api
tags: [mcp, fts5, bm25, token-budget, progressive-disclosure, recall]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "ObservationRepository, SearchEngine, openDatabase, migrations, debug logging"
  - phase: 02-mcp-interface-and-search
    plan: 01
    provides: "MCP server scaffold, save_memory tool, token-budget utility, migration 005 (title+FTS5)"
provides:
  - "Unified recall tool with search/view/purge/restore actions"
  - "3-level progressive disclosure: compact, timeline, full"
  - "ObservationRepository extended with getByIdIncludingDeleted, listIncludingDeleted, getByTitle"
  - "BM25 title weighting (2x content) for search relevance"
affects: [02-03 search tests, 03 hook integration, 05 slash commands]

# Tech tracking
tech-stack:
  added: []
  patterns: ["unified tool pattern: single tool with action parameter instead of separate tools", "progressive disclosure: compact -> timeline -> full detail levels", "BM25 column weighting via bm25(fts_table, col1_weight, col2_weight)"]

key-files:
  created:
    - src/mcp/tools/recall.ts
  modified:
    - src/storage/observations.ts
    - src/storage/search.ts
    - src/index.ts

key-decisions:
  - "BM25 weights set to 2.0 (title) / 1.0 (content) for title-biased relevance ranking"
  - "Single unified recall tool with action parameter (view/purge/restore) per user locked decision"
  - "Purge/restore require explicit IDs -- no blind bulk operations on search results"

patterns-established:
  - "Recall tool action pattern: search returns list with IDs, caller acts on specific IDs"
  - "Token budget per detail level: 2000 for compact/timeline, 4000 for single-item full view"
  - "Metadata footer on all view responses: result count, token estimate, detail level, truncation indicator"

# Metrics
duration: 3min
completed: 2026-02-08
---

# Phase 2 Plan 02: Recall Tool Summary

**Unified recall tool with FTS5 search, 3-level progressive disclosure, purge/restore lifecycle, and BM25 title-weighted ranking**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-08T22:25:09Z
- **Completed:** 2026-02-08T22:27:41Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Unified recall tool handles all 4 actions (search/view/purge/restore) in a single MCP tool
- Progressive disclosure at 3 detail levels (compact/timeline/full) with token budget enforcement
- ObservationRepository extended with 3 new query methods for purged-item access and title search
- BM25 title weighting (2x content) applied to both keyword and prefix search in SearchEngine
- Purge/restore require explicit ID selection, preventing blind bulk operations

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend ObservationRepository for recall tool queries** - `40309d7` (feat)
2. **Task 2: Implement unified recall tool with progressive disclosure** - `f61443d` (feat)

## Files Created/Modified
- `src/mcp/tools/recall.ts` - Unified recall tool with search/view/purge/restore actions, progressive disclosure formatting, token budget enforcement
- `src/storage/observations.ts` - Added getByIdIncludingDeleted, listIncludingDeleted, getByTitle methods
- `src/storage/search.ts` - BM25 weights updated to 2.0/1.0 (title/content) in searchKeyword and searchByPrefix
- `src/index.ts` - Registers recall tool alongside save_memory

## Decisions Made
- BM25 weights set to 2.0 (title) / 1.0 (content) per plan specification. Title matches rank higher than content-only matches, improving relevance for keyword searches.
- Purge and restore operations require explicit ID(s) via `ids` array or single `id` parameter. The tool returns an error if neither is provided, enforcing the search-first-then-act pattern.
- Single unified recall tool with `action` parameter rather than separate tools, per user locked decision from planning phase.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Both MCP tools (save_memory + recall) are registered and operational
- Recall tool ready for integration testing in Plan 02-03
- BM25 title weighting ready for search quality validation
- Progressive disclosure ready for context window management testing
- Token budget enforcement active on all response paths

---
*Phase: 02-mcp-interface-and-search*
*Completed: 2026-02-08*
