# Requirements

**Project:** Memorite — Claude Code Persistent Adaptive Memory Plugin
**Version:** v1
**Core Value:** You never lose context. Every thread is recoverable, every thought is findable.

## v1 Requirements

### Memory Core

- [ ] **MEM-01**: User's observations persist across Claude Code sessions in a single SQLite database file with WAL mode
- [ ] **MEM-02**: Observations are automatically captured via PostToolUse hook without user intervention
- [ ] **MEM-03**: Session lifecycle is tracked via SessionStart and SessionEnd hooks with unique session IDs
- [ ] **MEM-04**: User can manually save a memory with explicit text via MCP save_memory tool
- [ ] **MEM-05**: User can delete specific memories via MCP forget tool (soft delete with recovery option)
- [ ] **MEM-06**: All observations are scoped to the project directory — no cross-project contamination
- [ ] **MEM-07**: Multiple concurrent Claude Code sessions can read/write safely without corruption or data loss
- [ ] **MEM-08**: Database uses write-ahead journaling for crash recovery — incomplete writes never corrupt data
- [ ] **MEM-09**: Schema stores original text alongside embeddings with model version metadata for future migration
- [ ] **MEM-10**: Observation admission filters prevent storing low-signal noise (build logs, large file reads) — only meaningful content is retained

### Search

- [ ] **SRC-01**: User can search memories by keyword via FTS5 full-text search returning ranked results
- [ ] **SRC-02**: User can search memories by semantic meaning via vector similarity using sqlite-vec
- [ ] **SRC-03**: Hybrid search combines FTS5 keyword and vector semantic scores using reciprocal rank fusion
- [ ] **SRC-04**: Search uses 3-layer progressive disclosure: compact index (~50-100 tokens/result) -> timeline context -> full observation details
- [ ] **SRC-05**: Search results respect project scoping and never leak observations from other projects
- [ ] **SRC-06**: MCP search tool response stays under 2000 tokens to prevent context window poisoning

### Context Management

- [ ] **CTX-01**: On SessionStart, Claude receives a progressive disclosure index of recent context (last session summary + high-value observations) within 2 seconds
- [ ] **CTX-02**: Session summaries are generated at Stop hook by compressing session observations into concise summaries
- [ ] **CTX-03**: When adaptive topic shift is detected, current context thread is silently stashed (snapshot of topic observations + summary)
- [ ] **CTX-04**: User is notified when context has been stashed with a message indicating they can return to it
- [ ] **CTX-05**: User can resume a stashed context thread via /memorite:resume slash command, re-injecting the saved context
- [ ] **CTX-06**: User can query "where was I?" to surface recently abandoned context threads ranked by recency and relevance

### Intelligence

- [ ] **INT-01**: Embeddings are generated using pluggable strategy interface with local ONNX as default (all-MiniLM-L6-v2 or BGE Small EN v1.5)
- [ ] **INT-02**: Claude piggyback embedding strategy extracts semantic features during Claude's response generation window at zero added latency
- [ ] **INT-03**: Hybrid embedding strategy uses local ONNX for speed with Claude piggyback for quality, selectable at startup
- [ ] **INT-04**: All embedding computation and analysis runs in a worker thread — never blocks MCP tool responses or Claude's output
- [ ] **INT-05**: Topic shift detection uses cosine distance between consecutive observation embeddings with a static threshold as baseline
- [ ] **INT-06**: Adaptive threshold learning via EWMA adjusts per-user, per-session based on the user's natural topic variance
- [ ] **INT-07**: Adaptive threshold seeds new sessions with historical averages from previous sessions to handle cold start
- [ ] **INT-08**: Sensitivity multiplier is user-configurable as a dial between "sensitive" and "relaxed" with manual override always available
- [ ] **INT-09**: Entity extraction identifies typed entities from observations: Project, File, Decision, Problem, Solution, Tool, Person
- [ ] **INT-10**: Relationship detection identifies typed relations between entities: uses, depends_on, decided_by, related_to, part_of, caused_by, solved_by
- [ ] **INT-11**: Knowledge graph stores entities as nodes and relationships as edges in SQLite with graph traversal query support
- [ ] **INT-12**: Knowledge graph enforces entity type taxonomy and max node degree (50 edges) to prevent unqueryable hairball growth
- [ ] **INT-13**: Temporal awareness tracks when observations were created and detects staleness when newer observations contradict older ones

### Visualization

- [ ] **VIS-01**: Local web server on localhost serves the visualization UI accessible from any browser
- [ ] **VIS-02**: Interactive knowledge graph view renders entities as nodes and relationships as edges using force-directed layout (Cytoscape)
- [ ] **VIS-03**: User can click graph nodes to see associated observations, filter by entity type, and zoom to time ranges
- [ ] **VIS-04**: Timeline view shows chronological flow of sessions, observations, and topic shift points
- [ ] **VIS-05**: Web UI receives live updates via Server-Sent Events as new observations are processed
- [ ] **VIS-06**: Graph visualization handles up to 500+ nodes with viewport culling for performance

### User Interface

- [ ] **UI-01**: 5-7 MCP tools exposed to Claude: search, timeline, get_observations, save_memory, forget, graph_query, topic_context
- [ ] **UI-02**: /memorite:remember slash command allows user to explicitly save a memory with context
- [ ] **UI-03**: /memorite:recall slash command allows user to search memories by description
- [ ] **UI-04**: /memorite:stash slash command allows user to manually stash current context thread
- [ ] **UI-05**: /memorite:resume slash command allows user to resume a previously stashed context thread

### Data Quality

