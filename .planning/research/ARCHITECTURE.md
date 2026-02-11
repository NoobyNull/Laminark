# Architecture Patterns: Global Tool Discovery, Scope-Aware Registry, and Conversation-Driven Routing

**Domain:** MCP plugin architecture for Claude Code -- global installation, tool discovery, scope-aware routing
**Researched:** 2026-02-10
**Confidence:** HIGH (based on thorough codebase analysis + official Claude Code docs)

## Executive Summary

Laminark currently operates as a project-scoped plugin: installed via `.mcp.json` per-project, with hooks registered in `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}`. The database already supports multi-project data (all observations use `project_hash` partitioning in a single `~/.claude/plugins/cache/laminark/data/data.db` file). This means the **storage layer is already global** -- what needs to change is **discovery, installation, and routing**.

The key architectural insight is that Laminark's plugin structure (`hooks/hooks.json`, `.mcp.json`, `.claude-plugin/plugin.json`) already provides global hook and MCP registration when installed via `claude plugin install`. The missing pieces are:

1. **Tool registry** -- knowing what MCP tools/servers exist across all projects in a given session
2. **Scope resolution** -- determining which memories are relevant (project-local vs cross-project)
3. **Routing decisions** -- using conversation context to decide which scope to query

---

## Current Architecture (As-Is)

### Component Map

```
src/
  index.ts              -- MCP server entry point (stdio transport)
  hooks/
    handler.ts          -- Hook CLI entry point (reads stdin, dispatches by event)
    session-lifecycle.ts -- SessionStart/SessionEnd/Stop handlers
    capture.ts          -- Observation extraction from tool payloads
    admission-filter.ts -- Noise rejection pipeline
    privacy-filter.ts   -- Secret/sensitive file redaction
    save-guard.ts       -- Duplicate detection
    piggyback-extractor.ts -- Entity extraction piggybacked on embeddings
  mcp/
    server.ts           -- McpServer creation and stdio startup
    tools/
      recall.ts         -- Search/view/purge memories
      save-memory.ts    -- Explicit memory creation
      query-graph.ts    -- Knowledge graph traversal
      graph-stats.ts    -- Graph statistics
      topic-context.ts  -- Topic context stash retrieval
      status.ts         -- System health/status
  storage/
    database.ts         -- SQLite connection (WAL, sqlite-vec, migrations)
    observations.ts     -- ObservationRepository (CRUD, scoped to projectHash)
    sessions.ts         -- SessionRepository
    embeddings.ts       -- EmbeddingStore (vec0 table)
    search.ts           -- FTS5 + vector search
    migrations.ts       -- Versioned schema migrations (15 so far)
    notifications.ts    -- Transient notification queue
    research-buffer.ts  -- Research tool target buffer
    stash-manager.ts    -- Topic shift context stashes
  context/
    injection.ts        -- SessionStart context assembly (kind-aware)
  graph/
    types.ts            -- Entity/Relationship type taxonomy
    schema.ts           -- Graph DDL, CRUD, traversal
    extraction-rules.ts -- Regex entity extraction
    relationship-detector.ts -- Relationship inference
    constraints.ts      -- Graph constraint enforcement
    curation-agent.ts   -- Background graph maintenance
  shared/
    config.ts           -- Database path, project hash, config dir
    types.ts            -- Observation/Session/Search types + Zod schemas
    debug.ts            -- Debug logging

hooks/
  hooks.json            -- Plugin hook registration (PostToolUse, SessionStart, etc.)
.mcp.json               -- Project-scoped MCP server registration
.claude-plugin/
  plugin.json           -- Plugin manifest
  marketplace.json      -- Marketplace metadata
skills/
  status/SKILL.md       -- /laminark:status slash command
```

### Key Data Flow: Session Start (Current)

