---
phase: 04-embedding-engine-and-semantic-search
verified: 2026-02-08T16:30:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 04: Embedding Engine and Semantic Search Verification Report

**Phase Goal:** Observations gain semantic meaning through vector embeddings enabling "search by concept" alongside keyword search

**Verified:** 2026-02-08T16:30:00Z

**Status:** passed

**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can search by concept (e.g., "authentication decisions") and find observations that match semantically even without exact keyword overlap | ✓ VERIFIED | hybridSearch() in src/search/hybrid.ts combines FTS5 keyword and vec0 vector results using reciprocal rank fusion. EmbeddingStore.search() performs project-scoped KNN queries with cosine distance. recall tool uses hybridSearch when embeddingStore is available (src/mcp/tools/recall.ts:208). |
| 2 | Hybrid search combines keyword and semantic scores, returning better results than either alone | ✓ VERIFIED | reciprocalRankFusion() implemented in src/search/hybrid.ts with k=60 standard RRF algorithm. hybridSearch() merges FTS5 and vec0 results with matchType tagging (hybrid/fts/vector). SC-2 tests verify fusion correctness (17 tests in src/search/__tests__/hybrid.test.ts). |
| 3 | Embedding generation happens in a worker thread and never blocks MCP tool responses or slows Claude's output | ✓ VERIFIED | Worker thread entry point (src/analysis/worker.ts) runs createEmbeddingEngine() in separate thread. AnalysisWorker bridge (src/analysis/worker-bridge.ts) provides Promise-based embed() API with zero-copy Float32Array transfer. MCP server (src/index.ts:28) creates worker and processes unembedded observations every 5s in background (line 68). SC-3 tests verify non-blocking Promise API. |
| 4 | If the ONNX model is unavailable (missing file, load failure), the system silently falls back to keyword-only search with no errors | ✓ VERIFIED | KeywordOnlyEngine (src/analysis/engines/keyword-only.ts) returns null for all embed operations. createEmbeddingEngine() factory tries LocalOnnxEngine first, falls back to KeywordOnlyEngine on failure (src/analysis/embedder.ts:45-53). hybridSearch() checks worker.isReady() and falls back to keyword-only when false (src/search/hybrid.ts:111-128). SC-4 tests verify KeywordOnlyEngine returns null/false/0 for all operations (6 tests in src/analysis/__tests__/embedder.test.ts). |
| 5 | Plugin startup completes with zero perceptible latency -- the ONNX model loads lazily on first observation, not at process start | ✓ VERIFIED | LocalOnnxEngine uses dynamic import() for @huggingface/transformers in initialize() method (src/analysis/engines/local-onnx.ts:38). MCP server starts worker with fire-and-forget pattern: worker.start().catch() (src/index.ts:31) — server does NOT await worker initialization. Model loads only when first embed() call happens. SC-5 tests verify start() returns Promise without blocking (src/search/__tests__/hybrid.test.ts:394). |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| src/analysis/embedder.ts | EmbeddingEngine interface and createEmbeddingEngine() factory | ✓ VERIFIED | Interface defines 6 methods (embed, embedBatch, dimensions, name, initialize, isReady). Factory tries LocalOnnxEngine, falls back to KeywordOnlyEngine. Exports: EmbeddingEngine, createEmbeddingEngine. |
| src/analysis/engines/local-onnx.ts | BGE Small EN v1.5 q8 ONNX engine with dynamic import | ✓ VERIFIED | LocalOnnxEngine implements EmbeddingEngine. Uses dynamic import('@huggingface/transformers') in initialize(). Returns 384-dim Float32Array from embed(). Exports: LocalOnnxEngine. |
| src/analysis/engines/keyword-only.ts | Null fallback engine for graceful degradation | ✓ VERIFIED | KeywordOnlyEngine implements EmbeddingEngine. All methods return null/false/0. Exports: KeywordOnlyEngine. |
| src/storage/migrations.ts | Migration 006 with distance_metric=cosine | ✓ VERIFIED | Migration 006 at line 149-159 drops and recreates observation_embeddings table with "distance_metric=cosine" (line 156). Conditional on hasVectorSupport. |
| src/analysis/worker.ts | Worker thread entry point | ✓ VERIFIED | Worker imports parentPort from node:worker_threads, calls createEmbeddingEngine(), handles embed/embed_batch/shutdown messages. Zero-copy transfer with embedding.buffer. Built by tsdown to dist/analysis/worker.js (6.0k). |
| src/analysis/worker-bridge.ts | Main-thread AnalysisWorker bridge with Promise API | ✓ VERIFIED | AnalysisWorker creates Worker, provides embed()/embedBatch() Promise API, request-ID tracking with 30s timeouts. Exports: AnalysisWorker. |
| src/storage/embeddings.ts | EmbeddingStore for vec0 CRUD and KNN search | ✓ VERIFIED | EmbeddingStore provides store/search/delete/has/findUnembedded methods. Prepared statements for vec0 operations. Project-scoped KNN with subquery filter. Exports: EmbeddingStore, EmbeddingSearchResult. |
| src/search/hybrid.ts | Hybrid search with reciprocal rank fusion | ✓ VERIFIED | reciprocalRankFusion() implements standard RRF with k=60. hybridSearch() combines FTS5+vec0 results, assigns matchType (hybrid/fts/vector). Exports: reciprocalRankFusion, hybridSearch. |
| tsdown.config.ts | Third entry point for worker compilation | ✓ VERIFIED | Entry array includes src/analysis/worker.ts (line: entry: ['src/index.ts', 'src/hooks/handler.ts', 'src/analysis/worker.ts']). Produces dist/analysis/worker.js. |
| src/index.ts | MCP server with worker lifecycle | ✓ VERIFIED | Creates AnalysisWorker (line 28), EmbeddingStore (line 26), starts worker with fire-and-forget (line 31), background embedding loop every 5s (line 68), shutdown handlers clear embedTimer and call worker.shutdown(). |
| src/mcp/tools/recall.ts | recall tool using hybrid search | ✓ VERIFIED | Imports hybridSearch (line 11). search action calls hybridSearch when embeddingStore available (line 208), falls back to searchEngine.searchKeyword when not (line 218). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| src/analysis/embedder.ts | src/analysis/engines/local-onnx.ts | createEmbeddingEngine() factory | ✓ WIRED | Factory instantiates LocalOnnxEngine (line 46), calls initialize(), returns engine if success (line 50). |
| src/analysis/embedder.ts | src/analysis/engines/keyword-only.ts | createEmbeddingEngine() fallback | ✓ WIRED | Factory returns new KeywordOnlyEngine() if LocalOnnxEngine initialization fails (line 53). |
| src/analysis/engines/local-onnx.ts | @huggingface/transformers | dynamic import() in initialize() | ✓ WIRED | Line 38: await import('@huggingface/transformers'). Model loaded via pipeline() (line 43). |
| src/analysis/worker-bridge.ts | src/analysis/worker.ts | new Worker() with postMessage | ✓ WIRED | AnalysisWorker creates Worker (line 91), sends postMessage for embed requests (line 154, 178), handles onMessage responses. |
| src/analysis/worker.ts | src/analysis/embedder.ts | createEmbeddingEngine() in worker | ✓ WIRED | Worker imports createEmbeddingEngine (line 12), calls it in init (line 43), stores engine reference. |
| src/storage/embeddings.ts | observation_embeddings vec0 table | prepared statements | ✓ WIRED | Constructor prepares INSERT, MATCH, DELETE statements (lines 39-68). store() inserts to vec0 (line 79), search() queries with MATCH (line 98). |
| src/search/hybrid.ts | src/storage/search.ts | searchEngine.searchKeyword() | ✓ WIRED | hybridSearch() calls searchEngine.searchKeyword() (line 101). |
| src/search/hybrid.ts | src/storage/embeddings.ts | embeddingStore.search() | ✓ WIRED | hybridSearch() calls embeddingStore.search(queryEmbedding) (line 116) when worker ready. |
| src/index.ts | src/analysis/worker-bridge.ts | Creates and starts AnalysisWorker | ✓ WIRED | Line 28 creates worker, line 31 starts with fire-and-forget .catch(), line 55 calls worker.embed() in background loop. |
| src/mcp/tools/recall.ts | src/search/hybrid.ts | Calls hybridSearch() | ✓ WIRED | Line 208 calls hybridSearch with searchEngine, embeddingStore, worker, query params. |

