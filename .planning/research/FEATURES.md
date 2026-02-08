# Feature Research

**Domain:** Claude Code persistent memory plugin (MCP server + hooks)
**Researched:** 2026-02-08
**Confidence:** MEDIUM-HIGH (strong competitor landscape data; adaptive topic detection claims need validation during implementation)

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete. Every serious MCP memory plugin ships these.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Persistent cross-session memory | The entire point. Anthropic's official memory server, Mem0 OpenMemory, claude-mem, mcp-memory-service all do this. Users leave instantly without it. | MEDIUM | SQLite + WAL proven in Engram v1. Single-file storage is a strength over Mem0's Docker+Postgres+Qdrant stack. |
| Semantic search (vector similarity) | Users expect "find what I was working on" not "search exact keywords." Mem0, mcp-memory-service, claude-mem all provide vector search. | MEDIUM | sqlite-vec for vectors, sentence-transformers or ONNX model for embeddings. Pluggable strategy means this complexity is contained. |
| Full-text keyword search (FTS5) | Semantic search alone misses exact terms (function names, error codes, file paths). Hybrid search is now standard -- claude-mem uses it, Zep/Graphiti uses BM25+semantic+graph traversal. | LOW | SQLite FTS5 is battle-tested. Already proven in Engram v1. |
| Hybrid search (vector + keyword combined) | Single-mode search frustrates users. Graphiti achieves P95 300ms with hybrid. Claude-mem weights 70% semantic + 30% BM25. | MEDIUM | Requires score normalization between FTS5 rank scores and cosine similarity. Reciprocal rank fusion or weighted combination. |
| Automatic observation capture via hooks | Users will not manually save memories. Claude-mem's PostToolUse hook captures every tool execution automatically. This is the baseline expectation. | MEDIUM | Queue-based decoupling: hooks enqueue instantly, worker processes async. Claude-mem pattern: Hook -> Queue -> Worker. Critical: hooks must return in <100ms. |
| MCP tools for search, save, retrieval | The interface Claude uses to interact with memory. Anthropic's official server has 9 tools. Claude-mem has 5 (search, timeline, get_observations, save_memory, __IMPORTANT). Mem0 has 4 (add, search, list, delete). | MEDIUM | 5-7 tools is the sweet spot. Anthropic's 9 is fine-grained (separate create_entities, create_relations, add_observations). Claude-mem's 3-layer progressive disclosure (search -> timeline -> get_observations) is token-efficient (~10x savings). |
| Session management | Track which observations belong to which session. Prevents cross-contamination when running multiple Claude Code instances. Claude-mem tracks session lifecycle via SessionStart/SessionEnd hooks. | MEDIUM | Session ID generation, lifecycle tracking (start/end timestamps), session-scoped queries. Must handle concurrent sessions safely with WAL mode. |
| Manual memory save | Users need to explicitly tell Claude "remember this." Every competitor has an explicit save/add tool. Anthropic has create_entities, Mem0 has add_memories, claude-mem has save_memory. | LOW | Simple insert into observations table + embedding generation. The "easy win" tool. |
| Context injection on session start | SessionStart hook loads relevant prior context so Claude starts informed. Claude-mem injects last 10 summaries + 50 observations as a progressive disclosure index. | MEDIUM | Must be fast (<2s). Progressive disclosure (index first, details on demand) is the right pattern -- injecting full context would blow token budgets. |
| Session summaries | Generate compressed summaries when sessions end. Claude-mem's Stop hook sends observations to Claude Agent SDK for AI compression (5000 tokens raw -> 500 tokens summary). | MEDIUM | Depends on LLM for compression quality. Can piggyback on Claude's response generation (the zero-latency insight from PROJECT.md). |
| Project scoping | Memories must be scoped to projects. The MCP memory benchmark found servers "may occasionally mix information from different projects." Mem0 groups by project_overview, component_context, etc. | LOW | Project ID derived from working directory or explicit config. Filter all queries by project. |
| Privacy controls | Users must be able to exclude sensitive content. Claude-mem supports `<private>` tags. Engram uses AES-256-GCM encryption. | LOW | At minimum: exclude patterns (like .env content), manual forget/delete tool. Encryption is nice-to-have, not table stakes for local-only. |
| Delete/forget capability | Users must be able to remove memories. Anthropic has delete_entities/delete_observations/delete_relations. Mem0 has delete_all_memories. | LOW | Soft delete (mark as forgotten) preferred over hard delete for crash recovery. Expose both targeted and bulk delete. |

