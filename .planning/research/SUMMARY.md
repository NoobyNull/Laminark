# Project Research Summary

**Project:** Laminark v2.2 -- Automatic Debug Path Tracking, Waypoint Capture, KISS Summary Generation, Graph Overlay Visualization
**Domain:** Debug journey tracking and resolution path management for LLM coding assistant memory systems
**Researched:** 2026-02-14
**Confidence:** HIGH

## Executive Summary

Debug resolution paths are a new capability that automatically tracks a developer's journey from error detection to resolution, creating a "breadcrumb trail" of attempts, dead ends, pivots, and eventual fixes. The research reveals this feature requires **zero new npm dependencies** — every capability (state machines, pattern detection, graph traversal, path visualization) can be built with TypeScript/Node.js primitives and Laminark's existing stack (SQLite, D3.js, Claude Agent SDK V2, Hono).

The recommended architecture treats paths as a **parallel data structure alongside the knowledge graph**, not embedded within it. Paths live in two new SQLite tables (`debug_paths` and `path_waypoints`) with graph edges connecting them to existing Problem/Solution/File entities. Path lifecycle management belongs in the HaikuProcessor background pipeline, not the hook handler, because the hook handler is a short-lived CLI process with no persistent state. An in-memory PathTracker singleton in the MCP server maintains active path state to avoid per-observation DB queries.

The critical risk is **false positive debug detection** — treating every error as a debug session floods the graph with meaningless paths. Prevention requires a state machine approach with temporal confirmation (3+ error signals within a time window) rather than keyword matching on single observations. The second major risk is **Haiku call volume explosion** — path detection must extend the existing classifier prompt rather than adding separate API calls. By addressing these architectural decisions in Phase 1, the implementation can proceed with high confidence using well-established patterns from the existing codebase.

## Key Findings

### Recommended Stack

**No new npm packages needed.** Every capability maps to existing patterns in the Laminark codebase. The work breaks down to: (1) plain TypeScript state machine for path lifecycle (4 states, 6 transitions), (2) regex patterns on tool output plus Haiku AI classification for ambiguous cases (extending existing piggyback-extractor), (3) extension of existing PostToolUse hook pipeline for waypoint capture, (4) two new SQLite tables via existing migration framework, (5) Haiku AI call via existing Agent SDK V2 session API for KISS summaries, (6) new D3 SVG layer in existing graph visualization with animated breadcrumb trails.

**Core technologies:**
- **SQLite (existing better-sqlite3):** Two new tables (debug_paths, path_waypoints) via migration v20/v21 — follows established 19-migration pattern exactly
- **TypeScript enum + transition map:** Path lifecycle state machine (4 states: idle/active/resolved/abandoned) — library (xstate, robot) would be massive overkill for 15 lines of code
- **D3.js line generators (existing):** Path overlay visualization using `d3.curveCatmullRom` for smooth curves, CSS `stroke-dashoffset` animation for breadcrumb effect — zero new dependencies
- **Claude Agent SDK V2 (existing Haiku session):** KISS summary generation on path resolution using existing `callHaiku()` pattern — no new API integration
- **Hono (existing):** Path API endpoints (`/api/paths`, `/api/paths/:id`) following existing API route patterns
- **MCP SDK (existing):** Three new tools (`path:start`, `path:resolve`, `path:show`) following existing `server.tool()` pattern

**What NOT to add:**
- xstate/robot (state machine libraries): 4 states doesn't justify dependency weight
- dagre/graphlib (graph algorithms): Paths are linear sequences, not DAGs
- Redis/job queues: All state lives in SQLite, no async job processing needed
- Additional embedding models: Jaccard similarity on tokenized errors (already in `shared/similarity.ts`) suffices

### Expected Features

