# Architecture: Debug Resolution Paths Integration

**Domain:** Debug path tracking integrated into existing Laminark memory plugin
**Researched:** 2026-02-14
**Confidence:** HIGH (based on thorough analysis of all existing source files)

## Executive Summary

Debug resolution paths ("paths") are a new first-class entity type that tracks the journey from error detection to resolution. The architecture must integrate into three existing systems: (1) the PostToolUse hook pipeline for automatic detection, (2) the knowledge graph for path storage and entity linking, (3) the D3 visualization for breadcrumb trail overlays.

The key architectural insight is that **path lifecycle management belongs in the HaikuProcessor, not in the hook handler**. The hook handler (`handler.ts`) is a short-lived CLI process that opens a fresh DB connection per invocation -- it has no in-memory state across calls. The HaikuProcessor, by contrast, is a long-running background process in `index.ts` that already processes every observation through classify/extract/relate. Adding a fourth step (path detection) to this pipeline is the natural integration point.

Path state lives in two new SQLite tables (`debug_paths` and `path_waypoints`) with edges connecting paths to existing graph nodes. An in-memory `PathTracker` singleton in the MCP server process maintains active path state (current path ID, waypoint buffer, consecutive-success counter) to avoid per-observation DB queries for state checks.

The D3 overlay is a new SVG layer group inserted between edges and nodes, rendering path waypoints as animated breadcrumb trails with color-coded status indicators.

---

## Current Architecture (Relevant Components)

### Data Flow: PostToolUse Pipeline

```
stdin JSON
  |
  v
handler.ts (CLI process, ephemeral)
  |-- Self-referential filter (skip Laminark's own tools)
  |-- Research tool routing (Read/Glob/Grep -> research buffer)
  |-- extractObservation() -> semantic summary
  |-- Privacy filter (redact secrets, exclude sensitive files)
  |-- Admission filter (reject noise)
  |-- SaveGuard (duplicate detection)
  |-- ObservationRepository.create() -> SQLite
  |
  v
[Observation in DB, unclassified]
  |
  v
Background embedding loop (index.ts, 5s interval)
  |-- Generates embeddings for unembedded observations
  |-- Topic shift detection
  |-- SSE broadcast
  |
  v
HaikuProcessor (index.ts, 30s interval)
  |-- classifyWithHaiku() -> noise/signal + discovery/problem/solution
  |-- extractEntitiesWithHaiku() -> entity names + types
  |-- inferRelationshipsWithHaiku() -> edges between entities
  |-- Writes to graph_nodes / graph_edges
  |-- SSE broadcast (entity_updated)
```

### Key Constraint: Hook Handler Is Ephemeral

`handler.ts` is a CLI process invoked per tool call. It:
- Opens a fresh SQLite connection each time (~2ms with WAL)
- Has NO in-memory state across invocations
- MUST exit quickly (cold start budget)
- Only writes observations, never reads from Haiku or graph

This means: **path detection cannot happen in the hook handler**. Path detection requires multi-observation state (is an error pattern active? how many successes since last failure?). This state must live in the long-running MCP server process (`index.ts`).

### Existing Entity/Relationship Types

```typescript
// graph/types.ts -- FIXED taxonomies
ENTITY_TYPES = ['Project', 'File', 'Decision', 'Problem', 'Solution', 'Reference']
RELATIONSHIP_TYPES = ['related_to', 'solved_by', 'caused_by', 'modifies',
                      'informed_by', 'references', 'verified_by', 'preceded_by']
```

Paths connect to existing Problem/Solution/File/Decision nodes via edges. They do NOT need new entity types -- paths are a distinct concept stored in their own tables, with graph edges linking them to the knowledge graph.

### Existing Haiku Agent Pattern

Each agent follows the same pattern (see `haiku-classifier-agent.ts`, `haiku-entity-agent.ts`, `haiku-relationship-agent.ts`):

```typescript
// 1. Zod validation schema for output
const Schema = z.object({ ... });

// 2. System prompt constant
const SYSTEM_PROMPT = `...`;

// 3. Single exported async function
export async function doThingWithHaiku(input): Promise<Result> {
  const response = await callHaiku(SYSTEM_PROMPT, userContent, maxTokens);
  const parsed = extractJsonFromResponse(response);
  return Schema.parse(parsed);
}
```

New path-related Haiku agents MUST follow this exact pattern.

---

## Recommended Architecture: Debug Resolution Paths

