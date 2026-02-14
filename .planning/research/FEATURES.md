# Feature Landscape: Debug Resolution Paths

**Domain:** Automatic debug journey tracking within a knowledge graph memory system
**Researched:** 2026-02-14
**Focus:** NEW features only -- automatic debug session detection, waypoint capture, path-as-graph-entity, resolution detection, KISS summary generation, path visualization overlay, multi-layer dimensions
**Confidence:** MEDIUM-HIGH (debug detection heuristics are well-understood from observability tooling; novel application to LLM coding assistant context tracking)

---

## Context: What Already Exists in Laminark

These features are BUILT and SHIPPING. Debug resolution paths build directly on this infrastructure:

- **Observation pipeline:** PostToolUse hooks capture every tool invocation with semantic summaries, routed through `capture.ts` and `handler.ts`
- **Haiku classification:** Background processor classifies observations as `noise | signal` and then `discovery | problem | solution` via `haiku-classifier-agent.ts`
- **Knowledge graph:** `graph_nodes` (6 entity types: Project, File, Decision, Problem, Solution, Reference) + `graph_edges` (8 relationship types including `solved_by`, `caused_by`, `preceded_by`)
- **Semantic signal extraction:** `piggyback-extractor.ts` does rule-based sentiment detection (positive/negative/neutral/technical) and entity extraction in <10ms
- **Session tracking:** Every observation has a `session_id`, sessions have start/end lifecycle hooks
- **Haiku entity extraction + relationship inference:** Background processing pipeline that extracts entities and infers relationships from observation content
- **Context stashing:** Topic-scoped context snapshots with observation references
- **D3 graph visualization:** Interactive graph with filters, legend, edge label toggles, SSE live updates
- **Adaptive threshold system:** EWMA-based distance tracking for topic shift detection

**Key principle driving this feature:** The knowledge graph captures the full debug journey (every attempt, failure, reasoning), while the codebase only gets the clean KISS fix. Paths are the directed trails through this graph.

**Key infrastructure constraint:** All processing must be non-blocking. Haiku calls are batched in background. Hook handler processes synchronously and must complete fast. The existing pattern of "capture now, enrich later via HaikuProcessor" must be preserved.

---

## Table Stakes

Features that are essential for debug resolution paths to function. Without these, the feature has no value.

### TS-1: Automatic Debug Session Detection

| Aspect | Detail |
|--------|--------|
| **Why Expected** | The entire value proposition is "vibe tool" -- zero manual intervention. If the user has to signal "I'm debugging now," the feature fails its core promise. |
| **Complexity** | Medium |
| **Depends On** | Existing Haiku classifier (`problem` classification), existing sentiment detection (`negative` sentiment in `piggyback-extractor.ts`), existing observation pipeline |

**What it looks like in practice:**

Detection must work from signals already flowing through the system. The existing classifier already tags observations as `problem` -- that is the primary trigger. Secondary signals:

1. **Haiku classification trigger (primary):** When `classifyWithHaiku()` returns `classification: "problem"`, that observation is a candidate debug path entry point. Two or more `problem` observations within a time/sequence window strongly indicate active debugging.

2. **Sentiment-based fast trigger (secondary):** The existing `piggyback-extractor.ts` detects `negative` sentiment from words like "error", "failed", "broken", "bug", "crash". This runs in <10ms and provides an early signal before Haiku classification completes.

3. **Tool pattern trigger (tertiary):** Repeated Bash commands with error output, followed by Edit/Write, followed by more Bash (the classic "run-fail-fix-run" cycle) are detectable from `tool_name` sequences already captured in observations.

4. **Error output detection (tertiary):** Bash tool responses containing stack traces, error codes, or failure messages. The existing `tool_response` field in `PostToolUsePayload` provides this data.

**Detection state machine:**

