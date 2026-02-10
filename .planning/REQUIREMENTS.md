# Requirements

**Project:** Laminark — Claude Code Persistent Adaptive Memory Plugin
**Version:** v1
**Core Value:** You never lose context. Every thread is recoverable, every thought is findable.

## v1 Requirements

### Memory Core

- [x] **MEM-01**: User's observations persist across Claude Code sessions in a single SQLite database file with WAL mode
- [x] **MEM-02**: Observations are automatically captured via PostToolUse hook without user intervention
- [x] **MEM-03**: Session lifecycle is tracked via SessionStart and SessionEnd hooks with unique session IDs
- [x] **MEM-04**: User can manually save a memory with explicit text via MCP save_memory tool
- [x] **MEM-05**: User can delete specific memories via MCP forget tool (soft delete with recovery option)
- [x] **MEM-06**: All observations are scoped to the project directory — no cross-project contamination
- [x] **MEM-07**: Multiple concurrent Claude Code sessions can read/write safely without corruption or data loss
- [x] **MEM-08**: Database uses write-ahead journaling for crash recovery — incomplete writes never corrupt data
- [x] **MEM-09**: Schema stores original text alongside embeddings with model version metadata for future migration
- [x] **MEM-10**: Observation admission filters prevent storing low-signal noise (build logs, large file reads) — only meaningful content is retained

### Search

- [x] **SRC-01**: User can search memories by keyword via FTS5 full-text search returning ranked results
- [x] **SRC-02**: User can search memories by semantic meaning via vector similarity using sqlite-vec
- [x] **SRC-03**: Hybrid search combines FTS5 keyword and vector semantic scores using reciprocal rank fusion
- [x] **SRC-04**: Search uses 3-layer progressive disclosure: compact index (~50-100 tokens/result) -> timeline context -> full observation details
- [x] **SRC-05**: Search results respect project scoping and never leak observations from other projects
- [x] **SRC-06**: MCP search tool response stays under 2000 tokens to prevent context window poisoning

### Context Management

- [x] **CTX-01**: On SessionStart, Claude receives a progressive disclosure index of recent context (last session summary + high-value observations) within 2 seconds
- [x] **CTX-02**: Session summaries are generated at Stop hook by compressing session observations into concise summaries
- [x] **CTX-03**: When adaptive topic shift is detected, current context thread is silently stashed (snapshot of topic observations + summary)
- [x] **CTX-04**: User is notified when context has been stashed with a message indicating they can return to it
- [x] **CTX-05**: User can resume a stashed context thread via /laminark:resume slash command, re-injecting the saved context
- [x] **CTX-06**: User can query "where was I?" to surface recently abandoned context threads ranked by recency and relevance

### Intelligence

- [x] **INT-01**: Embeddings are generated using pluggable strategy interface with local ONNX as default (all-MiniLM-L6-v2 or BGE Small EN v1.5)
- [x] **INT-02**: Claude piggyback embedding strategy extracts semantic features during Claude's response generation window at zero added latency
- [x] **INT-03**: Hybrid embedding strategy uses local ONNX for speed with Claude piggyback for quality, selectable at startup
- [x] **INT-04**: All embedding computation and analysis runs in a worker thread — never blocks MCP tool responses or Claude's output
- [x] **INT-05**: Topic shift detection uses cosine distance between consecutive observation embeddings with a static threshold as baseline
- [x] **INT-06**: Adaptive threshold learning via EWMA adjusts per-user, per-session based on the user's natural topic variance
- [x] **INT-07**: Adaptive threshold seeds new sessions with historical averages from previous sessions to handle cold start
- [x] **INT-08**: Sensitivity multiplier is user-configurable as a dial between "sensitive" and "relaxed" with manual override always available
- [x] **INT-09**: Entity extraction identifies typed entities from observations: Project, File, Decision, Problem, Solution, Tool, Person
- [x] **INT-10**: Relationship detection identifies typed relations between entities: uses, depends_on, decided_by, related_to, part_of, caused_by, solved_by
- [x] **INT-11**: Knowledge graph stores entities as nodes and relationships as edges in SQLite with graph traversal query support
- [x] **INT-12**: Knowledge graph enforces entity type taxonomy and max node degree (50 edges) to prevent unqueryable hairball growth
- [x] **INT-13**: Temporal awareness tracks when observations were created and detects staleness when newer observations contradict older ones

### Visualization

- [x] **VIS-01**: Local web server on localhost serves the visualization UI accessible from any browser
- [x] **VIS-02**: Interactive knowledge graph view renders entities as nodes and relationships as edges using force-directed layout (Cytoscape)
- [x] **VIS-03**: User can click graph nodes to see associated observations, filter by entity type, and zoom to time ranges
- [x] **VIS-04**: Timeline view shows chronological flow of sessions, observations, and topic shift points
- [x] **VIS-05**: Web UI receives live updates via Server-Sent Events as new observations are processed
- [x] **VIS-06**: Graph visualization handles up to 500+ nodes with viewport culling for performance