### Differentiators (Competitive Advantage)

Features that set Memorite apart. Not expected, but valued. These are where Memorite competes.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Adaptive per-user topic shift detection** | NO competitor does this. Static thresholds fail for ADHD/variable focus patterns. Some days you're laser-focused (high threshold), some days scattered (low threshold). Memorite learns your personal baseline per-session using rolling cosine similarity windows between consecutive observations. When drift exceeds the adaptive threshold, it triggers context stashing. | HIGH | Requires: (1) rolling embedding comparison of consecutive observations, (2) per-user historical threshold data, (3) session-level recalibration based on early session behavior, (4) decay/learning rate for threshold adjustment. Research shows sliding window cosine similarity is standard for topic segmentation, but making it adaptive and per-user is novel. Depends on: embeddings infrastructure, observation capture. |
| **Zero-latency semantic processing** | Process embeddings and topic analysis during Claude's response generation time -- the user is already waiting. Claude-mem's worker processes async but still adds background load. Memorite makes this architectural: semantic work happens in the "free" compute window while Claude streams. No other memory plugin advertises this specific optimization. | HIGH | Requires precise lifecycle hook timing. PostToolUse fires during response generation, giving a window for parallel embedding computation. Must not block the response stream. Worker must be fast enough to complete before next observation arrives. |
| **Silent context stashing with recovery** | When topic shift is detected, silently preserve the previous context thread and notify the user it's been saved. User can `/resume` later. This directly addresses ADHD workflow: you jump topics, lose your thread, but the system caught it. No competitor does automatic stash-on-drift. | MEDIUM | Builds on adaptive topic detection. Stash = snapshot of current topic's observation cluster + summary. Resume = re-inject stashed context. Depends on: topic detection, session summaries. |
| **Knowledge graph with typed relationships** | Anthropic's official server stores entities+relations in flat JSONL. That's a toy. Zep/Graphiti builds real temporal knowledge graphs but requires Neo4j. Memorite builds a knowledge graph in SQLite with typed entities (concepts, files, decisions, people, tools) and typed relations (uses, depends_on, decided_by, related_to). Richer than Anthropic's, lighter than Graphiti's. | HIGH | Entity extraction from observations (LLM-assisted or rule-based). Relation inference. Graph query capability. Must not make the simple case complex -- knowledge graph should enhance search, not replace it. Depends on: observation capture, embeddings. |
| **Interactive web visualization (knowledge graph + timeline)** | Anthropic's memory-visualizer exists but is a static JSON viewer. No competitor offers a live, interactive graph exploration UI integrated with the memory server. D3.js force-directed graphs can visualize entity relationships. Timeline view shows conversation flow and topic shifts over time. | HIGH | Local web server (already needed for MCP SSE). D3.js or similar for force-directed graph. Timeline component showing sessions, topic shifts, stash points. Must be useful, not just pretty -- click a node to see its observations, filter by entity type, zoom to time range. Depends on: knowledge graph, session management. |
| **Pluggable embedding strategy** | Most competitors lock you into one approach (ChromaDB + sentence-transformers, or Qdrant, or OpenAI embeddings). Memorite supports: (1) local ONNX model (fast, private, works offline), (2) Claude piggyback (extract semantic features during response generation), (3) hybrid (local for speed, Claude for quality). User picks based on their constraints. | MEDIUM | Strategy pattern with common interface. Each strategy implements embed(text) -> vector. Config selects strategy. The Claude piggyback strategy is the novel one -- extracting embeddings from Claude's own processing. Depends on: core storage layer. |
| **ADHD-friendly workflow patterns** | The target user jumps between topics constantly. Design every feature around this: (1) stash/resume for topic recovery, (2) "where was I?" query that surfaces recently abandoned threads, (3) notification when stashed context might be relevant again, (4) minimal friction for all operations. No competitor explicitly designs for neurodivergent workflows. | MEDIUM | Mostly a design philosophy applied across features rather than a standalone feature. Stash/resume is the killer pattern. "Where was I?" is a specialized search query. Context re-surfacing is a proactive notification triggered by semantic similarity to stashed topics. Depends on: topic detection, context stashing, search. |
| **Progressive disclosure search (3-layer)** | Claude-mem pioneered this: search (compact index ~50-100 tokens/result) -> timeline (context around results) -> get_observations (full details ~500-1000 tokens/result). ~10x token savings vs dumping everything. This is genuinely better UX for the LLM consumer. | LOW | Already proven pattern. Implement search returning IDs+snippets, timeline returning chronological context, get_observations returning full content. Low complexity because the pattern is well-understood. Depends on: search infrastructure. |
| **Temporal awareness** | Zep/Graphiti's key insight: memories have timestamps and validity periods. "Uses React 17" becomes stale when "Upgraded to React 19" is recorded. Memorite should track when facts were true, not just when they were stored. Enables "what did we decide about X last week?" queries. | MEDIUM | Timestamps on all observations. Temporal queries (before/after/during). Staleness detection when newer observations contradict older ones. Depends on: observation capture, conflict detection. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems. Explicitly NOT building these.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Cloud sync / multi-device** | "I want my memories everywhere" | Massive complexity (encryption, conflict resolution, auth, server infrastructure). Engram tried zero-knowledge sync -- it's a whole product. Memorite is a local developer tool. Cloud sync turns it into a SaaS product. | Local-first, single machine. Export/import for migration. If someone needs sync, they can sync the SQLite file with Syncthing. |
| **Real-time everything (WebSocket live updates)** | "I want the graph to update live as I work" | WebSocket infrastructure adds complexity, debugging difficulty, connection management. For a local dev tool, the graph doesn't need sub-second updates. | Polling-based refresh (5-10s interval) for the web UI. HTTP SSE for MCP transport (already required). Good enough for a tool you glance at, not stare at. |
| **Multi-user / team memory** | "My team should share memories" | Requires auth, access control, conflict resolution between users, shared vs private memories. Completely different product. The MCP memory benchmark found project cross-contamination is already hard with ONE user. | Single-user only. If teams want shared context, that's a different tool (like a wiki or shared CLAUDE.md). |
| **Aggressive auto-curation (LLM rewriting memories)** | "Clean up and organize my memories automatically" | LLMs hallucinate. Auto-rewriting memories risks corrupting ground truth. Mem0's auto-categorization is useful but auto-editing is dangerous. You lose the original signal. | Store originals immutably. Generate summaries as a separate layer. Let the user curate explicitly via forget/update tools. Summaries can be regenerated; originals cannot. |
| **Heavy ML model dependency** | "Use the best embedding model for maximum quality" | Large models (>500MB) slow startup, consume memory, require GPU for reasonable speed. Engram v1 suffered from embedding overhead blocking UX. | Small ONNX models (all-MiniLM-L6-v2 at 22MB) for local embeddings. Quality is "good enough" for personal memory search. Claude piggyback for higher quality when available. |
| **Integration with non-Claude AI tools** | "Make it work with Cursor/Copilot/ChatGPT too" | MCP is the protocol, and many tools support it, but optimizing for Claude Code's specific hooks and lifecycle is where the value is. Generalizing dilutes the Claude-specific advantages (piggyback embeddings, response-generation timing). | Build for Claude Code first. MCP compliance means other tools can connect to the search tools, but hooks and tight integration are Claude Code only. |
| **Electron/Tauri desktop wrapper** | "I want a native app window" | Packaging overhead, update distribution, platform-specific bugs. A localhost web UI in the browser is universal and zero-install. | `localhost:PORT` web UI opened in default browser. Works everywhere, no wrapper needed. |
| **Complex conflict resolution agent** | "Automatically resolve contradictions between memories" | Engram v1 had a curation agent. It added latency, complexity, and sometimes got resolution wrong. For a personal tool, the user IS the conflict resolver. | Flag conflicts (show both versions), let user decide. Simple recency-based default (newer observation wins) with manual override. |
| **Granular permission system** | "Control which tools can read which memories" | Over-engineering for a single-user local tool. No threat model justifies RBAC on your own memories. | Simple privacy flag on sensitive observations. Binary: visible or hidden. |