**Must have (table stakes — Phase 1):**
- **Automatic debug session detection:** Zero manual intervention, detects from sentiment + tool patterns + Haiku classification. Existing `piggyback-extractor.ts` provides sentiment detection (<10ms), Haiku classifier provides `problem` classification (already runs). Two-tier: fast regex first, Haiku confirmation for ambiguous cases.
- **Waypoint capture (breadcrumb trail):** Every observation during active debug becomes potential waypoint. New work is linking observations to paths with ordering metadata. Reuses existing observation pipeline.
- **Resolution detection:** Haiku classifies as `solution` + positive sentiment shift + test pass after fail. Consecutive-success counter (threshold: 3) avoids premature resolution.
- **Path as graph entity:** Extends entity types to include 'DebugPath', connects to existing Problem/Solution/File entities via standard graph edges. Path data lives in dedicated tables, graph node serves as anchor.
- **KISS summary generation:** Single Haiku call on path resolution. Structured output format: `{kiss_summary, root_cause, what_fixed_it}`. Pre-filtered waypoints (first error, edits, final verification, solutions only).

**Should have (differentiators — Phase 2):**
- **Multi-layer dimensions:** Paths categorized along logical (mental model), programmatic (code-level), development (workflow) dimensions. Enriches summary generation, enables multi-dimensional search. Low marginal cost once summaries exist.
- **Dead end tracking:** Detects run-fail-revert patterns in waypoint sequences. Records what DID NOT work. Anti-pattern detection across multiple paths.
- **Proactive path recall:** When new debug starts, surface relevant past paths (same files, similar errors, matching patterns). Uses existing PreToolUse hook for context injection.

**Defer (v2+ — Phase 3):**
- **Path visualization overlay on graph:** D3 animated breadcrumb trails with color-coded status. Requires D3 work but existing graph already shows path entities. Defer until paths have accumulated.
- **Cross-session path linking:** Links debug activity across session boundaries (user closes/reopens Claude). Edge case that can wait until base system proven.

### Architecture Approach

Path lifecycle management belongs in the **HaikuProcessor, not the hook handler**. The hook handler (`handler.ts`) is a short-lived CLI process that opens a fresh DB connection per invocation — it has no in-memory state across calls. The HaikuProcessor is a long-running background process in `index.ts` that already processes every observation through classify/extract/relate. Adding a fourth step (path detection) to this pipeline is the natural integration point.

**Major components:**
1. **PathTracker (in-memory state machine)** — Singleton in MCP server process. Maintains active path state (current path ID, waypoint buffer, consecutive-success counter). One active path per session. Reads from PathRepository on startup, writes through it on state changes.
2. **PathRepository (SQLite persistence)** — CRUD operations for `debug_paths` + `path_waypoints` tables. Follows existing repository pattern from `sessions.ts`, `observations.ts`.
3. **haiku-path-detector-agent (Haiku agent)** — Determines whether observation indicates error/failure pattern (start path), waypoint (add to active), or resolution (close path). Called after classification, for every `signal` observation. Output: `{action, waypoint_type, confidence, reason}`. Must be fast (128 tokens max).
4. **haiku-path-summary-agent (Haiku agent)** — Generates KISS summary from waypoint history. Called once on path resolution. Input: all waypoints (summaries + types), trigger summary, resolution. Output: `{kiss_summary, root_cause, what_fixed_it}`. Rare call, can use 512 tokens.
5. **HaikuProcessor integration** — Modified `processOne()` flow: (1) classify observation, (2) **NEW: path detection**, (3) extract entities, (4) infer relationships. Path detection between classify and extract means it has classification data and entity extraction can include path node in context.
6. **D3 path overlay (separate SVG layer)** — `pathOverlayGroup` inserted between edges and nodes layers. Renders as animated dashed lines connecting waypoint nodes. Waypoint markers colored by type (error: red, attempt: yellow, resolution: green). Toggle control in toolbar.

**Key patterns to follow:**
- Repository + in-memory state hybrid (PathRepository handles persistence, PathTracker handles live state)
- One focused Haiku agent per concern (detection and summarization are separate agents)
- SSE broadcast for live updates (all path state changes broadcast via existing SSE system)

### Critical Pitfalls

