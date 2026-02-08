# Pitfalls Research

**Domain:** Claude Code persistent memory plugin with adaptive topic detection, knowledge graph, and web visualization
**Researched:** 2026-02-08
**Confidence:** HIGH (multiple verified sources, direct predecessor post-mortem data, SQLite official docs)

## Critical Pitfalls

### Pitfall 1: Indiscriminate Memory Storage ("Remember Everything" Trap)

**What goes wrong:**
The system stores every observation, conversation fragment, and tool output without filtering for quality or relevance. The memory database bloats rapidly. Worse, storing low-value or erroneous observations degrades retrieval quality -- the agent starts pulling back noise instead of signal. Harvard D3 Institute research shows that "add-all" strategies perform worse than having no memory at all, because incorrect or irrelevant memories propagate errors in downstream reasoning.

**Why it happens:**
It feels safer to capture everything than risk losing something important. The "never lose context" mission gets misinterpreted as "store every byte." Early-stage testing uses small datasets where bloat is invisible. Engram's viral success came from the concept of total recall, creating pressure to save aggressively.

**How to avoid:**
Implement selective memory admission from day one. Every observation passes through a quality gate before storage:
- Relevance score (does this relate to active work?)
- Novelty check (is this genuinely new information, or a rephrasing?)
- Utility-based retention (how likely is this to be useful in future retrieval?)
Use retrieval-history-based deletion: memories that are never retrieved after N retrievals of their neighbors get pruned. Research shows this yields up to 10% performance gains over naive strategies.

**Warning signs:**
- Database size growing faster than linearly with session count
- Search results returning obviously irrelevant observations
- Retrieval latency increasing session-over-session
- Memory search returning near-duplicate entries

**Phase to address:**
Phase 1 (Core Storage). The admission policy must be part of the storage layer from the start. Retrofitting filtering onto an already-bloated database requires a full reindex.

---

### Pitfall 2: Embedding Strategy Lock-in and Migration Hell

**What goes wrong:**
You pick an embedding model, store thousands of vectors, then need to change models (better model released, licensing changes, performance issues). Every existing vector is now incompatible with the new model's embedding space. Switching models requires a full reindex of all stored memories -- which can be slow, expensive, and risks data loss if the original text was discarded or compressed.

Research on "query drift compensation" confirms this is a fundamental problem: embeddings from different model versions are mathematically incompatible, and failing to reindex produces silently incorrect search results.

**Why it happens:**
Embeddings feel like an implementation detail, so developers store only vectors without the metadata needed for migration. The pluggable embedding strategy (a stated Memorite requirement) makes this worse -- the system explicitly supports multiple models, increasing the likelihood of model switches.

**How to avoid:**
- Always store the original text alongside vectors. Vectors are derived, text is primary.
- Store embedding model identifier and version with every vector row.
- Design the schema so reindexing is a background operation that does not block reads.
- Build a reindex command from day one (not as an afterthought).
- Consider storing multiple embedding representations per observation if cost permits.

**Warning signs:**
- Schema has vector columns but no model version column
- No CLI/API command for reindexing
- Original text has been lossy-compressed or discarded to save space
- Tests pass with hardcoded embeddings rather than live model inference

**Phase to address:**
Phase 1 (Core Storage) for schema design. Phase 2 (Embedding Strategy) for the reindex pipeline. The schema must accommodate migration before any vectors are written.

---

### Pitfall 3: Context Window Poisoning from Memory Injection

**What goes wrong:**
The MCP memory tools inject too many tokens into Claude's context window. A `read_graph()` or broad `search()` call dumps 10k-15k+ tokens of memory into context before the user's actual work begins. This burns through the 200k token window, reduces Claude's effective working memory for the current task, and can degrade response quality by flooding the model with tangentially relevant information.

Claude Code's own team had to build Tool Search (January 2026) specifically because MCP tools were consuming 51k tokens before any conversation started. The claude-mem project addresses this with a 3-layer workflow (search index -> timeline -> full details) achieving 10x token efficiency.

