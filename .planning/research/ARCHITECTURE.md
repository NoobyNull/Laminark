# Architecture Research

**Domain:** Claude Code memory plugin with adaptive topic detection, real-time semantic analysis, and visual memory exploration
**Researched:** 2026-02-08
**Confidence:** HIGH (Claude Code plugin SDK verified via official docs; SQLite/MCP patterns verified via official sources and production implementations)

## Standard Architecture

### System Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                     Claude Code Host Process                         │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   Plugin Hooks Layer                         │    │
│  │  SessionStart  UserPromptSubmit  PostToolUse  PreCompact     │    │
│  │  Stop          SessionEnd        PostToolUseFailure          │    │
│  └──────┬───────────────┬──────────────────┬────────────────────┘    │
│         │               │                  │                         │
│         │  stdin JSON    │  stdin JSON      │  stdin JSON             │
│         ▼               ▼                  ▼                         │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                Hook Dispatcher (shell scripts)               │    │
│  │    Fast path: enqueue + exit 0 (< 50ms)                     │    │
│  │    Sync hooks: SessionStart (context injection)              │    │
│  │    Async hooks: PostToolUse, Stop, SessionEnd                │    │
│  └──────┬───────────────────────────────────────────────────────┘    │
│         │                                                            │
│         │  HTTP POST / Unix domain socket                            │
│         ▼                                                            │
├─────────────────────────────────────────────────────────────────────┤
│                     Laminark Core Process                            │
│                                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────┐               │
│  │  Ingest    │  │  Analysis    │  │  Curation      │               │
│  │  Queue     │→ │  Pipeline    │→ │  Agent         │               │
│  │  (in-mem)  │  │  (worker)    │  │  (periodic)    │               │
│  └────────────┘  └──────────────┘  └────────────────┘               │
│         │               │                  │                         │
│  ┌──────┴───────────────┴──────────────────┴───────────────────┐    │
│  │                    Storage Engine                            │    │
│  │  SQLite + WAL │ FTS5 │ sqlite-vec │ better-sqlite3          │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   MCP Server (stdio)                         │    │
│  │  search │ timeline │ get_observations │ save_memory          │    │
│  │  graph_query │ topic_context │ stash │ resume                │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   Web Server (HTTP)                          │    │
│  │  localhost:37820 │ SSE for live updates                      │    │
│  │  Knowledge graph │ Timeline │ Session browser                │    │
│  └──────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **Hook Dispatcher** | Captures Claude Code lifecycle events, serializes to ingest queue. Must be fast (< 50ms for sync hooks). SessionStart injects recovered context. | Shell scripts calling into core process via HTTP/socket. Async hooks (`async: true`) for non-blocking observation capture. |
| **Ingest Queue** | Buffers incoming observations from hooks before processing. Decouples capture speed from analysis speed. | In-memory FIFO queue (array or ring buffer). Bounded size with overflow-to-disk fallback. |
| **Analysis Pipeline** | Embedding generation, topic shift detection, entity extraction, relationship detection. Runs in a worker thread to avoid blocking MCP responses. | Node.js `worker_threads` with a dedicated worker. Processes queue items in batches. Uses pluggable embedding strategy. |
| **Curation Agent** | Periodic consolidation: merges similar observations, generates summaries, prunes low-value data, updates knowledge graph edges. | Scheduled via `setInterval` or triggered on queue drain. Runs at reduced priority. Can use Claude API for high-quality summarization. |
| **Storage Engine** | Persistent storage for observations, embeddings, knowledge graph, topic state, session metadata. Single SQLite database with WAL for concurrent reads. | `better-sqlite3` with WAL mode, FTS5 virtual tables, `sqlite-vec` extension for vector search. Single writer, multiple readers. |
| **MCP Server** | Exposes memory tools to Claude via Model Context Protocol. Primary interface for Claude to search, save, and navigate memory. | `@modelcontextprotocol/sdk` TypeScript SDK, stdio transport. Zod schemas for tool input validation. |
| **Web Server** | Visual memory exploration: knowledge graph, timeline, session browser. Live updates via Server-Sent Events. | Lightweight HTTP server (Node built-in `http` or Fastify). Static SPA served from bundled assets. SSE for push updates. |
| **Embedding Engine** | Generates vector embeddings for semantic search. Pluggable: local ONNX, Claude extraction, or hybrid. | `@xenova/transformers` for local ONNX inference (all-MiniLM-L6-v2, 384 dimensions). Falls back to keyword-only if unavailable. |
| **Topic Detector** | Detects semantic topic shifts using embedding cosine distance with adaptive per-user thresholds. Triggers context stashing when threshold exceeded. | Exponentially weighted moving average (EWMA) of inter-observation similarity. Threshold adapts based on user's natural variance. |