```
Claude Code starts session
    |
    v
hooks/hooks.json fires SessionStart hook
    |
    v
handler.ts reads stdin JSON {session_id, cwd, hook_event_name: "SessionStart"}
    |
    v
getProjectHash(cwd) -> sha256 of canonical path, first 16 hex chars
    |
    v
openDatabase(getDatabaseConfig())  -- opens ~/.claude/.../data.db
    |
    v
handleSessionStart():
  1. sessionRepo.create(sessionId)
  2. assembleSessionContext(db, projectHash)
     - getLastCompletedSession(db, projectHash)
     - getRecentByKind(db, projectHash, 'change', 10, 1day)
     - getRecentByKind(db, projectHash, 'decision', 5, 7days)
     - getRecentByKind(db, projectHash, 'finding', 5, 7days)
     - getRecentByKind(db, projectHash, 'reference', 3, 3days)
  3. formatContextIndex() -> structured markdown
  4. enforce token budget (6000 chars / ~2000 tokens)
    |
    v
process.stdout.write(context) -- injected into Claude's context window
```

### Key Architectural Properties

1. **Single SQLite database** at `~/.claude/plugins/cache/laminark/data/data.db` shared across ALL projects
2. **project_hash partitioning** -- every table uses `project_hash` column for isolation
3. **Dual-process model** -- MCP server (long-running, stdio) + Hook handler (short-lived, per-event CLI)
4. **WAL mode** -- enables concurrent read/write between MCP server and hook handler
5. **SessionStart is synchronous** -- stdout goes directly into Claude's context window
6. **All other hooks are async** -- no stdout impact on Claude
7. **Plugin installation** -- `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin directory

---

## Recommended Architecture (To-Be)

### Architecture Principle: Minimal New Components

The current architecture already has most of the plumbing. The recommended approach is to **extend existing components** rather than create parallel systems.

### Component Changes Overview

| Component | Status | Change Description |
|-----------|--------|--------------------|
| `src/shared/config.ts` | MODIFY | Add scope resolution (project vs global) |
| `src/context/injection.ts` | MODIFY | Add cross-project context when relevant |
| `src/hooks/handler.ts` | MODIFY | Add tool registry updates on PostToolUse |
| `src/hooks/session-lifecycle.ts` | MODIFY | Add tool discovery at SessionStart |
| `src/storage/migrations.ts` | MODIFY | Add migration 16 for tool registry + routing tables |
| `src/storage/tool-registry.ts` | **NEW** | Tool registry repository (tracks MCP tools per project) |
| `src/routing/scope-resolver.ts` | **NEW** | Determines query scope (project / global / cross-project) |
| `src/routing/tool-router.ts` | **NEW** | Routes tool requests based on conversation context |
| `src/mcp/tools/recall.ts` | MODIFY | Add scope parameter, cross-project search |
| `src/mcp/tools/save-memory.ts` | MODIFY | Add scope parameter (project vs global) |
| `skills/` | MODIFY | Add new skill for cross-project recall |

### New Component: Tool Registry (`src/storage/tool-registry.ts`)

**Purpose:** Track which MCP tools and servers are available across projects. Not a discovery mechanism (Claude Code handles that), but a **memory** of what tools have been seen and used, enabling routing decisions.

**Why a table and not config parsing:** The hook handler cannot read `.mcp.json` files from arbitrary projects -- it only knows about the current `cwd`. But it DOES receive `tool_name` on every PostToolUse event. By recording tool usage in the database, Laminark builds a registry organically from actual usage rather than trying to parse config files.

```sql
-- Migration 16: Tool registry
CREATE TABLE tool_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_hash TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    server_name TEXT,          -- extracted from mcp__<server>__<tool> pattern
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
    usage_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_hash, tool_name)
);

