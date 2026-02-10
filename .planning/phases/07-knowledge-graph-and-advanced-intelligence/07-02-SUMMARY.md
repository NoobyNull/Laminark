---
phase: 07-knowledge-graph-and-advanced-intelligence
plan: 02
subsystem: embeddings
tags: [piggyback, semantic-signals, tfidf, keyword-extraction, hybrid-embeddings, embedding-strategy]

# Dependency graph
requires:
  - phase: 04-embedding-engine-and-semantic-search
    provides: EmbeddingEngine interface, LocalOnnxEngine, KeywordOnlyEngine
provides:
  - PiggybackEngine implementing EmbeddingEngine with ONNX+keyword blending
  - extractSemanticSignals for rule-based text feature extraction
  - createEmbeddingStrategy factory with 3-mode selection (local/piggyback/hybrid)
  - signalCache connecting hook extraction to embedding strategy
affects: [07-knowledge-graph-entity-extraction, 07-analysis-worker-integration, hook-handler-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns: [piggyback-extraction, signal-cache-ttl, vector-blending, strategy-factory]

key-files:
  created:
    - src/hooks/piggyback-extractor.ts
    - src/analysis/engines/piggyback.ts
    - src/analysis/hybrid-selector.ts
    - src/hooks/__tests__/piggyback-extractor.test.ts
    - src/analysis/__tests__/piggyback.test.ts
    - src/analysis/__tests__/hybrid-selector.test.ts
  modified: []

key-decisions:
  - "Files placed in src/analysis/engines/ and src/analysis/ (not src/embeddings/) to match existing codebase structure"
  - "PiggybackEngine implements existing EmbeddingEngine interface (Float32Array|null return type) rather than plan's simpler interface"
  - "Person @mention regex excludes trailing punctuation to prevent false captures like 'sarah.'"
  - "FNV-1a-inspired hash for keyword-to-dimension mapping in sparse vector construction"
  - "LAMINARK_EMBEDDING_MODE env var (not MEMORITE_EMBEDDING_MODE) to match project naming convention"

patterns-established:
  - "Signal cache pattern: Map with TTL-based lazy eviction, max 100 entries"
  - "Vector blending: 70% primary + 30% secondary with re-normalization to unit length"
  - "Strategy factory: createEmbeddingStrategy() returns un-initialized engine, caller manages lifecycle"

# Metrics
duration: 5min
completed: 2026-02-09
---

# Phase 7 Plan 02: Piggyback Embedding Strategy Summary

**Rule-based semantic signal extractor and 3-mode hybrid embedding selector leveraging Claude's response content for zero-latency embedding augmentation**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-09T05:10:51Z
- **Completed:** 2026-02-09T05:16:12Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Rule-based semantic signal extraction from Claude response text in < 10ms (keywords, entities, sentiment, topics)
- PiggybackEngine implementing EmbeddingEngine with 70/30 ONNX/keyword blending and graceful fallback chain
- Hybrid strategy selector with 3 modes (local/piggyback/hybrid) configurable via env var or API
- 50 new tests (14 extractor + 16 piggyback engine + 20 selector), 489 total passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Semantic signal extractor and piggyback embedding engine** - `3b0788a` (feat)
2. **Task 2: Hybrid embedding strategy selector** - `007897e` (feat)

## Files Created/Modified
- `src/hooks/piggyback-extractor.ts` - Rule-based semantic signal extraction: keywords, entities, sentiment, topics
- `src/analysis/engines/piggyback.ts` - PiggybackEngine with signal cache, vector blending, and fallback chain
- `src/analysis/hybrid-selector.ts` - Factory function for 3-mode embedding strategy selection
- `src/hooks/__tests__/piggyback-extractor.test.ts` - 14 tests for signal extraction
- `src/analysis/__tests__/piggyback.test.ts` - 16 tests for piggyback engine and cache TTL
- `src/analysis/__tests__/hybrid-selector.test.ts` - 20 tests for mode selection and env var handling

## Decisions Made
- **File locations:** Placed piggyback engine in `src/analysis/engines/` and selector in `src/analysis/` to match existing codebase structure (plan specified `src/embeddings/` which doesn't exist)
- **Interface compliance:** Implemented existing `EmbeddingEngine` interface (returns `Float32Array | null`) rather than plan's simplified `EmbeddingStrategy` interface
- **Env var naming:** Used `LAMINARK_EMBEDDING_MODE` (not `MEMORITE_EMBEDDING_MODE`) to match project naming convention
- **Person regex:** Narrowed `@mention` regex to exclude trailing punctuation (`.`, `,`) preventing false entity captures
- **Hash function:** FNV-1a-inspired hash for deterministic keyword-to-dimension mapping in sparse vectors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] File paths adapted to existing codebase structure**
- **Found during:** Task 1 (pre-execution analysis)
- **Issue:** Plan specified `src/embeddings/piggyback-strategy.ts` and `src/embeddings/hybrid-selector.ts`, but embedding infrastructure lives in `src/analysis/engines/` and `src/analysis/`
- **Fix:** Created files at `src/analysis/engines/piggyback.ts` and `src/analysis/hybrid-selector.ts` to match existing pattern
- **Verification:** TypeScript compilation passes, imports resolve correctly
- **Committed in:** 3b0788a, 007897e

**2. [Rule 3 - Blocking] Interface adapted to existing EmbeddingEngine (not plan's EmbeddingStrategy)**
- **Found during:** Task 1 (pre-execution analysis)
- **Issue:** Plan defined `EmbeddingStrategy` interface with `embed(): Promise<number[]>`, but project uses `EmbeddingEngine` with `embed(): Promise<Float32Array | null>` plus `initialize()`, `isReady()`, `name()` methods
- **Fix:** Implemented `EmbeddingEngine` interface exactly as defined in `src/analysis/embedder.ts`
- **Verification:** All engines implement all 6 interface methods, confirmed by tests
- **Committed in:** 3b0788a

**3. [Rule 1 - Bug] Fixed person @mention regex capturing trailing punctuation**
- **Found during:** Task 1 (test execution)
- **Issue:** Regex `/@([\w.-]+)/g` captured `sarah.` instead of `sarah` from `@sarah.`
- **Fix:** Changed to `/@([\w][\w-]*[\w]|[\w])/g` to exclude trailing dots/periods
- **Verification:** Person detection test passes with correct name extraction
- **Committed in:** 3b0788a

**4. [Rule 3 - Blocking] Fixed Map iteration for ES2024 target**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** `for...of` on Map entries required `--downlevelIteration` flag
- **Fix:** Used `Array.from(signalCache.keys())` pattern instead of direct Map iteration
- **Verification:** `npx tsc --noEmit --skipLibCheck` passes cleanly
- **Committed in:** 3b0788a

---

**Total deviations:** 4 auto-fixed (2 blocking, 1 bug, 1 blocking)
**Impact on plan:** All auto-fixes necessary for integration with existing codebase. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Piggyback embedding infrastructure ready for hook wiring (connecting extractSemanticSignals to PostToolUse handler)
- Signal cache provides integration point between hook layer and embedding layer
- Hybrid selector ready for analysis worker integration (replacing direct createEmbeddingEngine calls)
- Entity extraction from semantic signals provides foundation for knowledge graph entity nodes

## Self-Check: PASSED

All 6 created files verified on disk. Both task commits (3b0788a, 007897e) verified in git log. All 489 tests passing (50 new).

---
*Phase: 07-knowledge-graph-and-advanced-intelligence*
*Completed: 2026-02-09*