## Recommended Project Structure

```
laminark/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest (name, version, MCP config)
├── hooks/
│   └── hooks.json            # Hook definitions (async PostToolUse, sync SessionStart)
├── scripts/
│   ├── hook-dispatcher.sh    # Fast-path hook: reads stdin, POSTs to core, exits
│   └── session-start.sh      # Sync hook: queries core for context, prints to stdout
├── skills/
│   └── memory/
│       └── SKILL.md          # Memory skill for Claude auto-invocation
├── commands/
│   ├── remember.md           # /laminark:remember — manual save
│   ├── recall.md             # /laminark:recall — manual search
│   ├── stash.md              # /laminark:stash — stash current context
│   └── resume.md             # /laminark:resume — resume stashed context
├── .mcp.json                 # MCP server configuration (stdio transport)
├── src/
│   ├── index.ts              # Core process entry: starts MCP, web, analysis
│   ├── mcp/
│   │   ├── server.ts         # MCP server setup (tools, resources)
│   │   └── tools/
│   │       ├── search.ts     # Hybrid FTS5 + vector search
│   │       ├── timeline.ts   # Chronological context around anchor
│   │       ├── get-observations.ts  # Fetch full observation details
│   │       ├── save-memory.ts       # Manual memory storage
│   │       ├── graph-query.ts       # Knowledge graph traversal
│   │       └── topic-context.ts     # Current topic + stash/resume
│   ├── ingest/
│   │   ├── queue.ts          # In-memory observation queue
│   │   ├── receiver.ts       # HTTP/socket endpoint for hook data
│   │   └── normalizer.ts     # Normalize hook JSON into observations
│   ├── analysis/
│   │   ├── worker.ts         # Worker thread entry point
│   │   ├── pipeline.ts       # Orchestrates analysis steps
│   │   ├── embedder.ts       # Pluggable embedding generation
│   │   ├── topic-detector.ts # Adaptive topic shift detection
│   │   ├── entity-extractor.ts  # Named entity + concept extraction
│   │   └── relationship.ts   # Relationship/edge detection
│   ├── storage/
│   │   ├── database.ts       # SQLite connection, migrations, WAL setup
│   │   ├── observations.ts   # Observation CRUD + batch insert
│   │   ├── embeddings.ts     # sqlite-vec operations
│   │   ├── graph.ts          # Knowledge graph (nodes, edges, traversal)
│   │   ├── topics.ts         # Topic state, threshold history
│   │   └── sessions.ts       # Session metadata, recovery
│   ├── curation/
│   │   ├── curator.ts        # Periodic consolidation orchestrator
│   │   ├── summarizer.ts     # Observation merging + summary generation
│   │   └── pruner.ts         # Low-value observation removal
│   ├── web/
│   │   ├── server.ts         # HTTP server + SSE endpoints
│   │   ├── routes/
│   │   │   ├── api.ts        # REST API for UI data
│   │   │   └── sse.ts        # Server-Sent Events for live updates
│   │   └── ui/               # Bundled SPA assets (built separately)
│   │       └── dist/         # Prebuilt HTML/JS/CSS
│   └── shared/
│       ├── config.ts         # Configuration management
│       ├── types.ts          # Shared TypeScript types
│       └── logger.ts         # Structured logging
├── ui/                       # Web UI source (separate build)
│   ├── src/
│   │   ├── App.tsx           # React app shell
│   │   ├── components/
│   │   │   ├── KnowledgeGraph.tsx   # Force-directed graph (D3/react-force-graph)
│   │   │   ├── Timeline.tsx         # Chronological observation view
│   │   │   └── SessionBrowser.tsx   # Session list + detail
│   │   └── hooks/
│   │       └── useSSE.ts    # SSE connection hook
│   └── vite.config.ts       # Build config
├── package.json
└── tsconfig.json
```

