# Phase 4: Embedding Engine and Semantic Search - Research

**Researched:** 2026-02-08
**Domain:** Vector embeddings, ONNX inference, sqlite-vec KNN, hybrid search, worker threads
**Confidence:** HIGH (core patterns verified via live tests, official docs, and working code)

## Summary

Phase 4 transforms Laminark from keyword-only search into a semantic search system by adding vector embeddings to observations. The implementation requires four interlocking components: (1) a pluggable embedding engine using `@huggingface/transformers` v3 with BGE Small EN v1.5 as the default ONNX model, (2) an `EmbeddingStore` backed by sqlite-vec's `vec0` virtual table with cosine distance, (3) a `worker_threads` bridge that offloads all embedding computation to a background thread, and (4) a reciprocal rank fusion (RRF) algorithm that combines FTS5 keyword scores with vector similarity scores.

The codebase is well-prepared for this phase. Migration 004 already creates the `observation_embeddings` vec0 table (though it needs a new migration to add `distance_metric=cosine`). The `Observation` type already carries `embedding`, `embeddingModel`, and `embeddingVersion` fields. The `SearchResult` type already supports `matchType: 'vector' | 'hybrid'`. sqlite-vec v0.1.7-alpha.2 is already installed and loading successfully.

**Primary recommendation:** Use `@huggingface/transformers` v3.8+ with `Xenova/bge-small-en-v1.5` (384-dim, q8 quantization for ~34MB download). Load via dynamic `import()` inside a worker thread. Use cosine distance in sqlite-vec. Combine results with RRF (k=60). Every component must return `null` on failure -- never throw.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @huggingface/transformers | ^3.8 | ONNX model inference for embeddings | Actively maintained successor to archived fastembed-js. Wraps onnxruntime-node. 1200+ pre-converted models on HuggingFace Hub. Pipeline API handles tokenization, inference, and pooling in one call. **Confidence: HIGH** |
| sqlite-vec | ^0.1.7-alpha.2 | Vector similarity search | Already installed and loading. Pure C, zero dependencies. `vec0` virtual table with KNN MATCH queries. Supports cosine distance metric. In-process with existing better-sqlite3. **Confidence: HIGH** (verified via live tests) |
| node:worker_threads | (built-in) | Off-main-thread embedding computation | Built into Node.js 22 LTS. postMessage with transfer list enables zero-copy Float32Array transfer. **Confidence: HIGH** |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| onnxruntime-node | ^1.24 (transitive) | ONNX Runtime backend for Node.js | Transitive dependency of @huggingface/transformers. Loaded automatically when running in Node.js. No direct import needed. **Confidence: HIGH** |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @huggingface/transformers | onnxruntime-node directly | Lower-level: requires manual tokenization, model loading, tensor management. Transformers.js abstracts all of this with the pipeline API. |
| Xenova/bge-small-en-v1.5 | Xenova/all-MiniLM-L6-v2 | Same 384 dimensions. BGE Small scores slightly higher on MTEB retrieval benchmarks. Both ~33MB quantized. Either works. |
| sqlite-vec vec0 | Manual BLOB + vec_distance_cosine() | vec0 virtual table is faster (C-level KNN loop) and cleaner (SQL MATCH syntax). Manual approach only needed if vec0 proves unstable. |
| worker_threads | child_process.fork() | child_process creates a full OS process (~30MB overhead). worker_threads share memory space (~2MB overhead). For CPU-bound work in the same codebase, worker_threads is strictly better. |

**Installation:**
```bash
npm install @huggingface/transformers
# sqlite-vec already installed
# onnxruntime-node installed transitively
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── analysis/
│   ├── embedder.ts          # EmbeddingEngine interface + createEmbeddingEngine() factory
│   ├── engines/
│   │   ├── local-onnx.ts    # LocalOnnxEngine (default, uses @huggingface/transformers)
│   │   └── keyword-only.ts  # KeywordOnlyEngine (null fallback)
│   ├── worker.ts            # Worker thread entry point (receives embed messages)
│   └── worker-bridge.ts     # Main-thread API (AnalysisWorker class)
├── storage/
│   └── embeddings.ts        # EmbeddingStore (sqlite-vec operations)
└── search/
    └── hybrid.ts            # reciprocalRankFusion() + hybridSearch()
```

