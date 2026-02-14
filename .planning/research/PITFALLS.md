# Domain Pitfalls

**Domain:** Adding automatic debug path tracking and resolution path features to an existing memory/knowledge graph system (Laminark v2.2)
**Researched:** 2026-02-14
**Confidence:** HIGH (grounded in Laminark source analysis, existing pipeline architecture, and concrete integration points)

---

## Critical Pitfalls

Mistakes that cause rewrites, data corruption, or fundamentally broken user experiences.

---

### Pitfall 1: False Positive Debug Detection (Normal Errors Classified as Debug Sessions)

**What goes wrong:** The debug detection classifier treats every error, failure, or problem-related observation as the start of a debug session. Normal development activities -- a failing test during TDD, a build error from a typo, a lint warning -- get misclassified as "debug sessions." The system creates debug path entities for routine development friction, flooding the graph with meaningless paths.

**Why it happens:** The existing piggyback-extractor.ts already has negative sentiment detection (lines 96-100: `NEGATIVE_WORDS` includes 'error', 'failed', 'broken', 'bug', 'issue', 'problem'). If debug detection uses similar keyword-based signals, it will fire constantly. The Haiku classifier agent (haiku-classifier-agent.ts) classifies observations into noise/signal and discovery/problem/solution -- but "problem" classification does not equal "debug session." A developer writes a test that fails intentionally (TDD), encounters a build error they fix in 10 seconds, or gets a linter warning they ignore. None of these are debug sessions.

**Laminark-specific risk:** The current PostToolUse pipeline already processes every tool call through handler.ts (line 62-238). Adding debug detection at this granularity means every single error-containing observation triggers analysis. The HaikuProcessor already runs on a 30-second timer with batch processing (haiku-processor.ts lines 58-76). If debug detection happens inline in the hook handler (synchronous path) rather than in the background processor, it adds latency to every hook invocation. If it happens in the background processor, it adds another Haiku call per observation on top of the existing classify/extract-entities/infer-relationships pipeline.

**Consequences:**
- Graph fills with hundreds of trivial "debug path" entities and "debug_step" edges per day
- Real debug sessions (multi-hour investigation, multiple failed approaches) get lost in noise
- Users see a timeline of "debug sessions" that are actually just normal development -- trust evaporates
- Haiku API costs increase proportionally to false positive rate

**Prevention:**
- Debug sessions require **temporal duration and repeated failure patterns**, not single error events. A minimum of 3+ related error observations within a time window (e.g., 5 minutes) before opening a debug path
- Use a **state machine** approach: IDLE -> POTENTIAL_DEBUG (first error signal) -> ACTIVE_DEBUG (confirmation: same error topic recurring, or explicit retry patterns) -> RESOLVED (success observation after active debug)
- The POTENTIAL_DEBUG -> IDLE transition should have a short timeout (2-3 minutes). If no further related errors appear, it was not a debug session
- Never classify a single PostToolUse failure as debug session start. Require corroboration from subsequent observations
- Use the existing `kind` field on observations: only observations classified as `problem` by Haiku should contribute to debug detection. `verification` kind (test runs) should NOT auto-trigger debug unless the same test fails repeatedly

**Detection (warning signs you hit this):**
- More than 5 active debug paths created per hour of development
- Average debug path duration under 2 minutes
- Users reporting "I see debug sessions everywhere"
- Debug path entities outnumber Problem/Solution entities in the graph

**Phase impact:** This is THE critical design decision. Get the detection heuristics wrong and the entire feature is negative-value. Address in Phase 1 with extensive unit tests covering normal development scenarios (TDD cycles, build-fix-build cycles, intentional test failures).

---

### Pitfall 2: Haiku Call Volume Explosion (Performance Death by Detection)

**What goes wrong:** Adding debug detection as another Haiku call per observation pushes the system past sustainable API usage. The existing HaikuProcessor already makes up to 3 Haiku calls per signal observation (classify, extract entities, infer relationships). Adding a 4th call for "is this part of a debug session?" per observation, plus a 5th for "generate a KISS summary" when a path closes, creates unsustainable API load.

**Why it happens:** The current pipeline processes observations in batches of 10 with concurrency of 3 (haiku-processor.ts lines 57-60). Each observation can generate 3 sequential Haiku calls. With 10 observations per 30-second cycle, that is up to 30 Haiku calls per cycle. Adding debug detection at the same granularity pushes it to 40 calls per cycle. During active development sessions that generate 20+ observations per minute, the backlog grows faster than processing capacity.