## Feature Dependencies

```
[Observation Capture (hooks)]
    |
    +--requires--> [Session Management]
    |
    +--enables---> [Embeddings Infrastructure]
    |                   |
    |                   +--enables--> [Semantic Search]
    |                   |                 |
    |                   |                 +--combines-with--> [FTS5 Keyword Search]
    |                   |                                         |
    |                   |                                         +--produces--> [Hybrid Search]
    |                   |
    |                   +--enables--> [Topic Shift Detection]
    |                                     |
    |                                     +--enables--> [Adaptive Threshold Learning]
    |                                     |
    |                                     +--enables--> [Context Stashing]
    |                                                       |
    |                                                       +--enables--> [Stash Resume / "Where was I?"]
    |
    +--enables---> [Session Summaries]
    |
    +--enables---> [Knowledge Graph Extraction]
                        |
                        +--enables--> [Graph Queries]
                        |
                        +--enables--> [Web Visualization (Graph View)]

[MCP Tools]
    |
    +--requires--> [Hybrid Search]
    +--requires--> [Session Management]
    +--exposes---> [Progressive Disclosure (3-layer)]

[Web UI]
    |
    +--requires--> [Local HTTP Server]
    +--requires--> [Knowledge Graph] (for graph view)
    +--requires--> [Session Management] (for timeline view)
    +--enhanced-by--> [Topic Shift Detection] (to show shift points on timeline)

[Pluggable Embedding Strategy]
    |
    +--implements--> [Embeddings Infrastructure]
    +--strategy: local-onnx---> [ONNX Runtime + small model]
    +--strategy: claude-piggyback---> [Zero-latency semantic processing]
    +--strategy: hybrid---> [local for speed, claude for quality]
```

