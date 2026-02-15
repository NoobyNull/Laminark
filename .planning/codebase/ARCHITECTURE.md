# Architecture

**Analysis Date:** 2026-02-14

## Pattern Overview

**Overall:** Event-driven multi-agent memory system with layered background processing

**Key Characteristics:**
- MCP server exposes tools to Claude Code, hook handler captures tool execution events
- Multiple background agents process observations asynchronously (embedding, classification, graph extraction, curation)
- SQLite with WAL mode provides single-writer, multi-reader concurrency between processes
- Graceful degradation at every layer (vector search, worker thread, Haiku API)

## Layers

**Hook Handler (CLI Entry Point):**
- Purpose: Capture tool execution events from Claude Code hook system
- Location: `src/hooks/handler.ts`, `src/hooks/`
- Contains: Event processing pipeline, filters (privacy, admission, self-referential), research buffer routing
- Depends on: Storage layer, no MCP SDK (cold start optimization)
- Used by: Claude Code hook system (stdin JSON → stdout context injection)

**MCP Server (Tool Provider):**
- Purpose: Expose memory operations as MCP tools for Claude to invoke
- Location: `src/mcp/server.ts`, `src/mcp/tools/`
- Contains: 9 tool implementations (recall, save-memory, topic-context, query-graph, graph-stats, status, discover-tools, report-tools, debug-paths)
- Depends on: Storage layer, background agents (worker, status cache)
- Used by: Claude Code via MCP protocol (stdio transport)

**Storage Layer (Data Access):**
- Purpose: Database operations scoped to projects
- Location: `src/storage/`
- Contains: Repository pattern (observations, sessions, embeddings, research-buffer, stash-manager, threshold-store, notifications, tool-registry)
- Depends on: SQLite database, migrations system
- Used by: All layers (hooks, MCP tools, background agents)

**Background Agents (Async Processing):**
- Purpose: Continuous processing of observations without blocking main request paths
- Location: `src/analysis/`, `src/intelligence/`, `src/graph/`
- Contains: AnalysisWorker (embeddings via worker thread), HaikuProcessor (classification + entity/relationship extraction), CurationAgent (graph maintenance), TopicShiftHandler (topic detection)
- Depends on: Storage layer, external APIs (Anthropic Haiku)
- Used by: Main server (src/index.ts) via timer-based polling

**Web Visualization (UI Server):**
- Purpose: Real-time graph and observation visualization
- Location: `src/web/server.ts`, `src/web/routes/`
- Contains: Hono REST API + SSE streaming, static file serving
- Depends on: Storage layer (read-only queries)
- Used by: Browser clients (separate HTTP server on port 37820)

**Routing Intelligence (Tool Suggestion):**
- Purpose: Learn from usage patterns and suggest relevant tools
- Location: `src/routing/`
- Contains: ConversationRouter, intent-patterns, heuristic-fallback
- Depends on: Tool registry, observation context
- Used by: Hook handler (PostToolUse evaluation)

**Path Debugging (Reasoning Traces):**
- Purpose: Track multi-step reasoning paths for debugging
- Location: `src/paths/`
- Contains: PathTracker, PathRepository, KISS summary agent
- Depends on: Haiku for summarization
- Used by: HaikuProcessor (classification signals), debug-paths tool

## Data Flow

**Observation Capture Flow (Hook Handler → Storage):**

1. Claude Code executes tool (Read/Write/Edit/Bash)
2. Hook handler receives PostToolUse event via stdin
3. Tool registry records usage (DISC-05 organic discovery)
4. Self-referential filter skips Laminark's own tools
5. Privacy filter checks file exclusions and redacts secrets
6. Research tools (Read/Glob/Grep) → research buffer (not full observations)
7. Extract observation text from tool response
8. Admission filter rejects noise content
9. Save guard prevents duplicates (content similarity)
10. Store to observations table (ObservationRepository)
11. Routing evaluation suggests tools based on context

**Embedding & Topic Shift Flow (Background Loop):**

1. 5-second timer finds unembedded observations
2. AnalysisWorker.embed() sends text to worker thread
3. Worker returns Float32Array embedding (384 dimensions for MiniLM, 768 for ONNX)
4. Store embedding in vec0 virtual table (sqlite-vec)
5. SSE broadcast to web clients (new observation event)
6. TopicShiftHandler evaluates embedding distance from session centroid
7. If shift detected → stash old observations, queue notification
8. SSE broadcast topic shift event

**Knowledge Graph Extraction Flow (HaikuProcessor):**