CREATE INDEX idx_tool_registry_project ON tool_registry(project_hash);
CREATE INDEX idx_tool_registry_tool ON tool_registry(tool_name);
CREATE INDEX idx_tool_registry_server ON tool_registry(server_name) WHERE server_name IS NOT NULL;
```

**Integration point:** `handler.ts` PostToolUse handler calls `toolRegistry.recordUsage(projectHash, toolName)` on every tool event. This is lightweight (one upsert, ~1ms).

### New Component: Scope Resolver (`src/routing/scope-resolver.ts`)

**Purpose:** Determine the scope for memory operations (recall, save, context injection).

**Scope Levels:**

| Scope | Meaning | When Used |
|-------|---------|-----------|
| `project` | Current project only | Default for all operations |
| `global` | All projects | Explicit request ("across all projects") or global memories |
| `related` | Projects sharing tools/patterns | Conversation references a tool/pattern seen in other projects |

**Resolution Strategy:**

```typescript
interface ScopeDecision {
  scope: 'project' | 'global' | 'related';
  projectHashes: string[];  // which projects to query
  reason: string;           // why this scope was chosen
}

function resolveScope(
  currentProjectHash: string,
  query: string,
  toolContext?: string[],    // tools mentioned in conversation
): ScopeDecision {
  // 1. Explicit scope keywords
  if (/\b(all projects?|globally|everywhere|cross[- ]project)\b/i.test(query)) {
    return { scope: 'global', projectHashes: [], reason: 'explicit global keyword' };
  }

  // 2. Tool-based scope expansion
  //    If query mentions a tool/server seen in other projects,
  //    expand scope to those projects
  if (toolContext) {
    const relatedProjects = toolRegistry.findProjectsWithTools(toolContext);
    if (relatedProjects.length > 1) {
      return {
        scope: 'related',
        projectHashes: relatedProjects,
        reason: `tools ${toolContext.join(', ')} found in ${relatedProjects.length} projects`,
      };
    }
  }

  // 3. Default: project scope
  return { scope: 'project', projectHashes: [currentProjectHash], reason: 'default project scope' };
}
```

**Integration point:** Called by `recall` and `save_memory` MCP tools, and by `assembleSessionContext()`.

### New Component: Tool Router (`src/routing/tool-router.ts`)

**Purpose:** Use conversation context to determine WHICH Laminark capabilities to activate.

**Design Decision: NOT a proxy router.** Laminark should not try to intercept or route other MCP tools. Claude Code already handles MCP tool routing. Instead, the "router" determines how Laminark's OWN tools (recall, save_memory, query_graph) should behave based on context.

```typescript
interface RoutingContext {
  sessionId: string;
  projectHash: string;
  recentTools: string[];      // last N tools used in session
  recentObservationKinds: string[];  // what kinds of observations exist
  conversationTopics: string[];     // from topic detection
}

interface RoutingDecision {
  recallScope: 'project' | 'global' | 'related';
  suggestCrossProject: boolean;     // hint in context injection
  activeCapabilities: string[];     // which Laminark features to highlight
}
```

**Key insight:** The router does NOT make decisions at tool-call time (that is Claude's job). It provides **context enrichment** at SessionStart and via notifications, so Claude knows what is available and makes better tool choices.

---

## Data Flow: Session Start (To-Be)

```
Claude Code starts session in /path/to/project
    |
    v
hooks/hooks.json fires SessionStart hook
    |
    v
handler.ts reads stdin JSON
    |
    v
getProjectHash(cwd) -> projectHash
    |
    v
openDatabase() -- same as before
    |
    v
handleSessionStart():
  1. sessionRepo.create(sessionId)
  2. assembleSessionContext(db, projectHash)  [MODIFIED]
     |
     +-- NEW: Check tool_registry for this project
     |     - How many tools? How many observations?
     |     - Any cross-project tool overlap?
     |
     +-- Existing: getLastCompletedSession(db, projectHash)
     +-- Existing: getRecentByKind(db, projectHash, ...)
     |
     +-- NEW: If cross-project context is relevant:
     |     - Query project_metadata for related projects
     |     - Pull 1-2 high-value observations from related projects
     |     - Add "Cross-project context" section to output
     |
     +-- Existing: formatContextIndex()
     +-- NEW: Append routing hints section
     |     "Laminark has memories from N projects. Use recall with scope='global' to search across all."
     |
     +-- Existing: enforce token budget
    |
    v
process.stdout.write(context)
```

### Data Flow: PostToolUse Observation Capture (To-Be)

```
Claude uses any tool (Write, Bash, MCP tool, etc.)
    |
    v
