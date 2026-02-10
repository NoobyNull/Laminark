---
phase: 07-knowledge-graph-and-advanced-intelligence
plan: 04
subsystem: database
tags: [knowledge-graph, temporal-queries, staleness-detection, recency-scoring, exponential-decay]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "better-sqlite3 database layer, observations table schema, ObservationRow/Observation types"
  - phase: 07-knowledge-graph-and-advanced-intelligence
    plan: 01
    provides: "graph_nodes/graph_edges tables, upsertNode, GraphNode/EntityType types"
provides:
  - "getObservationsByTimeRange with entity filtering"
  - "calculateRecencyScore with 7-day half-life exponential decay"
  - "getObservationAge with human-readable age labels"
  - "getEntityTimeline for chronological observation history"
  - "getRecentEntities for active node discovery"
  - "detectStaleness with negation, replacement, and status change patterns"
  - "flagStaleObservation advisory flagging (never deletes)"
  - "getStaleObservations query with entity/resolution filters"
  - "StalenessReport and StalenessFlag interfaces"
  - "staleness_flags table (CREATE IF NOT EXISTS)"
affects: [07-05, 07-06, 07-07]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Exponential decay recency scoring (7-day half-life)", "Pattern-based contradiction detection (negation/replacement/status)", "Advisory staleness flagging -- flag but never delete", "Staleness flags in separate table decoupled from core observations"]

key-files:
  created:
    - src/graph/temporal.ts
    - src/graph/staleness.ts
    - src/graph/__tests__/temporal.test.ts
  modified: []

key-decisions:
  - "Staleness flags stored in separate staleness_flags table, not added to observations schema"
  - "Pattern-based contradiction detection using string matching (not LLM-based) for determinism and speed"
  - "Staleness is advisory -- flagged observations remain fully queryable, never hidden"
  - "Test file placed at src/graph/__tests__/temporal.test.ts (not tests/graph/) to match vitest config"

patterns-established:
  - "Exponential decay scoring: exp(-0.693 * ageDays / halfLife) for time-weighted relevance"
  - "Advisory flag pattern: separate table with resolved boolean for user-controlled resolution"
  - "Contradiction detection: negation keywords, replacement regex patterns, status change keywords"

# Metrics
duration: 3min
completed: 2026-02-09
---

# Phase 7 Plan 4: Temporal Awareness Summary

**Exponential-decay recency scoring, time-range queries, and pattern-based staleness detection for knowledge graph observations**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-09T05:19:22Z
- **Completed:** 2026-02-09T05:23:13Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- Time-range observation queries with entity filtering via graph_nodes.observation_ids
- Recency scoring with 7-day half-life exponential decay (1.0 at 0 days, ~0.5 at 7, ~0.25 at 14)
- Entity timeline view returning chronological observation history annotated with recency and age
- Staleness detection comparing consecutive observations for negation, replacement, and status change contradictions
- Advisory staleness flagging in a separate table -- flagged observations remain fully queryable
- 28 tests covering all temporal and staleness functionality

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement temporal query utilities** - `f038d21` (feat)
2. **Task 2: Implement staleness detection with contradiction flagging** - `f689ab4` (feat)

## Files Created/Modified
- `src/graph/temporal.ts` - Time range queries, recency scoring (exponential decay), age formatting, entity timeline, recent entities
- `src/graph/staleness.ts` - Contradiction detection (negation/replacement/status patterns), advisory flagging, stale observation queries
- `src/graph/__tests__/temporal.test.ts` - 28 tests covering recency scores, age labels, staleness detection, flagging, time range queries, entity timeline, recent entities

## Decisions Made
- **Separate staleness_flags table:** Kept staleness metadata decoupled from the core observations schema. The observations table (Phase 1) remains unchanged -- staleness is an overlay concern managed by the graph subsystem.
- **Pattern-based detection:** Used simple string matching (negation keywords, replacement regex, status change keywords) rather than LLM-based analysis. This gives deterministic, fast results suitable for background processing.
- **Advisory-only flagging:** Stale observations are flagged with a reason but never hidden or deleted. Users retain full control over which observations to trust. The resolved boolean lets users dismiss false positives.
- **Test file location:** Placed tests at `src/graph/__tests__/temporal.test.ts` instead of plan's `tests/graph/temporal.test.ts` because vitest config only scans `src/**/*.test.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test file path adjusted to match vitest config**
- **Found during:** Task 2 (test creation)
- **Issue:** Plan specified `tests/graph/temporal.test.ts` but vitest config only scans `src/**/*.test.ts`
- **Fix:** Placed test at `src/graph/__tests__/temporal.test.ts` following project convention
- **Files modified:** src/graph/__tests__/temporal.test.ts
- **Verification:** `npx vitest run src/graph/__tests__/temporal.test.ts` discovers and runs all 28 tests
- **Committed in:** f689ab4 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Path adjustment necessary for tests to be discovered. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Temporal query utilities ready for search ranking integration (recency-weighted results)
- Staleness detection ready for curation workflows (flag stale observations during graph updates)
- Entity timeline provides the foundation for "show me what changed" queries in Phase 7 plan 07
- Recent entities query enables "what's active?" dashboard features

## Self-Check: PASSED

All files verified present, all commit hashes verified in git log.

---
*Phase: 07-knowledge-graph-and-advanced-intelligence*
*Completed: 2026-02-09*