**Why it happens:**
Developers build memory retrieval for completeness rather than precision. The natural instinct is "give Claude everything it might need." Graph-based retrieval is especially prone to this -- following edges pulls in increasingly distant nodes. Without token budgets, a single memory query can return an entire conversation history.

**How to avoid:**
- Implement the 3-layer progressive retrieval pattern: (1) lightweight index search returning IDs and titles (~50-100 tokens per result), (2) targeted timeline/context expansion, (3) full observation fetch only for confirmed-relevant items.
- Set hard token budgets per memory injection (e.g., 500-2000 tokens max per retrieval).
- Use `defer_loading: true` for memory tools so they do not inflate the initial context.
- Return summaries by default, full content only on explicit drill-down.

**Warning signs:**
- Claude saying "I notice from my memory that..." about obviously irrelevant topics
- Context window exhaustion after fewer than 30-40 tool uses
- Users reporting Claude seems "distracted" or "unfocused" after memory loads
- Memory search results consistently exceed 1000 tokens

**Phase to address:**
Phase 1 (MCP Tools) for the progressive retrieval API design. This is an architectural decision that cannot be bolted on later -- the tool signatures define the retrieval pattern.

---

### Pitfall 4: SQLite Corruption from Concurrent Session Access

**What goes wrong:**
Multiple Claude Code sessions write to the same SQLite database simultaneously. Without proper WAL mode configuration and busy timeout handling, this produces "database is locked" errors, partial writes, or in worst cases, silent data corruption. The official SQLite documentation catalogs specific corruption vectors: file locking race conditions, WAL file separation from the database, and POSIX advisory lock cancellation when multiple file descriptors access the same file.

This is not hypothetical. The dev.to post-mortem on Claude Code concurrent sessions documents this exact failure mode: the official Memory MCP implementation lacked concurrent access support, causing data corruption during simultaneous writes.

**Why it happens:**
Developers test with a single Claude Code session. Concurrent access only surfaces when users run multiple sessions (common workflow: one session for frontend, one for backend, one for tests). SQLite's WAL mode allows concurrent reads but still serializes writes. The subtlety is that WAL mode does not eliminate locking -- it makes it more granular and better-behaved, but `SQLITE_BUSY` still occurs.

**How to avoid:**
- Enable WAL mode as the very first PRAGMA after opening the connection.
- Set `busy_timeout` to at least 5000ms (prevents immediate failures under contention).
- Use a single canonical file path for the database (no symlinks, no hardlinks -- different paths create separate WAL files and separate lock tracking, per SQLite docs).
- Never access the database file directly while connections are open (no backup-by-copy, use the SQLite backup API or `VACUUM INTO`).
- Run periodic WAL checkpoints to prevent unbounded WAL file growth.
- Never fork a process with an open database connection.
- Test with 3+ concurrent sessions from day one.

**Warning signs:**
- `SQLITE_BUSY` errors in logs
- WAL file growing beyond 10MB without checkpointing
- `-shm` file lingering after all connections close
- Different test runs producing different results (nondeterminism from race conditions)

**Phase to address:**
Phase 1 (Core Storage). The database initialization sequence must be correct from the first line of code. This is not fixable after deployment without risking existing user data.

---

### Pitfall 5: Dependency Weight Creep (The Engram Lesson)

**What goes wrong:**
The plugin accumulates dependencies that make installation fragile, startup slow, and the package enormous. Engram's original stack included Bun + Python + ChromaDB before a rewrite. Native binary dependencies (like better-sqlite3, ONNX runtime, node-canvas) require compilation on install, which fails on machines without build toolchains. The plugin becomes the thing users spend more time debugging than using.

Claude Code's own issue tracker documents multiple installation conflicts between npm-local and native binary installations (issue #10280), and MCP server failures on Windows from native dependency problems (issue #3369).