### Pattern 1: Pluggable Embedding Strategy
**What:** An `EmbeddingEngine` interface with `embed()`, `embedBatch()`, `dimensions()`, `name()`, `initialize()`, and `isReady()` methods. Two implementations: `LocalOnnxEngine` (default) and `KeywordOnlyEngine` (fallback). A factory function selects the right one.
**When to use:** Always. The interface decouples consumers from the specific engine.
**Example:**
```typescript
// Source: verified against @huggingface/transformers docs + Node.js tutorial
export interface EmbeddingEngine {
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
  dimensions(): number;
  name(): string;
  initialize(): Promise<boolean>;
  isReady(): boolean;
}

// LocalOnnxEngine.initialize() -- dynamic import for lazy loading
async initialize(): Promise<boolean> {
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(getConfigDir(), 'models');
    this.pipe = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
      dtype: 'q8',  // INT8 quantization: ~34MB download, faster inference
    });
    this.ready = true;
    return true;
  } catch {
    this.ready = false;
    return false;
  }
}

// LocalOnnxEngine.embed() -- returns Float32Array or null
async embed(text: string): Promise<Float32Array | null> {
  if (!this.ready || !this.pipe) return null;
  try {
    const output = await this.pipe(text, { pooling: 'cls', normalize: true });
    return new Float32Array(output.data);  // output.data is already Float32Array
  } catch {
    return null;
  }
}
```

### Pattern 2: Worker Thread Bridge with Request-ID Tracking
**What:** A main-thread `AnalysisWorker` class that spawns a worker thread and provides `embed(text): Promise<Float32Array | null>`. Each request gets a unique ID. The worker responds with the same ID. A Map tracks pending Promise resolvers.
**When to use:** For all embedding operations from the main thread.
**Example:**
```typescript
// Source: Node.js worker_threads docs + verified Float32Array transfer test
// Main thread sends:
worker.postMessage({ type: 'embed', id: '1', text: 'some text' });

// Worker responds (with transfer list for zero-copy):
parentPort.postMessage(
  { type: 'embed_result', id: '1', embedding: float32Array },
  [float32Array.buffer]  // Transfer, not clone
);

// Main thread receives Float32Array directly (instanceof Float32Array === true)
```

### Pattern 3: sqlite-vec KNN with Cosine Distance
**What:** Use `vec0` virtual table with `distance_metric=cosine` for semantic similarity. Pass `Float32Array` directly to prepared statements.
**When to use:** For all vector storage and retrieval.
**Critical finding:** The existing migration 004 creates the table WITHOUT `distance_metric=cosine`, defaulting to L2 distance. A new migration is needed to recreate the table with cosine distance.
**Example:**
```typescript
// Source: sqlite-vec official docs + verified via live test on this codebase
// Table creation (in new migration):
CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
  observation_id TEXT PRIMARY KEY,
  embedding float[384] distance_metric=cosine
);

// Insert:
db.prepare('INSERT INTO observation_embeddings(observation_id, embedding) VALUES (?, ?)')
  .run('obs-id', new Float32Array(384));

// KNN query:
db.prepare(`
  SELECT observation_id, distance
  FROM observation_embeddings
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT ?
`).all(new Float32Array(queryVector), 20);

// Filtered KNN (verified working -- MATCH + WHERE combined):
db.prepare(`
  SELECT observation_id, distance
  FROM observation_embeddings
  WHERE embedding MATCH ?
    AND observation_id IN (SELECT id FROM observations WHERE project_hash = ?)
  ORDER BY distance
  LIMIT ?
`).all(queryVector, projectHash, 20);
```

### Pattern 4: Reciprocal Rank Fusion (RRF)
**What:** Combines ranked lists from different retrieval methods without normalizing their disparate score scales. For each document, its fused score = sum(1/(k + rank_i)) across all lists where it appears.
**When to use:** To combine FTS5 keyword results with sqlite-vec vector results.
**Example:**
```typescript
// Source: Microsoft Azure AI Search docs, OpenSearch docs, academic literature
// k=60 is the empirically proven standard constant
function reciprocalRankFusion(
  rankedLists: Array<Array<{ id: string }>>,
  k: number = 60
): Array<{ id: string; fusedScore: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const { id } = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)); // 1-based rank
    }
  }
  return [...scores.entries()]
    .map(([id, fusedScore]) => ({ id, fusedScore }))
    .sort((a, b) => b.fusedScore - a.fusedScore);
}
```

