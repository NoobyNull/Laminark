---
phase: 04-embedding-engine-and-semantic-search
plan: 01
subsystem: analysis
tags: [embeddings, onnx, huggingface, bge, vec0, cosine-similarity]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "Migration infrastructure and vec0 table (migration 004)"
provides:
  - "EmbeddingEngine interface -- pluggable abstraction for all embedding consumers"
  - "LocalOnnxEngine -- BGE Small EN v1.5 q8 via @huggingface/transformers"
  - "KeywordOnlyEngine -- null fallback for graceful degradation"
  - "createEmbeddingEngine() factory with automatic fallback"
  - "Migration 006 -- vec0 table with cosine distance metric"
affects: [04-02, 04-03, 04-04, 05-topic-detection]

# Tech tracking
tech-stack:
  added: ["@huggingface/transformers ^3.8.1"]
  patterns: ["Dynamic import() for lazy model loading (DQ-04)", "Null-object pattern for graceful degradation (DQ-03)", "Engine factory with automatic fallback"]

key-files:
  created:
    - src/analysis/embedder.ts
    - src/analysis/engines/local-onnx.ts
    - src/analysis/engines/keyword-only.ts
  modified:
    - src/storage/migrations.ts
    - package.json

key-decisions:
  - "Float32Array.from(output.data) instead of new Float32Array(output.data) for ONNX pipeline output compatibility"
  - "Cosine distance metric for vec0 table -- correct for normalized BGE embeddings"

patterns-established:
  - "EmbeddingEngine interface: all consumers depend on interface, never concrete engines"
  - "Engine factory pattern: createEmbeddingEngine() tries best engine, falls back gracefully"
  - "Never-throw contract: all engine methods return null/false on failure"

# Metrics
duration: 3min
completed: 2026-02-09
---

# Phase 4 Plan 1: Embedding Engine Foundation Summary

**Pluggable EmbeddingEngine interface with BGE Small EN v1.5 q8 ONNX engine, keyword-only fallback, and cosine distance vec0 migration**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-09T00:06:04Z
- **Completed:** 2026-02-09T00:08:42Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- EmbeddingEngine interface with 6 methods (embed, embedBatch, dimensions, name, initialize, isReady)
- LocalOnnxEngine loads BGE Small EN v1.5 quantized q8 via dynamic import() for zero startup cost
- KeywordOnlyEngine provides silent null-object fallback for environments without ONNX runtime
- Migration 006 recreates observation_embeddings with distance_metric=cosine for correct similarity ranking
- All 245 existing tests pass with zero regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create EmbeddingEngine interface and two implementations** - `5a280ae` (feat)
2. **Task 2: Add migration 006 for cosine distance vec0 table** - `8e01e6c` (feat)

## Files Created/Modified
- `src/analysis/embedder.ts` - EmbeddingEngine interface and createEmbeddingEngine() factory
- `src/analysis/engines/local-onnx.ts` - BGE Small EN v1.5 q8 engine with dynamic import()
- `src/analysis/engines/keyword-only.ts` - Null fallback engine returning null/false for everything
- `src/storage/migrations.ts` - Migration 006 (drop + recreate vec0 with cosine distance)
- `package.json` - Added @huggingface/transformers dependency

## Decisions Made
- Used `Float32Array.from(output.data)` instead of `new Float32Array(output.data as ArrayBuffer)` because the ONNX pipeline returns ArrayLike<number>, not ArrayBuffer
- Cosine distance metric chosen for vec0 table because BGE embeddings are normalized, making cosine the correct similarity measure

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Float32Array construction from pipeline output**
- **Found during:** Task 1 (LocalOnnxEngine embed method)
- **Issue:** Plan specified `new Float32Array(output.data)` but `output.data` from the HF pipeline is `ArrayLike<number>`, not `ArrayBuffer` -- TypeScript compiler rejected the cast
- **Fix:** Changed to `Float32Array.from(output.data)` which correctly handles ArrayLike<number>
- **Files modified:** src/analysis/engines/local-onnx.ts
- **Verification:** `npx tsc --noEmit` passes
- **Committed in:** 5a280ae (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Type-safe fix, no scope change. Plan's intent preserved exactly.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- EmbeddingEngine interface ready for worker bridge (04-02) to consume
- LocalOnnxEngine ready for integration testing with actual model download
- Migration 006 ready to apply when database initializes with sqlite-vec
- KeywordOnlyEngine ensures graceful degradation if ONNX unavailable

## Self-Check: PASSED

All files verified present. All commit hashes verified in git log.

---
*Phase: 04-embedding-engine-and-semantic-search*
*Completed: 2026-02-09*