**Why it happens:**
Each dependency solves a real problem in isolation. better-sqlite3 is faster than node-sqlite3. ONNX gives local embeddings. A graph visualization library provides the UI. But each native dependency adds a compilation step, a platform matrix, and a failure mode. The decision is made feature-by-feature without tracking cumulative weight.

**How to avoid:**
- Maintain a strict dependency budget: count native dependencies (target: 0-1 for core, more acceptable for optional features).
- Use Node.js built-in `node:sqlite` (available since Node 22) if it meets performance requirements, eliminating the better-sqlite3 native compilation requirement.
- Make heavy dependencies optional: the embedding model should not block core save/search. If ONNX fails to install, fall back to keyword-only search.
- Measure cold-start time in CI. Set a budget (e.g., <500ms to first tool availability). Fail the build if it regresses.
- Separate the web UI into a lazy-loaded optional component -- users who only want MCP memory should not pay for visualization dependencies.

**Warning signs:**
- `npm install` takes longer than 30 seconds
- Installation instructions include "if you get a build error, try..."
- GitHub issues about installation failures on specific platforms
- Package size exceeding 50MB
- Startup time exceeding 1 second

**Phase to address:**
Phase 1 (Foundation). Dependency choices in Phase 1 compound through every subsequent phase. Switching from better-sqlite3 to node:sqlite in Phase 4 means revalidating all existing code.

---

### Pitfall 6: Adaptive Threshold Over-Engineering

**What goes wrong:**
The adaptive topic detection system becomes a complex ML pipeline that is impossible to debug, tune, or explain. The "adaptive per-user, per-session thresholds" requirement sounds elegant but creates a system where the threshold behaves unpredictably -- sometimes stashing context too aggressively (user loses their train of thought), sometimes not stashing at all (memory fills with noise). Users cannot understand why the system made a particular decision, eroding trust.

Research on dynamic topic detection confirms: topics show "consistent instability with words moving from one topic to another depending on algorithm setup." Short-text topic modeling is especially brittle due to data sparsity, slang, and insufficient word co-occurrence.

**Why it happens:**
"Adaptive" implies learning, which implies a model, which implies hyperparameters, which implies tuning. The developer builds an increasingly sophisticated system to handle edge cases, each addition making the overall behavior less predictable. The ADHD-pattern target user is especially sensitive to systems that behave inconsistently -- unpredictable tools get abandoned.

**How to avoid:**
- Start with a simple, deterministic threshold (e.g., cosine similarity drop > 0.3 between consecutive messages = topic shift). Ship this. Gather real usage data.
- Add adaptivity incrementally: session-level moving average of similarity scores, then per-user baseline calibration. Each step must be explainable.
- Always provide a manual override (slash command to force-stash or force-continue).
- Log every threshold decision with the inputs that drove it, enabling post-hoc debugging.
- Set bounds on adaptation: the threshold can adapt within [0.15, 0.6] but never outside that range, preventing runaway learning.

**Warning signs:**
- Cannot explain in one sentence why a particular stash decision was made
- Topic detection accuracy varies wildly between test runs
- The threshold tuning code is longer than the core memory storage code
- Users reporting "it keeps interrupting me" or "it never catches topic changes"

**Phase to address:**
Phase 2 (Topic Detection). But the architecture must support swappable detection strategies from Phase 1, so that the initial simple approach can be replaced without rewiring the storage layer.

---

### Pitfall 7: Knowledge Graph Becoming an Unqueryable Hairball

**What goes wrong:**
The knowledge graph accumulates entities and relationships without structure or governance. Every noun becomes a node, every co-occurrence becomes an edge. Within weeks, the graph has thousands of nodes with dense, meaningless connections. Queries that traverse the graph pull back enormous subgraphs. The visualization becomes an unreadable mess of overlapping nodes. The graph provides no more insight than a flat search index but costs significantly more to maintain and query.

**Why it happens:**
Knowledge graph construction from unstructured text (conversation logs) is fundamentally harder than building graphs from structured data. Entity extraction from casual developer conversation is noisy -- "the thing," "that bug," "the PR" all refer to specific entities but require coreference resolution to link correctly. Without schema enforcement, the graph evolves organically into spaghetti.