### Structure Rationale

- **`hooks/` + `scripts/`:** Claude Code plugin hooks must be shell scripts receiving JSON on stdin. They are the thinnest possible layer -- read stdin, POST to core process, exit. This keeps hook execution under 50ms. Async hooks (`async: true`) are used for PostToolUse/Stop/SessionEnd so they never block Claude.
- **`src/mcp/`:** MCP tools are the primary interface Claude uses to interact with memory. Separated from analysis logic because MCP responses must be fast (read-only database queries) while analysis is background work.
- **`src/ingest/`:** Decouples observation capture from analysis. The queue absorbs bursts of hook events during rapid tool use. The receiver is a minimal HTTP endpoint (or Unix domain socket for lower overhead).
- **`src/analysis/`:** Runs in a `worker_threads` worker. All CPU-intensive work (embedding generation, topic detection, entity extraction) happens here, never on the main thread. The main thread handles MCP requests and web server responses.
- **`src/storage/`:** Single `better-sqlite3` connection in WAL mode. The main thread reads; the analysis worker writes through a dedicated write queue. This matches SQLite's single-writer/multi-reader model.
- **`src/curation/`:** Periodic background process. Runs during quiet periods (session end, long pauses). Not latency-sensitive. Can optionally use Claude API for high-quality summarization.
- **`ui/`:** Separate build artifact. Prebuilt during `npm run build` and served as static files. Keeps the core process lightweight -- no bundler running at runtime.

## Architectural Patterns

### Pattern 1: Fire-and-Forget Hook Dispatch

**What:** Hook scripts read stdin JSON, POST it to the core process's ingest endpoint, and immediately exit with code 0. They do not wait for processing to complete.
**When to use:** For all observation-capture hooks (PostToolUse, Stop, SessionEnd). These hooks have no decision to make -- they only need to capture data.
**Trade-offs:** Maximizes hook speed (< 50ms) but means observations are eventually consistent. A crash between hook fire and database write loses that observation. Acceptable because individual observations are low-value; patterns matter more than any single event.

**Example:**
```bash
#!/bin/bash
# scripts/hook-dispatcher.sh
# Read all stdin, POST to core process, exit immediately
INPUT=$(cat)
curl -s -X POST http://localhost:37819/ingest \
  -H "Content-Type: application/json" \
  -d "$INPUT" &
exit 0
```

### Pattern 2: Worker Thread Analysis Pipeline

**What:** All CPU-intensive analysis (embedding generation, topic detection, entity extraction) runs in a dedicated `worker_threads` worker. The main thread handles only I/O: MCP requests, web server, and ingest receiver.
**When to use:** Always. This is the core performance pattern. Embedding generation takes 10-50ms per observation with ONNX; topic detection requires cosine similarity computation; entity extraction may involve regex + heuristics. None of this should block MCP tool responses.
**Trade-offs:** Adds complexity of cross-thread communication. Worker crashes require restart logic. SharedArrayBuffer could optimize embedding transfers but adds synchronization complexity -- start with `postMessage` and structured cloning, optimize later if profiling shows it matters.

**Example:**
```typescript
// Main thread: post observation to worker
import { Worker } from 'worker_threads';

const analysisWorker = new Worker('./src/analysis/worker.ts');

function enqueueObservation(obs: Observation): void {
  analysisWorker.postMessage({ type: 'analyze', payload: obs });
}

analysisWorker.on('message', (msg) => {
  if (msg.type === 'analysis_complete') {
    // Write results to SQLite from main thread (single writer)
    storage.writeAnalysisResults(msg.payload);
    // Notify SSE clients
    sse.broadcast('observation', msg.payload);
  }
});
```

### Pattern 3: Adaptive Topic Threshold via EWMA