### New Components

| Component | Location | Type | Purpose |
|-----------|----------|------|---------|
| `PathTracker` | `src/paths/path-tracker.ts` | Class (singleton in index.ts) | In-memory active path state machine |
| `PathRepository` | `src/paths/path-repository.ts` | Class | SQLite CRUD for debug_paths + path_waypoints |
| `haiku-path-detector-agent` | `src/intelligence/haiku-path-detector-agent.ts` | Function | Detects error patterns -> should path start/continue/resolve? |
| `haiku-path-summary-agent` | `src/intelligence/haiku-path-summary-agent.ts` | Function | Generates KISS summary on resolution |
| Path migration | `src/storage/migrations/` or inline | DDL | Creates debug_paths, path_waypoints tables |
| Path MCP tools | `src/mcp/tools/debug-paths.ts` | Tool registration | path_start, path_resolve, path_show, path_list |
| Path API routes | `src/web/routes/api.ts` (extend) | Hono routes | GET /api/paths, GET /api/paths/:id |
| Path overlay | `ui/graph.js` (extend) | D3 layer | SVG breadcrumb trail rendering |

### Modified Components

| Component | Change |
|-----------|--------|
| `src/intelligence/haiku-processor.ts` | Add step 4: path detection after classification |
| `src/index.ts` | Instantiate PathTracker, pass to HaikuProcessor |
| `src/web/routes/sse.ts` | New event types: `path_started`, `path_waypoint`, `path_resolved` |
| `ui/graph.js` | New SVG layer group for path overlay, new data arrays |
| `ui/app.js` | SSE handler for path events |

### Component Boundaries

```
src/paths/                     <-- NEW module
  path-tracker.ts              <-- State machine (in-memory)
  path-repository.ts           <-- SQLite persistence
  types.ts                     <-- Path/Waypoint interfaces

src/intelligence/
  haiku-path-detector-agent.ts <-- NEW: error/resolution pattern detection
  haiku-path-summary-agent.ts  <-- NEW: KISS summary generation
  haiku-processor.ts           <-- MODIFIED: add path detection step

src/mcp/tools/
  debug-paths.ts               <-- NEW: MCP tool registration

src/web/routes/
  api.ts                       <-- MODIFIED: add path endpoints
```

---

## Data Model

### New Tables

```sql
CREATE TABLE IF NOT EXISTS debug_paths (
  id TEXT PRIMARY KEY,
  project_hash TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'resolved', 'abandoned', 'stale')),
  trigger_observation_id TEXT,     -- observation that triggered path start
  trigger_summary TEXT NOT NULL,   -- what error/problem was detected
  resolution_summary TEXT,         -- KISS summary ("next time, just do X")
  dimensions TEXT DEFAULT '{}',    -- JSON: {logical, programmatic, development}
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS path_waypoints (
  id TEXT PRIMARY KEY,
  path_id TEXT NOT NULL REFERENCES debug_paths(id) ON DELETE CASCADE,
  observation_id TEXT,             -- link to source observation
  sequence_num INTEGER NOT NULL,   -- ordering within path
  waypoint_type TEXT NOT NULL CHECK(waypoint_type IN (
    'error', 'hypothesis', 'attempt', 'failure', 'success',
    'revert', 'pivot', 'discovery', 'resolution'
  )),
  summary TEXT NOT NULL,           -- what happened at this waypoint
  tool_name TEXT,                  -- which tool produced this
  file_path TEXT,                  -- file involved (if any)
  metadata TEXT DEFAULT '{}',      -- flexible JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_debug_paths_project ON debug_paths(project_hash);
CREATE INDEX IF NOT EXISTS idx_debug_paths_status ON debug_paths(status);
CREATE INDEX IF NOT EXISTS idx_debug_paths_session ON debug_paths(session_id);
CREATE INDEX IF NOT EXISTS idx_path_waypoints_path ON path_waypoints(path_id);
CREATE INDEX IF NOT EXISTS idx_path_waypoints_sequence ON path_waypoints(path_id, sequence_num);
```

### Graph Integration

Paths connect to the existing knowledge graph via standard `graph_edges`:

```
debug_paths.id  --[graph_edge: 'caused_by']--> graph_nodes (Problem)
debug_paths.id  --[graph_edge: 'solved_by']--> graph_nodes (Solution)
debug_paths.id  --[graph_edge: 'modifies']---> graph_nodes (File)
debug_paths.id  --[graph_edge: 'informed_by']-> graph_nodes (Reference)
```

