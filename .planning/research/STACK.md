# Technology Stack: Debug Resolution Paths

**Project:** Laminark v2.2 -- Automatic Debug Path Tracking, Waypoint Capture, KISS Summary Generation, Graph Overlay Visualization
**Researched:** 2026-02-14
**Scope:** NEW capabilities only. Existing validated stack (SQLite/WAL/FTS5, better-sqlite3, Hono, D3.js, Claude Agent SDK V2, tsdown, vitest, Zod) is NOT re-researched.

## Executive Summary

This milestone requires **zero new npm dependencies**. Every capability needed for debug path tracking -- state machines, pattern detection, graph traversal, path visualization -- can be built with TypeScript/Node.js primitives and the existing Laminark stack. The work breaks down to:

1. **State machine for path lifecycle** -- Plain TypeScript enum + transition table (10-15 lines). No library needed.
2. **Pattern detection for debug start/resolution** -- Regex patterns on tool output (extending existing `piggyback-extractor.ts` approach) + Haiku AI classification for ambiguous cases (existing Agent SDK V2 session API).
3. **Waypoint capture** -- Extension of existing PostToolUse hook pipeline. New "path-aware" middleware taps the same event stream.
4. **SQLite schema for paths/waypoints** -- Two new tables via existing migration framework (version 20+). Paths reference existing graph nodes.
5. **KISS summary generation** -- Haiku AI call via existing Claude Agent SDK V2 session API. Same pattern as existing observation enrichment.
6. **D3 graph overlay** -- New SVG layer group in existing `graph.js` force-directed visualization. D3 line generators with animated dashes for breadcrumb trails.

**Key architectural insight:** Paths are a *parallel data structure* alongside the knowledge graph, not embedded in it. A path references graph nodes as waypoints but has its own lifecycle (active/resolved/abandoned/stale). This keeps the core graph clean and paths queryable independently.

## Recommended Stack Additions

### NO new npm packages needed

| Capability | Implementation | Why No New Package |
|------------|---------------|-------------------|
| Path lifecycle state machine | TypeScript `const enum` + transition map | 4 states, 6 transitions. A library (xstate, robot) would be massive overkill. |
| Debug session detection | Regex on tool output + Haiku AI classification | Existing `piggyback-extractor.ts` already does regex-based signal extraction. Haiku handles edge cases. |
| Waypoint capture | PostToolUse hook middleware | Existing hook pipeline (`hooks/capture.ts`) already processes every tool event. Add path-aware logic. |
| Path storage | New SQLite tables via migration framework | Already at migration v19. Add v20 (debug_paths) and v21 (path_waypoints). |
| Loop detection | Simple visited-set algorithm in TypeScript | Track repeated file/error patterns. O(n) where n = waypoints in current path. |
| KISS summary generation | Claude Agent SDK V2 session API (Haiku) | Same pattern used by existing observation enrichment. No new API integration. |
| Path graph overlay | D3.js SVG layer + line generator | Existing `graph.js` already has layered SVG groups (edges, labels, nodes). Add a `pathsGroup` layer. |
| Animated breadcrumb trail | CSS `stroke-dashoffset` animation | Pure CSS animation on SVG path elements. No JS animation library needed. |
| MCP tools for path control | MCP SDK `server.tool()` | Same pattern as existing `topic-context` and `graph-stats` tools. |
| Path-aware context injection | PreToolUse hook extension | Existing PreToolUse hook pipeline. Inject active path context when relevant. |

## Detailed Technology Decisions

### 1. State Machine: Plain TypeScript (not xstate/robot)

**Decision:** Implement path lifecycle as a simple transition table.

**Why:** The debug path lifecycle has exactly 4 states and 6 valid transitions:

```
idle --> active       (debug detected or manual start)
active --> active     (waypoint added -- self-transition)
active --> resolved   (fix confirmed or manual resolve)
active --> abandoned  (session ends without resolution)
active --> stale      (timeout, e.g., 30 min no activity)
```

