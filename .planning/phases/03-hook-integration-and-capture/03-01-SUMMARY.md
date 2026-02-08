---
phase: 03-hook-integration-and-capture
plan: 01
subsystem: hooks
tags: [claude-code-hooks, stdin, sqlite-wal, observation-capture, session-lifecycle, tsdown]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "openDatabase, ObservationRepository, SessionRepository, getProjectHash, getDatabaseConfig, debug"
provides:
  - "Hook handler entry point (dist/hooks/handler.js) reading stdin JSON and dispatching by event type"
  - "Semantic observation extraction from PostToolUse events per tool type"
  - "Session lifecycle handlers (start/end) writing directly to SQLite"
  - "Self-referential capture filtering (mcp__laminark__ prefix skip)"
  - "Dual tsdown entry points (MCP server + hook handler)"
  - "laminark-hook bin entry in package.json"
affects: [03-02-admission-privacy-filters, 03-03-hook-tests, 05-session-context]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Direct SQLite write from hook process (no HTTP intermediary)", "Stdin JSON parsing with async iteration", "Dual entry point build with tsdown"]

key-files:
  created:
    - src/hooks/handler.ts
    - src/hooks/capture.ts
    - src/hooks/session-lifecycle.ts
    - src/hooks/index.ts
    - src/hooks/__tests__/capture.test.ts
    - src/hooks/__tests__/session-lifecycle.test.ts
  modified:
    - tsdown.config.ts
    - package.json

key-decisions:
  - "Stop events log only (no observation) -- Stop has no tool_name/tool_input per hook spec"
  - "processPostToolUse is synchronous (not async) since all DB operations are synchronous via better-sqlite3"
  - "Capture and session-lifecycle fully implemented in Task 1 alongside handler (needed for build resolution)"

patterns-established:
  - "Hook handler pattern: read stdin, parse JSON, dispatch by hook_event_name, exit 0 always"
  - "Observation source format: 'hook:{tool_name}' for provenance tracking"
  - "Self-referential filter: skip tools with mcp__laminark__ prefix"

# Metrics
duration: 3min
completed: 2026-02-08
---

# Phase 3 Plan 1: Hook Handler and Capture Pipeline Summary

**Hook handler entry point with stdin JSON dispatch, semantic observation extraction per tool type, and session lifecycle handlers writing directly to SQLite via WAL concurrent access**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-08T22:43:53Z
- **Completed:** 2026-02-08T22:47:30Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Hook handler reads stdin JSON from Claude Code hook invocations and dispatches to correct handler based on hook_event_name
- Semantic observation extraction for Write, Edit, Bash, Read, Glob, Grep, and MCP tools with truncation
- Self-referential mcp__laminark__ tools filtered out to prevent recursive capture
- Session lifecycle handlers create and close session records
- Dual tsdown entry points produce dist/index.js (MCP server) and dist/hooks/handler.js (hook handler)
- 28 new tests (22 capture + 6 session lifecycle) all passing with real database integration

## Task Commits

Each task was committed atomically:

1. **Task 1: Create hook handler entry point with build configuration** - `bfc5fd0` (feat)
2. **Task 2: Create capture module and session lifecycle handlers with tests** - `6ad77ac` (test)

## Files Created/Modified
- `src/hooks/handler.ts` - Hook entry point: stdin parsing, database open, event dispatch, exit 0 guarantee
- `src/hooks/capture.ts` - PostToolUse observation extraction with semantic summaries per tool type
- `src/hooks/session-lifecycle.ts` - SessionStart/SessionEnd handlers using SessionRepository
- `src/hooks/index.ts` - Barrel export for hooks module
- `src/hooks/__tests__/capture.test.ts` - 22 tests: extractObservation, truncation, processPostToolUse integration
- `src/hooks/__tests__/session-lifecycle.test.ts` - 6 tests: start, end, missing fields, full lifecycle
- `tsdown.config.ts` - Dual entry points: src/index.ts + src/hooks/handler.ts
- `package.json` - Added laminark-hook bin entry pointing to dist/hooks/handler.js

## Decisions Made
- Stop events are logged only (no observation created) because Stop hooks have no tool_name/tool_input/tool_response fields per the official hook specification
- processPostToolUse is synchronous (not async as shown in research pattern) because better-sqlite3 is inherently synchronous -- no awaits needed
- Capture and session-lifecycle modules were fully implemented in Task 1 alongside the handler (rather than as stubs) because tsdown needs real exports to resolve imports at build time

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Hook handler pipeline is complete and ready for Plan 02 (admission/privacy filters)
- Filters will be wired into processPostToolUse before the obsRepo.create() call
- Session lifecycle handlers are ready for Phase 5 context injection enhancement

## Self-Check: PASSED

All 7 created files verified present. Both task commits (bfc5fd0, 6ad77ac) verified in git log.

---
*Phase: 03-hook-integration-and-capture*
*Completed: 2026-02-08*