```
IDLE -> SUSPECTED (first problem signal)
SUSPECTED -> ACTIVE (second signal within window OR Haiku confirms)
ACTIVE -> ACTIVE (more problem/solution signals)
ACTIVE -> RESOLVED (resolution detected, see TS-3)
ACTIVE -> ABANDONED (timeout or session end without resolution)
SUSPECTED -> IDLE (no confirmation within window, discard)
```

**Implementation approach:** A lightweight `DebugDetector` class that runs in the hook handler's synchronous path using only rule-based signals (sentiment, tool patterns). Haiku confirmation happens asynchronously in the background processor. This preserves the "capture fast, enrich later" pattern.

### TS-2: Waypoint Capture (Breadcrumb Trail)

| Aspect | Detail |
|--------|--------|
| **Why Expected** | A debug path without waypoints is just a start and end marker. The journey between is the entire value. |
| **Complexity** | Low |
| **Depends On** | TS-1 (detection), existing observation pipeline, existing graph mutation functions (`upsertNode`, `insertEdge`) |

**What gets captured as waypoints:**

Once a debug session is ACTIVE, every observation becomes a potential waypoint. The system must capture:

- **Error observations:** The actual errors encountered (from Bash failures, PostToolUseFailure events)
- **Hypothesis observations:** What was tried (Edit/Write tool invocations during active debugging)
- **Investigation observations:** What was examined (Read/Grep/Glob during active debugging -- note: these currently route to research buffer, not observations. Need to also track them as waypoints or reference the research buffer)
- **Dead ends:** Attempts that did not resolve the problem (detected by continued problem signals after a fix attempt)

Each waypoint is an observation ID linked to the path. The waypoint captures are already happening via the existing observation pipeline. The new work is marking which observations belong to a debug path and in what order.

**Data model:** A waypoint is not a new entity -- it is a reference from a path entity to an existing observation, with ordering metadata. This is the KISS approach: reuse existing observations, add path-level structure on top.

### TS-3: Resolution Detection

| Aspect | Detail |
|--------|--------|
| **Why Expected** | Without knowing when debugging ended successfully, you cannot generate a summary. The "next time just do X" requires knowing what X was. |
| **Complexity** | Medium |
| **Depends On** | TS-1 (detection), existing Haiku classifier (`solution` classification), existing sentiment detection |

**Resolution signals (ordered by reliability):**

1. **Haiku classifies as `solution`:** Most reliable. The existing classifier already distinguishes solutions from problems and discoveries. A `solution` observation during an ACTIVE debug session is a strong resolution signal.

2. **Positive sentiment shift:** Sentiment changes from `negative` to `positive` (words like "works", "fixed", "resolved", "passed" in `POSITIVE_WORDS` set). Already computed by `piggyback-extractor.ts`.

3. **Test pass after test fail:** A Bash observation with test output showing passes after a previous observation showed failures. Detectable from tool response content.

4. **Explicit user confirmation:** User says something like "that fixed it" or "working now." Detectable from UserMessage hook events if available, or from observation content.

5. **Activity pattern change:** Debugging activity (repeated error-fix cycles) stops and shifts to different work. This is the weakest signal -- could mean abandoned rather than resolved.

**Resolution vs. abandonment:** If a debug session ends without a clear solution signal (no `solution` classification, no positive sentiment shift), it should be marked ABANDONED, not RESOLVED. Abandoned paths are still valuable -- they record dead ends for future reference.

### TS-4: Path as Graph Entity

| Aspect | Detail |
|--------|--------|
| **Why Expected** | Paths must live in the knowledge graph to be searchable, visualizable, and connected to other entities. A path that exists only in a separate table is invisible to the graph. |
| **Complexity** | Medium |
| **Depends On** | TS-1, TS-2, TS-3, existing graph schema and types system |

**Graph integration approach:**

The existing entity types are `Project | File | Decision | Problem | Solution | Reference`. The existing relationship types include `solved_by`, `caused_by`, `preceded_by`. These are already well-suited for debug paths:

- A **Path** is a new entity type (adds to the 6 existing types, making 7)
- A path entity CONNECTS to existing Problem and Solution entities via existing relationship types
- Waypoints are represented as `preceded_by` edges between observation-linked entities along the path
- The path entity's `metadata` field stores: status (active/resolved/abandoned), start time, end time, waypoint count, summary

**Entity type extension:**

```typescript
// Current: 'Project' | 'File' | 'Decision' | 'Problem' | 'Solution' | 'Reference'
// New:     'Project' | 'File' | 'Decision' | 'Problem' | 'Solution' | 'Reference' | 'Path'
```

**Relationship usage for paths:**

- `Path --caused_by--> Problem` (the problem that initiated the debug journey)
- `Path --solved_by--> Solution` (the solution that resolved it, if any)
- `Path --references--> File` (files involved in the debug journey)
- Waypoint ordering stored in path metadata as ordered observation ID array (not as graph edges -- avoids edge explosion)

### TS-5: KISS Summary Generation

| Aspect | Detail |
|--------|--------|
| **Why Expected** | The entire "next time just do X" promise. Without distilled summaries, users must re-read the full path. The codebase gets the clean fix; the graph stores the journey; the summary bridges the two. |
| **Complexity** | Medium |
| **Depends On** | TS-3 (resolution detection triggers summary generation), existing Haiku client infrastructure |

**Summary format:**

```
Problem: [one line describing the error/issue]
Root cause: [one line describing what actually caused it]
Fix: [one line describing the specific fix applied]
Key insight: [one line -- the "next time just do X" takeaway]
Files involved: [comma-separated list]
Dead ends: [brief note on what was tried but did not work]
```

**Generation approach:** Use the existing `callHaiku()` infrastructure with a focused prompt. Input: the ordered waypoint observations (their content field). Output: structured summary per the format above. This is a single Haiku call per resolved path, triggered when resolution is detected.

**Token budget:** Path waypoints can be numerous. Truncate to the most recent ~20 waypoints, prioritizing `problem` and `solution` classified observations. The existing `truncate()` helper in `capture.ts` provides the pattern.

---

## Differentiators

Features that set debug resolution paths apart from basic error logging. Not expected but significantly valuable.

### D-1: Multi-Layer Dimensions (Logical / Programmatic / Development)

| Aspect | Detail |
|--------|--------|
| **Value Proposition** | Debug paths exist in multiple conceptual layers simultaneously. A "TypeError: cannot read property of undefined" is a programmatic error, caused by a logical misunderstanding of the API, encountered during a development task. Capturing these layers enables richer search and cross-referencing. |
| **Complexity** | High |
| **Depends On** | TS-4 (path entity), TS-5 (summary generation), existing Haiku classification |

**Three dimensions:**

1. **Logical:** The conceptual understanding layer. "I assumed the API returned an array but it returns an object." This captures WHY the bug existed -- the mental model mismatch.

2. **Programmatic:** The code-level layer. "TypeError at line 42 of parser.ts because `result.items` was undefined when `result` is actually `{data: {items: [...]}}` not `{items: [...]}` ." This captures WHAT the bug was technically.

3. **Development:** The workflow layer. "This came up while migrating from v1 to v2 of the API client." This captures WHEN/WHERE in the development lifecycle this occurred.

**Implementation:** These are metadata fields on the Path entity populated by Haiku during summary generation. The summary prompt asks Haiku to categorize the path along all three dimensions. Stored in the path node's `metadata` JSON field.

**Search value:** When a user later encounters a similar error, the system can match on the programmatic dimension. When they are doing a similar task, it can match on the development dimension. When they have a similar misunderstanding, it can match on the logical dimension.

### D-2: Path Visualization Overlay on Graph