1. **False positive debug detection (CRITICAL)** — Every error treated as debug session floods graph with meaningless paths. **Prevention:** Debug sessions require temporal duration and repeated failure patterns (3+ error signals within 5-minute window). State machine: IDLE → POTENTIAL_DEBUG (first error) → ACTIVE_DEBUG (confirmation: recurring errors) → RESOLVED. Single PostToolUse failure never triggers debug session. Only `problem`-classified observations contribute. **Phase impact:** Phase 1 critical design decision — extensive unit tests covering normal development scenarios (TDD cycles, build-fix-build, intentional test failures).

2. **Haiku call volume explosion (CRITICAL)** — Adding separate Haiku call per observation for debug detection pushes past sustainable API usage. Current pipeline makes 3 Haiku calls per signal observation (classify, extract entities, infer relationships). Adding 4th call creates unsustainable load. **Prevention:** DO NOT add separate Haiku call for debug detection. Extend existing classifier prompt to include `debug_signal` field alongside existing `signal`/`classification` fields. Single call, richer output. KISS summary generation only at path closure (rare event, 2-5 per day). **Phase impact:** Phase 1 — modify existing classifier prompt rather than adding new agent module.

3. **Graph pollution from path entities (CRITICAL)** — Each debug path creates multiple entities/edges. 10-20 paths per day × 3-15 waypoints = 200+ new nodes and 500+ new edges per week, potentially exceeding entire existing graph size. Debug paths are sequential structures, not graph-structured — forcing into graph creates long chains that dominate layout. **Prevention:** Model paths in separate `debug_paths` table rather than cramming into graph_nodes/graph_edges. Path references existing graph nodes via foreign keys and edges. Add graph_nodes entry of type 'DebugPath' as anchor for edges, but full path data (waypoints, status, summaries) lives in dedicated tables. Implement UI toggle to show/hide path overlays. **Phase impact:** Phase 1 architecture decision BEFORE any implementation — separate-table approach strongly recommended.

4. **Cross-session state management (CRITICAL)** — Developer starts debugging in one session, session ends/resets, continues in new session. Path state lost because tracked in-memory. Laminark hooks run as separate Node.js processes per hook invocation (NO long-running process on hook side). State machine cannot live in-memory — must persist to SQLite on every transition. **Prevention:** All debug path state MUST be persisted to SQLite. On SessionStart, check for ACTIVE paths, inject hint into context. On SessionEnd, mark active paths as `suspended` (not closed). Resume when next session picks up same error pattern. Timeout: paths `suspended` >24 hours auto-resolve as "abandoned/unresolved". **Phase impact:** Phase 1 (data model), Phase 2 (state machine persistence), specific testing for session boundary case.

5. **Path noise (waypoints overwhelming signal)** — Every tool call during debug recorded as waypoint. 30-minute debug session produces 150 waypoints when only 5-10 meaningful (hypothesis, key finding, attempted fix, test failure, real fix, passing test). **Prevention:** Define explicit "debug-significant" tool patterns: only Write, Edit, Bash (test/build), and Haiku `problem`/`solution` classifications become waypoints. Use existing `kind` field: only `change`, `verification`, `decision` kinds are candidates. Waypoint deduplication (5 edits to same file → single "modified X (5 edits)" waypoint). Cap at 20-30 waypoints per path. **Phase impact:** Phase 1 — waypoint filtering rules.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Storage Foundation & Detection Pipeline
**Rationale:** Storage and detection are foundational — everything depends on these working correctly. False positive detection (Pitfall 1) is THE critical design decision. Must be addressed first with extensive testing before building downstream features. HaikuProcessor integration is natural extension point (background pipeline already processes every observation). The hook handler cannot hold path state (ephemeral subprocess), so SQLite persistence is required from day 1.

**Delivers:**
- `debug_paths` and `path_waypoints` SQLite tables (migrations v20/v21)
- PathRepository (CRUD operations)
- PathTracker (in-memory state machine with SQLite persistence)
- Extended entity types to include 'DebugPath'
- Modified classifier prompt to include debug detection (extends existing Haiku call, no new calls)
- HaikuProcessor integration (path detection as step 4 after classification)
- Resolution detection heuristic (consecutive-success counter)
- Basic waypoint capture with filtering (only significant tools/classifications)