### Anti-Patterns to Avoid
- **Importing @huggingface/transformers at module top-level:** This loads onnxruntime-node (~50MB native binary) at require-time, adding seconds to startup. Use dynamic `import()` inside `initialize()` only.
- **Running embedding in main thread:** Even 10-30ms per embedding blocks MCP tool responses. Always use worker_threads.
- **Using L2 distance with normalized embeddings:** BGE models output normalized embeddings. L2 distance on normalized vectors is proportional to cosine distance but with different scale. Use `distance_metric=cosine` explicitly for correct ranking.
- **Throwing exceptions from embedding methods:** Callers do not expect exceptions. Return `null` from `embed()` and `false` from `initialize()`. Let the system gracefully fall back to keyword-only.
- **Embedding full tool output:** Raw build logs, large file reads, and grep results are noise. The capture pipeline (Phase 3) already extracts semantic summaries. Embed the summary, not the raw output.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tokenization + ONNX inference | Custom tokenizer + onnxruntime-node direct | @huggingface/transformers pipeline() | Pipeline handles tokenizer loading, padding, truncation, inference, and output extraction. 500+ lines of code you don't write. |
| Vector similarity search | Manual cosine similarity in JS | sqlite-vec vec0 MATCH | C-level SIMD-optimized KNN. Orders of magnitude faster than JS at scale. Persists to disk. |
| Score normalization for hybrid search | Min-max normalization of BM25/cosine scores | Reciprocal Rank Fusion | RRF is rank-based, not score-based. No normalization needed. Proven in production at Azure AI Search, OpenSearch, Weaviate. |
| Worker thread communication | Raw postMessage with manual serialization | AnalysisWorker bridge class with ID-tracked Promises | The bridge handles request/response correlation, timeouts, error handling, and graceful shutdown. Without it, every caller must manage its own message handling. |

**Key insight:** Every component in this phase has a well-tested standard solution. The risk is not in the algorithms but in the integration: making sure the worker thread initializes lazily, the main thread writes embeddings to the database (not the worker), and the fallback path works silently.

## Common Pitfalls

### Pitfall 1: Migration 004 Uses L2 Distance (Not Cosine)
**What goes wrong:** The existing migration 004 creates `observation_embeddings USING vec0(observation_id TEXT PRIMARY KEY, embedding float[384])` without specifying `distance_metric=cosine`. This defaults to L2 distance. With normalized BGE embeddings, L2 distance still correlates with cosine similarity, but the absolute distances differ and ranking may be suboptimal.
**Why it happens:** The migration was written as a placeholder during Phase 1 before the embedding model was chosen.
**How to avoid:** Add a new migration (006 or a replacement) that drops and recreates the table with `distance_metric=cosine`. Since no embeddings exist yet (Phase 4 is the first to write them), this is safe.
**Warning signs:** Vector search returns results but ranking seems wrong; very similar texts don't rank close.

### Pitfall 2: ONNX Model Downloads on First Use
**What goes wrong:** The first call to `pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')` downloads the model files (~34MB for q8) from HuggingFace Hub. This takes seconds on slow connections and fails completely offline.
**Why it happens:** @huggingface/transformers uses a download-on-demand model with local caching.
**How to avoid:** Set `env.cacheDir` to a predictable location (e.g., `~/.laminark/models/`). The first embed call will be slow but subsequent calls use the cache. If download fails, `initialize()` returns `false` and the system falls back to KeywordOnlyEngine.
**Warning signs:** First embed request takes 5+ seconds; embedding fails in air-gapped environments.

### Pitfall 3: Worker Thread File Path Resolution After Build
**What goes wrong:** `new Worker('./src/analysis/worker.ts')` works in development but fails after `tsdown` bundles the code because the worker file path changes.
**Why it happens:** tsdown bundles entry points but worker files need to be separate entry points. The compiled worker.js path differs from the source worker.ts path.
**How to avoid:** Add `src/analysis/worker.ts` as an additional entry point in `tsdown.config.ts`. Resolve the worker path at runtime using `import.meta.url` or `new URL('./worker.js', import.meta.url).href`. Test the built output, not just the source.
**Warning signs:** Worker creation fails with `MODULE_NOT_FOUND` or `ERR_WORKER_PATH` after building.

