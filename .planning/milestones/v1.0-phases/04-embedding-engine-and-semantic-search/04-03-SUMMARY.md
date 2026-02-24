---
phase: 04-embedding-engine-and-semantic-search
plan: 03
subsystem: search
tags: [hybrid-search, reciprocal-rank-fusion, rrf, fts5, vec0, worker-lifecycle, background-embedding]

# Dependency graph
requires:
  - phase: 04-embedding-engine-and-semantic-search
    provides: "AnalysisWorker bridge, EmbeddingStore for vec0 operations, worker thread entry point"
provides:
  - "Hybrid search combining FTS5 keyword and vec0 vector results via reciprocal rank fusion"
  - "MCP server worker lifecycle with non-blocking startup and clean shutdown"
  - "Background embedding loop processing unembedded observations every 5 seconds"
  - "recall tool transparent hybrid search with keyword-only fallback"
affects: [04-04, 05-topic-detection, 06-adaptive-topic-detection]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Reciprocal rank fusion (RRF) with k=60 for merging ranked lists", "Background setInterval loop with graceful error handling", "Non-blocking worker.start() during server startup (DQ-04)", "Hybrid/FTS/vector matchType tagging on search results"]

key-files:
  created:
    - src/search/hybrid.ts
  modified:
    - src/index.ts
    - src/mcp/tools/recall.ts
    - src/storage/index.ts

key-decisions:
  - "hybridSearch requires db and projectHash params for ObservationRepository lookups on vector-only results"
  - "Background embedding interval at 5 seconds balances responsiveness with resource usage"
  - "worker.start() fire-and-forget with .catch() -- server starts immediately, worker loads model lazily"

patterns-established:
  - "Hybrid search pattern: keyword always runs, vector attempted if worker ready, RRF merges when both available"
  - "Background embedding pattern: setInterval + processUnembedded() with catch-all error logging"
  - "Graceful degradation chain: no vec support -> no embeddingStore -> keyword-only search"

# Metrics
duration: 2min
completed: 2026-02-09
---

# Phase 4 Plan 3: Hybrid Search and Worker Lifecycle Integration Summary

**Reciprocal rank fusion hybrid search combining FTS5 keyword and vec0 vector results, with non-blocking worker lifecycle and background embedding in the MCP server**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-09T00:16:31Z
- **Completed:** 2026-02-09T00:18:46Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- reciprocalRankFusion() merges ranked lists with standard k=60 smoothing constant
- hybridSearch() combines FTS5 keyword and vec0 vector results, falls back transparently to keyword-only
- MCP server creates AnalysisWorker on startup without blocking (DQ-04), model loads lazily on first embed
- Background loop processes unembedded observations every 5 seconds, updating embedding metadata
- recall tool uses hybrid search when embeddingStore available, keyword-only when not (DQ-03)
- All 245 existing tests pass with zero regressions
- All three entry points build successfully with tsdown

## Task Commits

Each task was committed atomically:

1. **Task 1: Create hybrid search with reciprocal rank fusion** - `cf62347` (feat)
2. **Task 2: Wire worker lifecycle and hybrid search into MCP server** - `17ab2fd` (feat)

## Files Created/Modified
- `src/search/hybrid.ts` - Hybrid search module with reciprocalRankFusion() and hybridSearch()
- `src/index.ts` - MCP server with AnalysisWorker lifecycle, EmbeddingStore, background embedding timer
- `src/mcp/tools/recall.ts` - Updated recall tool using hybrid search when available
- `src/storage/index.ts` - Added EmbeddingStore to barrel exports

## Decisions Made
- hybridSearch takes db and projectHash as params to create ObservationRepository for vector-only results that need full observation data
- Background embedding processes 10 observations per interval (5s) to avoid long-running batches
- Worker startup uses fire-and-forget pattern (non-blocking .catch()) so server responds to MCP requests immediately
- registerRecall uses default parameters (worker=null, embeddingStore=null) for backward compatibility with existing callers

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Hybrid search fully operational when worker thread has loaded the embedding model
- Background embedding automatically processes new observations without user intervention
- Final plan (04-04) can add acceptance tests to verify end-to-end embedding pipeline
- All graceful degradation paths tested through existing test suite (keyword-only when worker unavailable)

## Self-Check: PASSED

All files verified present. All commit hashes verified in git log. All exports and integration points verified.

---
*Phase: 04-embedding-engine-and-semantic-search*
*Completed: 2026-02-09*