hooks/hooks.json fires PostToolUse hook (async)
    |
    v
handler.ts reads stdin JSON {tool_name, tool_input, ...}
    |
    v
NEW: toolRegistry.recordUsage(projectHash, toolName)
  -- Extracts server_name from mcp__<server>__<tool> pattern
  -- Upserts into tool_registry (one statement, ~1ms)
    |
    v
Existing pipeline: filter -> extract -> privacy -> admission -> store
    |
    (no changes to existing pipeline)
```

### Data Flow: Recall with Scope (To-Be)

```
Claude calls mcp__laminark__recall({query: "auth patterns", scope: "global"})
    |
    v
recall tool handler:
  1. Parse scope parameter (default: 'project')
  2. If scope == 'project':
     - Query as today (single projectHash)
  3. If scope == 'global':
     - Query without project_hash filter
     - Annotate results with project name from project_metadata
  4. If scope == 'related':
     - scopeResolver.resolveScope() -> related projectHashes
     - Query with IN (projectHash1, projectHash2, ...)
     - Annotate results with project name
    |
    v
Format and return results (with project attribution in cross-project mode)
```

---

## Database Schema Changes

### Migration 16: Tool Registry and Routing

```sql
-- Tool registry: records which tools are used in which projects
CREATE TABLE tool_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_hash TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    server_name TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
    usage_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(project_hash, tool_name)
);

CREATE INDEX idx_tool_registry_project ON tool_registry(project_hash);
CREATE INDEX idx_tool_registry_tool ON tool_registry(tool_name);

-- Global memories: observations not tied to a single project
-- Uses existing observations table with a sentinel project_hash = '__global__'
-- No new table needed -- just a convention + scope resolver logic

-- Routing decisions log (for debugging and learning)
CREATE TABLE routing_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_hash TEXT NOT NULL,
    query TEXT NOT NULL,
    resolved_scope TEXT NOT NULL,
    resolved_projects TEXT NOT NULL,  -- JSON array of project hashes
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_routing_log_session ON routing_log(session_id, created_at DESC);
```

### Global Memory Convention

Rather than creating a separate table or storage for "global" memories, use a **sentinel project_hash** `'__global__'` in the existing observations table. This is cleaner than duplicating the entire observation infrastructure:

- `save_memory` with `scope: 'global'` stores with `project_hash = '__global__'`
- `recall` with `scope: 'global'` queries `WHERE project_hash IN (current, '__global__')` or without filter
- Context injection always includes `__global__` observations alongside project-specific ones

This avoids any schema changes to the observations table itself.

---

## Existing Component Modifications

### 1. `src/shared/config.ts` -- Scope Awareness

**Change:** Add constants for global scope sentinel and helper functions.

```typescript
// New exports
export const GLOBAL_PROJECT_HASH = '__global__';

export function isGlobalScope(projectHash: string): boolean {
  return projectHash === GLOBAL_PROJECT_HASH;
}
```

**Impact:** Minimal. Pure additions, no existing behavior changed.

### 2. `src/hooks/handler.ts` -- Tool Registry Recording

**Change:** After the existing PostToolUse pipeline, add a single call to record tool usage.

```typescript
// In the PostToolUse handler, after processPostToolUseFiltered():
case 'PostToolUse':
case 'PostToolUseFailure':
  processPostToolUseFiltered(input, obsRepo, researchBuffer);
  // NEW: Record tool usage in registry
  try {
    const toolReg = new ToolRegistry(laminarkDb.db, projectHash);
    toolReg.recordUsage(input.tool_name as string);
  } catch { /* non-fatal */ }
  break;