This is trivially representable as:

```typescript
const TRANSITIONS: Record<PathState, PathState[]> = {
  idle: ['active'],
  active: ['active', 'resolved', 'abandoned', 'stale'],
  resolved: [],
  abandoned: [],
  stale: [],
};
```

xstate (446 KB) or robot (2 KB) are designed for complex hierarchical/parallel state charts with guards, actions, and actors. Using them here would add dependency weight for a pattern that's 15 lines of TypeScript. The path state machine has no parallel states, no hierarchical nesting, no delayed transitions (timers are external), and no need for serialization/deserialization beyond what SQLite already provides.

**Confidence:** HIGH -- this is a well-understood pattern.

### 2. Debug Detection: Hybrid Regex + Haiku AI

**Decision:** Two-tier detection. Fast regex first (< 1ms), Haiku AI for ambiguous cases.

**Tier 1 -- Regex patterns (zero latency):**

```typescript
const ERROR_PATTERNS = [
  /\b(?:Error|TypeError|ReferenceError|SyntaxError)\b/,
  /\bfailed\b.*\b(?:test|build|compile|deploy)\b/i,
  /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED)\b/,
  /\bstack\s*trace\b/i,
  /\b(?:segfault|panic|abort|core dump)\b/i,
  /\bexit\s*code\s*[1-9]/i,
];
```

The existing `piggyback-extractor.ts` already classifies sentiment as `negative` using a similar word list (`NEGATIVE_WORDS`). Extend this with structured error pattern matching.

**Tier 2 -- Haiku classification (for ambiguous cases):**

When regex confidence is low (e.g., the word "error" appears in a comment, not an actual error), call Haiku via existing Agent SDK V2 session API with a classification prompt:

```
Is this tool output indicating a debug/troubleshooting scenario?
Output: [truncated tool output]
Answer: YES/NO with one-line reasoning
```

This matches the existing Haiku enrichment pattern used by observation processing.

**Why not ML-based classification?** The vocabulary of debugging is small and highly patterned. Regex catches 80%+ of cases. Haiku catches the rest. Training a classifier would require labeled data we don't have, add dependency weight (ONNX model loading), and wouldn't outperform the regex + LLM hybrid for this specific domain.

**Confidence:** HIGH -- regex for error detection is battle-tested. Haiku fallback ensures edge cases are covered.

### 3. SQLite Schema: Two New Tables

**Decision:** Add `debug_paths` and `path_waypoints` tables via migrations v20 and v21.

#### Table: `debug_paths` (migration v20)

```sql
CREATE TABLE debug_paths (
  id TEXT PRIMARY KEY,
  project_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','resolved','abandoned','stale')),
  trigger_observation_id TEXT,
  trigger_summary TEXT,
  resolution_summary TEXT,
  kiss_summary TEXT,
  waypoint_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_debug_paths_project ON debug_paths(project_hash);
CREATE INDEX idx_debug_paths_session ON debug_paths(session_id);
CREATE INDEX idx_debug_paths_state ON debug_paths(state);
CREATE INDEX idx_debug_paths_started ON debug_paths(started_at DESC);
```

Design rationale:
- `state` column with CHECK constraint matches the pattern used in `graph_nodes.type` and `graph_edges.type`.
- `trigger_observation_id` links back to the observation that triggered debug detection. Nullable because manual `path:start` MCP calls may not have one.
- `trigger_summary` stores the initial error/problem description for quick display without joining.
- `resolution_summary` stores what fixed it.
- `kiss_summary` stores the Haiku-generated "Keep It Simple" summary (e.g., "Error was caused by missing import. Fixed by adding `import X from Y`.").
- `waypoint_count` is denormalized for fast display. Updated via trigger or application code.
- Timestamps follow existing pattern (`datetime('now')` defaults).

#### Table: `path_waypoints` (migration v21)