**What:** Topic shift detection uses cosine distance between consecutive observation embeddings. The threshold is not static -- it adapts using an Exponentially Weighted Moving Average (EWMA) of recent distances. High variance sessions (scattered thinking) get a higher threshold; focused sessions get a lower one.
**When to use:** Every time a new observation's embedding is computed. The EWMA naturally handles per-session variation without explicit mode detection.
**Trade-offs:** EWMA is simple and cheap to compute but has a "cold start" problem at session beginning. Mitigation: seed with user's historical average from previous sessions. The decay factor (alpha) needs tuning -- too low and it lags behind real topic shifts; too high and it's too sensitive to noise.

**Example:**
```typescript
class AdaptiveTopicDetector {
  private ewmaDistance: number;
  private ewmaVariance: number;
  private alpha = 0.3;  // Decay factor, tunable per user
  private sensitivityMultiplier = 1.5;  // Standard deviations above mean

  constructor(seedDistance: number, seedVariance: number) {
    this.ewmaDistance = seedDistance;
    this.ewmaVariance = seedVariance;
  }

  detectShift(currentDistance: number): { shifted: boolean; confidence: number } {
    const threshold = this.ewmaDistance +
      this.sensitivityMultiplier * Math.sqrt(this.ewmaVariance);

    const shifted = currentDistance > threshold;
    const confidence = shifted
      ? Math.min((currentDistance - threshold) / threshold, 1.0)
      : 0;

    // Update EWMA
    this.ewmaDistance = this.alpha * currentDistance +
      (1 - this.alpha) * this.ewmaDistance;
    const diff = currentDistance - this.ewmaDistance;
    this.ewmaVariance = this.alpha * (diff * diff) +
      (1 - this.alpha) * this.ewmaVariance;

    return { shifted, confidence };
  }
}
```

### Pattern 4: Pluggable Embedding Strategy

**What:** The embedding engine is an interface with multiple implementations. Strategy selection happens at startup based on available resources, with runtime fallback.
**When to use:** Always. Different environments have different constraints. A developer laptop with 16GB RAM can run local ONNX models. A constrained CI environment might need keyword-only search. Future Claude API changes might enable piggyback embeddings.
**Trade-offs:** Interface indirection adds slight complexity. The "hybrid" strategy (local ONNX + API fallback) requires careful error handling. Must handle the case where embeddings are unavailable gracefully -- FTS5 keyword search still works without vectors.

**Example:**
```typescript
interface EmbeddingEngine {
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
  dimensions(): number;
  name(): string;
}

class LocalOnnxEngine implements EmbeddingEngine {
  // Uses @xenova/transformers with all-MiniLM-L6-v2
  // 384 dimensions, ~10-30ms per embedding on CPU
}

class KeywordOnlyEngine implements EmbeddingEngine {
  // Returns null embeddings -- system falls back to FTS5-only search
  // Zero overhead, still useful
}

class HybridEngine implements EmbeddingEngine {
  // Tries local ONNX first, falls back to keyword-only on failure
  // Logs degradation for observability
}
```

### Pattern 5: Single-Writer Database Access

**What:** SQLite with WAL mode allows concurrent reads but only one writer. All writes go through the main thread via a sequential write queue. The analysis worker sends write requests to the main thread via `postMessage`. MCP tool reads happen directly on the main thread's database connection.
**When to use:** Always with SQLite + `better-sqlite3`. This is not optional -- concurrent writers cause `SQLITE_BUSY` errors.
**Trade-offs:** Write throughput is limited to one thread, but `better-sqlite3` with WAL achieves 2000+ writes/second for typical observation sizes, far exceeding our needs (observations arrive at human conversation speed). Read latency stays under 6ms even under load.

## Data Flow

### Observation Capture Flow

```
Claude Code fires hook event (e.g., PostToolUse)
    │
    ▼
Hook script reads JSON from stdin
    │
    ▼
HTTP POST to core process ingest endpoint (fire-and-forget)
    │
    ▼
Ingest receiver normalizes JSON into Observation struct
    │
    ▼
Observation pushed to in-memory queue
    │
    ▼
Analysis worker picks up observation from queue
    │
    ├──▶ Embedding generation (10-30ms local ONNX)
    ├──▶ Topic shift detection (cosine distance vs EWMA threshold)
    ├──▶ Entity extraction (regex + heuristics)
    └──▶ Relationship detection (co-occurrence, temporal proximity)
    │
    ▼
Analysis results sent to main thread via postMessage
    │
    ▼
Main thread writes to SQLite (observation + embedding + entities + edges)
    │
    ▼
SSE broadcast to connected Web UI clients
```

