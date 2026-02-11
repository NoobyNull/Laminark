# Roadmap: Laminark

## Milestones

- Done **v1.0 Persistent Adaptive Memory** - Phases 1-8 (shipped 2026-02-09)
- In Progress **v2.0 Global Tool Intelligence** - Phases 9-16 (in progress)

## Phases

<details>
<summary>v1.0 Persistent Adaptive Memory (Phases 1-8) - SHIPPED 2026-02-09</summary>

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Storage Engine** - Rock-solid SQLite foundation with WAL, concurrency, and crash recovery
- [x] **Phase 2: MCP Interface and Search** - Claude-facing tools with keyword search and progressive disclosure
- [x] **Phase 3: Hook Integration and Capture** - Automatic observation capture via Claude Code hooks
- [x] **Phase 4: Embedding Engine and Semantic Search** - Vector embeddings with pluggable strategy and hybrid search
- [x] **Phase 5: Session Context and Summaries** - Context continuity across sessions with progressive disclosure
- [x] **Phase 6: Topic Detection and Context Stashing** - Adaptive topic shift detection with automatic context preservation
- [x] **Phase 7: Knowledge Graph and Advanced Intelligence** - Entity extraction, relationship mapping, and Claude piggyback embeddings
- [x] **Phase 8: Web Visualization** - Interactive knowledge graph and timeline views in the browser

### Phase 1: Storage Engine
**Goal**: A durable, concurrent-safe SQLite database that stores observations with full-text indexing and never loses data
**Depends on**: Nothing (first phase)
**Requirements**: MEM-01, MEM-06, MEM-07, MEM-08, MEM-09, SRC-05
**Success Criteria** (what must be TRUE):
  1. Observations written in one session are readable in a new session after process restart
  2. Three concurrent processes can read and write observations without corruption or data loss
  3. A process crash mid-write leaves the database in a consistent state with no partial records
  4. Observations from project A are never returned when querying from project B
  5. Schema stores original text, embedding vector (nullable), and model version metadata in every observation row
**Plans**: 4 plans

Plans:
- [x] 01-01-PLAN.md -- @laminark/memory package scaffolding, TypeScript toolchain, core types with Zod schemas, and config utilities
- [x] 01-02-PLAN.md -- SQLite database initialization with WAL mode, PRAGMA sequence, FTS5 external content with stable integer rowid, and migration system
- [x] 01-03-PLAN.md -- Observation CRUD, session lifecycle, and FTS5 keyword search with BM25 ranking and project scoping
- [x] 01-04-PLAN.md -- Acceptance tests proving all 5 success criteria: concurrency, crash recovery, persistence, project isolation, schema completeness (TDD)

### Phase 2: MCP Interface and Search
**Goal**: Claude can search, save, and manage memories through MCP tools with keyword search that respects token budgets
**Depends on**: Phase 1
**Requirements**: MEM-04, MEM-05, SRC-01, SRC-04, SRC-06, UI-01
**Success Criteria** (what must be TRUE):
  1. Claude can call search tool and receive keyword-ranked results from stored observations
  2. Claude can call save_memory tool to persist user-provided text as a new observation
  3. Claude can call forget tool to soft-delete a memory, which disappears from search but is recoverable
  4. Search results use 3-layer progressive disclosure (compact index, then timeline, then full details) and never exceed 2000 tokens
  5. All 5-7 MCP tools are discoverable and callable from Claude Code
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md -- Schema migration 005 (title column + FTS5 rebuild), MCP server scaffold with stdio transport, save_memory tool with auto-title, and token budget utility
- [x] 02-02-PLAN.md -- Unified recall tool with search/view/purge/restore actions, 3-level progressive disclosure, token budget enforcement, and BM25 title weighting
- [x] 02-03-PLAN.md -- Plugin manifest (.mcp.json) and integration tests proving all 5 Phase 2 success criteria

### Phase 3: Hook Integration and Capture
**Goal**: Observations are automatically captured from Claude's tool usage without any user intervention
**Depends on**: Phase 2
**Requirements**: MEM-02, MEM-03, MEM-10, DQ-02
**Success Criteria** (what must be TRUE):
  1. When Claude uses a tool (file edit, bash command, etc.), an observation is silently captured and stored without the user doing anything
  2. Session start and end events are tracked with unique session IDs in the database
  3. Low-signal noise (raw build output, large file dumps, repetitive linter warnings) is filtered out and never stored
  4. Sensitive content matching configured patterns (like .env file contents, API keys) is excluded from capture
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md -- Hook handler entry point, observation capture from PostToolUse, session lifecycle, and dual-entry-point build config
- [x] 03-02-PLAN.md -- Admission filter with noise detection and privacy filter with sensitive content redaction (TDD)
- [x] 03-03-PLAN.md -- hooks.json plugin configuration, filter pipeline wiring, and end-to-end integration tests