**Laminark-specific risk:** The Haiku client uses a singleton Agent SDK V2 session (haiku-client.ts lines 25-40). Sequential calls through a single session are serialized. The `callHaiku()` function is already the bottleneck. Adding more calls per observation directly extends the per-observation processing time. The 30-second timer interval (line 58) means if one cycle takes longer than 30 seconds, cycles stack up.

**Consequences:**
- Background processing falls behind, creating growing backlog of unprocessed observations
- Memory growth from buffered observations
- Debug path state becomes stale (events from 5 minutes ago finally get processed)
- Session resets in the Agent SDK cause cold-start overhead (~12 seconds per session creation)
- Increased API costs with no proportional value

**Prevention:**
- Do NOT add a separate Haiku call for debug detection. Instead, extend the existing classifier prompt (haiku-classifier-agent.ts) to include a `debug_signal` field alongside the existing `signal`/`classification` fields. Single call, richer output
- The classifier system prompt (lines 41-55) already asks "Is this noise or signal?" and "What kind?" -- add "Does this indicate debugging activity?" as a third question in the same prompt. This adds ~20 tokens to the response but zero additional API calls
- KISS summary generation should happen ONLY at path closure, not per-observation. A path closing is a rare event (maybe 2-5 per day), so one Haiku call for summary is acceptable
- Consider a rule-based pre-filter for debug detection that runs BEFORE Haiku, similar to how the admission filter (admission-filter.ts) pre-screens observations. Only observations matching debug-like patterns (error keywords + tool retry patterns) should have their Haiku classification include the debug signal

**Detection (warning signs you hit this):**
- `processOnce()` cycle time exceeds 30 seconds
- Observation backlog grows during active development
- `haiku-client.ts` session resets increase (indicating timeouts)
- Total Haiku calls per hour exceeds 200 during normal development

**Phase impact:** Address in Phase 1 by modifying the existing classifier prompt rather than adding new agent modules. The KISS summary agent is Phase 2 (path closure is a distinct concern).

---

### Pitfall 3: Graph Pollution from Path Entities (Debug Paths Overwhelming Core Knowledge)

**What goes wrong:** Each debug path creates new entities (DebugPath, DebugStep nodes) and edges (debug_step, resolved_by, caused_by). A busy developer might trigger 10-20 debug paths per day. Each path has 3-15 waypoints. Over a week, that is 200+ new nodes and 500+ new edges from debug tracking alone -- potentially exceeding the entire existing graph size for a project.

**Why it happens:** The existing entity type taxonomy is fixed at 6 types: Project, File, Decision, Problem, Solution, Reference (types.ts lines 13-20). The relationship type taxonomy has 8 types (lines 28-37). Adding DebugPath as a new entity type and debug-specific relationship types changes the fundamental graph shape. The MAX_NODE_DEGREE constraint (50 edges per node, types.ts line 118) was calibrated for the current entity mix. File nodes that participate in many debug paths will hit degree caps quickly, causing the enforceMaxDegree() function (constraints.ts lines 69-103) to prune potentially valuable non-debug edges.

**Laminark-specific risk:** The D3 visualization already renders the full graph with type-based coloring and edge label toggles (per the recent feature/d3-graph-viz branch). Adding a new entity type requires updating the color scheme, filter system, and legend. More critically, debug paths are inherently temporal/sequential structures, but the graph is designed for semantic relationships. Forcing sequential data into a graph structure creates long chains that dominate the layout.

**Consequences:**
- Graph visualization becomes unreadable -- long debug chains push semantic clusters apart
- Degree enforcement prunes valuable edges in favor of debug path edges
- Graph stats (graph-stats.ts) become misleading -- "200 entities" sounds impressive but 150 are debug steps
- Temporal decay (temporal-decay.ts) needs different parameters for debug edges vs. semantic edges -- debug paths should decay faster but currently all edges share the same half-life (30 days)
- SSE broadcast (haiku-processor.ts line 182-188) floods the UI with entity_updated events for debug steps