**Addresses features:**
- TS-1: Automatic debug session detection (with state machine temporal confirmation)
- TS-2: Waypoint capture (reuses observation pipeline)
- TS-3: Resolution detection (Haiku `solution` + sentiment + consecutive successes)
- TS-4: Path as graph entity (dedicated tables + graph node anchor)

**Avoids pitfalls:**
- Pitfall 1 (false positives): State machine with temporal confirmation, not keyword matching
- Pitfall 2 (Haiku volume): Extends existing classifier, no separate calls
- Pitfall 3 (graph pollution): Separate tables, not embedded in graph_nodes
- Pitfall 4 (cross-session): SQLite persistence from day 1
- Pitfall 5 (path noise): Waypoint filtering by kind and significance

**Testing requirements:**
- Unit tests for state machine transitions (all 6 valid transitions)
- False positive scenarios: TDD cycles, build errors, intentional test failures, lint warnings
- Cross-session persistence: SessionEnd → SessionStart boundary
- Waypoint filtering: verify only significant observations captured
- Integration with existing HaikuProcessor pipeline (no regression on classify/extract/relate)

### Phase 2: KISS Summaries & MCP Tools
**Rationale:** Once detection works reliably (Phase 1), summaries and manual controls add immediate user value. KISS summary is the "next time just do X" promise — the feature's core value proposition. MCP tools enable explicit path control for cases where auto-detection misses or user wants manual override. Both depend on Phase 1 storage/detection but can be built in parallel to each other.

**Delivers:**
- haiku-path-summary-agent (Haiku agent for KISS summaries)
- Resolution flow completion (PathTracker calls summary agent on resolve)
- Graph edge creation (link resolved paths to Problem/Solution/File nodes)
- Multi-layer dimensions (logical/programmatic/development) in summary metadata
- Dead end tracking (run-fail-revert pattern detection)
- Four MCP tools: `path:start`, `path:resolve`, `path:show`, `path:list`
- Tool registration in index.ts
- SSE broadcast for path events (`path_started`, `path_waypoint`, `path_resolved`)

**Uses stack elements:**
- Existing Haiku client (`callHaiku()` from haiku-client.ts)
- MCP SDK (`server.tool()` pattern from existing tools)
- Zod schemas for tool input validation

**Implements architecture components:**
- haiku-path-summary-agent (structured output: kiss_summary, root_cause, what_fixed_it)
- Path-to-graph linking (edges from path nodes to Problem/Solution/File entities)

**Addresses features:**
- TS-5: KISS summary generation (single Haiku call on resolution, structured format)
- D-1: Multi-layer dimensions (enriches summary with logical/programmatic/development categorization)
- D-4: Dead end tracking (waypoint sequence analysis for run-fail-revert patterns)

**Avoids pitfalls:**
- Pitfall 6 (summary quality): Structured output format, pre-filtered waypoints, few-shot examples, strict token limit

### Phase 3: Visualization & Proactive Recall
**Rationale:** Visualization and proactive recall require a corpus of resolved paths to demonstrate value. Deferring until base system has generated paths makes testing/iteration easier. D3 overlay work is independent of proactive recall — can be built in parallel. Both are high-value differentiators but not essential for core path tracking to function.

**Delivers:**
- Path API endpoints (GET `/api/paths`, `/api/paths/:id`, `/api/paths/active`)
- D3 path overlay layer (pathOverlayGroup SVG layer in graph.js)
- Animated breadcrumb trails (dashed lines with stroke-dashoffset animation)
- Waypoint markers (color-coded by type: error/attempt/failure/success/resolution/pivot/revert)
- Path toggle control (toolbar button, follows existing edge label toggle pattern)
- SSE event handlers for live path updates (app.js)
- Path detail panel (waypoint timeline, summary display)
- Proactive path recall (PreToolUse context injection with relevant past paths)
- Cross-session path linking (reopen existing path instead of creating new)

**Implements architecture components:**
- D3 path overlay (separate SVG layer between edges and nodes)
- Proactive recall (PreToolUse hook extension, existing assembleSessionContext integration)