```

**Impact:** One additional SQLite upsert per PostToolUse event. ~1ms overhead. Non-fatal on failure.

### 3. `src/context/injection.ts` -- Cross-Project Context

**Change:** Extend `assembleSessionContext()` to optionally include:
- Cross-project hints when other projects share tools
- Global memory observations
- Routing availability hint

**Token budget consideration:** Cross-project context competes with existing context for the 6000-char budget. Strategy: allocate max 1000 chars for cross-project content, reducing from existing sections only if needed.

### 4. `src/mcp/tools/recall.ts` -- Scope Parameter

**Change:** Add `scope` parameter to the recall tool input schema.

```typescript
scope: z
  .enum(['project', 'global', 'related'])
  .default('project')
  .describe('Search scope: project (current only), global (all projects), related (projects sharing tools)'),
```

When `scope !== 'project'`, modify queries to either remove project_hash filter or use an IN clause. Add project name attribution to results.

### 5. `src/mcp/tools/save-memory.ts` -- Scope Parameter

**Change:** Add `scope` parameter to save_memory.

```typescript
scope: z
  .enum(['project', 'global'])
  .default('project')
  .describe('Memory scope: project (current project) or global (available across all projects)'),
```

When `scope === 'global'`, store with `project_hash = '__global__'`.

### 6. `src/hooks/session-lifecycle.ts` -- Routing Hints

**Change:** After assembling context, append routing availability hints.

```typescript
// After assembleSessionContext():
const toolReg = new ToolRegistry(db, projectHash);
const toolCount = toolReg.getToolCount(projectHash);
const projectCount = toolReg.getDistinctProjectCount();

if (projectCount > 1) {
  context += `\n\n[Laminark has memories across ${projectCount} projects. ` +
    `Use recall with scope="global" to search across all.]`;
}
```

---

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `ToolRegistry` | Records tool usage per project, finds cross-project tool overlap | handler.ts (write), scope-resolver (read), session-lifecycle (read) |
| `ScopeResolver` | Determines query scope from context + keywords | recall tool, save-memory tool, context injection |
| `ToolRouter` | Enriches context with routing hints | session-lifecycle (SessionStart), context injection |
| `handler.ts` | Hook event dispatch + observation pipeline + tool recording | ToolRegistry (new), ObservationRepository, ResearchBuffer |
| `injection.ts` | Context assembly for SessionStart | ScopeResolver (new), ObservationRepository, SessionRepository |
| `recall.ts` | Memory search with scope | ScopeResolver (new), SearchEngine, EmbeddingStore |
| `save-memory.ts` | Memory creation with scope | ScopeResolver (new), ObservationRepository |

### Dependency Graph

```
                     handler.ts
                    /     |     \
               v          v      v
        ToolRegistry  ObsRepo  ResearchBuffer
              |
              v
        scope-resolver.ts  <---- recall.ts
              |                   save-memory.ts
              v                   injection.ts
        tool_registry table
        project_metadata table
        routing_log table
```

### Critical Boundary: Hook Handler vs MCP Server

The hook handler (`handler.ts`) and MCP server (`index.ts`) are **separate processes** sharing the same SQLite database via WAL mode. This is a load-bearing architectural property:

- **Hook handler:** Short-lived CLI process. Spawned per event. Must be fast (<100ms for SessionStart, <30ms for PostToolUse). Opens its own DB connection.
- **MCP server:** Long-running process. Stdio transport to Claude Code. Handles tool calls. Background workers (embedding, classification, curation).

New components must respect this boundary:
- `ToolRegistry.recordUsage()` runs in the hook handler (fast path)
- `ScopeResolver` runs in both (hook handler for SessionStart, MCP server for tool calls)
- `ToolRouter` runs in the hook handler (SessionStart context enrichment)

---

## Patterns to Follow

### Pattern 1: Upsert-on-Observe (Tool Registry)

**What:** Record tool information as a side effect of observing tool use, rather than actively scanning for tools.

**When:** Building the tool registry.

**Why:** The hook handler already receives every tool call. Parsing `.mcp.json` files from arbitrary project directories is fragile, requires filesystem access, and may not reflect actual tool availability. Organic recording from actual usage is more reliable.

```typescript
class ToolRegistry {
  recordUsage(toolName: string): void {
    // Extract server name from MCP pattern: mcp__<server>__<tool>
    const mcpMatch = toolName.match(/^mcp__([^_]+)__/);
    const serverName = mcpMatch ? mcpMatch[1] : null;

    this.stmtUpsert.run(this.projectHash, toolName, serverName);
  }
}
```

### Pattern 2: Sentinel Project Hash for Global Scope

**What:** Use `project_hash = '__global__'` for cross-project observations rather than creating separate global tables.

**When:** Storing and querying global memories.

**Why:** Reuses all existing infrastructure -- FTS5, vec0, triggers, repositories. No schema duplication. The ObservationRepository already scopes by project_hash, so querying global is just changing which hash to use.

```typescript
// Global save
const globalRepo = new ObservationRepository(db, GLOBAL_PROJECT_HASH);
globalRepo.create({ content: '...', source: 'mcp:save_memory', kind: 'decision' });

