---
phase: 14-conversation-routing
plan: 01
subsystem: routing
tags: [keyword-matching, heuristic, cold-start, tool-suggestion, types]

# Dependency graph
requires:
  - phase: 10-tool-discovery-registry
    provides: "ToolRegistryRow type for tool metadata"
provides:
  - "RoutingSuggestion, RoutingConfig, RoutingState, ToolPattern interfaces"
  - "DEFAULT_ROUTING_CONFIG constant with tuned defaults"
  - "extractKeywords, extractToolKeywords, evaluateHeuristic pure functions"
affects: [14-02-conversation-router, routing, context-injection]

# Tech tracking
tech-stack:
  added: []
  patterns: ["pure-function routing tier", "keyword overlap scoring", "stop word filtering"]

key-files:
  created:
    - src/routing/types.ts
    - src/routing/heuristic-fallback.ts
  modified: []

key-decisions:
  - "Heuristic functions are pure (no DB dependency) -- accept pre-fetched data for testability"
  - "Stop word set covers 50 common English function words for keyword extraction"
  - "Confidence scored as matchCount/toolKeywords.length (Jaccard-like overlap on tool side)"

patterns-established:
  - "Routing tier pattern: each tier is a pure function returning RoutingSuggestion | null"
  - "Tool keyword extraction: description + server_name + parsed command/skill name"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 14 Plan 01: Routing Types and Heuristic Fallback Summary

**Keyword-based cold-start routing types and heuristic fallback algorithm for tool suggestions with zero usage history**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T06:50:27Z
- **Completed:** 2026-02-11T06:52:05Z
- **Tasks:** 2
- **Files created:** 2

## Accomplishments
- Established routing type contracts (RoutingSuggestion, RoutingConfig, RoutingState, ToolPattern) used by both routing tiers
- Implemented pure heuristic fallback algorithm that matches recent observation keywords against tool descriptions/names
- DEFAULT_ROUTING_CONFIG tuned to avoid over-suggestion: 0.6 confidence threshold, max 2 per session, 5-call cooldown

## Task Commits

Each task was committed atomically:

1. **Task 1: Create routing types and configuration defaults** - `66dd1bd` (feat)
2. **Task 2: Implement heuristic fallback keyword matching** - `d969676` (feat)

## Files Created/Modified
- `src/routing/types.ts` - RoutingSuggestion, RoutingConfig, RoutingState, ToolPattern interfaces and DEFAULT_ROUTING_CONFIG constant
- `src/routing/heuristic-fallback.ts` - extractKeywords, extractToolKeywords, evaluateHeuristic pure functions for cold-start tool matching

## Decisions Made
- Heuristic functions are pure (no DB imports) -- accept pre-fetched observation strings and tool rows for testability and separation of concerns
- Stop word set includes 50 common English function words based on research specification
- Confidence scored as keyword match count divided by total tool keywords (tool-side Jaccard), not observation-side, to avoid penalizing tools with fewer keywords
- Early return when fewer than 2 observations (too early to judge intent)
- Added contextKeywords.size === 0 guard to avoid unnecessary iteration when observations contain only stop words

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Routing types ready for ConversationRouter class in plan 14-02
- Heuristic fallback ready to be called from the router's evaluation pipeline
- ToolPattern interface ready for learned pattern tier in plan 14-02

## Self-Check: PASSED

All artifacts verified:
- src/routing/types.ts: FOUND
- src/routing/heuristic-fallback.ts: FOUND
- 14-01-SUMMARY.md: FOUND
- Commit 66dd1bd: FOUND
- Commit d969676: FOUND

---
*Phase: 14-conversation-routing*
*Completed: 2026-02-11*
