---
phase: quick-debug-logging
plan: 1
subsystem: infra
tags: [debug, logging, stderr, performance]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "Storage layer modules (database, observations, search, sessions)"
provides:
  - "debug() and debugTimed() logging functions in src/shared/debug.ts"
  - "isDebugEnabled() config detection in src/shared/config.ts"
  - "Debug instrumentation across all 4 storage modules"
affects: [02-mcp-interface, 03-hook-capture, 04-embeddings]

# Tech tracking
tech-stack:
  added: []
  patterns: ["stderr debug logging with category tags and ISO timestamps", "cached isDebugEnabled() for zero-cost no-op path", "debugTimed() wrapper for operation timing"]

key-files:
  created: ["src/shared/debug.ts"]
  modified: ["src/shared/config.ts", "src/storage/database.ts", "src/storage/observations.ts", "src/storage/search.ts", "src/storage/sessions.ts", "src/storage/index.ts"]

key-decisions:
  - "stderr output via process.stderr.write (not console.log) to keep stdout clean for MCP"
  - "Cached boolean flag for zero-cost no-op when debug disabled"
  - "No log file output -- stderr is sufficient for now, log file can be added later"

patterns-established:
  - "debug(category, message, data?) for all debug logging"
  - "debugTimed(category, message, fn) for wrapping operations with timing"
  - "Categories: db, obs, search, session"

# Metrics
duration: 4min
completed: 2026-02-08
---

# Quick Task 1: Debug Logging Infrastructure Summary

**Cross-cutting debug logger with LAMINARK_DEBUG env var control, stderr output with ISO timestamps and category tags, and timing instrumentation across all storage modules**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-08T19:37:16Z
- **Completed:** 2026-02-08T19:40:56Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Created `debug()` and `debugTimed()` functions with cached enable check for zero overhead when disabled
- Added `isDebugEnabled()` to config.ts checking LAMINARK_DEBUG env var then ~/.laminark/config.json
- Instrumented all 4 storage modules (database, observations, search, sessions) with debug calls
- Verified: 840 debug lines across all 4 categories when enabled, zero output when disabled
- All 78 existing tests pass without modification

## Task Commits

Each task was committed atomically:

1. **Task 1: Create debug logger module and update config** - `49db7fb` (feat)
2. **Task 2: Wire debug logging into all storage layer modules** - `69de548` (feat)

## Files Created/Modified
- `src/shared/debug.ts` - Debug logger with `debug()` and `debugTimed()` functions
- `src/shared/config.ts` - Added `isDebugEnabled()` with env var and config.json detection
- `src/storage/index.ts` - Barrel exports for debug, debugTimed, isDebugEnabled
- `src/storage/database.ts` - Debug calls for PRAGMAs, sqlite-vec, open/close events
- `src/storage/observations.ts` - Debug calls for all CRUD operations with IDs and counts
- `src/storage/search.ts` - debugTimed wrapping FTS5 queries, result count logging
- `src/storage/sessions.ts` - Debug calls for create/end lifecycle events

## Decisions Made
- Used `process.stderr.write()` instead of `console.log` to keep stdout clean for MCP protocol
- Cached `isDebugEnabled()` result per-process so disabled path is a single boolean check
- No log file output -- stderr is sufficient; log file can be added in a future iteration if needed

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Debug infrastructure is available for all future phases via import from `src/shared/debug.js`
- Enable with `LAMINARK_DEBUG=1` env var or `{"debug": true}` in `~/.laminark/config.json`

## Self-Check: PASSED

All 7 files verified on disk. Both task commits (49db7fb, 69de548) found in git log.

---
*Plan: quick-1-debug-logging*
*Completed: 2026-02-08*