### Requirements Coverage

| Requirement | Status | Blocking Issue |
|-------------|--------|----------------|
| INT-01: Embeddings via pluggable strategy with local ONNX as default | ✓ SATISFIED | EmbeddingEngine interface is pluggable abstraction. LocalOnnxEngine uses BGE Small EN v1.5 q8. Factory pattern supports multiple engines. |
| INT-04: All embedding in worker thread, never blocks MCP | ✓ SATISFIED | Worker thread entry point runs engine. AnalysisWorker bridge provides non-blocking Promise API. MCP server processes embeddings in background loop. |
| SRC-02: Search by semantic meaning via vector similarity | ✓ SATISFIED | EmbeddingStore.search() performs KNN queries on vec0 table with cosine distance. hybridSearch() returns vector matches with matchType='vector'. |
| SRC-03: Hybrid search combines FTS5 + vector via RRF | ✓ SATISFIED | reciprocalRankFusion() merges ranked lists. hybridSearch() combines keyword and vector results with proper matchType assignment. |
| DQ-03: Graceful degradation to keyword-only when ONNX unavailable | ✓ SATISFIED | KeywordOnlyEngine provides null fallback. createEmbeddingEngine() catches initialization failures. hybridSearch() falls back when worker not ready. |
| DQ-04: Zero startup latency, lazy model loading | ✓ SATISFIED | LocalOnnxEngine uses dynamic import(). Worker starts with fire-and-forget pattern. Model loads on first embed() call, not at process start. |