### Dependency Notes

- **Observation Capture requires Session Management:** Every observation must be tagged with a session ID. Session lifecycle must be tracked before observations can be stored meaningfully.
- **Semantic Search requires Embeddings Infrastructure:** Cannot do vector similarity without vectors. This is a hard dependency.
- **Topic Shift Detection requires Embeddings:** Detects shifts by comparing cosine similarity of consecutive observation embeddings. No embeddings = no topic detection.
- **Context Stashing requires Topic Shift Detection:** Stashing is triggered by detected topic shifts. Without detection, there's nothing to trigger the stash.
- **Knowledge Graph requires Observation Capture:** Entities and relations are extracted from observations. No raw material = no graph.
- **Web Visualization requires Knowledge Graph AND Session Management:** Graph view needs entities+relations. Timeline view needs session data with temporal ordering.
- **Progressive Disclosure enhances MCP Tools:** Not a hard dependency but the 3-layer pattern (search -> timeline -> get) should be the default tool design.
- **Adaptive Threshold Learning enhances Topic Shift Detection:** Basic topic detection can work with a static threshold. Adaptive learning makes it per-user. Can be added incrementally.

## MVP Definition

### Launch With (v1)

Minimum viable product -- validate that persistent adaptive memory works and is useful.

- [ ] **SQLite storage with WAL mode** -- foundation for everything; single-file, crash-safe
- [ ] **Observation capture via PostToolUse hook** -- automatic, non-blocking, queue-based
- [ ] **Session lifecycle management** -- SessionStart/SessionEnd hooks, session ID tracking
- [ ] **FTS5 keyword search** -- immediate search capability, no embedding dependency
- [ ] **Embeddings with local ONNX model** -- small model (all-MiniLM-L6-v2), enables semantic search
- [ ] **Hybrid search (FTS5 + vector)** -- the search experience users expect
- [ ] **5 MCP tools** -- search, timeline, get_observations, save_memory, forget
- [ ] **Context injection on SessionStart** -- progressive disclosure index of recent context
- [ ] **Session summaries on Stop hook** -- compressed session summaries via Claude Agent SDK
- [ ] **Project scoping** -- memories isolated per project directory
- [ ] **Basic topic shift detection** -- static threshold cosine similarity, proves the concept

### Add After Validation (v1.x)

Features to add once core is working and users confirm the approach.