**Prevention:**
- Do NOT add DebugPath as a new entity type. Instead, model debug paths as metadata on existing Problem and Solution entities. A Problem node gains a `debug_path` metadata field containing the ordered waypoint references. A Solution node gains a `resolved_path_id` linking it to the Problem
- If new entity types are unavoidable, use a **separate table** for debug paths rather than cramming them into graph_nodes/graph_edges. Debug paths are inherently sequential, not graph-structured. A `debug_paths` table with `(id, problem_entity_id, status, waypoints JSON, created_at, resolved_at, summary)` is simpler and does not pollute the knowledge graph
- Implement a toggle in the UI to show/hide debug path overlays. The existing per-type edge label toggle pattern (from the recent commit 0200412) provides a template
- Set a hard cap on debug path entities per project (e.g., 50 active paths, auto-archive oldest). This prevents unbounded growth

**Detection (warning signs you hit this):**
- Debug-related nodes exceed 50% of total graph nodes
- Degree enforcement fires more frequently after debug tracking is enabled
- Users complain about graph visualization being "cluttered" or "unreadable"
- Graph traversal queries (schema.ts `traverseFrom()`) slow down due to increased node/edge count

**Phase impact:** This is an architecture decision that must be made in Phase 1 BEFORE any implementation. The separate-table approach is strongly recommended over extending the graph schema. Phase 3 (visualization) depends entirely on this decision.

---

### Pitfall 4: Cross-Session State Management (Debug Paths Spanning Context Resets)

**What goes wrong:** A developer starts debugging an issue in one Claude Code session, the session ends (Stop event) or context resets (hitting the token limit), and they continue in a new session. The debug path state is lost because the path was tracked in-memory during the session. The new session has no awareness that this is a continuation of an existing debug effort.

**Why it happens:** The current session lifecycle (session-lifecycle.ts) handles SessionStart and SessionEnd events. Sessions get summaries via compressObservations() (summarizer.ts). But debug path state (current path ID, active waypoints, detection state machine position) is inherently in-memory state during a session. The existing hook handler opens a fresh database connection per invocation (handler.ts line 257) -- there is no persistent in-memory state between hook calls.

**Laminark-specific risk:** Laminark hooks run as separate Node.js processes per hook invocation (bin: `laminark-hook` in package.json). There is NO long-running process on the hook side. Each PostToolUse event spawns a new process, reads stdin, processes, and exits. The MCP server (laminark-server) IS long-running but does not receive PostToolUse events. This means the debug detection state machine cannot live in-memory at all -- it must be persisted to SQLite on every state transition.

**Consequences:**
- Debug paths get "orphaned" when sessions end mid-debug -- no resolution is recorded
- The new session creates a duplicate debug path for the same issue, inflating the graph
- KISS summary generation never fires for orphaned paths (no closure event)
- The graph shows the same bug being "debugged" 3 times when it was actually one continuous effort
- Cross-session debug correlation is impossible without explicit linking

**Prevention:**
- All debug path state MUST be persisted to SQLite, not held in memory. The state machine (IDLE/POTENTIAL_DEBUG/ACTIVE_DEBUG/RESOLVED) must be stored per-project in a `debug_paths` table
- On SessionStart, check for any ACTIVE_DEBUG paths for the current project. If found, inject a hint into the session context (the SessionStart hook already writes to stdout for context injection, handler.ts line 287-289)
- On SessionEnd/Stop, do NOT auto-close active debug paths. Instead, mark them as `status: 'suspended'`. They resume when the next session picks up the same error pattern
- Implement a timeout: paths in `suspended` status for more than 24 hours get auto-resolved with a "abandoned/unresolved" summary
- The `.orphaned_at` file already visible in the git status hints at awareness of this problem pattern

**Detection (warning signs you hit this):**
- Multiple debug path entities for the same underlying problem
- Debug paths with no resolution (perpetually "active")
- SessionStart context injection not mentioning active debug paths
- Users reporting "it forgot I was debugging this"

**Phase impact:** Must be designed in Phase 1 (data model), implemented in Phase 2 (state machine persistence), and tested specifically for the session boundary case. The hook-as-subprocess architecture makes this non-trivial.

---

## Moderate Pitfalls

Mistakes that cause bugs, user confusion, or require significant rework but not full rewrites.

---

### Pitfall 5: Path Noise (Too Many Waypoints, Meaningless Breadcrumbs)

**What goes wrong:** Every tool call during a debug session gets recorded as a waypoint in the debug path. Reading files, running grep, checking git status -- all become waypoints. A 30-minute debug session produces 150 waypoints when only 5-10 were actually meaningful (the hypothesis, the key finding, the attempted fix, the test failure, the real fix, the passing test).