### Anti-Patterns Found

None detected. Code follows established patterns:
- Never-throw contract: All engine methods return null/false on failure
- Graceful degradation: Multiple fallback layers (KeywordOnlyEngine, keyword-only search)
- Non-blocking worker: Fire-and-forget startup, Promise-based API, zero-copy transfers
- Proper resource cleanup: embedTimer cleared in shutdown handlers

### Human Verification Required

None required. All success criteria are programmatically verifiable and covered by automated tests (286 total tests, 41 new Phase 4 tests covering all 5 SC):
- SC-1: Semantic search by concept (verified via hybridSearch integration)
- SC-2: Hybrid combines scores (RRF + matchType tests)
- SC-3: Non-blocking embedding (Promise API tests)
- SC-4: Graceful degradation (KeywordOnlyEngine tests)
- SC-5: Zero startup latency (fire-and-forget start tests)

---

## Summary

Phase 04 goal **FULLY ACHIEVED**. All 5 observable truths verified:

1. ✓ **Semantic search works** — hybridSearch combines FTS5 keyword and vec0 vector results
2. ✓ **Hybrid fusion works** — reciprocalRankFusion merges ranked lists with proper matchType
3. ✓ **Non-blocking embedding works** — worker thread with Promise API, background loop
4. ✓ **Graceful degradation works** — KeywordOnlyEngine fallback, keyword-only search when worker unavailable
5. ✓ **Zero startup latency works** — dynamic import, fire-and-forget worker start, lazy model loading

All 11 required artifacts exist and are substantive. All 10 key links are wired. All 6 requirements satisfied. 286 tests pass (41 new Phase 4 tests). No gaps, no blockers, no human verification needed.

**Ready to proceed to Phase 05: Topic Detection and Context Stashing.**

---

_Verified: 2026-02-08T16:30:00Z_
_Verifier: Claude (gsd-verifier)_
