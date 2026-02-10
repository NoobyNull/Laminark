---
phase: 06-topic-detection-and-context-stashing
plan: 07
subsystem: intelligence
tags: [topic-detection, notifications, mcp-tools, integration-wiring, context-stashing]

# Dependency graph
requires:
  - phase: 06-01
    provides: TopicShiftDetector with cosine distance detection
  - phase: 06-02
    provides: StashManager for context stash CRUD
  - phase: 06-03
    provides: TopicShiftHandler integration layer
  - phase: 06-05
    provides: AdaptiveThresholdManager and ThresholdStore
  - phase: 06-06
    provides: TopicDetectionConfig, TopicShiftDecisionLogger
provides:
  - TopicShiftHandler wired into MCP server background embedding loop
  - NotificationStore for pending topic shift notifications
  - Notification delivery piggybacked on MCP tool responses
  - Integration tests proving SC1 (auto stash) and SC2 (notification delivery)
affects: [07-knowledge-graph, 08-visualization]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Notification piggybacking: consume-on-read pattern for delivering async notifications via next MCP tool response"
    - "Transient table via CREATE TABLE IF NOT EXISTS in constructor (no migration needed for queues)"
    - "Non-fatal try/catch wrapper around topic detection in embedding loop"

key-files:
  created:
    - src/storage/notifications.ts
    - src/hooks/__tests__/topic-shift-integration.test.ts
  modified:
    - src/index.ts
    - src/mcp/tools/recall.ts
    - src/mcp/tools/topic-context.ts
    - src/mcp/tools/save-memory.ts

key-decisions:
  - "NotificationStore uses CREATE TABLE IF NOT EXISTS inline rather than numbered migration -- transient queue, not core data"
  - "Notification delivery via MCP tool response piggybacking -- no polling, no separate endpoints"
  - "Topic detection errors wrapped in try/catch to never crash the background embedding loop"
  - "Integration tests placed in src/hooks/__tests__/ following project convention (no root tests/ directory)"

patterns-established:
  - "Consume-on-read notification pattern: add() stores, consumePending() returns and deletes atomically"
  - "Notification format: [Laminark] prefix for all piggybacked messages"
  - "prependNotifications helper for wrapping MCP tool responses with pending notifications"

# Metrics
duration: 5min
completed: 2026-02-09
---

# Phase 6 Plan 7: Topic Detection Wiring and Notification Delivery Summary

**TopicShiftHandler wired into MCP server embedding loop with NotificationStore consume-on-read delivery piggybacked on tool responses**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-09T04:46:13Z
- **Completed:** 2026-02-09T04:51:24Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- TopicShiftHandler fully wired into processUnembedded() loop with all 6 dependencies (detector, stashManager, obsRepo, config, decisionLogger, adaptiveManager)
- NotificationStore created with add/consumePending lifecycle for async notification delivery
- All 3 MCP tools (recall, topic-context, save-memory) consume and prepend pending notifications to responses
- 8 integration tests proving SC1 (stash creation on topic shift) and SC2 (notification stored and delivered)
- Zero regressions: 431 existing tests + 8 new = 439 total, all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire TopicShiftHandler into MCP server embedding loop and add notification store** - `94ecaaf` (feat)
2. **Task 2: Piggyback notifications on MCP tool responses and add integration tests** - `06f3a23` (feat)

## Files Created/Modified
- `src/storage/notifications.ts` - NotificationStore with add/consumePending lifecycle (transient queue with CREATE TABLE IF NOT EXISTS)
- `src/index.ts` - TopicShiftHandler instantiated with all dependencies, called after each embedding in processUnembedded() loop
- `src/mcp/tools/recall.ts` - Accepts notificationStore, prepends pending notifications to all responses
- `src/mcp/tools/topic-context.ts` - Accepts notificationStore, prepends pending notifications to all responses
- `src/mcp/tools/save-memory.ts` - Accepts notificationStore, prepends pending notifications to responses
- `src/hooks/__tests__/topic-shift-integration.test.ts` - 8 integration tests covering SC1, SC2, full pipeline, and graceful degradation

## Decisions Made
- NotificationStore uses inline CREATE TABLE IF NOT EXISTS rather than numbered migration to avoid migration numbering conflicts for what is a simple transient queue
- Notification delivery uses consume-on-read pattern piggybacked on MCP tool responses (no polling, no separate endpoints, no data loss)
- Topic detection errors are caught and logged but never crash the embedding loop (non-fatal wrapper)
- Integration tests placed in src/hooks/__tests__/ following existing project convention rather than plan's suggested tests/integration/ path

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test assertion for decision ordering**
- **Found during:** Task 2 (integration tests)
- **Issue:** Decision logger returns decisions ORDER BY created_at DESC, but both test decisions share the same timestamp, causing non-deterministic ordering
- **Fix:** Changed assertion from checking specific index order to counting shifted vs not-shifted decisions
- **Files modified:** src/hooks/__tests__/topic-shift-integration.test.ts
- **Verification:** Test passes consistently
- **Committed in:** 06f3a23 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix in test assertion)
**Impact on plan:** Minor test fix, no scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 6 (Topic Detection and Context Stashing) is now fully complete with all success criteria closed
- SC1: Automatic topic detection triggers stash creation after each embedding is generated
- SC2: Notifications delivered piggybacked on the next MCP tool response Claude makes
- Ready for Phase 7 (Knowledge Graph)
- Topic detection data flow is end-to-end: observation -> hook capture -> embedding generation -> topic shift detection -> stash creation -> notification stored -> MCP tool response delivers notification

## Self-Check: PASSED

All 6 created/modified files verified present on disk. Both task commits (94ecaaf, 06f3a23) verified in git history.

---
*Phase: 06-topic-detection-and-context-stashing*
*Completed: 2026-02-09*