### Phase 4: Embedding Engine and Semantic Search
**Goal**: Observations gain semantic meaning through vector embeddings enabling "search by concept" alongside keyword search
**Depends on**: Phase 3
**Requirements**: INT-01, INT-04, SRC-02, SRC-03, DQ-03, DQ-04
**Success Criteria** (what must be TRUE):
  1. User can search by concept (e.g., "authentication decisions") and find observations that match semantically even without exact keyword overlap
  2. Hybrid search combines keyword and semantic scores, returning better results than either alone
  3. Embedding generation happens in a worker thread and never blocks MCP tool responses or slows Claude's output
  4. If the ONNX model is unavailable (missing file, load failure), the system silently falls back to keyword-only search with no errors
  5. Plugin startup completes with zero perceptible latency -- the ONNX model loads lazily on first observation, not at process start
**Plans**: 4 plans

Plans:
- [x] 04-01-PLAN.md -- EmbeddingEngine interface, LocalOnnxEngine (BGE Small q8), KeywordOnlyEngine fallback, and migration 006 (cosine distance)
- [x] 04-02-PLAN.md -- Worker thread bridge for non-blocking embedding, EmbeddingStore for sqlite-vec vec0 operations, and tsdown worker entry point
- [x] 04-03-PLAN.md -- Hybrid search with reciprocal rank fusion (FTS5 + vector), MCP server worker lifecycle, and background embedding loop
- [x] 04-04-PLAN.md -- Acceptance tests proving all 5 success criteria: semantic search, hybrid ranking, non-blocking, graceful degradation, zero latency

### Phase 5: Session Context and Summaries
**Goal**: Claude starts every session already knowing what happened last time, and users can explicitly save and search memories via slash commands
**Depends on**: Phase 4
**Requirements**: CTX-01, CTX-02, UI-02, UI-03
**Success Criteria** (what must be TRUE):
  1. When a new Claude Code session starts, Claude receives a concise summary of the last session plus high-value recent observations within 2 seconds
  2. When a session ends, observations from that session are compressed into a concise session summary stored for future retrieval
  3. User can type /laminark:remember followed by text to explicitly save a memory with context
  4. User can type /laminark:recall followed by a description to search memories and see relevant results
**Plans**: 3 plans

Plans:
- [x] 05-01-PLAN.md -- Session summary generation at Stop hook (compress session observations)
- [x] 05-02-PLAN.md -- SessionStart context injection with progressive disclosure index
- [x] 05-03-PLAN.md -- /laminark:remember and /laminark:recall slash command implementations

### Phase 6: Topic Detection and Context Stashing
**Goal**: When the user jumps to a new topic, the system preserves their previous context thread and lets them return to it
**Depends on**: Phase 4, Phase 5
**Requirements**: INT-05, INT-06, INT-07, INT-08, CTX-03, CTX-04, CTX-05, CTX-06, UI-04, UI-05, DQ-05
**Success Criteria** (what must be TRUE):
  1. When the user shifts to a clearly different topic mid-session, the system detects it and silently stashes the previous context thread
  2. User sees a brief notification that their previous context was stashed, with an indication of how to return
  3. User can type /laminark:resume to see stashed context threads and re-inject a chosen thread back into the conversation
  4. User can ask "where was I?" to see recently abandoned context threads ranked by recency and relevance
  5. Topic detection adapts to the user's natural variance over time -- a scattered session raises the shift threshold, a focused session lowers it
**Plans**: 7 plans

Plans:
- [x] 06-01-PLAN.md -- Static topic shift detection with cosine distance (TDD)
- [x] 06-02-PLAN.md -- Context stash storage layer and StashManager CRUD
- [x] 06-03-PLAN.md -- TopicShiftHandler integration and /laminark:stash command
- [x] 06-04-PLAN.md -- /laminark:resume command and topic_context MCP tool
- [x] 06-05-PLAN.md -- Adaptive EWMA threshold with historical session seeding (TDD)
- [x] 06-06-PLAN.md -- Sensitivity configuration and decision logging
- [x] 06-07-PLAN.md -- Gap closure: wire topic detection into embedding loop and add notification delivery