### Context Injection Flow (SessionStart)

```
Claude Code fires SessionStart hook (sync, blocking)
    │
    ▼
Hook script queries core process: GET /context/session-start
    │
    ▼
Core process reads from SQLite:
    ├──▶ Last session summary
    ├──▶ Active stashed contexts
    ├──▶ Recent high-value observations
    └──▶ Current topic state
    │
    ▼
Core process formats context string (token-aware, max ~2000 tokens)
    │
    ▼
Hook script prints context to stdout
    │
    ▼
Claude Code adds stdout text to Claude's context window
```

### MCP Search Flow

```
Claude invokes MCP tool (e.g., search)
    │
    ▼
MCP server receives tool call via stdio
    │
    ▼
Tool handler executes:
    ├──▶ FTS5 keyword search (< 1ms for typical queries)
    ├──▶ sqlite-vec vector search (< 5ms for < 100K observations)
    └──▶ Score fusion (RRF or weighted combination)
    │
    ▼
Results formatted as compact index (IDs + scores + snippets)
    │
    ▼
Response sent back via stdio to Claude
```

### Topic Shift + Context Stash Flow

```
Analysis worker detects topic shift (confidence > threshold)
    │
    ▼
Current topic context serialized:
    ├──▶ Active topic label
    ├──▶ Key observations from current topic
    ├──▶ Open questions / incomplete threads
    └──▶ Relevant entity IDs
    │
    ▼
Stash record written to SQLite (stash table)
    │
    ▼
New topic initialized with fresh EWMA baseline
    │
    ▼
Next MCP interaction or SessionStart injects:
    "Topic shift detected. Previous context stashed.
     Use /laminark:resume to return."
```

### Key Data Flows

1. **Observation capture:** Hook event --> ingest queue --> analysis worker --> SQLite write --> SSE broadcast. Latency is irrelevant because async hooks decouple this from Claude's response generation.
2. **Memory retrieval:** MCP tool call --> SQLite read (FTS5 + vector) --> formatted response. Must be fast (< 50ms) because it blocks Claude's reasoning.
3. **Context injection:** SessionStart hook --> SQLite read --> stdout to Claude. Must be fast (< 200ms) because it blocks session startup.
4. **Web UI updates:** SSE push from main thread whenever a write completes. No polling. Graph/timeline state managed client-side.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0-10K observations | Single SQLite file, no optimization needed. FTS5 and sqlite-vec handle this trivially. Typical for weeks of daily use. |
| 10K-100K observations | sqlite-vec may slow for full-table vector scans. Add pre-filtering by session/time window before vector search. FTS5 remains fast. Curation agent becomes important for pruning low-value observations. |
| 100K-1M observations | Partition observations by time period (monthly). Archive old observations to separate SQLite files. Keep active window in primary database. Vector index may need quantization (int8) for memory. |
| 1M+ observations | Unlikely for single-user tool. If reached, consider external vector store (Qdrant) while keeping SQLite for metadata/FTS. But this is premature optimization territory. |

### Scaling Priorities

1. **First bottleneck: Vector search latency.** sqlite-vec does brute-force KNN. At 100K 384-dim float32 vectors, search takes ~50-100ms. Mitigation: pre-filter by time window (last N sessions) before vector scan. This keeps the effective search set small.
2. **Second bottleneck: ONNX model load time.** First embedding after cold start takes 1-3 seconds for model loading. Mitigation: lazy-load on first observation, not at process startup. Cache the model in the worker thread. The user won't notice because it happens during their first prompt.
3. **Third bottleneck: WAL file growth.** Continuous writes without checkpointing grow the WAL file. Mitigation: periodic `PRAGMA wal_checkpoint(PASSIVE)` during quiet periods (session end, long pauses). Never use `TRUNCATE` mode during active use.

## Anti-Patterns

### Anti-Pattern 1: Synchronous Embedding in Hook Scripts