**Addresses features:**
- D-2: Path visualization overlay on graph (D3 animated trails, color-coded status)
- D-3: Proactive path recall during active debugging (surface relevant past paths)
- D-5: Cross-session path linking (same issue across multiple sessions)

**Avoids pitfalls:**
- Pitfall 7 (visualization clutter): Toggle control, separate layer, compound node collapse
- Pitfall 11 (duplicate paths): Similarity check against recent resolved paths before creating new
- Pitfall 12 (SSE storms): Batched `debug_path_updated` events with debounced re-render (500ms)

### Phase Ordering Rationale

- **Phase 1 before Phase 2/3:** Detection must work correctly before summaries/visualization have data to work with. False positive detection is critical — flooding graph with meaningless paths destroys feature value. State persistence must work before cross-session features.
- **Phase 2 parallel to Phase 3:** Summaries and visualization are independent. Summaries provide immediate value (can read path summaries via MCP tools without UI). Visualization enhances but doesn't gate summary value.
- **Phase 3 deferred:** Visualization and proactive recall require corpus of resolved paths. Better to defer until paths accumulate from Phase 1/2 usage. Trying to test D3 overlay or proactive recall with zero paths is difficult and unrealistic.

**Dependency chain:**
```
Phase 1 (Storage + Detection)
  |
  +---> Phase 2 (Summaries + Tools)  [parallel with Phase 3]
  |
  +---> Phase 3 (Visualization + Recall)  [parallel with Phase 2]
```

### Research Flags

**Phases likely needing deeper research during planning:**
- **None** — All three phases use existing Laminark patterns and well-documented technologies. Phase 1 extends HaikuProcessor (existing pattern), Phase 2 uses existing Haiku/MCP patterns, Phase 3 uses existing D3/SSE patterns. The research has identified all integration points and critical decisions.

**Phases with standard patterns (skip research-phase):**
- **Phase 1:** SQLite migrations (19 prior migrations), HaikuProcessor integration (existing 3-step pipeline), repository pattern (sessions.ts, observations.ts provide templates)
- **Phase 2:** Haiku agents (classifier/entity/relationship agents provide pattern), MCP tools (existing tools provide `server.tool()` pattern), SSE broadcast (existing SSE system)
- **Phase 3:** D3 visualization (existing graph.js has layered SVG groups), PreToolUse hooks (existing pattern from topic context injection), API endpoints (existing Hono routes)

**Implementation confidence:** HIGH — every capability maps to existing codebase patterns with specific file references identified. No novel integrations or unknown technologies.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. Every capability maps to existing patterns with specific file/line references from codebase analysis. 19 prior SQLite migrations validate schema approach. D3 v7 line generators and CSS animations are well-documented standard patterns. |
| Features | HIGH | Feature taxonomy (table stakes / differentiators / anti-features) grounded in codebase analysis of existing observation pipeline, Haiku classification, and session tracking. Detection signals already flowing through system (sentiment, classification, tool patterns). |
| Architecture | HIGH | Based on thorough analysis of all existing source files. Key architectural insight (HaikuProcessor vs hook handler for path lifecycle) comes from understanding hook-as-subprocess architecture. PathTracker pattern matches existing in-memory + DB hybrid used by observation processing. |
| Pitfalls | HIGH | All critical pitfalls grounded in specific Laminark architecture constraints (ephemeral hook handler, HaikuProcessor call volume, fixed entity taxonomy, session boundaries). Prevention strategies reference exact integration points (existing classifier prompt, existing repository pattern, existing SSE broadcast). |

**Overall confidence:** HIGH

### Gaps to Address

**Waypoint type taxonomy (MEDIUM confidence):** The 6 waypoint types (error, attempt, discovery, pivot, backtrack, resolution) are proposed based on debug workflow analysis but may need refinement during implementation. **Mitigation:** Start with these types, monitor waypoint classification quality in Phase 1, adjust taxonomy if patterns emerge that don't fit. Waypoint type is metadata, not core architecture — safe to evolve.