```sql
CREATE TABLE path_waypoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path_id TEXT NOT NULL REFERENCES debug_paths(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  waypoint_type TEXT NOT NULL
    CHECK(waypoint_type IN ('error','attempt','discovery','pivot','backtrack','resolution')),
  observation_id TEXT,
  node_id TEXT,
  summary TEXT NOT NULL,
  tool_name TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_waypoints_path ON path_waypoints(path_id, sequence);
CREATE INDEX idx_waypoints_node ON path_waypoints(node_id) WHERE node_id IS NOT NULL;
```

Design rationale:
- `sequence` provides deterministic ordering within a path (timestamps can collide).
- `waypoint_type` classifies the nature of each step. This enables visualization (color-code waypoints by type) and pattern analysis (detect loops = repeated `error` after `attempt`).
- `node_id` optionally links to a graph node. Not all waypoints map to entities (e.g., a bash command failure doesn't necessarily have a graph node).
- `observation_id` links to the raw observation for audit trail.
- `tool_name` captures which tool produced this waypoint (for pattern analysis).
- `metadata` is flexible JSON for waypoint-type-specific data (error codes, file paths, etc.).
- `INTEGER PRIMARY KEY AUTOINCREMENT` matches the pattern used in `observations` and `research_buffer`.

#### Why separate tables (not extending graph_nodes/graph_edges)?

Paths are temporal sequences with lifecycle state. Graph nodes/edges are atemporal knowledge. Mixing them would:
1. Pollute the graph taxonomy (adding `Path` and `Waypoint` entity types breaks the clean 6-type taxonomy).
2. Make path queries expensive (filtering temporal path data from atemporal graph data).
3. Create awkward state management (graph nodes don't have lifecycle states).

Instead, paths *reference* graph nodes via `path_waypoints.node_id`, creating a clean overlay relationship.

**Confidence:** HIGH -- follows established Laminark migration patterns exactly.

### 4. Loop Detection: Visited-Set Pattern

**Decision:** Track `(file_path, error_signature)` tuples in a Map during active path.

```typescript
interface LoopDetector {
  seen: Map<string, number>; // key -> count
  threshold: number;         // default: 3
}
```

A "loop" is detected when the same file + similar error appears 3+ times. This triggers a `backtrack` waypoint and optionally a Haiku prompt: "You seem to be trying the same approach repeatedly. Consider a different strategy."

**Why not a graph cycle detection algorithm?** Path waypoints are a linear sequence, not a graph. The "loop" we're detecting is semantic repetition (same error recurring), not structural cycles. A simple frequency counter on `(file, error_hash)` keys is more appropriate and O(1) per check.

**Confidence:** HIGH -- straightforward frequency counting.

### 5. KISS Summary Generation: Haiku via Agent SDK V2

**Decision:** Generate summaries using the existing Haiku session API when a path transitions to `resolved`.

Prompt template:

```
Summarize this debug journey in 2-3 sentences. Focus on: what broke, why, and what fixed it.

Problem: {trigger_summary}
Steps taken: {waypoint_summaries}
Resolution: {resolution_summary}

Write a KISS (Keep It Simple) summary a developer would find useful months later.
```

This matches the existing enrichment pattern. The Agent SDK V2 session API is already configured and working. No new API setup needed.

**Cost consideration:** One Haiku call per resolved path. At typical debugging frequency (1-5 paths per session), this adds < $0.01 per session.

**Confidence:** HIGH -- existing pattern, no new integration.

### 6. D3 Graph Overlay: SVG Layer with Animated Paths

**Decision:** Add a `pathsOverlayGroup` SVG layer between `edgesGroup` and `nodesGroup` in the existing `graph.js`.

```javascript
// In initGraph(), after edgesGroup creation:
pathsOverlayGroup = svgG.append('g').attr('class', 'paths-overlay-group');
```

Path visualization:

```javascript
// Render path as a sequence of connected waypoint nodes
var pathLine = d3.line()
  .x(function(d) { return d.x; })
  .y(function(d) { return d.y; })
  .curve(d3.curveCatmullRom.alpha(0.5)); // Smooth curves through waypoints

pathsOverlayGroup.selectAll('path.debug-path')
  .data(activePaths)
  .join('path')
  .attr('class', 'debug-path')
  .attr('d', function(d) { return pathLine(d.waypoints); })
  .attr('stroke', '#f85149')       // Error red for active, green for resolved
  .attr('stroke-width', 3)
  .attr('fill', 'none')
  .attr('stroke-dasharray', '8 4') // Dashed line for breadcrumb effect
  .attr('marker-mid', 'url(#path-arrow)'); // Direction arrows
```

Animated breadcrumb effect via CSS:

```css
.debug-path {
  stroke-dasharray: 8 4;
  stroke-dashoffset: 0;
  animation: path-flow 1s linear infinite;
}

@keyframes path-flow {
  to { stroke-dashoffset: -12; }
}

.debug-path.resolved {
  stroke: #3fb950;
  animation: none;
  stroke-dasharray: none;
}
```

**Why D3 line generator (not manual SVG paths)?** `d3.curveCatmullRom` produces smooth curves through waypoint positions without manual bezier control point calculation. The existing graph already uses D3 extensively.

**Why not a separate canvas/WebGL layer?** Paths overlay a small number of nodes (typically 5-20 waypoints). SVG handles this with zero performance concern. Canvas would be warranted only at 1000+ simultaneous paths, which is not a realistic scenario.

**Confidence:** HIGH -- D3 line generators and SVG animations are well-documented, standard patterns.

### 7. MCP Tools: Three New Tool Definitions

**Decision:** Add three MCP tools following the existing `server.tool()` pattern from `topic-context.ts`:

| Tool | Purpose | Parameters |
|------|---------|-----------|
| `path:start` | Manually start a debug path | `summary: string` (what you're debugging) |
| `path:resolve` | Mark active path as resolved | `resolution: string` (what fixed it) |
| `path:show` | Display path history | `pathId?: string` (optional, defaults to most recent), `format?: 'summary' \| 'detailed'` |

These follow the existing MCP tool pattern. Zod schemas for input validation (already a dependency).

**Confidence:** HIGH -- extends existing MCP tool pattern.

### 8. PostToolUse Hook Integration Point

**Decision:** Add path-aware processing as a new middleware in the existing PostToolUse pipeline.

Current flow:
```
PostToolUse event --> capture.ts (extractObservation) --> database
```

New flow:
```
PostToolUse event --> capture.ts (extractObservation) --> database
                  \-> path-tracker.ts (detect debug / add waypoint) --> debug_paths + path_waypoints
```

The path tracker runs *in parallel* with observation capture (not blocking it). It reads the same `PostToolUsePayload` and makes independent decisions about path lifecycle.

Integration point in `hooks/index.ts`:
```typescript
export { processPostToolUse, extractObservation } from './capture.js';
export { processPathEvent } from './path-tracker.js';  // NEW
```

The hook handler (`handler.ts`, not in the src directory but in the hooks bin) calls both.

**Confidence:** HIGH -- clean extension of existing pipeline.

## What NOT to Add

These technologies were considered and explicitly rejected:

| Technology | Why NOT |
|-----------|---------|
| **xstate** (state machine library) | 446 KB for 4 states and 6 transitions. Plain TypeScript is clearer and lighter. |
| **robot** (tiny state machine) | Even at 2 KB, adds a dependency for trivial logic. |
| **dagre / dagre-d3** (graph layout) | Paths are linear sequences, not DAGs. D3 line generators handle this. |
| **graphlib** (graph algorithms) | No graph algorithms needed. Loop detection is frequency counting, not cycle detection. |
| **bull / bee-queue** (job queues) | Path events are synchronous within the hook pipeline. No async job processing needed. |
| **redis** | All state lives in SQLite. No cross-process coordination needed. |
| **Additional embedding model** | Path similarity could use embeddings for "similar error" detection, but Jaccard on tokenized error messages (already in `shared/similarity.ts`) suffices. |
| **D3 sankey / chord diagrams** | Path visualization is a simple directed trail, not a flow diagram. Line + arrows is the right abstraction. |

## Existing Stack Leveraged (NOT re-researched)

| Component | Version | How Used for Paths |
|-----------|---------|-------------------|
| better-sqlite3 | ^12.6.2 | Path + waypoint storage, migrations |
| Hono | ^4.11.9 | API endpoints for path data (`/api/paths`, `/api/paths/:id`) |
| D3.js | (CDN, v7) | Graph overlay visualization with line generators |
| @anthropic-ai/claude-agent-sdk | ^0.2.42 | Haiku calls for KISS summary generation |
| @modelcontextprotocol/sdk | ^1.26.0 | MCP tool definitions (`path:start`, `path:resolve`, `path:show`) |
| Zod | ^4.3.6 | Input validation for MCP tool parameters |
| vitest | ^4.0.18 | Testing path lifecycle, detection, storage |

## New File Structure

```
src/
  paths/                          # NEW module
    types.ts                      # PathState, WaypointType, interfaces
    lifecycle.ts                  # State machine, transitions
    detector.ts                   # Debug detection (regex + Haiku)
    tracker.ts                    # Waypoint capture, loop detection
    repository.ts                 # SQLite CRUD for paths + waypoints
    summary.ts                    # KISS summary generation via Haiku
  hooks/
    path-tracker.ts               # PostToolUse hook integration (NEW)
  mcp/tools/
    path-tools.ts                 # MCP tool definitions (NEW)
  web/routes/
    api.ts                        # Extended with /api/paths endpoints
  storage/
    migrations.ts                 # Extended with v20, v21 migrations
ui/
  graph.js                        # Extended with paths overlay layer
```

## Installation / Build Changes

```bash
# No new packages to install
# No build configuration changes
# No new environment variables
# No new external services
```

The only changes are source code additions within the existing project structure.

## API Endpoints (New)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/paths` | List paths (filterable by state, project) |
| GET | `/api/paths/:id` | Get path with waypoints |
| GET | `/api/paths/active` | Get currently active path |
| GET | `/api/paths/:id/overlay` | Get path waypoints with node positions for D3 overlay |

These follow the existing API pattern in `web/routes/api.ts` (Hono router, typed context with `db` variable).

## Sources

- Codebase analysis: `/data/Laminark/src/` (all source files reviewed)
- Existing patterns: `hooks/capture.ts`, `piggyback-extractor.ts`, `graph/schema.ts`, `storage/migrations.ts`
- D3.js line generators: standard D3 v7 API (d3.line, d3.curveCatmullRom)
- SVG animation: standard CSS animation on stroke-dashoffset
- SQLite CHECK constraints: already used in graph_nodes.type and graph_edges.type

## Confidence Assessment

| Decision | Confidence | Rationale |
|----------|------------|-----------|
| Zero new dependencies | HIGH | Every capability maps to existing patterns in the codebase |
| SQLite schema design | HIGH | Follows established migration pattern (19 prior migrations) |
| State machine approach | HIGH | 4 states, trivial complexity, no library warranted |
| Regex + Haiku detection | HIGH | Extends existing piggyback-extractor pattern |
| D3 overlay visualization | HIGH | Standard D3 patterns, existing graph.js architecture supports layers |
| Waypoint type taxonomy | MEDIUM | The 6 waypoint types (error, attempt, discovery, pivot, backtrack, resolution) may need refinement during implementation. Start with these, adjust based on real usage. |
| Loop detection threshold | MEDIUM | Default of 3 repetitions is a guess. May need tuning. Configurable. |
