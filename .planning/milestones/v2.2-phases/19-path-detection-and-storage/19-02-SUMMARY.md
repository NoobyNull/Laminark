---
phase: 19-path-detection-and-storage
plan: 02
subsystem: intelligence
tags: [haiku, classifier, debug-signals, zod]

requires:
  - phase: 17-haiku-intelligence
    provides: "Haiku classifier agent and client infrastructure"
provides:
  - "DebugSignal type exported from haiku-classifier-agent.ts"
  - "debug_signal field in ClassificationResult (is_error, is_resolution, waypoint_hint, confidence)"
  - "Extended SYSTEM_PROMPT with debug signal classification instructions"
affects: [19-path-detection-and-storage]

tech-stack:
  added: []
  patterns: ["Piggyback detection on existing LLM call via extended prompt"]

key-files:
  created: []
  modified:
    - src/intelligence/haiku-classifier-agent.ts

key-decisions:
  - "Used Zod .default(null) for backward compatibility when Haiku omits debug_signal"
  - "debug_signal evaluated for both noise and signal observations (build failures are noise but debug-relevant)"

patterns-established:
  - "Extend existing Haiku prompt rather than adding new API calls"

duration: 1min
completed: 2026-02-14
---

# Phase 19 Plan 02: Haiku Debug Signal Detection Summary

**Extended Haiku classifier to detect debug signals (error/resolution/waypoint) in the same API call as noise/signal classification**

## Performance

- **Duration:** 1 min
- **Started:** 2026-02-14T22:16:13Z
- **Completed:** 2026-02-14T22:17:27Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added DebugSignalSchema with is_error, is_resolution, waypoint_hint, and confidence fields
- Extended SYSTEM_PROMPT with debug signal classification instructions alongside existing noise/signal logic
- Exported DebugSignal type for PathTracker consumption in Plan 03
- Backward-compatible via Zod .default(null) -- handles missing debug_signal from Haiku gracefully

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend classifier prompt and schema for debug signals** - `9636c5b` (feat)

**Plan metadata:** `7d768b0` (docs: complete plan)

## Files Created/Modified
- `src/intelligence/haiku-classifier-agent.ts` - Extended with DebugSignalSchema, DebugSignal type, and debug signal detection in SYSTEM_PROMPT

## Decisions Made
- Used Zod `.default(null)` on debug_signal schema field for backward compatibility -- if Haiku response omits the field, it defaults to null rather than throwing a parse error
- debug_signal is evaluated for both noise and signal observations -- build failure output is classified as "noise" but can still carry debug_signal data (e.g., is_error: true)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- DebugSignal type and ClassificationResult.debug_signal field ready for PathTracker state machine in Plan 03
- Single Haiku call preserved -- no API volume impact

---
*Phase: 19-path-detection-and-storage*
*Completed: 2026-02-14*