**How to avoid:**
- Define a fixed entity type taxonomy from day one (e.g., Project, File, Decision, Problem, Solution, Tool, Person -- and nothing else).
- Enforce relationship types (e.g., RELATES_TO, CAUSED_BY, SOLVED_BY, PART_OF). No free-form edges.
- Implement entity merging: detect when "the API" and "our REST API" and "the backend endpoints" refer to the same entity.
- Set a maximum node degree: if an entity has >50 edges, it is too generic and should be split or pruned.
- Build graph maintenance (deduplication, pruning orphans, merging synonyms) as a background job, not a manual task.

**Warning signs:**
- Visualization requires zooming to see individual nodes
- Most-connected nodes are generic terms ("code," "file," "bug," "error")
- Graph queries return >100 nodes for simple lookups
- Entity names are inconsistent (same concept with 5+ different node labels)

**Phase to address:**
Phase 3 (Knowledge Graph). But the entity extraction rules and type taxonomy must be designed before any graph construction begins. Migrating an untyped graph to a typed schema requires re-extracting every entity from source text.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store vectors without model version metadata | Simpler schema, fewer columns | Full reindex required on any model change, with no way to do it incrementally | Never -- the version column costs nothing |
| Skip WAL checkpointing | No maintenance code needed | WAL file grows unbounded, eventual disk exhaustion, degraded read performance | Never -- checkpoint on session close at minimum |
| Hardcode embedding dimensions | Avoids dynamic tensor handling | Locked to one model family; changing to a model with different dimensions requires schema migration | Only if you commit to one model for the project lifetime |
| Inline knowledge graph in the memory SQLite DB | Single file, simpler deployment | Graph queries fight with memory writes for locks; no graph-specific indexing | Acceptable for MVP if graph is read-heavy. Split to separate connection or DB if write contention appears |
| Use synchronous embedding in the save path | Simpler code, guaranteed consistency | Blocks the MCP response until embedding completes, adding 50-200ms latency per save | Never for user-facing saves. Acceptable for background batch processing |
| Ship web UI bundled with core plugin | Single install | Doubles package size, pulls in frontend dependencies (React, D3, etc.) for users who only want CLI memory | Only for initial release. Split into optional `@memorite/web` package by Phase 4 |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Claude Code SDK hooks (PostToolUse, etc.) | Doing heavy processing in the hook callback, blocking Claude's response pipeline | Hook should only enqueue work. All processing (embedding, graph updates, topic analysis) happens in a background worker or microtask queue |
| MCP tool registration | Registering 15+ tools with verbose schemas, consuming 10k+ tokens of context on session start | Minimal tool count (target: 5-8). Use `defer_loading: true` for secondary tools. Keep descriptions under 100 tokens each |
| SQLite from multiple threads/workers | Opening separate connections without coordinating WAL mode and busy timeouts | Single connection manager that enforces WAL + busy_timeout on every connection. Or: single writer process with message-passing from workers |
| ONNX Runtime for local embeddings | Bundling ONNX as a hard dependency, failing install on machines without build tools | Make ONNX optional. Fall back to Claude-piggyback embeddings or keyword-only search. Never let embedding failure block core functionality |
| Web UI WebSocket connection | Keeping WebSocket open permanently, sending every database change as a real-time event | Lazy connection (only when UI is open). Batch updates. Send diffs, not full state. Disconnect after idle timeout |
| node:sqlite vs better-sqlite3 | Assuming node:sqlite has feature parity with better-sqlite3 | Verify: does node:sqlite support WAL mode PRAGMAs, user-defined functions (for FTS5 ranking), and the backup API? Test before committing |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Synchronous embedding on every save | MCP tool response time >200ms, user notices "lag" after Claude messages | Queue embeddings for background processing. Return save confirmation immediately, embed asynchronously | Immediately -- even one 150ms embedding blocks the response pipeline |
| Unbounded graph traversal in search | Search queries take >500ms, return massive JSON payloads | Set depth limits (max 2 hops), node count limits (max 50 per query), and token budget per response | At ~5000 nodes / ~20000 edges |
| D3 force layout with all nodes rendered | Browser tab freezes, high CPU usage, unresponsive graph interaction | Viewport culling (render only visible nodes), level-of-detail (simplify distant nodes), WebGL rendering via PixiJS for >500 nodes, Web Workers for layout computation | At ~500 SVG nodes / ~1000 edges for SVG. WebGL extends to ~5000 nodes |
| FTS5 + vector search without result merging strategy | Keyword search and semantic search return different result sets with no unified ranking | Implement reciprocal rank fusion (RRF) or weighted score combination. Decide the merge strategy before building hybrid search | Immediately -- users get confusing results if keyword and semantic results are interleaved without ranking |
| WAL checkpoint starvation under concurrent reads | WAL file grows without bound, disk usage spikes, read performance degrades | Schedule checkpoints during low-activity periods (session close, idle timeout). Set `wal_autocheckpoint` to reasonable value (default 1000 pages is fine for most cases) | At ~100MB WAL file size, or after extended periods with persistent read connections |
| Loading entire knowledge graph for visualization | Browser memory >1GB, initial page load >5 seconds | Paginate graph loading. Start with a focus node and expand on demand. Never send the full graph to the browser | At ~2000 nodes |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing API keys or tokens captured from conversation | Memory search exposes secrets in plaintext to any MCP client or web UI viewer | Implement a secret detection filter in the admission pipeline. Regex patterns for common API key formats. Never store observations matching secret patterns |
| Web UI server binding to 0.0.0.0 | Any device on the local network can access the memory database | Bind to 127.0.0.1 only. Require a session token for WebSocket connections. Add CORS restrictions |
| No authentication on MCP tools | Any MCP client connected to the system can read/write/delete all memories | Implement per-session tokens. Scope tool access by session ID. Add a confirmation step for bulk delete operations |
| Storing file contents verbatim in observations | Proprietary source code stored in memory database, persisting after the project is deleted | Store references (file path + hash) rather than full file contents. Respect .gitignore patterns for what to observe |
| Memory database file permissions too open | Other users on shared machines can read the SQLite file | Set file permissions to 0600 (owner read/write only) on database creation. Store in user-specific directory (~/.memorite/) |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Silent memory operations with no feedback | User has no idea if memory is working. Zero trust in the system. "Is it even doing anything?" | Subtle indicators: "[memory: 3 observations saved]" in session output. Not verbose, but present. Slash command `/memory status` for detailed stats |
| Aggressive topic stashing that interrupts flow | ADHD users -- the core audience -- experience the stash notification as an interruption that breaks hyperfocus. The tool designed to help scattered work patterns becomes another source of distraction | Default to silent stashing. Only notify on explicit topic return ("Welcome back to X -- I saved your context from earlier"). Never interrupt mid-thought |
| Knowledge graph visualization without search/filter | User opens graph, sees 500 nodes, cannot find anything useful. Closes the tab and never returns | Open graph focused on a search result or current topic. Provide search-within-graph. Highlight recent nodes. Filter by entity type, date range, project |
| Requiring manual memory curation | "You need to tag and organize your memories for best results." ADHD users will not do this. The system must work without any user maintenance | Fully automatic curation with optional manual override. Auto-tagging, auto-linking, auto-pruning. Manual commands exist but are never required |
| Stale memory injection (retrieving outdated context) | Claude references a decision that was reversed 3 weeks ago, or a bug that was already fixed. User loses trust in memory accuracy | Implement temporal decay in retrieval scoring. Recent memories rank higher. Mark memories as superseded when contradicting information is stored. Show timestamps in memory results |