**What people do:** Generate embeddings inside the hook script itself before returning, making the hook take 50-100ms+ instead of < 5ms.
**Why it's wrong:** Sync hooks block Claude's response generation. Even async hooks should exit fast because each creates a separate OS process. Embedding generation should happen in the persistent analysis worker, not in ephemeral hook processes.
**Do this instead:** Hook scripts only capture and forward data. All analysis happens in the long-running core process's worker thread.

### Anti-Pattern 2: Multiple SQLite Connections Writing Concurrently

**What people do:** Open separate `better-sqlite3` connections in the MCP server, analysis worker, and web server, all writing to the same database.
**Why it's wrong:** SQLite with WAL mode supports concurrent reads but only one writer at a time. Multiple writers cause `SQLITE_BUSY` errors or WAL file contention. `better-sqlite3` uses synchronous operations, so a busy-wait timeout just blocks the event loop.
**Do this instead:** Funnel all writes through a single connection on the main thread. The analysis worker sends write requests via `postMessage`. MCP and web servers only read.

### Anti-Pattern 3: Embedding Every Token of Tool Output

**What people do:** Generate embeddings for the full output of every tool call, including multi-thousand-line file reads and grep results.
**Why it's wrong:** Most tool output is noise (file contents, build logs, test output). Embedding it wastes CPU time and pollutes the vector space with low-signal data. It also bloats the database with large observation records.
**Do this instead:** Extract a semantic summary from tool output (first ~200 characters + tool name + file paths mentioned). Embed the summary, not the raw output. Store raw output only if explicitly requested by user or if the tool is Write/Edit (actual code changes have high signal).

### Anti-Pattern 4: Blocking MCP Responses on Analysis Completion

**What people do:** Wait for embedding generation and topic detection to complete before returning MCP search results.
**Why it's wrong:** MCP tool responses should use whatever data is already in the database. Analysis of the current observation can happen after the search response is sent. If Claude searches for context, it needs results now, not after a 50ms embedding delay.
**Do this instead:** MCP reads are always against committed database state. New observations flow through the async pipeline and become searchable on the next query, not the current one. This is eventually consistent and perfectly acceptable for a memory system.

### Anti-Pattern 5: Static Topic Shift Threshold

**What people do:** Use a fixed cosine distance threshold (e.g., 0.7) for all users and sessions.
**Why it's wrong:** Users have wildly different working patterns. A developer with ADHD may naturally jump between topics more frequently, making their inter-observation distances higher on average. A static threshold would either miss real shifts for focused users or trigger false positives for scattered users.
**Do this instead:** Use EWMA-based adaptive threshold that learns the user's natural variance. Seed new sessions with historical averages. Allow the sensitivity multiplier to be user-configurable as a dial between "sensitive" and "relaxed."

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Claude Code (hooks) | Shell scripts receiving JSON on stdin. `async: true` for non-blocking capture. Sync for SessionStart context injection. | Hook scripts are the only integration point with Claude Code host process. They must be fast and reliable. |
| Claude Code (MCP) | stdio transport via `@modelcontextprotocol/sdk`. Tools defined with Zod schemas. | Primary interface for Claude to interact with memory. MCP server runs as child process of Claude Code. |
| Claude API (optional) | HTTP API for high-quality summarization in curation agent. | Not required. Only used if configured. Adds cost but improves summary quality over heuristic approaches. |
| ONNX Runtime (local) | `@xenova/transformers` loads models from HuggingFace Hub (cached locally after first download). | First load downloads ~90MB model. Subsequent loads are instant from cache. Graceful degradation if unavailable. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Hook scripts <-> Core process | HTTP POST to localhost (ingest endpoint) or Unix domain socket | Fire-and-forget. Core process must handle hook script crashes gracefully (lost observation is acceptable). |
| Main thread <-> Analysis worker | `worker_threads` `postMessage` | Structured cloning for observation data. Worker sends back analysis results. Main thread writes to DB. |
| MCP server <-> Storage | Direct `better-sqlite3` read calls on main thread | Synchronous reads are fast (< 5ms). No async overhead needed. |
| Web server <-> Storage | Direct `better-sqlite3` read calls on main thread | Same connection as MCP server. SSE broadcasts triggered by write completions. |
| Web UI <-> Web server | HTTP REST for initial load, SSE for live updates | SPA fetches initial state via REST, then subscribes to SSE for incremental updates. |

## Build Order (Dependency Chain)