1. 30-second timer finds unclassified observations
2. HaikuProcessor batch processes (concurrency: 3)
3. Haiku classifier: noise vs signal, discovery/problem/solution
4. If noise → soft delete observation (deleted_at timestamp)
5. If signal → Haiku entity agent extracts entities (Project/File/Decision/Problem/Solution/Reference)
6. Quality gate validates entities (length, taxonomy compliance)
7. Upsert nodes to knowledge_graph_nodes table
8. Haiku relationship agent infers edges (related_to/solved_by/caused_by/modifies/informed_by/references/verified_by/preceded_by)
9. Insert edges to knowledge_graph_edges table
10. Constraint enforcement (max 50 edges per node)

**Curation Flow (Background Maintenance):**

1. 5-minute timer triggers CurationAgent
2. Merge near-duplicate observations (fuzzy dedup)
3. Deduplicate entities (case-insensitive, abbreviations, paths)
4. Enforce max degree constraint (approaching 50 edges)
5. Staleness sweep (flag contradictions)
6. Low-value pruning (short + unlinked + old + auto-captured)
7. Temporal decay (reduce edge weights over time, delete aged-out edges)
8. SSE broadcast curation complete event
9. StatusCache marked dirty for next refresh

**State Management:**
- Stateless request handling (each MCP tool call is independent)
- Session state tracked in sessions table (session_id from hook events)
- Background agent state in-memory (timers, worker thread handles)
- Adaptive thresholds persisted to threshold_store table (cold start seeding)

## Key Abstractions

**Observation:**
- Purpose: Unit of captured knowledge from tool executions
- Examples: `src/storage/observations.ts`, `src/shared/types.ts`
- Pattern: Repository with project scoping, soft deletes, FTS5 full-text search

**Repository Pattern:**
- Purpose: Project-scoped database access with prepared statements
- Examples: `src/storage/observations.ts`, `src/storage/sessions.ts`, `src/storage/embeddings.ts`, `src/storage/tool-registry.ts`
- Pattern: Constructor receives db + projectHash, all queries automatically scoped

**Background Agent:**
- Purpose: Timer-based asynchronous processing with error isolation
- Examples: `src/analysis/worker-bridge.ts`, `src/intelligence/haiku-processor.ts`, `src/graph/curation-agent.ts`
- Pattern: start()/stop() lifecycle, try/catch isolation, non-fatal degradation

**Knowledge Graph:**
- Purpose: Typed entity-relationship model with fixed taxonomy
- Examples: `src/graph/types.ts` (6 entity types, 8 relationship types), `src/graph/schema.ts`
- Pattern: Const arrays + union types (not enums), runtime validation with type guards

**Filter Pipeline:**
- Purpose: Multi-stage validation before storing observations
- Examples: `src/hooks/handler.ts` processPostToolUseFiltered
- Pattern: Early return on rejection, composable filters (privacy → admission → save guard)

## Entry Points

**MCP Server Entry:**
- Location: `src/index.ts`
- Triggers: Claude Code starts MCP server via stdio
- Responsibilities: Initialize database, start background agents (worker, HaikuProcessor, CurationAgent), register MCP tools, optionally start web server

**Hook Handler Entry:**
- Location: `src/hooks/handler.ts` (exported as `laminark-hook` binary)
- Triggers: Claude Code hook events (PreToolUse, PostToolUse, SessionStart, SessionEnd, Stop)
- Responsibilities: Process hook JSON from stdin, apply filter pipeline, write to database, optionally write context to stdout (PreToolUse, SessionStart)

**Web Server Entry:**
- Location: `src/web/server.ts`
- Triggers: Main server starts web server on port 37820 (unless --no_gui flag)
- Responsibilities: Serve static UI, expose REST API, stream SSE events

## Error Handling

**Strategy:** Graceful degradation with extensive try/catch isolation

**Patterns:**
- Background agents never crash main process (timer callbacks wrapped in .catch())
- Worker thread failures → keyword-only mode (no vector search)
- sqlite-vec load failure → keyword-only mode
- Haiku API failures → observation stays unclassified (retried next cycle)
- Tool registry/research buffer missing (pre-migration) → skip functionality
- Hook handler errors logged via debug, always exit 0 (non-zero exit surfaces errors to Claude)

## Cross-Cutting Concerns

**Logging:** Debug function with category tags (mcp, db, hook, embed, haiku, obs), controlled by LAMINARK_DEBUG env var

**Validation:** Zod schemas at API boundaries (ObservationInsert, tool input schemas), runtime type guards for graph types

**Authentication:** None (local-only MCP server, stdio transport, no network exposure)

---

*Architecture analysis: 2026-02-14*