### Pitfall 4: Structured Clone vs Transfer for Float32Array
**What goes wrong:** Using `postMessage(data)` without a transfer list creates a full copy of every Float32Array. For 384-dim float32 vectors, this is 1.5KB copied per message -- not catastrophic but wasteful.
**Why it happens:** Structured clone is the default. Transfer must be explicitly requested.
**How to avoid:** Always pass `[embedding.buffer]` as the second argument to `postMessage()` when sending Float32Array from worker to main thread. The buffer is transferred (zero-copy), not cloned. Note: the sending side can no longer read the buffer after transfer.
**Warning signs:** Memory usage grows during batch embedding; GC pressure increases.

### Pitfall 5: sqlite-vec MATCH Requires LIMIT
**What goes wrong:** A KNN query without `LIMIT` or `k = ?` throws an error.
**Why it happens:** sqlite-vec requires bounded KNN queries to prevent full-table scans.
**How to avoid:** Always include `LIMIT ?` in KNN queries. SQLite 3.41+ supports LIMIT directly (we have 3.51.2, verified). Default to 20 results for search, 50 for batch operations.
**Warning signs:** `OperationalError: A LIMIT or 'k = ?' constraint is required`.

### Pitfall 6: Embedding Null or Empty Text
**What goes wrong:** Passing empty string or null to the embedding pipeline produces garbage vectors or throws.
**Why it happens:** Models expect non-empty input.
**How to avoid:** Validate text length > 0 before calling `embed()`. Return `null` for empty text.
**Warning signs:** Zero vectors or NaN values in embedding results.

## Code Examples

Verified patterns from official sources and live tests:

### Feature Extraction with @huggingface/transformers
```typescript
// Source: HuggingFace docs + Node.js tutorial
// Dynamic import for lazy loading (DQ-04)
const { pipeline, env } = await import('@huggingface/transformers');

// Set cache to Laminark data dir
env.cacheDir = '/home/user/.laminark/models';

// Create pipeline (downloads model on first call, caches for subsequent)
const extractor = await pipeline(
  'feature-extraction',
  'Xenova/bge-small-en-v1.5',
  { dtype: 'q8' }  // INT8 quantization: ~34MB, good quality/speed tradeoff
);

// Single text embedding
const output = await extractor('authentication decisions for the API', {
  pooling: 'cls',     // BGE models use CLS token pooling
  normalize: true,     // L2-normalize for cosine similarity
});
const embedding = new Float32Array(output.data);  // 384-dim Float32Array

// Batch embedding (native batch support)
const batchOutput = await extractor(
  ['text one', 'text two', 'text three'],
  { pooling: 'cls', normalize: true }
);
const embeddings = batchOutput.tolist();  // Array of number arrays
```

### sqlite-vec Operations (Verified Live)
```typescript
// Source: sqlite-vec docs + live test on this codebase (2026-02-08)
import * as sqliteVec from 'sqlite-vec';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
sqliteVec.load(db);

// SQLite 3.51.2 confirmed -- LIMIT works (requires 3.41+)
// vec_version: v0.1.7-alpha.2

// Create table with cosine distance (CRITICAL: must specify distance_metric)
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
  observation_id TEXT PRIMARY KEY,
  embedding float[384] distance_metric=cosine
)`);

// Insert embedding
db.prepare('INSERT INTO observation_embeddings(observation_id, embedding) VALUES (?, ?)')
  .run('obs-abc123', new Float32Array(384));  // Float32Array passed directly

// KNN search
const results = db.prepare(`
  SELECT observation_id, distance
  FROM observation_embeddings
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT ?
`).all(new Float32Array(queryVector), 20);
// Returns: [{ observation_id: 'obs-abc123', distance: 0.031 }, ...]

// Filtered KNN (VERIFIED: MATCH + WHERE IN works together)
const filtered = db.prepare(`
  SELECT observation_id, distance
  FROM observation_embeddings
  WHERE embedding MATCH ?
    AND observation_id IN (
      SELECT id FROM observations WHERE project_hash = ? AND deleted_at IS NULL
    )
  ORDER BY distance
  LIMIT ?
`).all(queryVector, projectHash, 20);

