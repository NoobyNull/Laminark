---
phase: 14-conversation-routing
plan: 02
subsystem: routing
tags: [pattern-matching, conversation-router, notification-delivery, session-lifecycle, handler-pipeline]

# Dependency graph
requires:
  - phase: 14-conversation-routing
    plan: 01
    provides: "RoutingSuggestion, RoutingConfig, ToolPattern types and heuristic fallback"
  - phase: 12-usage-tracking
    provides: "tool_usage_events table for learned pattern extraction"
  - phase: 10-tool-discovery-registry
    provides: "ToolRegistryRepository and getAvailableForSession() for scope-filtered candidates"
  - phase: 06-topic-detection-and-context-stashing
    provides: "NotificationStore for suggestion delivery"
provides:
  - "Learned pattern extraction from tool_usage_events (extractPatterns, storePrecomputedPatterns)"
  - "Sequence overlap scoring (computeSequenceOverlap, evaluateLearnedPatterns)"
  - "ConversationRouter orchestrating both routing tiers with state management"
  - "PostToolUse routing evaluation step (handler.ts step 9)"
  - "SessionStart pattern pre-computation step (session-lifecycle.ts)"
  - "routing_state and routing_patterns transient SQLite tables"
affects: [context-injection, handler-pipeline, session-lifecycle]

# Tech tracking
tech-stack:
  added: []
  patterns: ["two-tier routing (learned + heuristic)", "transient SQLite tables (inline CREATE TABLE IF NOT EXISTS)", "notification-based suggestion delivery", "per-session routing state persistence"]

key-files:
  created:
    - src/routing/intent-patterns.ts
    - src/routing/conversation-router.ts
  modified:
    - src/hooks/handler.ts
    - src/hooks/session-lifecycle.ts

key-decisions:
  - "ConversationRouter created per-evaluation (no long-lived state) -- handler is short-lived CLI process"
  - "routing_state and routing_patterns tables created inline (no migration) -- transient data refreshed each session"
  - "db parameter added explicitly to processPostToolUseFiltered (Option A from plan) for clean separation"
  - "Learned tier runs first, heuristic fallback only when learned returns null -- progressive takeover model"
  - "Pattern pre-computation at SessionStart guards toolRegistry presence (reuses same condition as config scan)"

patterns-established:
  - "Routing tier cascade: learned first, heuristic fallback, with confidence gate at each level"
  - "Supplementary pipeline step pattern: try/catch wrapper, never blocks core pipeline"
  - "Transient table pattern: CREATE TABLE IF NOT EXISTS + DELETE + INSERT in transaction for data refresh"

# Metrics
duration: 3min
completed: 2026-02-11
---

# Phase 14 Plan 02: Learned Patterns and ConversationRouter Summary

**Two-tier conversation routing with learned pattern matching, ConversationRouter orchestrator, and end-to-end handler/session lifecycle integration via NotificationStore**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-11T06:54:17Z
- **Completed:** 2026-02-11T06:57:29Z
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 2

## Accomplishments
- Implemented learned pattern extraction from tool_usage_events: sliding window, frequency filtering, pre-computed storage
- Created ConversationRouter orchestrating both tiers with rate limiting (max 2/session, 5-call cooldown), confidence gating (0.6 threshold), and notification delivery
- Wired routing into PostToolUse handler (step 9, after observation storage) and SessionStart (pattern pre-computation after config scan)
- All routing code wrapped in try/catch -- supplementary pipeline that never blocks core handler

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement learned pattern extraction and sequence matching** - `0db49db` (feat)
2. **Task 2: Create ConversationRouter and wire into handler/session lifecycle** - `eb2250a` (feat)

## Files Created/Modified
- `src/routing/intent-patterns.ts` - extractPatterns, storePrecomputedPatterns, evaluateLearnedPatterns, computeSequenceOverlap for historical tool sequence pattern matching
- `src/routing/conversation-router.ts` - ConversationRouter class: two-tier routing orchestrator with rate limiting, state management, and NotificationStore delivery
- `src/hooks/handler.ts` - Added db parameter to processPostToolUseFiltered, routing evaluation as step 9 after observation storage, ConversationRouter import
- `src/hooks/session-lifecycle.ts` - Added pattern pre-computation at SessionStart after config scanning, extractPatterns/storePrecomputedPatterns imports

## Decisions Made
- ConversationRouter instantiated per-evaluation rather than long-lived singleton -- matches the short-lived CLI handler process model
- Added `db?: BetterSqlite3.Database` as explicit parameter to processPostToolUseFiltered (plan Option A) rather than extracting from toolRegistry internals
- routing_state and routing_patterns tables created inline with CREATE TABLE IF NOT EXISTS (same pattern as pending_notifications) -- no migration needed for transient data
- Learned tier invoked first with heuristic fallback, matching the progressive takeover design from research
- Pattern pre-computation guarded by `if (toolRegistry)` check, reusing the same condition as config scanning
- Confidence gate applied both within each tier function AND at the router level (belt-and-suspenders)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete conversation routing pipeline operational end-to-end
- Phase 14 fully complete: types, heuristic fallback, learned patterns, ConversationRouter, handler integration, session lifecycle integration
- Ready for Phase 15 (staleness management) or Phase 16 (future enhancements)
- Pre-existing test failures in graph-related tests (query-graph, entity-extractor, curation-agent, summarizer) are unrelated to routing changes

## Self-Check: PASSED

All artifacts verified:
- src/routing/intent-patterns.ts: FOUND
- src/routing/conversation-router.ts: FOUND
- src/routing/types.ts: FOUND
- src/routing/heuristic-fallback.ts: FOUND
- 14-02-SUMMARY.md: FOUND
- Commit 0db49db: FOUND
- Commit eb2250a: FOUND

---
*Phase: 14-conversation-routing*
*Completed: 2026-02-11*