## "Looks Done But Isn't" Checklist

- [ ] **Memory search:** Often missing hybrid ranking -- FTS5 and vector results returned separately without merged scoring. Verify results are ranked by a single unified score
- [ ] **Concurrent sessions:** Often missing cross-session observation isolation. Verify that Session A's tool outputs do not appear in Session B's context without explicit cross-session search
- [ ] **WAL mode:** Often missing checkpoint scheduling. Verify WAL file size after 100+ write operations. Should be bounded, not growing indefinitely
- [ ] **Embedding pipeline:** Often missing graceful degradation. Verify that if the embedding model fails/is unavailable, save still succeeds (text-only, no vector) and keyword search still works
- [ ] **Knowledge graph:** Often missing entity deduplication. Verify that searching for a concept returns one canonical node, not 5 variants of the same entity
- [ ] **Topic detection:** Often missing the "no shift" case. Verify that a focused 2-hour session on one topic does NOT produce spurious stash events
- [ ] **Web UI:** Often missing empty state handling. Verify that a new user with zero memories sees a helpful onboarding state, not a blank canvas or error
- [ ] **Backup/restore:** Often missing WAL-aware backup. Verify backup captures database + WAL + SHM atomically (or uses SQLite backup API), not just the .sqlite file
- [ ] **Cleanup:** Often missing memory deletion cascading to graph nodes. Verify that deleting a memory also removes its graph entities and relationships
- [ ] **Plugin lifecycle:** Often missing graceful shutdown. Verify that killing Claude Code mid-session does not leave orphaned lock files, partial writes, or corrupted WAL

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Database corruption from concurrent access | MEDIUM | Restore from automatic backup (if backup system exists). Rebuild WAL with `PRAGMA wal_checkpoint(TRUNCATE)`. If unrecoverable, rebuild from exported JSON. This is why automated backups before every session start are critical |
| Embedding model lock-in (need to switch models) | MEDIUM | If original text is stored: batch reindex all observations with new model (hours for large DBs). If text was discarded: unrecoverable. Must re-extract from conversation logs if available |
| Knowledge graph spaghetti | HIGH | Cannot be incrementally fixed. Requires defining the entity taxonomy, then re-extracting all entities from source observations with new extraction rules. Effectively rebuilding the graph from scratch |
| Context window bloat from memory tools | LOW | Update tool descriptions to be shorter. Implement `defer_loading`. Restructure retrieval to progressive pattern. No data migration needed, only code changes |
| Memory bloat from indiscriminate storage | MEDIUM | Run a one-time pruning job: delete observations below a utility threshold, merge duplicates, remove orphaned graph nodes. Future-proof by adding admission filter. Cannot recover wasted disk space without VACUUM |
| Dependency weight (too many native deps) | HIGH | Requires replacing dependencies one at a time while maintaining backward compatibility. Each replacement needs a full test pass. Cannot be done incrementally -- users on the old stack need migration support |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Indiscriminate memory storage | Phase 1 (Core Storage) | Memory count stays sublinear with session count. No exact duplicates in search results |
| Embedding migration hell | Phase 1 (Schema Design) + Phase 2 (Embedding) | `model_version` column exists. Reindex command works. Switching models produces valid search results |
| Context window poisoning | Phase 1 (MCP Tool Design) | Total memory injection per query <2000 tokens. Session remains functional after 50+ tool uses |
| SQLite corruption | Phase 1 (Database Init) | 3 concurrent sessions writing simultaneously produce zero errors after 1000 operations each |
| Dependency weight creep | Phase 1 (Foundation) | `npm install` < 30 seconds. Cold start < 500ms. Zero native compilation required for core functionality |
| Adaptive threshold over-engineering | Phase 2 (Topic Detection) | Threshold decision explainable in one sentence for any given input. Manual override always works |
| Knowledge graph hairball | Phase 3 (Knowledge Graph) | Max 8 entity types. No node with >50 edges. Graph query returns <50 nodes for single-entity lookup |
| Web UI performance | Phase 4 (Visualization) | Graph renders <500ms for 500 nodes. No browser tab freeze. Viewport culling active |
| Memory staleness | Phase 2 (Retrieval Ranking) | Temporal decay visible in search results. Superseded memories ranked below current ones |
| Secret leakage | Phase 1 (Admission Pipeline) | Synthetic API keys in test observations are never stored. Regex filter catches common secret patterns |