**Why it happens:** The PostToolUse hook fires for every tool call. The existing admission filter (admission-filter.ts) already filters navigation commands (ls, cd, pwd) and research tools (Read, Glob, Grep go to research buffer). But during debug, even non-navigation tools produce noise: reading error logs, re-running the same failing test, checking build output. These are valid observations but not meaningful debug waypoints.

**Laminark-specific risk:** The research buffer pattern (handler.ts lines 130-138) routes Read/Glob/Grep to a separate buffer instead of observations. This same pattern could inform debug waypoint filtering -- but the research buffer is session-scoped and flushed, while debug waypoints need persistence.

**Prevention:**
- Define explicit "debug-significant" tool patterns: only Write, Edit, Bash (test/build commands), and explicit Haiku-classified "problem"/"solution" observations become waypoints
- Use the existing `kind` field: only `change` (Write/Edit), `verification` (test/build), and `decision` kind observations are waypoint candidates
- Implement waypoint deduplication: if the same file is edited 5 times in a row, collapse to a single "modified X (5 edits)" waypoint
- Cap waypoints per path at 20-30. After the cap, only record waypoints that represent state transitions (new hypothesis, different file, test outcome change)

**Detection:**
- Average waypoints per debug path exceeds 20
- More than 50% of waypoints are Read/Glob/Grep tools
- KISS summaries are verbose and unfocused because they try to summarize 100+ waypoints

---

### Pitfall 6: KISS Summary Quality (Haiku Generating Useless Summaries)

**What goes wrong:** When a debug path closes, Haiku generates a KISS (Keep It Simple, Stupid) summary. But the summary is either too vague ("Fixed a bug") or too verbose (regurgitates every waypoint). The summary fails to capture the actual insight: what was wrong, why it was hard to find, and what the fix was.

**Why it happens:** The quality of the summary depends entirely on the quality of the input. If the debug path has 50 waypoints of mixed signal quality, Haiku cannot distinguish the key moments from the noise. The existing `compressObservations()` function (summarizer.ts) handles session summaries by grouping by kind -- but debug paths need a different compression strategy: problem statement, investigation highlights, root cause, fix, verification.

**Laminark-specific risk:** The existing summarizer (summarizer.ts) uses a purely rule-based approach with no LLM calls -- it extracts snippets and groups by kind. Debug path summaries will require an LLM call because the narrative structure (problem -> investigation -> root cause -> fix) requires understanding, not just grouping. This is the one place where a dedicated Haiku call is justified (per-path-closure, not per-observation). But the prompt must be carefully structured.

**Prevention:**
- Structure the KISS summary prompt to demand a specific format: `{problem: string, root_cause: string, fix: string, key_insight: string}`. Four fields, each 1-2 sentences. No freeform narrative
- Pre-filter the waypoints before sending to Haiku for summary: include only the first error observation, any Write/Edit observations, the final successful verification, and any observations Haiku classified as "solution"
- Set a strict token limit (256 tokens output). The existing `callHaiku()` takes `_maxTokens` parameter (haiku-client.ts line 66) even though it is currently unused with the Agent SDK
- Include 2-3 few-shot examples in the system prompt showing good KISS summaries
- Store the raw waypoint IDs alongside the summary so users can drill into details if the summary is insufficient

**Detection:**
- KISS summaries averaging more than 500 characters (too verbose) or fewer than 50 characters (too vague)
- Users never clicking on debug path summaries in the UI (suggests they are not useful)
- Summaries containing phrases like "various changes were made" or "the issue was resolved" (vague filler)

---

### Pitfall 7: Visualization Clutter (Path Overlays Making Graph Unreadable)

**What goes wrong:** Debug paths are rendered as connected sequences of nodes in the D3 graph visualization. Each path creates a chain of 5-15 connected nodes cutting across the existing semantic graph layout. Multiple overlapping paths create a visual mess that makes the underlying knowledge graph unusable.

**Why it happens:** D3 force-directed layouts position nodes based on edge connections. Long sequential chains (path waypoints) create strong linear forces that distort the layout. The existing graph has semantic clusters (related files, problems with solutions), and debug paths cut across these clusters because debugging involves touching many unrelated parts of the codebase.

**Laminark-specific risk:** The current D3 visualization (from the feature/d3-graph-viz branch) has per-type edge label toggles and entity type filters. Debug paths would need their own visual treatment: different edge style (dashed? colored?), collapsible path chains, and a toggle to show/hide all paths. The existing color scheme has 6 entity types. Adding debug-specific visual elements risks overwhelming the legend and filter controls.