### Phase 7: Knowledge Graph and Advanced Intelligence
**Goal**: Observations are connected into a navigable knowledge graph of entities and relationships, with high-quality embeddings from Claude's own reasoning
**Depends on**: Phase 4, Phase 6
**Requirements**: INT-02, INT-03, INT-09, INT-10, INT-11, INT-12, INT-13, DQ-01
**Success Criteria** (what must be TRUE):
  1. Entities (Project, File, Decision, Problem, Solution, Tool, Person) are automatically extracted from observations and stored as graph nodes
  2. Typed relationships (uses, depends_on, decided_by, related_to, part_of, caused_by, solved_by) connect entities as graph edges
  3. Claude can query the knowledge graph via MCP tool (e.g., "what files does this decision affect?" returns traversal results)
  4. Graph enforces entity type taxonomy and caps node degree at 50 edges, preventing unnavigable hairball growth
  5. Curation agent periodically merges similar observations and generates consolidated summaries during quiet periods
**Plans**: 8 plans

Plans:
- [x] 07-01-PLAN.md -- Graph storage schema, type taxonomy, and recursive CTE traversal queries
- [x] 07-02-PLAN.md -- Claude piggyback embedding strategy and hybrid selector
- [x] 07-03-PLAN.md -- Entity extraction rules and pipeline for all 7 entity types
- [x] 07-04-PLAN.md -- Temporal awareness and observation staleness detection
- [x] 07-05-PLAN.md -- Relationship detection and graph constraint enforcement (max degree, dedup)
- [x] 07-06-PLAN.md -- MCP query_graph and graph_stats tools for Claude graph access
- [x] 07-07-PLAN.md -- Curation agent for observation merging and graph maintenance
- [x] 07-08-PLAN.md -- Gap closure: wire entity extraction, relationship detection, and curation agent into live flow

### Phase 8: Web Visualization
**Goal**: Users can visually explore their memory graph and session timeline in an interactive browser UI
**Depends on**: Phase 7
**Requirements**: VIS-01, VIS-02, VIS-03, VIS-04, VIS-05, VIS-06
**Success Criteria** (what must be TRUE):
  1. User opens localhost URL in any browser and sees the memory visualization UI
  2. Knowledge graph renders as an interactive force-directed layout where entities are nodes and relationships are edges
  3. User can click a node to see its associated observations, filter nodes by entity type, and zoom to specific time ranges
  4. Timeline view shows chronological flow of sessions, observations, and topic shift points
  5. UI updates live as new observations are processed (no manual refresh needed)
**Plans**: 5 plans

Plans:
- [x] 08-01-PLAN.md -- Hono web server with static SPA serving, REST API for graph/timeline data, and SSE endpoint
- [x] 08-02-PLAN.md -- Cytoscape knowledge graph with force-directed layout and entity type styling
- [x] 08-03-PLAN.md -- Graph interaction: node click details, entity type filtering, time range zoom
- [x] 08-04-PLAN.md -- Timeline view with session cards, observation entries, and topic shift markers
- [x] 08-05-PLAN.md -- Live SSE updates end-to-end and viewport culling for 500+ node performance

</details>

### v2.0 Global Tool Intelligence (In Progress)

**Milestone Goal:** Transform Laminark from a project-scoped memory plugin into a globally-installed tool intelligence layer that discovers, maps, and routes to available tools based on conversation context and scope awareness.

- [x] **Phase 9: Global Installation** - Plugin manifest, global deployment, and project-aware session bootstrapping
- [x] **Phase 10: Tool Discovery and Registry** - Config parsing, tool enumeration, and scope-aware registry storage
- [x] **Phase 11: Scope Resolution** - Prefix-based scope detection and per-session tool filtering
- [ ] **Phase 12: Usage Tracking** - Organic tool usage recording from hook events with project and session context
- [ ] **Phase 13: Context Enhancement** - Session start injection extended with ranked tool suggestions within budget
- [ ] **Phase 14: Conversation Routing** - Intent-to-tool mapping with confidence thresholds and cold start heuristics
- [ ] **Phase 15: Tool Search** - MCP tool for querying the registry by keyword, scope, and semantic meaning
- [ ] **Phase 16: Staleness Management** - Config rescan, age-based deprioritization, and failure-driven demotion