### User Interface

- [x] **UI-01**: 5-7 MCP tools exposed to Claude: search, timeline, get_observations, save_memory, forget, graph_query, topic_context
- [x] **UI-02**: /laminark:remember slash command allows user to explicitly save a memory with context
- [x] **UI-03**: /laminark:recall slash command allows user to search memories by description
- [x] **UI-04**: /laminark:stash slash command allows user to manually stash current context thread
- [x] **UI-05**: /laminark:resume slash command allows user to resume a previously stashed context thread

### Data Quality

- [x] **DQ-01**: Curation agent runs during quiet periods (session end, long pauses) to merge similar observations and generate consolidated summaries
- [x] **DQ-02**: Privacy controls allow excluding sensitive content patterns (like .env file contents) from observation capture
- [x] **DQ-03**: Embedding engine gracefully degrades — if ONNX model unavailable, system falls back to FTS5 keyword-only search
- [x] **DQ-04**: Plugin startup adds zero perceptible latency — ONNX model loads lazily on first observation, not at process start
- [x] **DQ-05**: All topic shift decisions are logged with inputs for debugging and threshold tuning

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
| MEM-01 | Phase 1: Storage Engine | Done |
| MEM-02 | Phase 3: Hook Integration and Capture | Done |
| MEM-03 | Phase 3: Hook Integration and Capture | Done |
| MEM-04 | Phase 2: MCP Interface and Search | Done |
| MEM-05 | Phase 2: MCP Interface and Search | Done |
| MEM-06 | Phase 1: Storage Engine | Done |
| MEM-07 | Phase 1: Storage Engine | Done |
| MEM-08 | Phase 1: Storage Engine | Done |
| MEM-09 | Phase 1: Storage Engine | Done |
| MEM-10 | Phase 3: Hook Integration and Capture | Done |
| SRC-01 | Phase 2: MCP Interface and Search | Done |
| SRC-02 | Phase 4: Embedding Engine and Semantic Search | Done |
| SRC-03 | Phase 4: Embedding Engine and Semantic Search | Done |
| SRC-04 | Phase 2: MCP Interface and Search | Done |
| SRC-05 | Phase 1: Storage Engine | Done |
| SRC-06 | Phase 2: MCP Interface and Search | Done |
| CTX-01 | Phase 5: Session Context and Summaries | Done |
| CTX-02 | Phase 5: Session Context and Summaries | Done |
| CTX-03 | Phase 6: Topic Detection and Context Stashing | Done |
| CTX-04 | Phase 6: Topic Detection and Context Stashing | Done |
| CTX-05 | Phase 6: Topic Detection and Context Stashing | Done |
| CTX-06 | Phase 6: Topic Detection and Context Stashing | Done |
| INT-01 | Phase 4: Embedding Engine and Semantic Search | Done |
| INT-02 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| INT-03 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| INT-04 | Phase 4: Embedding Engine and Semantic Search | Done |
| INT-05 | Phase 6: Topic Detection and Context Stashing | Done |
| INT-06 | Phase 6: Topic Detection and Context Stashing | Done |
| INT-07 | Phase 6: Topic Detection and Context Stashing | Done |
| INT-08 | Phase 6: Topic Detection and Context Stashing | Done |
| INT-09 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| INT-10 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| INT-11 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| INT-12 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| INT-13 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| VIS-01 | Phase 8: Web Visualization | Done |
| VIS-02 | Phase 8: Web Visualization | Done |
| VIS-03 | Phase 8: Web Visualization | Done |
| VIS-04 | Phase 8: Web Visualization | Done |
| VIS-05 | Phase 8: Web Visualization | Done |
| VIS-06 | Phase 8: Web Visualization | Done |
| UI-01 | Phase 2: MCP Interface and Search | Done (2 unified tools per design decision) |
| UI-02 | Phase 5: Session Context and Summaries | Done |
| UI-03 | Phase 5: Session Context and Summaries | Done |
| UI-04 | Phase 6: Topic Detection and Context Stashing | Done |
| UI-05 | Phase 6: Topic Detection and Context Stashing | Done |
| DQ-01 | Phase 7: Knowledge Graph and Advanced Intelligence | Done |
| DQ-02 | Phase 3: Hook Integration and Capture | Done |
| DQ-03 | Phase 4: Embedding Engine and Semantic Search | Done |
| DQ-04 | Phase 4: Embedding Engine and Semantic Search | Done |
| DQ-05 | Phase 6: Topic Detection and Context Stashing | Done |

---
*Generated: 2026-02-08 from research + user selections*
*Traceability updated: 2026-02-09 — all requirements marked Done after v1.0 milestone audit*