- [ ] **Adaptive threshold learning** -- trigger: users report static threshold is too sensitive/insensitive for their work pattern
- [ ] **Context stashing + resume** -- trigger: topic detection is reliable enough to auto-stash
- [ ] **Knowledge graph extraction** -- trigger: search alone isn't enough; users want relationship queries
- [ ] **Pluggable embedding strategy (Claude piggyback)** -- trigger: ONNX model quality isn't sufficient for some users
- [ ] **Temporal awareness / staleness detection** -- trigger: users report outdated memories surfacing
- [ ] **Delete/forget with soft-delete** -- trigger: users need to manage memory size or remove sensitive content

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Web UI with interactive knowledge graph visualization** -- why defer: high implementation cost, requires stable graph data model first
- [ ] **Web UI timeline view** -- why defer: needs stable session/topic data model; can use MCP tools for timeline access initially
- [ ] **"Where was I?" proactive re-surfacing** -- why defer: requires reliable topic detection + stashing working first
- [ ] **Conflict detection and flagging** -- why defer: needs enough memory volume that contradictions actually occur
- [ ] **Export/import for migration** -- why defer: until there are users who need to move data

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Persistent storage (SQLite+WAL) | HIGH | LOW | P1 |
| Automatic observation capture (hooks) | HIGH | MEDIUM | P1 |
| Session management | HIGH | MEDIUM | P1 |
| FTS5 keyword search | HIGH | LOW | P1 |
| Local ONNX embeddings | HIGH | MEDIUM | P1 |
| Hybrid search | HIGH | MEDIUM | P1 |
| MCP tools (5 core) | HIGH | MEDIUM | P1 |
| Context injection (SessionStart) | HIGH | MEDIUM | P1 |
| Session summaries (Stop hook) | MEDIUM | MEDIUM | P1 |
| Project scoping | MEDIUM | LOW | P1 |
| Basic topic shift detection | MEDIUM | MEDIUM | P1 |
| Manual save/forget tools | MEDIUM | LOW | P1 |
| Adaptive threshold learning | HIGH | HIGH | P2 |
| Context stashing + resume | HIGH | MEDIUM | P2 |
| Knowledge graph extraction | MEDIUM | HIGH | P2 |
| Pluggable embeddings (Claude piggyback) | MEDIUM | HIGH | P2 |
| Temporal awareness | MEDIUM | MEDIUM | P2 |
| Progressive disclosure (3-layer search) | MEDIUM | LOW | P2 |
| Web UI - knowledge graph view | MEDIUM | HIGH | P3 |
| Web UI - timeline view | MEDIUM | HIGH | P3 |
| Proactive context re-surfacing | HIGH | HIGH | P3 |
| Conflict flagging | LOW | MEDIUM | P3 |
| Export/import | LOW | LOW | P3 |

**Priority key:**
- P1: Must have for launch -- core memory loop (capture -> store -> search -> inject)
- P2: Should have -- differentiators that make Memorite better than competitors
- P3: Nice to have -- visualization and polish once foundation is solid

## Competitor Feature Analysis

| Feature | Anthropic Official Memory | Mem0 OpenMemory | claude-mem | mcp-memory-service | Memorite (planned) |
|---------|---------------------------|-----------------|------------|--------------------|--------------------|
| Storage | JSONL file | Postgres + Qdrant (Docker) | SQLite + ChromaDB | SQLite-vec / ChromaDB | SQLite + WAL + FTS5 + sqlite-vec |
| Search | String matching on entities | Semantic (Qdrant) | Hybrid (FTS5 + Chroma) | Semantic (sentence-transformers) | Hybrid (FTS5 + sqlite-vec) |
| Auto capture | None (manual only) | Auto-capture in IDE | 5 lifecycle hooks | Manual + natural triggers | 5+ lifecycle hooks |
| Knowledge graph | Entities + Relations (flat) | None (categorized memories) | None | None | Typed entities + typed relations (SQLite) |
| Topic detection | None | None | None | None | **Adaptive per-user detection** |
| Context stashing | None | None | None | None | **Auto-stash on topic drift** |
| Visualization | Third-party static viewer | Dashboard (cloud) | Web viewer (port 37777) | None | **Interactive graph + timeline** |
| Embedding strategy | None (no vectors) | Qdrant vectors | ChromaDB vectors | Sentence-transformers | **Pluggable (ONNX / Claude / hybrid)** |
| Token efficiency | Read entire graph | Standard retrieval | 3-layer progressive disclosure | Standard retrieval | 3-layer progressive disclosure |
| Dependencies | Node.js only | Docker + Postgres + Qdrant | Bun + SQLite + ChromaDB | Python + ChromaDB | Node.js + SQLite only |
| ADHD workflow | None | None | None | None | **Stash/resume, "where was I?", adaptive thresholds** |
| Concurrency | N/A (file-based) | Database-level | Session-scoped | Not documented | WAL mode + session scoping |
| Privacy | Local file | Local Docker | `<private>` tags | Local | Exclude patterns + forget tool |