**Important design decision:** Paths are NOT graph_nodes. They live in their own table because they have fundamentally different structure (ordered waypoints, status lifecycle, temporal bounds). But they connect TO graph nodes via edges. This means we need a way to reference path IDs in graph_edges without foreign key conflicts.

**Solution:** Add a `graph_nodes` entry of a new type when a path starts, so edges can reference it. This requires extending the entity type taxonomy:

```typescript
// Extend ENTITY_TYPES to include 'DebugPath'
ENTITY_TYPES = ['Project', 'File', 'Decision', 'Problem', 'Solution', 'Reference', 'DebugPath']
```

When a path is created, a corresponding `graph_nodes` entry with `type = 'DebugPath'` is created. This node serves as the graph-side anchor for all path-related edges. The full path data (waypoints, status, summaries) lives in `debug_paths` / `path_waypoints`, but the node enables graph traversal and visualization.

---

## PathTracker State Machine

```
                   +-----------+
                   |   IDLE    |  No active path
                   +-----+-----+
                         |
             error/failure observation detected
                         |
                   +-----v-----+
                   |  ACTIVE   |  Path started, collecting waypoints
                   +-----+-----+
                         |
              +----------+----------+
              |                     |
    resolution detected      staleness timeout
              |                     |
        +-----v-----+        +-----v-----+
        | RESOLVED  |        | ABANDONED |
        +-----------+        +-----------+
```

### In-Memory State (PathTracker)

```typescript
interface ActivePathState {
  pathId: string;
  sessionId: string;
  consecutiveSuccesses: number;  // counts toward resolution detection
  waypointCount: number;
  lastWaypointAt: number;        // timestamp for staleness
  triggerClassification: string; // what type of error triggered this
}

class PathTracker {
  private activePaths: Map<string, ActivePathState>;  // keyed by sessionId
  private readonly repo: PathRepository;

  // Called by HaikuProcessor after classification
  processObservation(obs: ClassifiedObservation, sessionId: string): void;

  // Called by MCP tools for explicit control
  startPath(sessionId: string, trigger: string): string;
  resolvePath(sessionId: string, resolution?: string): void;
  abandonPath(sessionId: string): void;

  // Staleness check (called on timer)
  checkStalePaths(): void;
}
```

**Key design: one active path per session.** A session can only have one active debug path at a time. If a new error is detected while a path is active, it becomes a waypoint (pivot/new-error) on the existing path, not a separate path. This prevents path explosion and matches how debugging actually works -- you're working on one problem even if related errors surface.

### Resolution Detection Heuristic

Resolution is NOT a single event -- it's a pattern. The PathTracker uses a consecutive-success counter:

1. Each observation classified as `solution` or with successful test output increments `consecutiveSuccesses`
2. Each observation classified as `problem` resets `consecutiveSuccesses` to 0
3. When `consecutiveSuccesses >= RESOLUTION_THRESHOLD` (default: 3), trigger resolution
4. On resolution: call `haiku-path-summary-agent` to generate KISS summary
5. Mark path as `resolved`, set `resolved_at`