- [ ] **DQ-01**: Curation agent runs during quiet periods (session end, long pauses) to merge similar observations and generate consolidated summaries
- [ ] **DQ-02**: Privacy controls allow excluding sensitive content patterns (like .env file contents) from observation capture
- [ ] **DQ-03**: Embedding engine gracefully degrades — if ONNX model unavailable, system falls back to FTS5 keyword-only search
- [ ] **DQ-04**: Plugin startup adds zero perceptible latency — ONNX model loads lazily on first observation, not at process start
- [ ] **DQ-05**: All topic shift decisions are logged with inputs for debugging and threshold tuning

## v2 Requirements (Deferred)

- Proactive context re-surfacing — notify user when current discussion is semantically similar to a stashed topic
- Conflict detection and flagging — surface contradictions between observations (e.g., "uses React 17" vs "upgraded to React 19")
- Export/import for migration — allow moving memory database between machines
- Advanced graph maintenance — automated deduplication, synonym merging ("the API" = "our REST API"), background pruning
- Multi-strategy curation — use Claude API for high-quality summarization when configured

## Out of Scope

- **Cloud sync / multi-device** — local-first, single machine. Users can sync SQLite file with Syncthing if needed.
- **Multi-user / team memory** — this is a personal developer tool. Team context is a different product.
- **Mobile app** — web UI on localhost is sufficient for developer workflows.
- **Electron/Tauri desktop wrapper** — browser-based web UI keeps it simple and universal.
- **Integration with non-Claude AI tools** — optimized for Claude Code plugin lifecycle. MCP compliance allows passive connections.
- **Aggressive auto-curation (LLM rewriting memories)** — hallucination risk corrupts ground truth. Store originals immutably, summaries are a separate layer.
- **Heavy ML models (>500MB)** — kills startup time and memory footprint. Small ONNX models are good enough for personal memory search.
- **Real-time WebSocket live updates** — SSE polling is sufficient for a tool you glance at, not stare at.
- **Granular permission system / RBAC** — single-user local tool has no threat model justifying access controls.

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| MEM-01 | Phase 1: Storage Engine | Pending |
| MEM-02 | Phase 3: Hook Integration and Capture | Pending |
| MEM-03 | Phase 3: Hook Integration and Capture | Pending |
| MEM-04 | Phase 2: MCP Interface and Search | Pending |
| MEM-05 | Phase 2: MCP Interface and Search | Pending |
| MEM-06 | Phase 1: Storage Engine | Pending |
| MEM-07 | Phase 1: Storage Engine | Pending |
| MEM-08 | Phase 1: Storage Engine | Pending |
| MEM-09 | Phase 1: Storage Engine | Pending |
| MEM-10 | Phase 3: Hook Integration and Capture | Pending |
| SRC-01 | Phase 2: MCP Interface and Search | Pending |
| SRC-02 | Phase 4: Embedding Engine and Semantic Search | Pending |
| SRC-03 | Phase 4: Embedding Engine and Semantic Search | Pending |
| SRC-04 | Phase 2: MCP Interface and Search | Pending |
| SRC-05 | Phase 1: Storage Engine | Pending |
| SRC-06 | Phase 2: MCP Interface and Search | Pending |
| CTX-01 | Phase 5: Session Context and Summaries | Pending |
| CTX-02 | Phase 5: Session Context and Summaries | Pending |
| CTX-03 | Phase 6: Topic Detection and Context Stashing | Pending |
| CTX-04 | Phase 6: Topic Detection and Context Stashing | Pending |
| CTX-05 | Phase 6: Topic Detection and Context Stashing | Pending |
| CTX-06 | Phase 6: Topic Detection and Context Stashing | Pending |
| INT-01 | Phase 4: Embedding Engine and Semantic Search | Pending |
| INT-02 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| INT-03 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| INT-04 | Phase 4: Embedding Engine and Semantic Search | Pending |
| INT-05 | Phase 6: Topic Detection and Context Stashing | Pending |
| INT-06 | Phase 6: Topic Detection and Context Stashing | Pending |
| INT-07 | Phase 6: Topic Detection and Context Stashing | Pending |
| INT-08 | Phase 6: Topic Detection and Context Stashing | Pending |
| INT-09 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| INT-10 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| INT-11 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| INT-12 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| INT-13 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| VIS-01 | Phase 8: Web Visualization | Pending |
| VIS-02 | Phase 8: Web Visualization | Pending |
| VIS-03 | Phase 8: Web Visualization | Pending |
| VIS-04 | Phase 8: Web Visualization | Pending |
| VIS-05 | Phase 8: Web Visualization | Pending |
| VIS-06 | Phase 8: Web Visualization | Pending |
| UI-01 | Phase 2: MCP Interface and Search | Pending |
| UI-02 | Phase 5: Session Context and Summaries | Pending |
| UI-03 | Phase 5: Session Context and Summaries | Pending |
| UI-04 | Phase 6: Topic Detection and Context Stashing | Pending |
| UI-05 | Phase 6: Topic Detection and Context Stashing | Pending |
| DQ-01 | Phase 7: Knowledge Graph and Advanced Intelligence | Pending |
| DQ-02 | Phase 3: Hook Integration and Capture | Pending |
| DQ-03 | Phase 4: Embedding Engine and Semantic Search | Pending |
| DQ-04 | Phase 4: Embedding Engine and Semantic Search | Pending |
| DQ-05 | Phase 6: Topic Detection and Context Stashing | Pending |

---
*Generated: 2026-02-08 from research + user selections*
*Traceability updated: 2026-02-08 by roadmap creation*