## Phase Details

### Phase 9: Global Installation
**Goal**: Laminark is present in every Claude Code session as a globally-installed plugin that detects and adapts to whichever project the user is working in
**Depends on**: Phase 8 (v1.0 complete)
**Requirements**: GLOB-01, GLOB-02, GLOB-03, GLOB-04, GLOB-05
**Success Criteria** (what must be TRUE):
  1. User opens any Claude Code session in any project directory and Laminark's MCP tools and hooks are available without per-project `.mcp.json` configuration
  2. Laminark detects the current project directory on session start and scopes memory operations to that project automatically
  3. The self-referential filter correctly ignores Laminark's own tool calls under both the legacy `mcp__laminark__` prefix and the new `mcp__plugin_laminark_laminark__` prefix
  4. User can install Laminark globally via `claude plugin install` from the published npm package
**Plans**: 2 plans

Plans:
- [x] 09-01-PLAN.md -- Dual-prefix self-referential filter with TDD (GLOB-04)
- [x] 09-02-PLAN.md -- Plugin manifest, hooks.json, and .mcp.json configuration for global install (GLOB-01, GLOB-02, GLOB-03, GLOB-05)

### Phase 10: Tool Discovery and Registry
**Goal**: Laminark knows what tools exist across all configuration scopes and stores them in a queryable registry with provenance metadata
**Depends on**: Phase 9
**Requirements**: DISC-01, DISC-02, DISC-03, DISC-04, DISC-05, DISC-06
**Success Criteria** (what must be TRUE):
  1. On session start, Laminark reads `.mcp.json`, `~/.claude.json`, `~/.claude/commands/`, `.claude/commands/`, `~/.claude/skills/`, `.claude/skills/`, and `~/.claude/plugins/installed_plugins.json` to enumerate available tools
  2. Every discovered tool is stored in a `tool_registry` table with its name, description, scope origin, and discovery timestamp
  3. When Claude invokes any tool during a session, Laminark records the tool name in the registry even if it was not found during config discovery (organic discovery via PostToolUse)
  4. The registry persists across sessions -- tools discovered yesterday are still queryable today
**Plans**: 2 plans (complete)

Plans:
- [x] 10-01-PLAN.md -- Tool type definitions, migration 16 (tool_registry table), and ToolRegistryRepository
- [x] 10-02-PLAN.md -- Config scanner (DISC-01 through DISC-04), organic discovery (DISC-05), and handler/session-lifecycle wiring

### Phase 11: Scope Resolution
**Goal**: Tool suggestions and queries are filtered to only include tools actually available in the current session's resolved scope
**Depends on**: Phase 10
**Requirements**: SCOP-01, SCOP-02, SCOP-03, SCOP-04
**Success Criteria** (what must be TRUE):
  1. Each tool in the registry has a scope classification (built-in, global, project, plugin) derived from its name prefix and config origin
  2. Session start context only surfaces tools that are available in the current project's resolved scope (built-in + global + current project + team)
  3. A tool registered from project A's `.mcp.json` is never suggested or surfaced when working in project B
  4. Scope detection correctly parses tool_name prefixes: bare names are built-in, `mcp__` prefix is MCP server, `mcp__plugin_` prefix is plugin-provided
**Plans**: 1 plan (complete)

Plans:
- [x] 11-01-PLAN.md -- Scope-filtered query (getAvailableForSession), tool section formatting, and session context wiring

### Phase 12: Usage Tracking
**Goal**: Laminark builds a usage profile of which tools are used, how often, and in what context, providing the data foundation for intelligent routing
**Depends on**: Phase 10, Phase 11
**Requirements**: UTRK-01, UTRK-02, UTRK-03
**Success Criteria** (what must be TRUE):
  1. Every PostToolUse hook event increments the tool's usage count and updates its last_used_at timestamp in the registry
  2. Each usage event is recorded with its session ID and project association, enabling per-project and per-session usage analysis
  3. Usage data accumulated across multiple sessions is queryable -- a tool used 50 times over the past week shows that history
**Plans**: TBD