The architecture has clear dependency layers. Each layer must work before the next can be built effectively.

### Layer 1: Storage Engine (no dependencies)
Build first because everything reads from or writes to it.
- SQLite + WAL + better-sqlite3 connection
- Schema migrations (observations, sessions, topics, graph nodes/edges)
- FTS5 virtual table setup
- sqlite-vec extension loading + vector table
- Basic CRUD operations for observations and sessions

### Layer 2: MCP Server + Ingest Receiver (depends on Layer 1)
Build second because this is the primary user-facing interface and the data entry point.
- MCP server with `search`, `timeline`, `get_observations`, `save_memory` tools
- Ingest HTTP endpoint (receives hook data, writes to queue/DB)
- Hybrid search (FTS5 keyword + vector if available)
- These can be built in parallel since they share the storage layer but don't depend on each other

### Layer 3: Hook Integration (depends on Layer 2)
Build third because hooks need the ingest endpoint to send data to.
- Hook dispatcher script (fire-and-forget POST)
- SessionStart context injection script (sync query + stdout)
- hooks.json configuration
- Plugin manifest (plugin.json, .mcp.json)

### Layer 4: Analysis Pipeline (depends on Layers 1 + 2)
Build fourth. This is where the "intelligence" lives but the system works without it (keyword-only search).
- Worker thread setup
- Pluggable embedding engine (start with local ONNX)
- Topic shift detection (EWMA-based)
- Entity extraction + relationship detection
- Knowledge graph population

### Layer 5: Web UI (depends on Layers 1 + 4)
Build last because it's visualization of data that must exist first.
- HTTP server + SSE endpoints
- Knowledge graph visualization (react-force-graph or D3)
- Timeline view
- Session browser
- Curation agent (runs during quiet periods, enhances data quality)

### Build Order Rationale

This order means each layer delivers standalone value:
- **After Layer 1-2:** Claude can save and search memories (keyword-only). Functional but basic.
- **After Layer 3:** Automatic observation capture. No manual intervention needed. System "just works."
- **After Layer 4:** Semantic search, topic detection, knowledge graph. The "intelligence" layer.
- **After Layer 5:** Visual exploration and curation. Polish and long-term data quality.

The critical insight is that Layers 1-3 form a minimum viable plugin. A developer could use Laminark with only keyword search and manual saves, and it would still be useful. Layers 4-5 add the differentiating intelligence and visual features.

## Sources

- [Claude Code Plugin SDK - Official Documentation](https://code.claude.com/docs/en/plugins) (HIGH confidence)
- [Claude Code Hooks Reference - Official Documentation](https://code.claude.com/docs/en/hooks) (HIGH confidence)
- [Claude Code Plugins Reference - Official Documentation](https://code.claude.com/docs/en/plugins-reference) (HIGH confidence)
- [MCP Architecture Overview - Official Specification](https://modelcontextprotocol.io/docs/learn/architecture) (HIGH confidence)
- [MCP TypeScript SDK - Official Repository](https://github.com/modelcontextprotocol/typescript-sdk) (HIGH confidence)
- [better-sqlite3 Performance Documentation](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) (HIGH confidence)
- [sqlite-vec - Official Repository](https://github.com/asg017/sqlite-vec) (HIGH confidence)
- [Node.js Worker Threads Documentation](https://nodejs.org/api/worker_threads.html) (HIGH confidence)
- [Scaling SQLite with Node Worker Threads](https://dev.to/lovestaco/scaling-sqlite-with-node-worker-threads-and-better-sqlite3-4189) (MEDIUM confidence)
- [@xenova/transformers - NPM](https://www.npmjs.com/package/@xenova/transformers) (HIGH confidence)
- [Claude-Mem Architecture (predecessor reference)](https://github.com/thedotmack/claude-mem) (MEDIUM confidence)
- [Engram Memory Layer (predecessor reference)](https://github.com/EvolvingLMMs-Lab/engram) (MEDIUM confidence)
- [react-force-graph - GitHub](https://github.com/vasturiano/react-force-graph) (HIGH confidence)

---
*Architecture research for: Claude Code memory plugin with adaptive topic detection and visual memory exploration*
*Researched: 2026-02-08*
