# Roadmap: Memorite

## Overview

Memorite delivers persistent adaptive memory for Claude Code in 8 phases following the natural dependency chain: storage foundation, then interfaces, then capture, then intelligence, then visualization. Phases 1-3 produce a minimum viable plugin with keyword search and automatic observation capture. Phases 4-6 add semantic intelligence, session continuity, and adaptive topic detection. Phases 7-8 add the knowledge graph, advanced embedding strategies, and visual exploration. Every phase delivers a coherent, independently verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Storage Engine** - Rock-solid SQLite foundation with WAL, concurrency, and crash recovery
- [ ] **Phase 2: MCP Interface and Search** - Claude-facing tools with keyword search and progressive disclosure
- [ ] **Phase 3: Hook Integration and Capture** - Automatic observation capture via Claude Code hooks
- [ ] **Phase 4: Embedding Engine and Semantic Search** - Vector embeddings with pluggable strategy and hybrid search
- [ ] **Phase 5: Session Context and Summaries** - Context continuity across sessions with progressive disclosure
- [ ] **Phase 6: Topic Detection and Context Stashing** - Adaptive topic shift detection with automatic context preservation
- [ ] **Phase 7: Knowledge Graph and Advanced Intelligence** - Entity extraction, relationship mapping, and Claude piggyback embeddings
- [ ] **Phase 8: Web Visualization** - Interactive knowledge graph and timeline views in the browser

## Phase Details

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
- [ ] 01-01-PLAN.md -- Project scaffolding, TypeScript config, core types, and dependency installation
- [ ] 01-02-PLAN.md -- SQLite database initialization with WAL mode, schema, migration system, and FTS5
- [ ] 01-03-PLAN.md -- Observation CRUD, session management, and FTS5 keyword search with project scoping
- [ ] 01-04-PLAN.md -- Concurrency safety, crash recovery, and persistence acceptance tests (TDD)

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
**Plans**: 4 plans

Plans:
- [ ] 02-01-PLAN.md -- MCP server scaffold with stdio transport and FTS5 keyword search tool
- [ ] 02-02-PLAN.md -- save_memory, forget, and get_observations CRUD tools
- [ ] 02-03-PLAN.md -- Timeline tool and token budget enforcement (2000 token cap)
- [ ] 02-04-PLAN.md -- Plugin manifest (.mcp.json) and Claude Code integration verification

### Phase 3: Hook Integration and Capture
**Goal**: Observations are automatically captured from Claude's tool usage without any user intervention
**Depends on**: Phase 2
**Requirements**: MEM-02, MEM-03, MEM-10, DQ-02
**Success Criteria** (what must be TRUE):
  1. When Claude uses a tool (file edit, bash command, etc.), an observation is silently captured and stored without the user doing anything
  2. Session start and end events are tracked with unique session IDs in the database
  3. Low-signal noise (raw build output, large file dumps, repetitive linter warnings) is filtered out and never stored
  4. Sensitive content matching configured patterns (like .env file contents, API keys) is excluded from capture
**Plans**: 4 plans

Plans:
- [ ] 03-01-PLAN.md -- Hook dispatcher scripts and ingest receiver HTTP endpoint with normalizer
- [ ] 03-02-PLAN.md -- Observation admission filter with noise detection and relevance scoring
- [ ] 03-03-PLAN.md -- Privacy filter for sensitive content redaction with configurable patterns
- [ ] 03-04-PLAN.md -- hooks.json configuration, pipeline orchestrator, and end-to-end capture testing

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
- [ ] 04-01: Pluggable embedding strategy interface with local ONNX default implementation
- [ ] 04-02: Worker thread setup for non-blocking embedding generation
- [ ] 04-03: sqlite-vec integration for vector similarity search
- [ ] 04-04: Hybrid search with reciprocal rank fusion (FTS5 + vector)
- [ ] 04-05: Graceful degradation and lazy model loading

