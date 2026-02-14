---
phase: 20-intelligence-and-mcp-tools
plan: 03
subsystem: intelligence
tags: [jaccard-similarity, path-recall, cross-session, debug-paths, hooks]

# Dependency graph
requires:
  - phase: 19-path-detection-and-storage
    provides: "PathTracker, PathRepository, debug_paths/path_waypoints schema"
  - phase: 20-intelligence-and-mcp-tools
    provides: "KISS summary agent, PathRepository.updateKissSummary"
provides:
  - "Proactive path recall via Jaccard similarity matching (findSimilarPaths)"
  - "Cross-session debug path linking via SessionStart hook"
  - "Auto-abandonment of stale paths (>24h)"
  - "PathRepository.findRecentActivePath() and listPathsByStatus()"
affects: [mcp-tools, debug-resolution-ui, future-path-intelligence]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Proactive context injection via similarity matching", "Cross-session state linking via hook lifecycle"]

key-files:
  created: [src/paths/path-recall.ts]
  modified: [src/hooks/pre-tool-context.ts, src/hooks/session-lifecycle.ts, src/hooks/handler.ts, src/paths/path-repository.ts]

key-decisions:
  - "Jaccard similarity threshold 0.25 for path recall (balances recall vs noise on short text)"
  - "Path recall capped at 2 results in PreToolUse to stay within context budget"
  - "findRecentActivePath uses 24h window query (not getActivePath) for cross-session safety"

patterns-established:
  - "Optional PathRepository parameter pattern: hooks accept pathRepo? for graceful degradation"
  - "initPathSchema called in hook handler for table existence guarantee in ephemeral subprocesses"

# Metrics
duration: 3min
completed: 2026-02-14
---

# Phase 20 Plan 03: Path Recall and Cross-Session Linking Summary

**Proactive path recall via Jaccard similarity matching on past resolved debug paths, with cross-session path continuation and stale path auto-abandonment in SessionStart**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-14T23:12:45Z
- **Completed:** 2026-02-14T23:15:57Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- Created path-recall module that finds similar past resolved debug paths via Jaccard similarity on trigger and resolution summaries
- PreToolUse hook now surfaces "you've seen this before" context with KISS summaries during active debugging
- SessionStart detects active paths from prior sessions and notifies developer with waypoint count and last activity
- Stale paths (>24h) auto-abandoned on session start to prevent lingering zombie paths
- PathRepository extended with findRecentActivePath() and listPathsByStatus() for cross-session queries

## Task Commits

Each task was committed atomically:

1. **Task 1: Create path recall module and wire into PreToolUse hook** - `6f4fc70` (feat)
2. **Task 2: Cross-session path linking via SessionStart** - `1b1ec38` (feat)
3. **Task 3: Wire pathRepo into hook handler entry point** - `26c9f5a` (feat)

## Files Created/Modified
- `src/paths/path-recall.ts` - Jaccard similarity matching for past resolved paths with KISS summary parsing
- `src/hooks/pre-tool-context.ts` - Added path recall section that surfaces similar past paths during debugging
- `src/hooks/session-lifecycle.ts` - Cross-session path detection, auto-abandonment of stale paths
- `src/hooks/handler.ts` - PathRepository construction and wiring to PreToolUse and SessionStart handlers
- `src/paths/path-repository.ts` - Added findRecentActivePath(), listPathsByStatus() with prepared statements

## Decisions Made
- Jaccard threshold 0.25 chosen as reasonable for short-text similarity (trigger/resolution summaries are typically 1-2 sentences)
- Path recall limited to 2 results in PreToolUse to respect the hook's context budget (~500-600 chars)
- initPathSchema called in hook handler to guarantee table existence in ephemeral subprocess context
- findRecentActivePath uses a dedicated 24h window query rather than reusing getActivePath for explicit staleness boundary

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All Phase 20 plans complete: KISS summary agent, MCP tools, path recall, and cross-session linking
- Debug resolution paths feature fully implemented end-to-end
- Ready for Phase 21 (if applicable) or milestone completion

## Self-Check: PASSED

All files verified present. All commit hashes verified in git log.

---
*Phase: 20-intelligence-and-mcp-tools*
*Completed: 2026-02-14*