This avoids premature resolution (one passing test doesn't mean the problem is solved) while not requiring explicit user action.

---

## HaikuProcessor Integration

### Modified processOne() Flow

```typescript
// Current flow (3 steps):
// 1. Classify observation (noise/signal, discovery/problem/solution)
// 2. Extract entities
// 3. Infer relationships

// New flow (4 steps):
// 1. Classify observation (noise/signal, discovery/problem/solution) -- UNCHANGED
// 2. Path detection (NEW)
//    - If classification === 'problem' and no active path: start path
//    - If active path exists: add waypoint based on classification + content
//    - If resolution heuristic met: resolve path, generate summary
// 3. Extract entities -- UNCHANGED
// 4. Infer relationships -- UNCHANGED (but now also creates edges to path nodes)
```

**Why between classify and extract:** Path detection depends on classification output (problem/solution/discovery) but not on entity extraction. Placing it after classify and before extract means:
- It has the classification data it needs
- Entity extraction can include the path node in its context
- Relationship inference can create edges from entities to the active path

### HaikuProcessor Constructor Change

```typescript
// Current
constructor(db, projectHash, opts?)

// New
constructor(db, projectHash, pathTracker, opts?)
```

The `PathTracker` is injected from `index.ts` where it's instantiated as a singleton.

---

## New Haiku Agents

### 1. haiku-path-detector-agent.ts

**Purpose:** Determine whether an observation indicates an error/failure pattern that should start a path, or a resolution pattern that should end one.

**Input:** Observation content + classification + active path context (if any)
**Output:** `{ action: 'start_path' | 'add_waypoint' | 'resolve' | 'none', waypoint_type?: WaypointType, reason: string }`

**When called:** After classification, for every `signal` observation (skip `noise`).

**Note:** This agent is called frequently (every signal observation) so the prompt must be focused and the response schema minimal. Keep max_tokens low (128).

```typescript
const PathDetectorSchema = z.object({
  action: z.enum(['start_path', 'add_waypoint', 'resolve', 'none']),
  waypoint_type: z.enum([
    'error', 'hypothesis', 'attempt', 'failure', 'success',
    'revert', 'pivot', 'discovery', 'resolution'
  ]).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
```

### 2. haiku-path-summary-agent.ts

**Purpose:** Generate a KISS ("Keep It Simple, Stupid") resolution summary from the full path waypoint history.

**Input:** All waypoints for the path (summaries + types), trigger summary, resolution observation
**Output:** `{ kiss_summary: string, root_cause: string, what_fixed_it: string }`

**When called:** Once, when a path is resolved. This is a rarer call so it can use more tokens (512).

```typescript
const PathSummarySchema = z.object({
  kiss_summary: z.string(),    // "Next time, just do X"
  root_cause: z.string(),      // What actually caused the problem
  what_fixed_it: z.string(),   // The specific action that resolved it
});
```

---

## MCP Tool Integration

### New Tools

| Tool Name | Purpose | Input | Output |
|-----------|---------|-------|--------|
| `path_start` | Explicitly start a debug path | `{ trigger: string }` | Path ID + confirmation |
| `path_resolve` | Explicitly resolve active path | `{ resolution?: string }` | Summary + confirmation |
| `path_show` | Show active or specific path | `{ path_id?: string }` | Formatted path with waypoints |
| `path_list` | List recent paths | `{ status?: string, limit?: number }` | Path list with summaries |

### Registration Pattern (matches existing tools)

```typescript
export function registerDebugPaths(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHash: string,
  pathTracker: PathTracker,
  notificationStore: NotificationStore | null,
): void {
  server.registerTool('path_start', { ... }, async (args) => { ... });
  server.registerTool('path_resolve', { ... }, async (args) => { ... });
  server.registerTool('path_show', { ... }, async (args) => { ... });
  server.registerTool('path_list', { ... }, async (args) => { ... });
}
```

---

## Web API Additions

### New Endpoints

```
GET /api/paths
  ?project=HASH     -- filter by project
  ?status=active    -- filter by status
  ?limit=20         -- pagination
  Returns: { paths: [...] }

GET /api/paths/:id
  Returns: { path: {...}, waypoints: [...], linkedEntities: [...] }

GET /api/paths/active
  ?project=HASH
  Returns: { path: {...} | null }
```

### SSE Events

```
event: path_started
data: { id, trigger, sessionId, timestamp }

event: path_waypoint
data: { pathId, waypointId, type, summary, sequenceNum, timestamp }

event: path_resolved
data: { id, kissSummary, waypointCount, duration, timestamp }
```

---

## D3 Graph Overlay

### Architecture

The path overlay is a new SVG layer group in the graph visualization, positioned between the edges layer and the nodes layer:

```
svgG (zoom group)
  |-- edgesGroup
  |-- edgeLabelsGroup
  |-- pathOverlayGroup   <-- NEW
  |-- nodesGroup
  |-- nodeLabelsGroup
```

### Data Structure

```javascript
// Path overlay data (separate from node/edge data)
var pathData = [];          // active/recent paths
var pathWaypointData = [];  // waypoints for visible paths

// Each path has:
{
  id: 'path-123',
  status: 'active',         // active | resolved
  nodeIds: ['n1', 'n2', 'n3'],  // graph node IDs touched by waypoints
  waypoints: [
    { nodeId: 'n1', sequenceNum: 0, type: 'error' },
    { nodeId: 'n2', sequenceNum: 1, type: 'attempt' },
    { nodeId: 'n3', sequenceNum: 2, type: 'resolution' },
  ]
}
```

### Rendering Strategy

Paths render as **animated dashed lines** connecting the graph nodes that waypoints reference, in sequence order:

1. **Path line:** A `<path>` element using D3 line generator, connecting waypoint nodes in order. Dashed stroke, colored by path status (red for active, green for resolved).

2. **Waypoint markers:** Small circles on each waypoint node, colored by waypoint type:
   - `error`: red
   - `attempt`: yellow
   - `failure`: orange
   - `success`: green
   - `resolution`: bright green with glow
   - `pivot`: purple
   - `revert`: gray

3. **Path label:** Text element showing path trigger summary, positioned near the first waypoint.

4. **Animation:** Active paths have a CSS dash-offset animation (marching ants effect) to visually distinguish them from resolved paths.

### Toggle Control

A new "Paths" toggle button in the toolbar (next to edge labels toggle) controls path overlay visibility. Path overlay follows the same LOD rules as edge labels -- hidden at zoom levels < 0.5.

### SSE Integration

```javascript
// In app.js SSE handler
case 'path_started':
  // Add path to pathData, render overlay
  break;
case 'path_waypoint':
  // Add waypoint to existing path, re-render
  break;
case 'path_resolved':
  // Update path status, change color to green
  break;
```

---

## Patterns to Follow

### Pattern 1: Repository + In-Memory State Hybrid

**What:** PathRepository handles persistence, PathTracker handles live state. PathTracker reads from PathRepository on startup (load active paths) and writes through it on state changes.

**Why:** The HaikuProcessor runs every 30s. Path state changes (waypoint additions, resolution checks) happen more frequently and need sub-second response. In-memory state avoids DB round-trips for hot-path operations.

**Example:**
```typescript
class PathTracker {
  constructor(private repo: PathRepository) {
    // Load active paths from DB on startup
    const active = repo.getActivePaths();
    for (const path of active) {
      this.activePaths.set(path.sessionId, {
        pathId: path.id,
        sessionId: path.sessionId,
        consecutiveSuccesses: 0,
        waypointCount: path.waypointCount,
        lastWaypointAt: Date.now(),
        triggerClassification: path.triggerSummary,
      });
    }
  }
}
```

### Pattern 2: Haiku Agent Per Concern

**What:** One focused Haiku agent per distinct AI task. Path detection and path summarization are separate agents with separate prompts.

**Why:** Existing pattern (classifier, entity-extractor, relationship-detector are each separate). Focused prompts produce better results than kitchen-sink prompts. Separate agents can be tested independently.

### Pattern 3: SSE Broadcast for Live Updates

**What:** All path state changes broadcast via the existing SSE system. The D3 overlay subscribes to these events.

**Why:** Existing pattern (entity_updated, new_observation, topic_shift all broadcast via SSE). Keeps the web UI reactive without polling.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Path Detection in Hook Handler

**What:** Trying to detect debug patterns in `handler.ts`.
**Why bad:** Hook handler is ephemeral -- no state across invocations. Would require DB queries for every tool call (expensive, slow). Would add latency to the critical path.
**Instead:** Piggyback on HaikuProcessor which already processes every observation.

### Anti-Pattern 2: Paths as Graph Nodes Only

**What:** Storing path data entirely in graph_nodes/graph_edges.
**Why bad:** Paths have ordered waypoints (sequence matters), temporal lifecycle (started/resolved), and status state. Graph nodes are unordered and have no lifecycle concept. Forcing paths into the graph model would require awkward metadata hacks.
**Instead:** Dedicated tables for paths/waypoints, with a graph_node anchor for graph integration.

### Anti-Pattern 3: Separate Haiku Session for Path Agents

**What:** Creating a new Claude Agent SDK session for path-related Haiku calls.
**Why bad:** The existing `haiku-client.ts` provides a shared singleton session. Creating parallel sessions wastes resources and may hit rate limits.
**Instead:** Use the existing `callHaiku()` function from `haiku-client.ts`.

### Anti-Pattern 4: Blocking HaikuProcessor for Path Summary

**What:** Having the HaikuProcessor wait for KISS summary generation before processing next observation.
**Why bad:** KISS summaries are expensive (many waypoints in context, 512 tokens output). Blocking would delay entity extraction for subsequent observations.
**Instead:** Fire-and-forget the summary generation. Mark path as `resolving`, generate summary async, then update to `resolved` when done.

---

## Build Order (Dependency-Aware)

### Phase 1: Storage Foundation

**Must build first -- everything depends on it.**

1. Path migration (debug_paths + path_waypoints tables)
2. Extend ENTITY_TYPES to include 'DebugPath' (graph/types.ts)
3. Update graph migration CHECK constraint to allow 'DebugPath'
4. PathRepository (CRUD operations)
5. PathTracker (in-memory state machine)

**Dependencies:** None (only touches storage layer)
**Unblocks:** Everything else

### Phase 2: Detection Pipeline

**Builds on Phase 1 storage.**

6. haiku-path-detector-agent (new Haiku agent)
7. HaikuProcessor integration (add step 4: path detection)
8. PathTracker wiring in index.ts (instantiate, inject into HaikuProcessor)
9. Resolution detection heuristic in PathTracker
10. SSE broadcast for path events

**Dependencies:** Phase 1 (PathRepository, PathTracker)
**Unblocks:** MCP tools, visualization

### Phase 3: KISS Summary Generation

**Builds on Phase 2 detection.**

11. haiku-path-summary-agent (new Haiku agent)
12. Resolution flow completion (PathTracker calls summary agent on resolve)
13. Graph edge creation (link resolved paths to Problem/Solution/File nodes)

**Dependencies:** Phase 2 (detection must work before summarization)
**Unblocks:** Full path lifecycle

### Phase 4: MCP Tools

**Builds on Phase 1+2 for explicit control.**

14. path_start tool
15. path_resolve tool
16. path_show tool
17. path_list tool
18. Tool registration in index.ts

**Dependencies:** Phase 1 (PathRepository), Phase 2 (PathTracker)
**Can build in parallel with:** Phase 3

### Phase 5: Visualization

**Builds on Phase 1+2 for data availability.**

19. Path API endpoints (web/routes/api.ts)
20. D3 path overlay layer (ui/graph.js)
21. Path toggle control (toolbar button)
22. SSE event handlers for live path updates (ui/app.js)
23. Path detail panel (show waypoints, summary)

**Dependencies:** Phase 1 (data in DB), Phase 2 (SSE events)
**Can build in parallel with:** Phase 3, Phase 4

---

## Scalability Considerations

| Concern | At 10 paths | At 100 paths | At 1000 paths |
|---------|-------------|--------------|---------------|
| PathTracker memory | Negligible (~1KB per active) | Still fine (only active paths in memory) | OK (typically <10 active at once) |
| Waypoint table size | Trivial | ~1000 waypoints | ~10K waypoints, may need LIMIT on queries |
| D3 overlay rendering | Smooth | Need to limit visible paths (top 10 recent) | Must filter aggressively |
| Haiku detector calls | 1 per signal obs (existing Haiku budget) | Same -- detector runs per obs not per path | Same |
| KISS summary generation | Rare (1 per resolution) | ~100 total, spread over time | Manageable -- async and infrequent |

### Performance Budget

- Path detector Haiku call: ~200ms (small prompt, 128 tokens). Runs inside HaikuProcessor which already budgets for 3 Haiku calls per observation.
- PathTracker.processObservation(): <1ms (in-memory map lookup + counter update)
- Waypoint write: <5ms (single INSERT)
- Path overlay render: <16ms (must stay within frame budget for 60fps)

---

## Sources

- Codebase analysis: `src/hooks/handler.ts` (PostToolUse pipeline, ephemeral CLI process)
- Codebase analysis: `src/intelligence/haiku-processor.ts` (background enrichment orchestrator)
- Codebase analysis: `src/intelligence/haiku-client.ts` (shared Haiku session)
- Codebase analysis: `src/intelligence/haiku-classifier-agent.ts` (Haiku agent pattern)
- Codebase analysis: `src/graph/schema.ts` (graph operations, traversal)
- Codebase analysis: `src/graph/types.ts` (entity/relationship taxonomy)
- Codebase analysis: `src/graph/migrations/001-graph-tables.ts` (table DDL pattern)
- Codebase analysis: `src/web/routes/api.ts` (REST API pattern, Hono routes)
- Codebase analysis: `src/web/routes/sse.ts` (SSE broadcast pattern)
- Codebase analysis: `ui/graph.js` (D3 force-directed graph, layer groups, SSE integration)
- Codebase analysis: `src/index.ts` (MCP server wiring, background processor lifecycle)
- Codebase analysis: `src/mcp/tools/query-graph.ts` (MCP tool registration pattern)
- Codebase analysis: `src/storage/database.ts` (SQLite WAL configuration)
- Codebase analysis: `src/storage/sessions.ts` (repository pattern)