| Aspect | Detail |
|--------|--------|
| **Value Proposition** | Seeing debug journeys overlaid on the knowledge graph reveals patterns invisible in text: which files are repeatedly involved in bugs, which problems are related, where solutions cluster. |
| **Complexity** | Medium |
| **Depends On** | TS-4 (path entity in graph), existing D3 visualization, existing SSE infrastructure |

**Visualization approach:**

- Paths are rendered as highlighted, directed trails through the existing graph
- Path edges get a distinct visual treatment: thicker lines, different color per path status (active=yellow, resolved=green, abandoned=red)
- Path entity nodes are visually distinct (different shape or icon from the 6 existing entity types)
- Clicking a path node shows the summary and waypoint timeline
- Filter controls to show/hide paths, filter by status, filter by time range

**Existing infrastructure leverage:** The D3 graph already supports per-type edge label toggles, entity type filters, and a legend. Adding a Path entity type and path-specific edge styling follows the established patterns.

### D-3: Proactive Path Recall During Active Debugging

| Aspect | Detail |
|--------|--------|
| **Value Proposition** | When a new debug session starts, automatically surface relevant past debug paths. "Last time you saw this error, the root cause was X and the fix was Y." This is where the investment in path capture pays dividends. |
| **Complexity** | Medium-High |
| **Depends On** | TS-1 (detection), TS-5 (summaries), existing PreToolUse proactive context injection |

**Implementation approach:**

The existing `PreToolUse` hook already supports proactive context injection. When TS-1 detects a new debug session entering ACTIVE state, query the graph for resolved paths that share:

