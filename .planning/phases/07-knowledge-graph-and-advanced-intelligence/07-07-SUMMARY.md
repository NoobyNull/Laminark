---
phase: 07-knowledge-graph-and-advanced-intelligence
plan: 07
subsystem: intelligence
tags: [knowledge-graph, curation, observation-merging, deduplication, staleness, pruning, background-agent]

# Dependency graph
requires:
  - phase: 07-knowledge-graph-and-advanced-intelligence
    plan: 03
    provides: "Entity extraction pipeline, extractAndPersist (Plan 03)"
  - phase: 07-knowledge-graph-and-advanced-intelligence
    plan: 04
    provides: "Staleness detection and flagging: detectStaleness, flagStaleObservation, initStalenessSchema (Plan 04)"
  - phase: 07-knowledge-graph-and-advanced-intelligence
    plan: 05
    provides: "Graph constraints: findDuplicateEntities, mergeEntities, enforceMaxDegree, countEdgesForNode (Plan 05)"
provides:
  - "findMergeableClusters() detects near-duplicate observation clusters (cosine >0.95 or Jaccard >0.85)"
  - "mergeObservationCluster() creates consolidated summaries with audit trail and mean embeddings"
  - "pruneLowValue() conservative AND-logic pruning (short AND unlinked AND old AND auto-captured)"
  - "runCuration() standalone 5-step curation cycle (merge, dedup, constraints, staleness, prune)"
  - "CurationAgent class with start/stop lifecycle and configurable interval (default 5min)"
  - "onSessionEnd() and onQuietPeriod() trigger functions for integration"
  - "CurationReport interface documenting all curation actions"
  - "MergeCluster interface for observation similarity clustering"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: ["Cosine similarity with Jaccard text fallback for embedding-less observations", "Greedy clustering requiring all-pairs similarity above threshold", "Five-step isolated curation pipeline with per-step try/catch", "Soft-delete-only curation -- no hard deletes, full audit trails"]

key-files:
  created:
    - src/graph/observation-merger.ts
    - src/graph/curation-agent.ts
    - src/graph/__tests__/curation-agent.test.ts
  modified: []

key-decisions:
  - "Jaccard text similarity threshold 0.85 (lower than cosine 0.95) since text comparison is less precise"
  - "Greedy clustering algorithm: observations checked against all existing cluster members, not just seed"
  - "runCuration is async (Promise<CurationReport>) for future extensibility, though current operations are synchronous"
  - "Staleness sweep checks only recently-updated entities (last 24h) rather than full graph scan"
  - "Test file placed at src/graph/__tests__/curation-agent.test.ts following project convention"

patterns-established:
  - "Observation merger pattern: findMergeableClusters -> mergeObservationCluster per cluster, all in transactions"
  - "Curation agent pattern: 5-step pipeline, each step isolated, per-step error collection, single CurationReport"
  - "Conservative pruning: AND-logic across all criteria (short + unlinked + old + auto-captured)"
  - "Idempotent curation: merged obs soft-deleted, staleness flags checked before adding, dedup resolves completely"

# Metrics
duration: 4min
completed: 2026-02-09
---

# Phase 7 Plan 7: Background Curation Agent Summary

**Background curation agent with observation merging (cosine/Jaccard similarity), entity dedup, staleness sweeps, and conservative low-value pruning -- all soft-delete with audit trails**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-09T05:37:35Z
- **Completed:** 2026-02-09T05:41:35Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- Observation similarity detection using cosine similarity on embeddings (>0.95 threshold) with Jaccard text fallback (>0.85) for observations without embeddings
- Observation merging that creates consolidated summaries preserving all unique information, computes mean embeddings, and soft-deletes originals with full merge metadata audit trail
- Conservative low-value pruning using AND-logic: only prunes observations matching ALL of short (<20 chars), no linked entities, older than 90 days, AND auto-captured (never user-saved)
- Five-step curation agent (merge, dedup, constraints, staleness, prune) with per-step error isolation, idempotency guarantees, and configurable periodic scheduling
- 17 new tests covering observation clustering, merging with soft-delete verification, pruning edge cases, full curation cycle (dedup/staleness/idempotency), error resilience, and agent lifecycle

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement observation similarity detection and merging** - `4946b87` (feat)
2. **Task 2: Implement curation agent with scheduling and orchestration** - `c15d9d4` (feat)

## Files Created/Modified
- `src/graph/observation-merger.ts` - findMergeableClusters (cosine/Jaccard similarity clustering), mergeObservationCluster (transactional merge with audit trail), pruneLowValue (conservative AND-logic pruning), cosineSimilarity/jaccardSimilarity helpers
- `src/graph/curation-agent.ts` - runCuration (standalone 5-step curation function), CurationAgent class (start/stop/runOnce lifecycle), onSessionEnd/onQuietPeriod triggers, CurationReport interface
- `src/graph/__tests__/curation-agent.test.ts` - 17 tests: observation clustering (3), merging (1), pruning (4), curation cycle (5), agent lifecycle (4)

## Decisions Made
- **Jaccard threshold 0.85:** Text-based similarity is less precise than embedding cosine, so a lower threshold captures more near-duplicates that lack embeddings.
- **Greedy clustering:** Each candidate observation must be similar to ALL existing cluster members (not just the seed). This is stricter but prevents false merges in large clusters.
- **Recently-updated staleness scope:** Rather than scanning every entity on every curation run, staleness sweep only checks entities updated in the last 24 hours. This keeps the sweep fast while still catching contradictions promptly.
- **Async runCuration:** Made the curation function async even though current DB operations are synchronous, to support future async operations without breaking the API.
- **Test file convention:** Placed tests at `src/graph/__tests__/curation-agent.test.ts` following project vitest config (`src/**/*.test.ts`).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Curation agent ready for integration into main server lifecycle (start on init, stop on shutdown)
- onSessionEnd() and onQuietPeriod() ready to be called from hook handlers
- Phase 7 (Knowledge Graph and Advanced Intelligence) is now complete: schema, embeddings, extraction, temporal/staleness, relationships/constraints, MCP tools, and curation agent all implemented
- 614 total tests passing (17 new + 597 existing), no regressions

## Self-Check: PASSED

All files verified present, all commit hashes verified in git log.

---
*Phase: 07-knowledge-graph-and-advanced-intelligence*
*Completed: 2026-02-09*
