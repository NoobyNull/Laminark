---
phase: 06-topic-detection-and-context-stashing
plan: 06
subsystem: intelligence
tags: [topic-detection, configuration, sensitivity, decision-logging, observability]

# Dependency graph
requires:
  - phase: 06-03
    provides: "TopicShiftHandler orchestrating detector + stash manager"
  - phase: 06-05
    provides: "AdaptiveThresholdManager with EWMA distance/variance computation"
provides:
  - "TopicDetectionConfig with sensitivity presets (sensitive/balanced/relaxed)"
  - "TopicShiftDecisionLogger for debugging and threshold tuning"
  - "Migration 009: shift_decisions table for decision logging"
  - "Full pipeline integration: config -> detect -> adapt -> log -> stash"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [sensitivity-preset-pattern, decision-logging-pattern, optional-dependency-injection]

key-files:
  created:
    - src/config/topic-detection-config.ts
    - src/intelligence/decision-logger.ts
    - src/intelligence/__tests__/decision-logger.test.ts
    - src/storage/migrations/009-decision-log.sql
  modified:
    - src/hooks/topic-shift-handler.ts
    - src/storage/migrations.ts

key-decisions:
  - "Migration numbered 009 (not 008 as plan stated) because 008 was already taken by threshold_history"
  - "Optional dependency pattern: config, decisionLogger, adaptiveManager are all optional in TopicShiftHandlerDeps for backward compatibility"
  - "Decision logger uses randomBytes(16).toString('hex') for IDs matching project-wide pattern"

patterns-established:
  - "Optional dependency injection: handler works with or without optional deps for simpler test setups"
  - "Decision logging: every detection decision captured for debugging regardless of outcome"
  - "Sensitivity presets: named presets map to numeric multipliers via pure function"

# Metrics
duration: 5min
completed: 2026-02-09
---

# Phase 6 Plan 6: Sensitivity Configuration and Decision Logging Summary

**User-configurable sensitivity dial (sensitive/balanced/relaxed presets) with comprehensive decision logging for all topic shift decisions**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-09T03:11:38Z
- **Completed:** 2026-02-09T03:17:00Z
- **Tasks:** 3
- **Files created:** 4
- **Files modified:** 2

## Accomplishments
- TopicDetectionConfig with three sensitivity presets, manual threshold override, and enable/disable toggle
- TopicShiftDecisionLogger persisting every detection decision with full context (distance, threshold, EWMA state, confidence)
- TopicShiftHandler wired with full pipeline: config check -> detect -> adaptive update -> decision log -> stash -> notify
- 10 new decision logger tests, all 431 tests passing (10 existing handler tests unchanged)

## Task Commits

Each task was committed atomically:

1. **Task 1: Topic detection configuration with sensitivity presets** - `4ecf9f4` (feat) - config module
2. **Task 2: Decision logger with database persistence** - `e363495` (feat) - logger + migration + 10 tests
3. **Task 3: Wire config and logging into TopicShiftHandler** - `dc391c2` (feat) - handler integration

## Files Created/Modified
- `src/config/topic-detection-config.ts` - TopicDetectionConfig interface, sensitivity presets, loadTopicDetectionConfig, applyConfig
- `src/intelligence/decision-logger.ts` - TopicShiftDecisionLogger class with log/getSessionDecisions/getShiftRate
- `src/intelligence/__tests__/decision-logger.test.ts` - 10 tests covering persistence, ordering, shift rate, project scoping
- `src/storage/migrations/009-decision-log.sql` - Reference SQL for shift_decisions table
- `src/storage/migrations.ts` - Added migration version 9 (create_shift_decisions)
- `src/hooks/topic-shift-handler.ts` - Integrated optional config, decisionLogger, adaptiveManager dependencies

## Decisions Made
- Migration numbered 009 instead of 008: Plan specified 008-decision-log.sql but version 8 was already used by threshold_history (06-05). Used 009 to avoid conflict.
- Optional dependency injection pattern for TopicShiftHandlerDeps: config, decisionLogger, and adaptiveManager are all optional, allowing existing Plan 03 tests to pass unchanged without mocking new dependencies.
- Decision logger generates IDs via randomBytes(16).toString('hex'), consistent with ObservationRepository and StashManager patterns throughout the project.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migration version conflict: 008 already taken**
- **Found during:** Task 2 (Decision logger implementation)
- **Issue:** Plan specified migration `008-decision-log.sql` but version 8 was already used by `create_threshold_history` (06-05)
- **Fix:** Used migration version 9 (`009-decision-log.sql`) instead
- **Files modified:** src/storage/migrations.ts, src/storage/migrations/009-decision-log.sql
- **Verification:** All 431 tests pass, migration applies correctly after version 8
- **Committed in:** e363495 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary correction for migration version uniqueness. No scope creep.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 6 complete: all 6 plans executed
- Full topic detection pipeline operational: config -> detect -> adapt -> log -> stash -> notify
- 431 total tests passing, zero regressions across the phase
- Ready for Phase 7 (Knowledge Graph) which builds on the observation and embedding infrastructure

## Self-Check: PASSED

- FOUND: src/config/topic-detection-config.ts
- FOUND: src/intelligence/decision-logger.ts
- FOUND: src/intelligence/__tests__/decision-logger.test.ts
- FOUND: src/storage/migrations/009-decision-log.sql
- FOUND: 4ecf9f4 (Task 1 commit)
- FOUND: e363495 (Task 2 commit)
- FOUND: dc391c2 (Task 3 commit)

---
*Phase: 06-topic-detection-and-context-stashing*
*Plan: 06*
*Completed: 2026-02-09*