## Sources

- [SQLite Official: How To Corrupt An SQLite Database File](https://www.sqlite.org/howtocorrupt.html) -- authoritative documentation on corruption vectors
- [SQLite Official: Write-Ahead Logging](https://sqlite.org/wal.html) -- WAL mode behavior, checkpoint starvation, concurrent access limits
- [Fixing Claude Code's Concurrent Session Problem (dev.to)](https://dev.to/daichikudo/fixing-claude-codes-concurrent-session-problem-implementing-memory-mcp-with-sqlite-wal-mode-o7k) -- real-world post-mortem on SQLite concurrent session failures
- [Fixing Claude Code's Amnesia (blog.fsck.com)](https://blog.fsck.com/2025/10/23/episodic-memory/) -- episodic memory approach, journaling limitations, ambient capture insight
- [Claude Code MCP Context Bloat 46.9% Reduction (Medium)](https://medium.com/@joe.njenga/claude-code-just-cut-mcp-context-bloat-by-46-9-51k-tokens-down-to-8-5k-with-new-tool-search-ddf9e905f734) -- Tool Search feature, token overhead measurements
- [Claude Code Issue #13805: Lazy-load MCP servers](https://github.com/anthropics/claude-code/issues/13805) -- MCP eager loading consuming 11.5% of context window
- [Claude Code Issue #3406: Built-in tools + MCP descriptions 10-20k token overhead](https://github.com/anthropics/claude-code/issues/3406) -- tool description bloat measurements
- [Harvard D3 Institute: How Selective Recall Boosts LLM Performance](https://d3.harvard.edu/smarter-memories-stronger-agents-how-selective-recall-boosts-llm-performance/) -- indiscriminate storage degrades performance; utility-based deletion yields 10% gains
- [How Memory Management Impacts LLM Agents (arxiv)](https://arxiv.org/html/2505.16067v1) -- add-all strategy performs worse than no memory; strict filtering boosts accuracy
- [Embedding Drift and Model Compatibility (arxiv)](https://arxiv.org/abs/2506.00037) -- query drift compensation, reindex requirements on model change
- [Drift-Adapter: Near Zero-Downtime Embedding Model Upgrades](https://www.arxiv.org/pdf/2509.23471) -- practical approach to model migration without full reindex
- [D3 Force Layout Optimization (NebulaGraph)](https://www.nebula-graph.io/posts/d3-force-layout-optimization) -- viewport culling, level-of-detail, WebGL fallback for large graphs
- [Scale Up D3 Graph Visualization (Neo4j)](https://medium.com/neo4j/scale-up-your-d3-graph-visualisation-webgl-canvas-with-pixi-js-63f119d96a28) -- PixiJS + WebGL for graph rendering beyond SVG limits
- [ADHD Working Memory Research (ADD Resource Center)](https://www.addrc.org/the-memory-maze-understanding-working-short-term-and-long-term-memory-in-adhd/) -- memory mechanisms in ADHD, implications for tool design
- [Neurodivergent-Aware Productivity Framework (arxiv)](https://arxiv.org/html/2507.06864) -- ADHD as systems-level attentional modulation challenge, not task deficit
- [MCP "Too Many Tools" Problem](https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/) -- tool count limits, context overhead from verbose schemas
- [Optimising MCP Server Context Usage (Scott Spence)](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code) -- practical MCP optimization techniques
- [claude-mem GitHub Repository](https://github.com/thedotmack/claude-mem) -- 3-layer progressive retrieval pattern, Endless Mode compression
- [EvolvingLMMs-Lab/engram GitHub Repository](https://github.com/EvolvingLMMs-Lab/engram) -- predecessor architecture reference, E2EE memory layer

---
*Pitfalls research for: Claude Code persistent memory plugin (Memorite)*
*Researched: 2026-02-08*