**Prevention:**
- If using the separate-table approach (Pitfall 3 recommendation), debug paths are NOT graph entities at all -- they get their own dedicated view/panel rather than being overlaid on the semantic graph
- If paths must appear in the graph, render them as a single compound node (collapsed by default) that expands on click, rather than as individual waypoint nodes
- Provide a dedicated "Debug Timeline" view that shows paths as a timeline/waterfall chart rather than forcing them into the graph topology
- Use the existing SSE system (sse.ts) to push path updates to a separate UI panel rather than the main graph

**Detection:**
- D3 graph layout computation time increases significantly after debug tracking is enabled
- Users toggling debug-related filters off immediately after opening the graph
- Graph node count exceeds 100 (the D3 force layout degrades above this threshold for readability)

---

### Pitfall 8: Detection Latency vs. Path Accuracy (When to Open a Debug Path)

**What goes wrong:** If debug detection happens in the background HaikuProcessor (30-second cycle), there is a significant delay between the first error signal and the debug path opening. By the time the system detects "this is a debug session," the developer has already made 10 more tool calls that were not captured as waypoints because the path was not yet active.

**Why it happens:** The current architecture has two processing paths: the synchronous hook handler (handler.ts, runs per tool call, ~10ms) and the asynchronous HaikuProcessor (haiku-processor.ts, runs every 30s in the MCP server). Debug detection accuracy requires Haiku classification (async), but path tracking requires real-time waypoint capture (sync). These are fundamentally at odds.

**Laminark-specific risk:** The hook handler is a separate process per invocation (no persistent state). The MCP server is long-running. If debug detection happens in the MCP server (via HaikuProcessor), waypoint capture must also happen there -- but the MCP server does not receive raw PostToolUse events, only observations stored by the hook.

**Prevention:**
- Use a two-tier detection strategy:
  1. **Fast tier (hook handler, sync):** Rule-based pre-screening. Check if the current observation contains error patterns AND a recent observation (last 3) also contained error patterns for the same topic. If yes, create a `debug_path` row with status `potential`. This is cheap (one SQL query against recent observations)
  2. **Slow tier (HaikuProcessor, async):** Confirm or deny the potential debug path using Haiku classification. Upgrade to `active` or downgrade to `false_positive`
- Retroactively attach missed waypoints: when a path is confirmed as `active`, backfill the observations between the first error signal and the confirmation as waypoints. The observations are already in the database with timestamps -- just link them
- Accept that the first 1-2 observations of a debug session may not be captured as waypoints in real-time. This is an acceptable tradeoff for avoiding Haiku calls on every tool use

**Detection:**
- Debug paths consistently missing their first 3-5 observations as waypoints
- Users reporting "the debug path started in the middle of my investigation"
- Time between first error observation and debug path creation exceeds 60 seconds

---

## Minor Pitfalls

Issues that cause friction or technical debt but are recoverable.

---

### Pitfall 9: Entity Type Taxonomy Rigidity

**What goes wrong:** The existing entity types (types.ts) are a fixed const array with a comment "FIXED -- no other types allowed." Adding DebugPath or DebugStep as entity types requires modifying this array, updating SQL CHECK constraints in migrations, updating the write-quality-gate.ts confidence thresholds, updating the D3 color scheme, and updating the graph-stats.ts query.

**Prevention:** If the separate-table approach is adopted (Pitfall 3), this is a non-issue. If entity types must be extended, batch all type additions into a single migration and update all downstream consumers in the same commit. The fuzzy-dedup.ts, constraints.ts, and write-quality-gate.ts files all reference entity types and need updates.

---

### Pitfall 10: Temporal Decay Mismatch for Debug Edges

**What goes wrong:** The existing temporal decay (temporal-decay.ts) uses a 30-day half-life with 180-day max age. Debug path edges should decay much faster (debug from 3 months ago is rarely relevant) but the current system applies uniform decay to all edges. Old debug paths survive in the graph long after they are useful.

**Prevention:** Add a `decay_class` field to edges (or use edge type to determine decay parameters). Debug-related edges get a 7-day half-life and 30-day max age. The `applyTemporalDecay()` function (temporal-decay.ts lines 95-149) should branch on edge type to select decay parameters.

---

### Pitfall 11: Duplicate Debug Paths for the Same Issue