### Phase 13: Context Enhancement
**Goal**: Claude starts every session knowing not just what happened last time, but what tools are available and most relevant to the current context
**Depends on**: Phase 11, Phase 12
**Requirements**: CTXT-01, CTXT-02, CTXT-03
**Success Criteria** (what must be TRUE):
  1. Session start injection includes an "Available Tools" section listing the most relevant tools for the current project scope
  2. The tool suggestions section fits within a 500-character sub-budget and does not cause the overall context injection to exceed 6000 characters
  3. Tools are ranked by a relevance score combining usage frequency and recency, so the most-used recent tools appear first
**Plans**: TBD

### Phase 14: Conversation Routing
**Goal**: Laminark detects when the conversation is heading toward a task that a specific tool can handle and proactively suggests it, with graceful behavior when it lacks data
**Depends on**: Phase 12, Phase 13
**Requirements**: ROUT-01, ROUT-02, ROUT-03, ROUT-04
**Success Criteria** (what must be TRUE):
  1. When the user discusses a topic that historically led to using a specific tool, Laminark detects the pattern match and surfaces a suggestion
  2. Tool suggestions are delivered via the existing notification mechanism (context injection or hook notification) -- Laminark never auto-invokes tools on the user's behalf
  3. When confidence in a routing match is below threshold, no suggestion is made rather than showing a low-quality guess
  4. In a fresh installation with no usage history, heuristic fallback routing provides basic suggestions based on tool descriptions and the current conversation topic
**Plans**: TBD

### Phase 15: Tool Search
**Goal**: Claude can explicitly search and explore the tool registry to find tools by keyword, scope, or semantic description
**Depends on**: Phase 10, Phase 12
**Requirements**: SRCH-01, SRCH-02, SRCH-03
**Success Criteria** (what must be TRUE):
  1. Claude can call a `discover_tools` MCP tool to search the registry by keyword and optionally filter by scope
  2. Tool descriptions are indexed for semantic search using the existing hybrid search infrastructure (FTS5 + vector), so "file manipulation" finds tools described as "read and write files"
  3. Search results include each tool's scope, total usage count, and last used timestamp, giving Claude enough context to recommend the right tool
**Plans**: TBD

### Phase 16: Staleness Management
**Goal**: The tool registry stays accurate over time by detecting removed tools, deprioritizing stale entries, and demoting tools that consistently fail
**Depends on**: Phase 10, Phase 12
**Requirements**: STAL-01, STAL-02, STAL-03
**Success Criteria** (what must be TRUE):
  1. On each session start, config rescan compares current config files against the registry and marks tools that no longer appear in any config as stale
  2. Tools not seen (neither discovered nor used) in 30+ days are automatically deprioritized in ranking and suggestions
  3. When a PostToolUseFailure event occurs, the failing tool is deprioritized in future suggestions until a successful use resets its standing
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 9 -> 10 -> 11 -> 12 -> 13 -> 14 -> 15 -> 16

Note: Phases 15 and 16 depend on Phases 10+12 (not on each other or on 13/14), so they could execute in parallel with 13/14 if needed. The linear order above is the default sequence.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Storage Engine | v1.0 | 4/4 | Complete | 2026-02-08 |
| 2. MCP Interface and Search | v1.0 | 3/3 | Complete | 2026-02-08 |
| 3. Hook Integration and Capture | v1.0 | 3/3 | Complete | 2026-02-08 |
| 4. Embedding Engine and Semantic Search | v1.0 | 4/4 | Complete | 2026-02-08 |
| 5. Session Context and Summaries | v1.0 | 3/3 | Complete | 2026-02-08 |
| 6. Topic Detection and Context Stashing | v1.0 | 7/7 | Complete | 2026-02-08 |
| 7. Knowledge Graph and Advanced Intelligence | v1.0 | 8/8 | Complete | 2026-02-08 |
| 8. Web Visualization | v1.0 | 5/5 | Complete | 2026-02-08 |
| 9. Global Installation | v2.0 | 2/2 | Complete | 2026-02-10 |
| 10. Tool Discovery and Registry | v2.0 | 2/2 | Complete | 2026-02-11 |
| 11. Scope Resolution | v2.0 | 1/1 | Complete | 2026-02-11 |
| 12. Usage Tracking | v2.0 | 0/TBD | Not started | - |
| 13. Context Enhancement | v2.0 | 0/TBD | Not started | - |
| 14. Conversation Routing | v2.0 | 0/TBD | Not started | - |
| 15. Tool Search | v2.0 | 0/TBD | Not started | - |
| 16. Staleness Management | v2.0 | 0/TBD | Not started | - |