**Loop detection threshold (MEDIUM confidence):** Default of 3 repetitions for detecting "stuck in a loop" is a heuristic guess. May need tuning based on real usage. **Mitigation:** Make threshold configurable. Monitor false positive/negative rates in Phase 2. Typical range: 2-5 repetitions.

**KISS summary prompt engineering (MEDIUM confidence):** Summary quality depends on prompt structure and few-shot examples. Research identified structured output format and pre-filtering strategy, but exact prompt wording requires iteration. **Mitigation:** Phase 2 includes testing with real debug paths from Phase 1. Iterate on prompt based on summary quality. Store raw waypoint IDs alongside summary so users can drill into details if summary insufficient.

**D3 overlay visual design (MEDIUM confidence):** Color scheme, line thickness, animation speed are UX decisions requiring visual testing. Research provides technical approach (D3 line generators, CSS animations) but not final visual parameters. **Mitigation:** Phase 3 implementation includes visual iteration. Provide toggle to hide paths if users find overlay distracting. Follow existing graph color scheme conventions.

**No validation gaps:** All core technical decisions (storage model, detection heuristics, Haiku integration, graph linking) have HIGH confidence with specific implementation references from codebase analysis.

## Sources

### Primary (HIGH confidence)
- **Laminark codebase analysis** — All source files reviewed for integration points:
  - `src/hooks/handler.ts` (PostToolUse pipeline, ephemeral CLI process, lines 62-238)
  - `src/intelligence/haiku-processor.ts` (background enrichment, 30s timer, lines 58-76, 181-188)
  - `src/intelligence/haiku-classifier-agent.ts` (Haiku agent pattern, lines 41-55)
  - `src/intelligence/haiku-client.ts` (shared Haiku session, singleton Agent SDK V2, lines 25-40, 66)
  - `src/graph/types.ts` (entity/relationship taxonomy, fixed arrays, lines 13-20, 28-37, 118)
  - `src/graph/schema.ts` (graph operations, traversal, constraints)
  - `src/graph/migrations/001-graph-tables.ts` (table DDL pattern)
  - `src/graph/constraints.ts` (MAX_NODE_DEGREE enforcement, lines 69-103)
  - `src/graph/temporal-decay.ts` (30-day half-life, 180-day max age, lines 95-149)
  - `src/hooks/piggyback-extractor.ts` (sentiment detection NEGATIVE_WORDS, lines 96-100)
  - `src/hooks/admission-filter.ts` (pre-screening pattern)
  - `src/hooks/session-lifecycle.ts` (SessionStart/SessionEnd events)
  - `src/curation/summarizer.ts` (compressObservations pattern)
  - `src/web/routes/api.ts` (Hono REST API pattern)
  - `src/web/routes/sse.ts` (SSE broadcast pattern)
  - `src/mcp/tools/query-graph.ts` (MCP tool registration pattern)
  - `src/storage/database.ts` (SQLite WAL configuration)
  - `ui/graph.js` (D3 force-directed graph, layer groups, SSE integration)
  - `src/index.ts` (MCP server wiring, background processor lifecycle)

### Secondary (MEDIUM confidence)
- **Braintrust AI Observability Guide 2026** — Session analysis and pattern detection patterns for observability tooling
- **Middleware Root Cause Analysis in Distributed Systems** — Automated detection techniques, anomaly detection approaches
- **DZone LLMs for Root Cause Analysis** — LLM-driven RCA and postmortem generation patterns
- **Rootly AI-Generated Postmortems** — Automated summary generation from incident timelines (KISS summary inspiration)
- **Akira AI Agents for Software Error Resolution** — AI debug agent memory stack and session tracking patterns
- **Elastic Root Cause Analysis with Logs** — Log pattern analysis and anomaly detection strategies

### Tertiary (informational, not critical)
- **Replay.io Time Travel Debugging** — Session replay vs runtime replay architecture distinctions (informed anti-feature AF-1 decision)
- **Acquia Automating Error Detection with Git Bisect** — Binary search debugging workflow (informed anti-feature AF-2 decision)

---
*Research completed: 2026-02-14*
*Ready for roadmap: yes*