// Cross-project query (current + global)
const results = db.prepare(`
  SELECT * FROM observations
  WHERE project_hash IN (?, ?)
  AND deleted_at IS NULL
  ORDER BY created_at DESC
  LIMIT ?
`).all(projectHash, GLOBAL_PROJECT_HASH, limit);
```

### Pattern 3: Context Budget Partitioning

**What:** Allocate fixed sub-budgets within the SessionStart token budget for different context types.

**When:** Extending context injection with cross-project information.

**Why:** The current 6000-char budget is already tight. Adding cross-project context without a budget partition would crowd out project-local context.

```
Total budget: 6000 chars (~2000 tokens)
  Session summary:     ~500 chars
  Project observations: ~4000 chars (existing)
  Cross-project hints:  ~500 chars (new)
  Routing hints:        ~200 chars (new)
  Buffer:               ~800 chars
```

### Pattern 4: Non-Fatal Side Effects

**What:** All new side effects (tool registry recording, routing log writes) are wrapped in try/catch and never prevent the primary operation from completing.

**When:** Any new database writes in the hook handler hot path.

**Why:** The hook handler MUST exit 0. Any failure in a side-effect cannot be allowed to break observation capture or context injection. This pattern is already used extensively in `index.ts` (graph extraction, provenance edges, etc.).

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Config File Parsing for Tool Discovery

**What:** Reading `.mcp.json` or `~/.claude.json` to discover available tools.

**Why bad:** These files are not in Laminark's control. Their format may change. They may reference servers that are not actually running. They require filesystem traversal across project directories.

**Instead:** Build the tool registry organically from PostToolUse events. The first time a tool is used, it gets registered. This is always accurate because it reflects actual tool availability.

### Anti-Pattern 2: Routing Proxy

**What:** Intercepting Claude Code's tool calls and routing them to different MCP servers.

**Why bad:** Claude Code already handles MCP tool routing. A proxy adds latency, complexity, and creates race conditions. Claude Code's Tool Search feature already handles dynamic tool discovery.

**Instead:** Laminark's "routing" is about routing its OWN operations (recall, save, context injection) to the right scope. It provides context hints so Claude makes better tool choices, but never intercepts or redirects other tools.

### Anti-Pattern 3: Separate Global Database

**What:** Creating a second SQLite database for global/cross-project data.

**Why bad:** Double the migration burden. Double the connection management. FTS5 and vec0 tables would need to be duplicated. WAL coordination across two databases is harder.

**Instead:** Use the sentinel `__global__` project_hash in the existing single database. All existing infrastructure (FTS5, embeddings, graph, triggers) works automatically.

### Anti-Pattern 4: Heavy SessionStart Processing

**What:** Running complex queries, filesystem scans, or network calls during SessionStart.

**Why bad:** SessionStart is synchronous. stdout goes into Claude's context. Total budget is 2 seconds. Currently takes ~50-100ms. Every additional query adds risk of timeout.

**Instead:** Keep SessionStart lean. Pre-compute routing decisions in the background (MCP server process or post-session hooks). At SessionStart, read pre-computed results from the database.

---

## Scalability Considerations

| Concern | At 1 project | At 10 projects | At 100 projects |
|---------|-------------|----------------|-----------------|
| Tool registry size | ~20 rows | ~200 rows | ~2000 rows |
| Cross-project query | N/A | 10-way IN clause | Needs pagination or scoring |
| SessionStart latency | ~50ms | ~60ms (one more query) | ~80ms (need index optimization) |
| Database size | ~5MB | ~50MB | ~500MB (may need WAL checkpointing tuning) |
| FTS5 global search | ~20ms | ~100ms | May need `rank` optimization |

**Scaling strategy for 100+ projects:** If a user has 100+ projects, the cross-project features should use scoring/recency to limit the search space rather than querying all projects. The `tool_registry` table's `last_used_at` column enables this -- only query projects active in the last 30 days.

---

## Build Order (Dependency-Aware)

### Phase 1: Foundation (No User-Visible Changes)

1. **Migration 16** -- Add `tool_registry` and `routing_log` tables
2. **`src/storage/tool-registry.ts`** -- ToolRegistry repository class
3. **`src/shared/config.ts`** -- Add `GLOBAL_PROJECT_HASH` constant
4. **`src/hooks/handler.ts`** -- Add tool registry recording to PostToolUse

*Rationale:* Start recording tool usage immediately. This populates the registry for subsequent features. No user-visible changes, no risk.

### Phase 2: Scope Resolution

5. **`src/routing/scope-resolver.ts`** -- ScopeResolver with keyword detection + tool overlap
6. **`src/mcp/tools/recall.ts`** -- Add `scope` parameter, cross-project search
7. **`src/mcp/tools/save-memory.ts`** -- Add `scope` parameter, global storage

*Rationale:* Once the registry has data, enable explicit scope selection. Users can now say "recall across all projects" and it works.

### Phase 3: Context Enrichment

8. **`src/context/injection.ts`** -- Add cross-project context section
9. **`src/hooks/session-lifecycle.ts`** -- Add routing hints to SessionStart
10. **`src/routing/tool-router.ts`** -- Routing context enrichment

*Rationale:* With scope resolution working, enhance automatic context to hint at cross-project capabilities. This is the "conversation-driven" part -- Claude sees the hints and uses scope parameters naturally.

### Phase 4: Polish

11. **Skills/commands** -- Add `/laminark:recall-global` or similar slash command
12. **Status tool** -- Show cross-project stats in `status` output
13. **UI** -- Add cross-project view to web visualization

---

## Integration Test Points

| Test | Validates |
|------|-----------|
| PostToolUse records tool in registry | Tool registry recording works |
| MCP tool name parsed to server_name | `mcp__github__search` -> server `github` |
| SessionStart includes routing hints when multiple projects exist | Context enrichment works |
| recall with scope='global' returns cross-project results | Scope resolution works |
| recall with scope='project' only returns current project | Default isolation preserved |
| save_memory with scope='global' stores with sentinel hash | Global storage works |
| SessionStart stays under 2s with 50+ projects | Performance budget maintained |
| Hook handler exits 0 even if tool registry write fails | Non-fatal side effect pattern |

---

## Sources

- Laminark codebase analysis (all src/ files, hooks/, .claude-plugin/)
- [Claude Code Plugins documentation](https://code.claude.com/docs/en/plugins) -- plugin structure, `${CLAUDE_PLUGIN_ROOT}`, `.mcp.json` in plugins
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks) -- hook events, matchers, stdin/stdout, async/sync behavior, `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PLUGIN_ROOT}`
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) -- scopes (local/project/user), `~/.claude.json`, `.mcp.json`, tool naming `mcp__<server>__<tool>`, Tool Search feature
- [Claude Code plugin marketplace](https://claude.com/blog/claude-code-plugins) -- plugin installation and distribution
- [Claude Code hooks guide](https://claude.com/blog/how-to-configure-hooks) -- practical hook configuration

**Confidence:** HIGH -- recommendations are grounded in the actual codebase architecture and verified against official Claude Code documentation. The single-database, project_hash partitioning approach is already proven in the existing system.