**What goes wrong:** A developer encounters the same bug twice (perhaps after a merge or revert). The system creates two separate debug paths because it has no mechanism to link the current error pattern to a previously resolved path. The same root cause gets debugged and documented twice.

**Prevention:** Before creating a new debug path, check if any resolved path in the last 7 days has a similar problem statement (using the existing Jaccard similarity from similarity.ts or semantic search from the embedding store). If a match is found, reopen the existing path instead of creating a new one. This also enables a "recurring bugs" metric.

---

### Pitfall 12: SSE Broadcast Storm During Active Debugging

**What goes wrong:** The HaikuProcessor broadcasts `entity_updated` SSE events for every entity it persists (haiku-processor.ts lines 181-188). If debug tracking creates 10+ entities per debug session and there are multiple sessions per hour, the SSE channel floods the D3 UI with update events, causing excessive re-renders.

**Prevention:** Batch debug-related SSE events into a single `debug_path_updated` event per path update cycle. The SSE broadcast function (sse.ts) already supports custom event types. The UI should handle `debug_path_updated` with a debounced re-render (500ms cooldown).

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Data model design | Pitfall 3 (graph pollution) | Use separate table for debug paths, not graph entities |
| Detection heuristics | Pitfall 1 (false positives) | State machine with temporal confirmation, not keyword matching |
| Haiku integration | Pitfall 2 (call volume) | Extend existing classifier prompt, do NOT add new agent module |
| State persistence | Pitfall 4 (cross-session) | All state in SQLite, hook handler has no persistent memory |
| Waypoint capture | Pitfall 5 (path noise) | Filter by observation kind, cap at 20-30 per path |
| Waypoint capture | Pitfall 8 (detection latency) | Two-tier detection: rule-based fast path + Haiku confirmation |
| KISS summaries | Pitfall 6 (quality) | Structured output format, pre-filtered waypoints, few-shot examples |
| UI integration | Pitfall 7 (visualization clutter) | Separate debug timeline view, NOT graph overlay |
| UI integration | Pitfall 12 (SSE storms) | Batched debug_path_updated events with debounce |
| Graph maintenance | Pitfall 10 (temporal decay) | Per-type decay parameters, faster decay for debug edges |
| Edge cases | Pitfall 11 (duplicate paths) | Similarity check against recent resolved paths before creating new |
| Schema changes | Pitfall 9 (taxonomy rigidity) | Prefer separate table; if extending types, batch all updates |

## Integration Risk Matrix

These risks are specific to Laminark's architecture and would not apply to a greenfield system.

| Integration Point | Risk Level | Specific Concern |
|-------------------|------------|------------------|
| PostToolUse hook handler | HIGH | Hook runs as subprocess with no persistent state -- all debug detection state must be in SQLite |
| HaikuProcessor pipeline | HIGH | Adding calls increases per-observation processing time; must extend existing classifier, not add calls |
| Entity type taxonomy | MEDIUM | Fixed array with CHECK constraints; prefer separate table to avoid ripple changes |
| SaveGuard duplicate detection | LOW | Debug waypoints should bypass duplicate detection (same error recurring IS the signal) |
| Research buffer | LOW | Debug waypoints could reuse the research buffer pattern for low-signal tool calls |
| D3 visualization | MEDIUM | New entity types or edge types require color scheme, filter, and legend updates |
| SSE broadcast | MEDIUM | High-frequency debug updates can flood the UI; needs batching |
| Temporal decay | LOW | Uniform decay parameters need per-type branching for debug edges |
| Session lifecycle | MEDIUM | SessionEnd must NOT close debug paths; needs `suspended` status |
| Observation classifier | HIGH | Debug signal must be part of existing classification, not a separate call |

## Sources

- Direct source analysis of Laminark codebase (all files referenced by path above)
- Existing HaikuProcessor architecture (src/intelligence/haiku-processor.ts)
- Hook handler pipeline (src/hooks/handler.ts)
- Graph schema and constraints (src/graph/schema.ts, src/graph/constraints.ts, src/graph/types.ts)
- Temporal decay system (src/graph/temporal-decay.ts)
- Write quality gate (src/graph/write-quality-gate.ts)
- Haiku client architecture (src/intelligence/haiku-client.ts)
- Session lifecycle (src/hooks/session-lifecycle.ts)
- Admission filter (src/hooks/admission-filter.ts)
- Summarizer (src/curation/summarizer.ts)
