---
phase: 06-topic-detection-and-context-stashing
plan: 05
subsystem: intelligence
tags: [ewma, adaptive-threshold, topic-detection, cold-start, session-seeding]

# Dependency graph
requires:
  - phase: 06-topic-detection-and-context-stashing
    plan: 01
    provides: "TopicShiftDetector with static threshold and cosineDistance utility"
provides:
  - "AdaptiveThresholdManager with EWMA distance/variance computation"
  - "ThresholdState interface for cross-module EWMA state transfer"
  - "ThresholdStore for persisting and loading session threshold history"
  - "Migration 008: threshold_history table for session seeding"
affects: [06-06]

# Tech tracking
tech-stack:
  added: []
  patterns: [ewma-adaptive-threshold, cold-start-seeding-from-history, bounded-threshold-clamping]

key-files:
  created:
    - src/intelligence/adaptive-threshold.ts
    - src/intelligence/__tests__/adaptive-threshold.test.ts
    - src/storage/threshold-store.ts
    - src/storage/migrations/008-threshold-history.sql
  modified:
    - src/storage/migrations.ts
    - src/storage/index.ts

key-decisions:
  - "Migration numbered 008 (not 007 as plan stated) because 007 was already taken by context_stashes"
  - "EWMA variance uses diff from post-update mean (distance - newEwmaDistance) per standard EWMA formulation"
  - "seedFromHistory does not reset observationCount -- preserves session tracking independently from statistical seeding"
  - "ThresholdStore uses prepared statements pattern (constructor-bound) matching StashManager architecture"

patterns-established:
  - "EWMA adaptive module: pure math computation with no DB dependencies, store is separate"
  - "ThresholdState interface: standard state transfer type between manager and store"
  - "Cold-start seeding: loadHistoricalSeed returns null when no history, caller decides fallback"

# Metrics
duration: 3min
completed: 2026-02-09
---

# Phase 6 Plan 5: EWMA Adaptive Topic Threshold Summary

**EWMA-based adaptive threshold manager with session-seeded cold start, bounded [0.15, 0.6] clamping, and SQLite persistence via ThresholdStore**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-09T03:05:30Z
- **Completed:** 2026-02-09T03:08:52Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files created:** 4
- **Files modified:** 2

## Accomplishments
- AdaptiveThresholdManager: EWMA distance + variance tracking, update/seed/reset/getThreshold/getState API
- ThresholdStore: saveSessionThreshold and loadHistoricalSeed (last 10 sessions average) with prepared statements
- Migration 008: threshold_history table with project+recency composite index
- 29 tests covering convergence (high/low/mixed), boundary clamping, cold start, seeding, round-trip persistence, integration

## Task Commits

Each task was committed atomically (TDD flow):

1. **RED: Failing tests** - `50ab454` (test) - 29 test cases for AdaptiveThresholdManager + ThresholdStore + integration
2. **GREEN: Implementation** - `1a3fa7b` (feat) - AdaptiveThresholdManager, ThresholdStore, migration 008, index exports

## Files Created/Modified
- `src/intelligence/adaptive-threshold.ts` - AdaptiveThresholdManager class, ThresholdState interface, EWMA computation
- `src/intelligence/__tests__/adaptive-threshold.test.ts` - 29 tests: EWMA math, convergence, bounds, cold start, persistence, integration
- `src/storage/threshold-store.ts` - ThresholdStore class with saveSessionThreshold/loadHistoricalSeed
- `src/storage/migrations/008-threshold-history.sql` - threshold_history table DDL (reference SQL)
- `src/storage/migrations.ts` - Added migration version 8 (create_threshold_history)
- `src/storage/index.ts` - Re-exported ThresholdStore and HistoricalSeed type

## Decisions Made
- Migration numbered 008 instead of 007 (plan referenced 007 but that was already used by context_stashes from plan 06-02)
- EWMA variance computed from post-update mean (standard formulation: diff = distance - newEwma, not pre-update)
- seedFromHistory preserves observationCount -- count tracks session activity, seed only affects statistical baseline
- ThresholdStore follows same prepared-statement constructor pattern as StashManager for consistency

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migration version conflict: 007 already taken**
- **Found during:** Task 2 (GREEN implementation)
- **Issue:** Plan specified migration `007-threshold-history.sql` but version 7 was already used by `create_context_stashes` (06-02)
- **Fix:** Used migration version 8 (`008-threshold-history.sql`) instead
- **Files modified:** src/storage/migrations.ts, src/storage/migrations/008-threshold-history.sql
- **Verification:** All 421 tests pass, migration applies correctly after version 7
- **Committed in:** 1a3fa7b (GREEN commit)

**2. [Rule 1 - Bug] Mixed distances test used extreme alternation hitting cap**
- **Found during:** Task 2 (GREEN verification)
- **Issue:** Test alternated 0.7/0.1 which produces high variance, pushing threshold to 0.6 cap -- not "middle" as intended
- **Fix:** Changed to 0.4/0.2 alternation which maintains moderate variance and stays in middle band
- **Files modified:** src/intelligence/__tests__/adaptive-threshold.test.ts
- **Verification:** Test correctly validates threshold is between 0.15 and 0.6 (exclusive)
- **Committed in:** 1a3fa7b (GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- AdaptiveThresholdManager ready for integration with TopicShiftDetector (Plan 06)
- ThresholdStore ready for session lifecycle hooks to save/load threshold state
- All 421 tests pass (392 existing + 29 new), zero regressions

## Self-Check: PASSED

- FOUND: src/intelligence/adaptive-threshold.ts
- FOUND: src/intelligence/__tests__/adaptive-threshold.test.ts
- FOUND: src/storage/threshold-store.ts
- FOUND: src/storage/migrations/008-threshold-history.sql
- FOUND: 50ab454 (test commit)
- FOUND: 1a3fa7b (feat commit)
- FOUND: ThresholdStore export in index.ts
- FOUND: Migration version 8 in migrations.ts

---
*Phase: 06-topic-detection-and-context-stashing*
*Plan: 05*
*Completed: 2026-02-09*