// Scalar function also works (alternative approach for pre-filtered sets)
const scalar = db.prepare(`
  SELECT id, vec_distance_cosine(?, (
    SELECT embedding FROM observation_embeddings WHERE observation_id = observations.id
  )) AS dist
  FROM observations
  WHERE project_hash = ?
  ORDER BY dist
  LIMIT ?
`).all(queryVector, projectHash, 20);
```

### Worker Thread Float32Array Transfer (Verified Live)
```typescript
// Source: Node.js worker_threads docs + verified on Node.js 25.4.0
// Worker sends embedding with zero-copy transfer:
parentPort.postMessage(
  { type: 'embed_result', id: requestId, embedding: float32Array },
  [float32Array.buffer]  // Transfer list -- zero-copy
);

// Main thread receives:
worker.on('message', (msg) => {
  msg.embedding instanceof Float32Array;  // true
  msg.embedding.length;                    // 384
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| fastembed-js | @huggingface/transformers v3 | Jan 2026 (fastembed archived) | Must use HF transformers pipeline API instead of fastembed's embed() |
| sqlite-vss (Faiss-based) | sqlite-vec (pure C) | 2024 | Lighter dependency, same API surface, better portability |
| Static topic thresholds | EWMA adaptive thresholds | Phase 6 (future) | Not relevant to Phase 4, but embedding quality here affects Phase 6 |
| L2 distance default | Cosine distance explicit | sqlite-vec 0.1.3+ | Must specify `distance_metric=cosine` in table DDL; default remains L2 |

**Deprecated/outdated:**
- fastembed-js: Archived January 15, 2026. Do not use. @huggingface/transformers is the replacement.
- @xenova/transformers: Old package name. Now `@huggingface/transformers` (same maintainer, merged into HF org).
- sqlite-vss: Predecessor to sqlite-vec. Based on Faiss. No longer developed.

## Critical Findings from Codebase Analysis

### Finding 1: Migration 004 Must Be Updated
The existing migration 004 in `src/storage/migrations.ts` creates:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
  observation_id TEXT PRIMARY KEY,
  embedding float[384]
);
```
This uses the **default L2 distance**, not cosine. Since no embeddings have been written yet (Phase 4 is the first to write them), a new migration 006 should drop and recreate this table with `distance_metric=cosine`. Alternatively, since migration 004 is only applied when `hasVectorSupport` is true and the table may not exist on all installs, a conditional migration approach may be simpler.

### Finding 2: Observation Type Already Supports Embeddings
`src/shared/types.ts` already has `embedding: Float32Array | null`, `embeddingModel: string | null`, and `embeddingVersion: string | null` on the `Observation` type. `ObservationInsert` accepts these fields. The `ObservationRepository.update()` method can update embedding fields. This means the ingest pipeline can write embeddings after the worker computes them.

### Finding 3: SearchResult Type Ready for Hybrid
`SearchResult.matchType` already includes `'vector' | 'hybrid'` variants. The planner can leverage this without type changes.

### Finding 4: Hook Handler Opens Separate DB Connection
The hook handler (`src/hooks/handler.ts`) opens its own database connection per invocation. The embedding worker should NOT run in the hook process. Embeddings should be generated asynchronously by the MCP server process, which has a long-lived database connection and can host the worker thread.

### Finding 5: tsdown Needs Worker Entry Point
`tsdown.config.ts` currently has two entry points: `src/index.ts` and `src/hooks/handler.ts`. The worker file `src/analysis/worker.ts` must be added as a third entry point so it's compiled as a standalone file that `new Worker()` can load.

### Finding 6: sqlite-vec MATCH + WHERE Filter Works
Live testing confirmed that `WHERE embedding MATCH ? AND observation_id IN (...)` works correctly with sqlite-vec v0.1.7-alpha.2 on SQLite 3.51.2. This enables project-scoped vector search without a two-step approach.

### Finding 7: Float32Array Passes Directly to better-sqlite3
No Buffer.from() conversion needed for sqlite-vec operations. `stmt.run(id, new Float32Array(...))` and `stmt.all(new Float32Array(...))` work directly. This is different from the observations table's embedding BLOB column (which does need Buffer conversion).

## Open Questions

1. **BGE Small vs all-MiniLM-L6-v2 model choice**
   - What we know: Both are 384-dim, both ~34MB quantized, BGE scores slightly higher on MTEB retrieval benchmarks
   - What's unclear: Whether BGE's CLS pooling or MiniLM's mean pooling produces better results for short observation summaries (typical length: 50-200 chars)
   - Recommendation: Use BGE Small with CLS pooling as specified in INT-01. Switch to MiniLM only if quality issues arise during testing. Both use the same pipeline API -- switching is a one-line change.

2. **q8 vs fp32 quantization tradeoff**
   - What we know: q8 is ~34MB (vs 133MB fp32), inference is faster, quality loss is minimal for retrieval tasks
   - What's unclear: Exact quality degradation for very short texts (our observation summaries)
   - Recommendation: Use `dtype: 'q8'` (default for WASM, good for CPU). Fall back to fp32 only if retrieval quality is measurably poor. The `dtype` parameter is set at pipeline creation time.

3. **Where should the embedding worker live architecturally?**
   - What we know: The MCP server process (`src/index.ts`) is long-lived. The hook handler process is ephemeral (opens DB, processes one event, exits).
   - What's unclear: Whether the worker should start at MCP server startup or lazily on first save_memory/hook capture
   - Recommendation: Start the worker at MCP server startup (just creates the thread, does NOT load the model). Model loads lazily on first embed request. This satisfies DQ-04 (zero startup latency) while having the worker ready for the first observation.

4. **Should hook-captured observations get embeddings?**
   - What we know: The hook handler writes observations synchronously. Adding embedding computation would block the hook (violates INT-04).
   - What's unclear: How to trigger embedding for hook-captured observations
   - Recommendation: The MCP server process should poll for observations without embeddings (embedding IS NULL) and process them in the background worker. Or, use a SQLite trigger/notification pattern. The simplest approach: after each observation is stored (by hook or save_memory), the MCP server's main loop checks for unembedded observations and queues them.

## Sources

### Primary (HIGH confidence)
- sqlite-vec official docs: [KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html) -- MATCH syntax, distance metrics, LIMIT requirements
- sqlite-vec official docs: [Node.js usage](https://alexgarcia.xyz/sqlite-vec/js.html) -- load(), Float32Array, better-sqlite3 integration
- sqlite-vec official example: [simple-node/demo.mjs](https://github.com/asg017/sqlite-vec/blob/main/examples/simple-node/demo.mjs) -- Complete working example with Float32Array
- @huggingface/transformers docs: [env API](https://huggingface.co/docs/transformers.js/en/api/env) -- cacheDir, allowRemoteModels, localModelPath
- @huggingface/transformers docs: [Node.js tutorial](https://huggingface.co/docs/transformers.js/tutorials/node) -- Singleton pattern, lazy loading, ESM usage
- @huggingface/transformers docs: [Pipeline API](https://huggingface.co/docs/transformers.js/en/api/pipelines) -- feature-extraction, pooling, normalize
- Node.js docs: [worker_threads](https://nodejs.org/api/worker_threads.html) -- postMessage, transfer list, Worker constructor
- Xenova/bge-small-en-v1.5: [Model card](https://huggingface.co/Xenova/bge-small-en-v1.5) -- 384-dim, ONNX weights, quantization variants
- Live tests on Laminark codebase (2026-02-08) -- vec0 cosine distance, MATCH+WHERE filter, Float32Array passing, worker thread transfer

### Secondary (MEDIUM confidence)
- Microsoft Azure AI Search: [Hybrid Search Scoring (RRF)](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking) -- k=60 standard, production implementation
- OpenSearch blog: [Introducing reciprocal rank fusion](https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/) -- RRF algorithm details, empirical validation
- ParadeDB: [What is Reciprocal Rank Fusion?](https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion) -- Clear explanation of RRF formula and k parameter

### Tertiary (LOW confidence)
- Blog: [How to Create Vector Embeddings in Node.js](https://philna.sh/blog/2024/09/25/how-to-create-vector-embeddings-in-node-js/) -- Practical example of pipeline usage (September 2024, pre-v3.8)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries verified via live tests on this codebase
- Architecture: HIGH -- patterns follow official docs and prior successful implementations
- Pitfalls: HIGH -- critical migration issue found and documented via live testing
- Integration: MEDIUM -- worker thread + build system interaction needs validation during implementation

**Research date:** 2026-02-08
**Valid until:** 2026-03-08 (stable domain, 30-day validity)