### Phase 5: Session Context and Summaries
**Goal**: Claude starts every session already knowing what happened last time, and users can explicitly save and search memories via slash commands
**Depends on**: Phase 4
**Requirements**: CTX-01, CTX-02, UI-02, UI-03
**Success Criteria** (what must be TRUE):
  1. When a new Claude Code session starts, Claude receives a concise summary of the last session plus high-value recent observations within 2 seconds
  2. When a session ends, observations from that session are compressed into a concise session summary stored for future retrieval
  3. User can type /memorite:remember followed by text to explicitly save a memory with context
  4. User can type /memorite:recall followed by a description to search memories and see relevant results
**Plans**: 3 plans

Plans:
- [ ] 05-01-PLAN.md -- Session summary generation at Stop hook (compress session observations)
- [ ] 05-02-PLAN.md -- SessionStart context injection with progressive disclosure index
- [ ] 05-03-PLAN.md -- /memorite:remember and /memorite:recall slash command implementations

### Phase 6: Topic Detection and Context Stashing
**Goal**: When the user jumps to a new topic, the system preserves their previous context thread and lets them return to it
**Depends on**: Phase 4, Phase 5
**Requirements**: INT-05, INT-06, INT-07, INT-08, CTX-03, CTX-04, CTX-05, CTX-06, UI-04, UI-05, DQ-05
**Success Criteria** (what must be TRUE):
  1. When the user shifts to a clearly different topic mid-session, the system detects it and silently stashes the previous context thread
  2. User sees a brief notification that their previous context was stashed, with an indication of how to return
  3. User can type /memorite:resume to see stashed context threads and re-inject a chosen thread back into the conversation
  4. User can ask "where was I?" to see recently abandoned context threads ranked by recency and relevance
  5. Topic detection adapts to the user's natural variance over time -- a scattered session raises the shift threshold, a focused session lowers it
**Plans**: 6 plans

Plans:
- [ ] 06-01-PLAN.md -- Static topic shift detection with cosine distance (TDD)
- [ ] 06-02-PLAN.md -- Context stash storage layer and StashManager CRUD
- [ ] 06-03-PLAN.md -- TopicShiftHandler integration and /memorite:stash command
- [ ] 06-04-PLAN.md -- /memorite:resume command and topic_context MCP tool
- [ ] 06-05-PLAN.md -- Adaptive EWMA threshold with historical session seeding (TDD)
- [ ] 06-06-PLAN.md -- Sensitivity configuration and decision logging

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
**Plans**: 7 plans

Plans:
- [ ] 07-01-PLAN.md -- Graph storage schema, type taxonomy, and recursive CTE traversal queries
- [ ] 07-02-PLAN.md -- Claude piggyback embedding strategy and hybrid selector
- [ ] 07-03-PLAN.md -- Entity extraction rules and pipeline for all 7 entity types
- [ ] 07-04-PLAN.md -- Temporal awareness and observation staleness detection
- [ ] 07-05-PLAN.md -- Relationship detection and graph constraint enforcement (max degree, dedup)
- [ ] 07-06-PLAN.md -- MCP query_graph and graph_stats tools for Claude graph access
- [ ] 07-07-PLAN.md -- Curation agent for observation merging and graph maintenance

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
- [ ] 08-01-PLAN.md -- Hono web server with static SPA serving, REST API for graph/timeline data, and SSE endpoint
- [ ] 08-02-PLAN.md -- Cytoscape knowledge graph with force-directed layout and entity type styling
- [ ] 08-03-PLAN.md -- Graph interaction: node click details, entity type filtering, time range zoom
- [ ] 08-04-PLAN.md -- Timeline view with session cards, observation entries, and topic shift markers
- [ ] 08-05-PLAN.md -- Live SSE updates end-to-end and viewport culling for 500+ node performance

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Storage Engine | 0/4 | Planned | - |
| 2. MCP Interface and Search | 0/4 | Planned | - |
| 3. Hook Integration and Capture | 0/4 | Planned | - |
| 4. Embedding Engine and Semantic Search | 0/4 | Planned | - |
| 5. Session Context and Summaries | 0/3 | Planned | - |
| 6. Topic Detection and Context Stashing | 0/6 | Planned | - |
| 7. Knowledge Graph and Advanced Intelligence | 0/7 | Planned | - |
| 8. Web Visualization | 0/5 | Planned | - |