**Key competitive gaps Memorite fills:**
1. No competitor does adaptive topic detection
2. No competitor does automatic context stashing on topic drift
3. No competitor explicitly designs for neurodivergent workflows
4. No competitor offers pluggable embedding strategy
5. Interactive graph + timeline visualization is unique (Anthropic's is static, claude-mem's is basic)

**Where competitors are ahead:**
1. claude-mem is shipping and proven -- Memorite is greenfield
2. Mem0 has broad ecosystem support (13+ clients) -- Memorite is Claude Code only
3. Anthropic's official server has brand trust -- Memorite must earn it
4. Zep/Graphiti has sophisticated temporal graph tech -- Memorite's graph will be simpler

## Sources

- [Anthropic Official Knowledge Graph Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) -- 9 MCP tools, JSONL storage, entities+relations+observations (HIGH confidence)
- [Mem0 OpenMemory MCP](https://mem0.ai/openmemory) -- Docker+Postgres+Qdrant, 4 MCP tools, auto-tagging, local-first (HIGH confidence)
- [claude-mem](https://github.com/thedotmack/claude-mem) -- 5 MCP tools, 6 hooks, 3-layer progressive disclosure, Bun+SQLite+ChromaDB (HIGH confidence)
- [claude-mem Hooks Architecture](https://docs.claude-mem.ai/hooks-architecture) -- queue-based decoupling pattern, worker service, observation processing (HIGH confidence)
- [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) -- semantic search, sentence-transformers, dream-inspired consolidation (MEDIUM confidence)
- [Zep/Graphiti](https://github.com/getzep/graphiti) -- temporal knowledge graph, P95 300ms retrieval, hybrid search, Neo4j-based (HIGH confidence)
- [Engram (EvolvingLMMs-Lab)](https://github.com/EvolvingLMMs-Lab/engram) -- privacy-first, AES-256-GCM, SQLite storage, zero-knowledge sync (MEDIUM confidence)
- [MCP Memory Benchmark](https://aimultiple.com/memory-mcp) -- operation accuracy metrics, read-on-resume behavior, project cross-contamination issues (MEDIUM confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- SessionStart, PostToolUse, Stop, SessionEnd, 60s timeout, parallel execution (HIGH confidence)
- [Semantic chunking via cosine similarity](https://superlinked.com/vectorhub/articles/semantic-chunking) -- sliding window topic segmentation, threshold-based breakpoints (HIGH confidence)
- [Google Memory Bank (ACL 2025)](https://dr-arsanjani.medium.com/introducing-memory-bank-building-stateful-personalized-ai-agents-with-long-term-memory-f714629ab601) -- topic-based memory, async extraction, no latency in live conversation (MEDIUM confidence)
- [ADHD Developer Workflow Patterns](https://super-productivity.com/blog/adhd-developer-productivity-guide/) -- context switching costs (20+ min recovery), consolidation reduces friction (MEDIUM confidence)
- [D3.js Force-Directed Graphs](https://dev.to/nigelsilonero/how-to-implement-a-d3js-force-directed-graph-in-2025-5cl1) -- interactive visualization, force simulation, entity relationship display (HIGH confidence)
- [AI Agent Memory Conflict Resolution](https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/) -- priority-based resolution, rollback mechanisms, semantic consolidation (MEDIUM confidence)

---
*Feature research for: Claude Code persistent memory plugin*
*Researched: 2026-02-08*