- Same files involved (via `Path --references--> File` edges)
- Similar problem descriptions (via embedding similarity on the path's problem observation)
- Same error patterns (via FTS5 search on waypoint observations)

Surface the top 1-2 most relevant path summaries in the PreToolUse context injection. The existing `assembleSessionContext()` provides the injection point.

### D-4: Dead End Tracking and Anti-Pattern Detection

| Aspect | Detail |
|--------|--------|
| **Value Proposition** | Recording what DID NOT work is as valuable as recording what did. "Do not try X, it leads to Y" prevents repeating the same mistakes. Over time, patterns of dead ends reveal systemic issues. |
| **Complexity** | Medium |
| **Depends On** | TS-2 (waypoints), TS-3 (resolution detection), TS-5 (summary) |

**Detection approach:**

A dead end is a sequence within an ACTIVE debug path where:
1. An Edit/Write is made (hypothesis: "this will fix it")
2. A subsequent Bash/test run fails (hypothesis disproven)
3. Another Edit/Write reverts or changes the same file (backtracking)

This run-fail-revert pattern is detectable from the observation sequence. Each dead end gets tagged in the path metadata with what was tried and why it failed.

**Anti-pattern aggregation:** When multiple paths share similar dead ends (same approach tried and failed across different debug sessions), this is an anti-pattern. Surfaceable during proactive recall: "This approach has failed in 3 previous sessions."

### D-5: Cross-Session Path Linking

| Aspect | Detail |
|--------|--------|
| **Value Proposition** | Debug sessions can span multiple Claude sessions (user closes Claude, reopens later, continues debugging the same issue). Linking these produces a complete picture. |
| **Complexity** | Medium |
| **Depends On** | TS-1, TS-4, existing session lifecycle hooks |

**Linking approach:**

When a new session starts and TS-1 detects debugging activity, check if there is an ACTIVE or recently ABANDONED path from a previous session that involves the same files and similar error patterns. If so, link the new session's debug activity to the existing path rather than creating a new one.

Linking criteria:
- Previous path status is ACTIVE or ABANDONED within the last 24 hours
- At least 2 common files referenced
- Error pattern similarity above threshold (via embedding comparison)

---

## Anti-Features

Features to explicitly NOT build. These are tempting but wrong for this context.

### AF-1: Full Execution Recording / Time-Travel Replay

| Aspect | Detail |
|--------|--------|
| **Why Avoid** | Time-travel debugging (TTD) records every CPU instruction for deterministic replay. This requires process injection, massive storage (trace files in GB range), and runtime-specific tooling. Laminark operates at the observation layer, not the runtime layer. We are capturing the developer's journey through the codebase, not the program's execution trace. |
| **What to Do Instead** | Capture tool invocations and their semantic summaries (already done). The observation-level view is the correct abstraction for an LLM assistant's memory. |

### AF-2: Git Bisect Integration / Commit-Level Bug Localization

| Aspect | Detail |
|--------|--------|
| **Why Avoid** | Git bisect finds which commit introduced a bug through binary search. This is a fundamentally different problem: Laminark tracks debug sessions within a single working session, not across commit history. Integrating git bisect would require Laminark to understand the commit graph, execute tests, and manage git state -- all outside its domain. |
| **What to Do Instead** | If a debug path involves git operations (Bash commands with git), capture those as waypoints naturally. The path summary will note "reverted commit X" as part of the journey, without Laminark driving the git workflow. |

### AF-3: Manual Debug Session Annotation / Notebook Interface

| Aspect | Detail |
|--------|--------|
| **Why Avoid** | Debug notebooks (Jupyter-style) require users to manually organize and annotate their debugging steps. This contradicts the "vibe tool" principle -- zero manual intervention. Adding manual annotation creates friction and relies on the user remembering to use it during the most cognitively loaded moments (active debugging). |
| **What to Do Instead** | Everything is automatic. The only manual interaction is reading the generated summary after the fact. If a user wants to add context, the existing `save_memory` MCP tool serves that purpose. |

### AF-4: Real-Time Debugging Dashboard / Live Metrics

| Aspect | Detail |
|--------|--------|
| **Why Avoid** | Observability platforms (Datadog, Elastic) provide real-time dashboards with metrics, alerting, and drill-down. Laminark is a memory system, not a monitoring system. Real-time dashboards add UI complexity, WebSocket overhead, and solve the wrong problem. The user is already debugging in their terminal -- they do not need a separate dashboard to watch. |
| **What to Do Instead** | The existing web UI shows the graph after the fact. Path visualization (D-2) adds debug journey overlays to this existing view. No real-time "debugging in progress" dashboard. |

### AF-5: Automatic Fix Application / Self-Healing

| Aspect | Detail |
|--------|--------|
| **Why Avoid** | Some AI debugging tools attempt to automatically apply fixes. This is dangerous for a memory system: Laminark observes and remembers, it does not act. Auto-applying fixes would require Laminark to invoke tools on the user's behalf, which violates the observation-only architecture and creates safety risks. |
| **What to Do Instead** | Surface relevant past solutions during proactive recall (D-3). The human (or Claude agent) decides whether and how to apply them. |

### AF-6: Custom Debug Detection Rules / User-Configurable Triggers

| Aspect | Detail |
|--------|--------|
| **Why Avoid** | Premature configuration surface. The detection heuristics (TS-1) should work well out of the box for the common case. Adding user-configurable triggers before the system has proven its defaults creates complexity without value. Configuration can be added later if the defaults prove insufficient. |
| **What to Do Instead** | Ship with sensible defaults. Tune based on real usage data. If users consistently report false positives/negatives, then add configuration knobs. |

---

## Feature Dependencies

```
TS-1: Debug Session Detection
  |
  +---> TS-2: Waypoint Capture (requires detection to know when to capture)
  |       |
  |       +---> D-4: Dead End Tracking (requires waypoint sequence analysis)
  |
  +---> TS-3: Resolution Detection (requires active session to resolve)
  |       |
  |       +---> TS-5: KISS Summary Generation (triggered by resolution)
  |               |
  |               +---> D-1: Multi-Layer Dimensions (enriches summary)
  |
  +---> TS-4: Path as Graph Entity (requires detection to create path node)
  |       |
  |       +---> D-2: Path Visualization Overlay (requires path in graph)
  |       |
  |       +---> D-5: Cross-Session Path Linking (requires path entity persistence)
  |
  +---> D-3: Proactive Path Recall (requires detection + past summaries)
```

**Critical path:** TS-1 -> TS-2 + TS-3 (parallel) -> TS-4 -> TS-5

Everything downstream of TS-5 (D-1, D-3) and TS-4 (D-2, D-5) can follow in later phases.

---

## MVP Recommendation

**Prioritize (Phase 1 -- Core Path Tracking):**

1. **TS-1: Debug Session Detection** -- The foundation. Start with rule-based detection only (sentiment + tool patterns from existing extractors). Haiku confirmation as background enrichment. Ship fast, tune later.

2. **TS-2: Waypoint Capture** -- Low complexity because the observation pipeline already captures everything. New work is linking observations to paths.

3. **TS-3: Resolution Detection** -- Essential companion to detection. Use existing `solution` classification from Haiku as primary signal.

4. **TS-4: Path as Graph Entity** -- Add `Path` to entity types. Store waypoints as ordered observation IDs in metadata. Connect to Problem/Solution entities.

5. **TS-5: KISS Summary Generation** -- Single Haiku call on resolution. This is the user-facing value.

**Prioritize (Phase 2 -- Enrichment):**

6. **D-1: Multi-Layer Dimensions** -- Enriches summary generation prompt, low marginal cost once TS-5 exists.

7. **D-4: Dead End Tracking** -- Waypoint sequence analysis on top of TS-2.

**Defer (Phase 3 -- Leverage):**

8. **D-2: Path Visualization Overlay** -- Valuable but requires D3 work. Existing graph already shows path entities.

9. **D-3: Proactive Path Recall** -- The highest-value differentiator but requires a corpus of resolved paths to be useful. Defer until paths have accumulated.

10. **D-5: Cross-Session Path Linking** -- Edge case handling that can wait until the base system is proven.

**Defer rationale:** D-2 and D-3 require the base system to be generating paths before they add value. Ship the detection-capture-resolution-summary pipeline first, let paths accumulate, then add visualization and proactive recall.

---

## Sources

- [Braintrust AI Observability Guide 2026](https://www.braintrust.dev/articles/best-ai-observability-tools-2026) -- Session analysis and pattern detection patterns
- [Middleware Root Cause Analysis in Distributed Systems](https://middleware.io/blog/identify-root-cause-analysis/) -- Automated detection techniques, anomaly detection
- [Replay.io Time Travel Debugging](https://blog.replay.io/introduction-to-time-travel-debugging) -- Session replay vs runtime replay architecture distinctions
- [DZone LLMs for Root Cause Analysis](https://dzone.com/articles/llms-automated-root-cause-analysis-incident-response) -- LLM-driven RCA and postmortem generation patterns
- [Rootly AI-Generated Postmortems](https://rootly.com/sre/ai-generated-postmortems-rootlys-automated-rca-tool) -- Automated summary generation from incident timelines
- [Acquia Automating Error Detection with Git Bisect](https://dev.acquia.com/tutorial/automating-error-detection-git-bisect-run) -- Binary search debugging workflow (informed AF-2 decision)
- [Akira AI Agents for Software Error Resolution](https://www.akira.ai/blog/ai-agents-for-debugging) -- AI debug agent memory stack and session tracking patterns
- [Elastic Root Cause Analysis with Logs](https://www.elastic.co/observability-labs/blog/observability-logs-machine-learning-aiops) -- Log pattern analysis and anomaly detection
- Laminark codebase analysis: `src/intelligence/haiku-classifier-agent.ts`, `src/hooks/piggyback-extractor.ts`, `src/graph/types.ts`, `src/graph/schema.ts`, `src/hooks/capture.ts`, `src/intelligence/haiku-processor.ts`
