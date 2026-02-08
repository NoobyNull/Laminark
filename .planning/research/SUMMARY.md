# Project Research Summary

**Project:** Laminark - Claude Code Persistent Adaptive Memory Plugin
**Domain:** Developer tooling / LLM memory system / Claude Code plugin
**Researched:** 2026-02-08
**Confidence:** HIGH

## Executive Summary

Laminark is a Claude Code plugin providing persistent cross-session memory with adaptive topic detection, semantic search, and visual exploration. The research reveals a crowded competitive landscape (Anthropic's official memory server, Mem0 OpenMemory, claude-mem, mcp-memory-service) where differentiation comes from adaptive per-user behavior and ADHD-friendly workflow patterns. The recommended architecture uses Node.js 22 LTS with SQLite + WAL for storage, sqlite-vec for vector search, and a pluggable embedding strategy defaulting to local ONNX models. The critical architectural insight is worker-thread-based analysis decoupled from MCP response latency, with zero-latency semantic processing during Claude's response generation window.

The key risks center on SQLite corruption from concurrent session access, embedding model lock-in without migration support, and context window poisoning from over-eager memory injection. These are well-understood problems with proven solutions: WAL mode with proper PRAGMA configuration eliminates corruption, storing original text with model version metadata enables migration, and 3-layer progressive disclosure (search index -> timeline -> full details) keeps token usage under control. The technology choices are conservative and proven - better-sqlite3 is the fastest SQLite driver for Node.js, FTS5 is battle-tested for keyword search, and sqlite-vec is the only in-process vector solution that doesn't require external services.

The competitive advantage lies in features no competitor offers: adaptive per-user topic shift detection that learns individual focus patterns, silent context stashing when topic drift is detected, and interactive web visualization combining knowledge graph and timeline views. These align directly with the ADHD-focused design philosophy. Success depends on building a reliable foundation (Phases 1-2) before adding intelligence features (Phases 3-4), and rigorously avoiding the "remember everything" trap that degrades both performance and retrieval quality.

## Key Findings

### Recommended Stack

The stack is optimized for zero-dependency deployment and in-process performance. Node.js 22 LTS provides Active LTS support until April 2027 with built-in WebSocket support and 30% faster startup than Node 20. TypeScript 5.8 with erasable syntax enables direct Node.js execution without build steps for development. The Model Context Protocol SDK (v1.26) is the official integration layer with Claude Code.

**Core technologies:**
- **Node.js 22 LTS + TypeScript 5.8**: Runtime and language - Active LTS, native WebSocket, erasable syntax support
- **better-sqlite3 ^12.6**: Synchronous SQLite driver - 100x faster than async alternatives for local queries, supports sqlite-vec extension loading
- **SQLite FTS5 + sqlite-vec ^0.1.7**: Hybrid search - FTS5 for keyword BM25 ranking (built-in), sqlite-vec for vector similarity (pure C, zero dependencies)
- **@huggingface/transformers ^3.8**: Local embeddings - ONNX Runtime with BGE Small EN v1.5 (384-dim), ~23MB model, sub-100ms inference, no API key needed
- **hono ^4.11**: Web server - 14KB, zero dependencies, 3.5x faster than Express, built on Web Standards
- **cytoscape ^3.33**: Graph visualization - Canvas-based, built-in graph algorithms (PageRank, centrality), handles hundreds of nodes smoothly

**Why not alternatives:**
- fastembed-js archived January 2026, no longer maintained
- node:sqlite requires Node 23.5+ (not LTS), cannot load extensions yet
- Express/Fastify are heavier and slower than Hono for a minimal localhost API
- React/Vue/Svelte are overkill for 2 visualization views - vanilla JS keeps bundle tiny

### Expected Features

The feature landscape is dominated by table stakes that every memory plugin must have: persistent cross-session storage, semantic vector search, keyword FTS5 search, hybrid search combining both, automatic observation capture via hooks, MCP tools for search/save/retrieval, session management, context injection on session start, and project scoping. Missing any of these makes the product feel incomplete.

**Must have (table stakes):**
- Persistent cross-session memory with SQLite single-file storage
- Hybrid search (FTS5 keyword + sqlite-vec semantic + score fusion)
- Automatic observation capture via PostToolUse/Stop/SessionEnd hooks
- 5-7 MCP tools with 3-layer progressive disclosure (search -> timeline -> get_observations)
- Session lifecycle management (SessionStart/SessionEnd) with concurrent session safety
- Context injection on session start (progressive index, not full dump)
- Session summaries generated at Stop hook
- Manual save/forget tools with soft delete for crash recovery
- Project scoping to prevent cross-contamination

**Should have (competitive differentiators):**
- **Adaptive per-user topic shift detection** - learns personal baseline per-session using rolling cosine similarity windows, triggers context stashing when drift exceeds adaptive threshold (NO competitor does this)
- **Zero-latency semantic processing** - embeddings and topic analysis happen during Claude's response generation window, the user is already waiting (architectural optimization)
- **Silent context stashing with recovery** - auto-preserve previous context thread on topic shift, `/resume` to return later (directly addresses ADHD workflow)
- **Knowledge graph with typed relationships** - entities (concepts, files, decisions, people, tools) and typed relations (uses, depends_on, decided_by) in SQLite, richer than Anthropic's flat JSONL, lighter than Graphiti's Neo4j
- **Interactive web visualization** - live knowledge graph (force-directed) + timeline view showing sessions and topic shifts (no competitor offers this level of integration)
- **Pluggable embedding strategy** - local ONNX (fast, private), Claude piggyback (extract from response generation), or hybrid (local for speed, Claude for quality)

**Defer (v2+):**
- Web UI visualization (high implementation cost, requires stable graph data model first)
- Proactive context re-surfacing ("where was I?" notifications)
- Conflict detection and flagging (needs enough memory volume that contradictions occur)
- Export/import for migration (until users need to move data)
- Temporal awareness / staleness detection (wait until outdated memories actually surface)

**Anti-features (explicitly NOT building):**
- Cloud sync / multi-device (massive complexity, turns local tool into SaaS product)
- Multi-user / team memory (requires auth, access control, conflict resolution)
- Aggressive auto-curation with LLM rewriting (hallucination risk corrupts ground truth)
- Heavy ML models (>500MB kills startup time and memory footprint)
- Electron/Tauri desktop wrapper (localhost web UI is universal and zero-install)

### Architecture Approach

The architecture is a single Node.js process handling both MCP (stdio transport) and web UI (HTTP localhost), with strict separation between capture (hooks), analysis (worker thread), storage (SQLite), and interfaces (MCP tools + web server). The critical pattern is decoupling: hooks fire-and-forget to an in-memory queue (<50ms), a worker thread processes the queue (embedding generation, topic detection, entity extraction), and the main thread handles all database writes and MCP responses. This ensures MCP tool latency stays under 50ms regardless of background analysis load.

**Major components:**
1. **Hook Dispatcher** - captures Claude Code lifecycle events (PostToolUse, SessionStart, etc.), enqueues instantly (<50ms), SessionStart is sync for context injection
2. **Ingest Queue** - in-memory FIFO buffer decouples capture speed from analysis speed, bounded size with overflow-to-disk fallback
3. **Analysis Pipeline** - worker thread processes queue: embedding generation (ONNX), topic shift detection (EWMA-based adaptive threshold), entity extraction, relationship detection
4. **Storage Engine** - SQLite + WAL for concurrent reads, FTS5 for keyword search, sqlite-vec for vector similarity, single writer pattern (main thread only)
5. **MCP Server** - stdio transport, 5-7 tools with progressive disclosure (index -> timeline -> full details), reads from committed DB state only
6. **Web Server** - Hono on localhost, SSE for live updates, serves static SPA assets, knowledge graph + timeline views
7. **Topic Detector** - EWMA-based adaptive threshold learns per-user variance, detects semantic shifts via embedding cosine distance, triggers context stashing

**Key patterns:**
- **Fire-and-forget hooks**: Hook scripts POST to core process and exit immediately, never block Claude's response
- **Worker thread analysis**: All CPU-intensive work (embeddings, topic detection) in `worker_threads` worker, main thread handles only I/O
- **Adaptive threshold via EWMA**: Exponentially weighted moving average of inter-observation distances naturally handles per-session variation without explicit mode detection
- **Single-writer DB access**: SQLite with WAL allows concurrent reads but only one writer - all writes funnel through main thread's connection
- **Pluggable embedding strategy**: Interface with multiple implementations (local ONNX, Claude piggyback, keyword-only fallback), strategy selected at startup

**Build order (dependency chain):**
1. **Layer 1: Storage Engine** (no dependencies) - SQLite + WAL + schema + FTS5 + sqlite-vec
2. **Layer 2: MCP Server + Ingest** (depends on Layer 1) - MCP tools + ingest endpoint + hybrid search
3. **Layer 3: Hook Integration** (depends on Layer 2) - hook scripts + hooks.json + plugin manifest
4. **Layer 4: Analysis Pipeline** (depends on Layers 1+2) - worker thread + embeddings + topic detection + knowledge graph
5. **Layer 5: Web UI** (depends on Layers 1+4) - HTTP server + graph visualization + timeline + curation agent

This ordering means Layers 1-3 form a minimum viable plugin (keyword search + automatic capture) that delivers standalone value, then Layers 4-5 add intelligence and visualization.

### Critical Pitfalls

Research identified 7 critical pitfalls that have killed similar projects. These are not theoretical - they're documented in post-mortems of Engram v1, the official Anthropic memory server concurrent session failures, and claude-mem's evolution.

1. **Indiscriminate memory storage ("remember everything")** - Storing every observation without filtering degrades retrieval quality because noise drowns signal. Harvard D3 Institute research shows add-all strategies perform worse than no memory. **Prevention:** Selective admission with relevance scoring, novelty checks, utility-based retention, retrieval-history-based pruning. Must be in Phase 1 storage layer from day one.

2. **Embedding model lock-in and migration hell** - Switching embedding models requires full reindex, but thousands of existing vectors are incompatible with new model's space. Query drift research confirms vectors from different models are mathematically incompatible. **Prevention:** Always store original text alongside vectors, store model identifier and version per vector row, design schema for background reindexing, build reindex command from day one. Phase 1 schema design is critical.

3. **Context window poisoning from memory injection** - Broad memory searches dump 10k-15k tokens before user's actual work, burning through 200k context window. Claude Code's Tool Search (January 2026) was built specifically to address 51k token MCP overhead. **Prevention:** 3-layer progressive disclosure (index -> timeline -> details), hard token budgets per retrieval (500-2000 max), `defer_loading: true` for secondary tools. Phase 1 MCP tool design locks this in.

4. **SQLite corruption from concurrent session access** - Multiple Claude Code sessions writing simultaneously cause "database is locked" errors, partial writes, or silent corruption. Official SQLite docs document specific corruption vectors. The dev.to post-mortem on Claude Code shows this exact failure. **Prevention:** WAL mode as first PRAGMA, `busy_timeout` >=5000ms, single canonical file path (no symlinks), periodic WAL checkpoints, test with 3+ concurrent sessions from day one. Phase 1 database initialization.

5. **Dependency weight creep (the Engram lesson)** - Native binary dependencies (better-sqlite3, ONNX Runtime) require compilation, fail on machines without build tools, slow install, make package enormous. Engram's original stack needed Bun + Python + ChromaDB. **Prevention:** Strict dependency budget (0-1 native deps for core), make heavy deps optional (ONNX failure falls back to keyword-only), measure cold-start time in CI (<500ms budget), separate web UI into lazy-loaded optional component. Phase 1 foundation choices compound through all subsequent phases.

6. **Adaptive threshold over-engineering** - Complex ML pipeline for topic detection becomes impossible to debug, tune, or explain. Threshold behaves unpredictably - sometimes stashing too aggressively, sometimes not at all. Research on dynamic topic detection confirms "consistent instability" and brittleness in short-text scenarios. **Prevention:** Start with simple deterministic threshold (cosine drop >0.3 = shift), ship it, gather data, add adaptivity incrementally (session-level moving average, then per-user baseline), always provide manual override, log every decision with inputs, bound adaptation range [0.15, 0.6]. Phase 2 topic detection, but architecture must support swappable strategies from Phase 1.

7. **Knowledge graph becoming unqueryable hairball** - Every noun becomes a node, every co-occurrence an edge, graph accumulates thousands of dense meaningless connections within weeks. Queries pull back enormous subgraphs, visualization is unreadable. **Prevention:** Fixed entity type taxonomy from day one (Project, File, Decision, Problem, Solution, Tool, Person only), enforce relationship types (RELATES_TO, CAUSED_BY, SOLVED_BY, PART_OF), entity merging for synonyms ("the API" = "our REST API"), max node degree 50 edges, background graph maintenance for deduplication/pruning. Phase 3 knowledge graph, but type taxonomy designed before any construction begins.

## Implications for Roadmap

Based on research findings, the roadmap should follow the architecture's natural dependency layers, with each phase delivering standalone value before the next begins. The build order (Storage -> MCP+Ingest -> Hooks -> Analysis -> Web UI) maps directly to phase structure because each layer depends on the previous being stable.

### Phase 1: Foundation - Storage, Search, and MCP Interface
**Rationale:** Everything reads from or writes to storage, so it must be rock-solid first. MCP tools are the primary interface Claude uses, so they come next. This phase addresses the most critical pitfalls (SQLite corruption, context window poisoning, dependency weight).

**Delivers:**
- SQLite database with WAL mode, schema migrations, FTS5 virtual tables
- basic CRUD operations for observations and sessions
- Hybrid search (FTS5 keyword + sqlite-vec if available, graceful degradation to keyword-only)
- 5 core MCP tools (search, timeline, get_observations, save_memory, forget) with 3-layer progressive disclosure
- Project scoping and session management
- Ingest HTTP endpoint for receiving hook data

**Addresses features:** Persistent storage, hybrid search, MCP tools, session management, project scoping, manual save/forget

**Avoids pitfalls:** SQLite corruption (WAL + busy_timeout + concurrent session tests), context window poisoning (progressive disclosure + token budgets), embedding lock-in (schema with model_version column + store original text), dependency weight (minimal native deps, ONNX optional)

**Research needs:** Standard patterns. SQLite + better-sqlite3 + FTS5 are well-documented. Skip `/gsd:research-phase`.

---

### Phase 2: Automatic Capture and Basic Topic Detection
**Rationale:** Foundation is stable, now add automatic observation capture. This is where the plugin becomes "zero-friction" - no manual intervention needed. Basic topic detection proves the concept before adding adaptivity.

**Delivers:**
- Hook dispatcher scripts (fire-and-forget POST to ingest endpoint)
- SessionStart context injection script (sync query + stdout)
- hooks.json configuration and plugin manifest
- Worker thread setup for async analysis
- Local ONNX embedding engine (pluggable strategy interface, default implementation)
- Basic topic shift detection with static threshold (cosine similarity drop >0.3)
- Session summaries generated at Stop hook

**Addresses features:** Automatic observation capture, context injection on session start, session summaries, semantic search foundation, basic topic shift detection

**Avoids pitfalls:** Hook blocking (fire-and-forget pattern), indiscriminate storage (admission filter in ingest pipeline), threshold over-engineering (start simple, deterministic)

**Research needs:** Claude Code hooks API (official docs, high confidence). ONNX Runtime + @huggingface/transformers (standard integration). Skip deep research.

---

### Phase 3: Adaptive Intelligence - Topic Learning and Knowledge Graph
**Rationale:** Core capture and search are working. Now add the intelligence layer that differentiates Laminark: adaptive thresholds that learn per-user patterns, and knowledge graph for relationship queries.

**Delivers:**
- Adaptive threshold learning (EWMA-based, per-user historical baseline)
- Context stashing triggered by topic shift detection
- Resume command to restore stashed context
- Entity extraction from observations (typed: Project, File, Decision, Problem, Solution, Tool, Person)
- Relationship detection (typed: uses, depends_on, decided_by, related_to)
- Knowledge graph storage (nodes + edges in SQLite)
- Graph query capability via MCP tools

**Addresses features:** Adaptive per-user topic shift detection, silent context stashing with recovery, knowledge graph with typed relationships, "where was I?" query foundation

**Avoids pitfalls:** Threshold over-engineering (incremental adaptivity with manual override + logging), graph hairball (fixed taxonomy + relationship types + max node degree)

**Research needs:** HIGH. Topic detection adaptation strategies need validation. Entity extraction from conversation text is noisy. Recommend `/gsd:research-phase` for:
- EWMA parameter tuning (alpha decay factor, sensitivity multiplier)
- Entity extraction heuristics and coreference resolution strategies
- Graph maintenance patterns (deduplication, pruning)

---

### Phase 4: Visualization and Curation
**Rationale:** Data model is stable, intelligence features are working. Now add visual exploration and long-term data quality maintenance.

**Delivers:**
- Web server with SSE endpoints for live updates
- Interactive knowledge graph visualization (cytoscape force-directed layout)
- Timeline view showing sessions, observations, topic shift points
- Session browser (list + detail views)
- Curation agent for periodic consolidation (merge similar observations, generate summaries, prune low-value data)

**Addresses features:** Interactive web visualization (graph + timeline), curation for long-term data quality

**Avoids pitfalls:** Graph rendering performance (viewport culling, node count limits, level-of-detail), UI empty state handling

**Research needs:** MEDIUM. Cytoscape integration is well-documented, but optimizing force-directed layout for 500+ nodes and ensuring viewport culling may need performance testing. Can likely proceed with standard patterns, but flag for potential deep-dive if performance issues arise during implementation.

---

### Phase Ordering Rationale

- **Dependencies drive order:** Storage before MCP before hooks before analysis before UI - each layer depends on stability of previous
- **Validate core loop first:** Phases 1-2 complete the memory loop (capture -> store -> search -> inject) before adding intelligence
- **Defer visualization until data is stable:** Web UI in Phase 4 ensures the knowledge graph schema won't change after visualization is built
- **Incremental complexity:** Each phase adds one major complexity dimension (Phase 1: database, Phase 2: async capture, Phase 3: adaptive learning, Phase 4: visual UI)

**Pitfall prevention strategy:**
- Critical pitfalls (SQLite corruption, context window poisoning, embedding lock-in) addressed in Phase 1 before any scale
- Medium pitfalls (threshold over-engineering, graph hairball) addressed in Phases 2-3 with incremental approach
- Performance pitfalls (UI rendering) deferred to Phase 4 when they actually manifest

### Research Flags

**Phases needing deeper research during planning:**
- **Phase 3 (Adaptive Intelligence)**: Topic detection adaptation requires EWMA parameter tuning, entity extraction from noisy conversation text needs heuristics validation, graph maintenance patterns need design
- **Phase 4 (Visualization)**: Graph rendering performance optimization at 500+ nodes may need deep-dive, though standard patterns likely sufficient

**Phases with standard patterns (skip research-phase):**
- **Phase 1 (Foundation)**: SQLite + better-sqlite3 + FTS5 + MCP SDK are extensively documented with high-confidence sources
- **Phase 2 (Capture)**: Claude Code hooks API has official documentation, ONNX Runtime integration is standard

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core technologies verified via official docs and npm. Node.js 22 LTS, better-sqlite3, MCP SDK, Hono, Cytoscape all have stable releases and extensive documentation. Only medium confidence item: sqlite-vec is alpha but no realistic in-process alternative exists. |
| Features | MEDIUM-HIGH | Strong competitor analysis (Anthropic official, Mem0, claude-mem, mcp-memory-service) provides solid baseline. Table stakes features verified across multiple implementations. Adaptive topic detection claims need validation during implementation - this is novel territory. |
| Architecture | HIGH | Claude Code plugin SDK verified via official docs. SQLite/MCP patterns verified via official sources and production implementations (claude-mem, Engram). Worker thread analysis pattern is standard Node.js. Single-writer SQLite pattern is well-documented. |
| Pitfalls | HIGH | Multiple verified sources including official SQLite corruption docs, dev.to post-mortem on concurrent sessions, claude-mem evolution, Engram lessons, Harvard D3 Institute research on memory quality. These are documented failures, not theoretical risks. |

**Overall confidence:** HIGH

The technology stack is proven and documented. The feature landscape is well-understood through competitor analysis. The architecture follows established patterns for Claude Code plugins and SQLite usage. The pitfalls are drawn from real post-mortems. The main uncertainty is in the adaptive topic detection implementation - the concept is sound (EWMA for adaptive thresholds) but parameter tuning will require iteration during Phase 3.

### Gaps to Address

**Adaptive topic detection parameters:**
- EWMA decay factor (alpha) optimal value for conversation-speed observations (minutes between messages vs. seconds)
- Sensitivity multiplier (how many standard deviations above mean = shift)
- Cold start strategy (how to seed EWMA at session beginning before sufficient history)
- **Handling:** Phase 3 implementation should include A/B testing framework with multiple parameter sets, logged for post-hoc analysis. Plan to iterate thresholds based on real usage data.

**Entity extraction quality from casual conversation:**
- Coreference resolution ("the thing," "that bug," "the PR") without NLP pipeline
- Entity boundary detection (when does "the frontend" vs "frontend code" vs "our React frontend" refer to same entity?)
- **Handling:** Start with conservative extraction (explicit nouns only), add sophistication incrementally based on graph quality metrics. Acceptable to under-extract initially vs. over-extract and create noise.

**Embedding model selection tradeoffs:**
- Quality vs. speed vs. size (all-MiniLM-L6-v2 at 22MB vs. BGE Small EN v1.5 at 33MB)
- Dimensionality impact on sqlite-vec performance (384-dim vs. 768-dim)
- **Handling:** Phase 2 should benchmark both models on representative conversation snippets, measure search quality and latency. Make model configurable for future flexibility.

**Knowledge graph maintenance frequency:**
- How often to run deduplication/pruning without impacting interactive performance
- Trigger-based (after N observations) vs. time-based (nightly) vs. on-demand
- **Handling:** Phase 3 should implement configurable scheduling with defaults, monitor maintenance duration, adjust based on database size growth patterns.

## Sources

### Primary (HIGH confidence)
- [Claude Code Plugin Docs](https://code.claude.com/docs/en/plugins) - Plugin structure, hooks, MCP integration
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) - PostToolUse, SessionStart, notification hooks
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) - v1.26.0, v2 roadmap
- [SQLite Official: How To Corrupt An SQLite Database](https://www.sqlite.org/howtocorrupt.html) - Corruption vectors and prevention
- [SQLite Official: Write-Ahead Logging](https://sqlite.org/wal.html) - WAL mode behavior, checkpoint management
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) - v12.6.2, performance docs
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec) - v0.1.7-alpha, pure C, Node.js integration
- [SQLite FTS5 docs](https://www.sqlite.org/fts5.html) - BM25, external content tables
- [@huggingface/transformers npm](https://www.npmjs.com/package/@huggingface/transformers) - v3.8.1, ONNX Runtime
- [Hono.js](https://hono.dev/) - v4.11.9, Web Standards API
- [Cytoscape.js](https://js.cytoscape.org/) - v3.33.1, graph algorithms
- [Node.js Worker Threads Documentation](https://nodejs.org/api/worker_threads.html) - Official API docs

### Secondary (MEDIUM confidence)
- [Anthropic Official Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) - 9 MCP tools, entities+relations pattern
- [claude-mem](https://github.com/thedotmack/claude-mem) - 3-layer progressive disclosure, hooks architecture
- [Fixing Claude Code's Concurrent Session Problem](https://dev.to/daichikudo/fixing-claude-codes-concurrent-session-problem-implementing-memory-mcp-with-sqlite-wal-mode-o7k) - Real-world SQLite failure post-mortem
- [Claude Code MCP Context Bloat 46.9% Reduction](https://medium.com/@joe.njenga/claude-code-just-cut-mcp-context-bloat-by-46-9-51k-tokens-down-to-8-5k-with-new-tool-search-ddf9e905f734) - Token overhead measurements
- [Harvard D3 Institute: Selective Recall Boosts LLM Performance](https://d3.harvard.edu/smarter-memories-stronger-agents-how-selective-recall-boosts-llm-performance/) - Indiscriminate storage research
- [Embedding Drift and Model Compatibility](https://arxiv.org/abs/2506.00037) - Query drift compensation, reindex requirements
- [Semantic chunking via cosine similarity](https://superlinked.com/vectorhub/articles/semantic-chunking) - Sliding window topic segmentation
- [D3 Force Layout Optimization](https://www.nebula-graph.io/posts/d3-force-layout-optimization) - Viewport culling, WebGL fallback
- [Mem0 OpenMemory MCP](https://mem0.ai/openmemory) - Docker+Postgres+Qdrant competitor architecture
- [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) - Semantic search implementation
- [Zep/Graphiti](https://github.com/getzep/graphiti) - Temporal knowledge graph reference
- [Engram](https://github.com/EvolvingLMMs-Lab/engram) - Predecessor architecture, privacy-first design

### Tertiary (LOW confidence, needs validation)
- [Google Memory Bank](https://dr-arsanjani.medium.com/introducing-memory-bank-building-stateful-personalized-ai-agents-with-long-term-memory-f714629ab601) - Topic-based memory concepts
- [MCP Memory Benchmark](https://aimultiple.com/memory-mcp) - Operation accuracy metrics
- [ADHD Developer Workflow Patterns](https://super-productivity.com/blog/adhd-developer-productivity-guide/) - Context switching costs

---
*Research completed: 2026-02-08*
*Ready for roadmap: yes*
