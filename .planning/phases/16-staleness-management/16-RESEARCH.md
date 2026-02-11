# Phase 16: Staleness Management - Research

**Researched:** 2026-02-10
**Domain:** Tool registry lifecycle management (staleness detection, deprioritization, failure demotion)
**Confidence:** HIGH

## Summary

Phase 16 is the final phase of the v2.0 milestone. It ensures the tool registry stays accurate over time by implementing three staleness mechanisms: (1) config rescan comparison at SessionStart to detect removed tools, (2) age-based deprioritization for tools not seen in 30+ days, and (3) failure-driven demotion when PostToolUseFailure events accumulate. All three mechanisms feed into the existing ranking and routing pipeline to deprioritize stale/failing tools without deleting them.

The existing infrastructure is exceptionally well-prepared for this phase. The `tool_registry` table already has `discovered_at`, `updated_at`, `last_used_at`, and `usage_count` columns. The `tool_usage_events` table already records `success` as a boolean (0/1). Config scanning at SessionStart already populates the registry via `scanConfigForTools()`. The ranking system (`rankToolsByRelevance`) already uses frequency-share scoring. The routing system (`ConversationRouter`) already filters tools through `getAvailableForSession`. The key work is adding a `status` column to `tool_registry`, building the comparison logic in the SessionStart flow, and modifying the ranking/filtering queries to account for staleness and failure rates.

**Primary recommendation:** Add a `status` column to `tool_registry` (migration 19) with values `active`/`stale`/`demoted`, implement staleness detection as a diff between config scan results and existing registry entries at SessionStart, and wire deprioritization into `getAvailableForSession` and `rankToolsByRelevance`.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | existing | All staleness queries and status updates | Already used for entire storage layer |
| Node.js fs (sync) | existing | Config file reading during SessionStart | Already used in config-scanner.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | - | - | Zero new dependencies per V2 constraint |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `status` column on `tool_registry` | Separate `tool_staleness_flags` table (like `staleness_flags` for observations) | Separate table adds JOIN complexity for every query. A status column is simpler since staleness is a first-class property of a tool registry entry, unlike observation staleness which is advisory metadata. Use the column approach. |
| Boolean `is_stale` column | `status TEXT` enum column | Text enum is more extensible (`active`/`stale`/`demoted`) and self-documenting in queries. Three-state is needed: active (normal), stale (config-removed/age-expired), demoted (failure-based). |
| Time-based decay in ranking | Event-count-based window (existing approach) | The existing `rankToolsByRelevance` already uses event-count windows (last 200 events). Age-based deprioritization is a separate concern -- it applies to the registry entry itself, not to event-window scoring. Both mechanisms coexist. |

**Installation:**
```bash
# No installation needed -- zero new dependencies
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── hooks/
│   ├── session-lifecycle.ts   # Modified: staleness detection in handleSessionStart
│   └── config-scanner.ts      # Unchanged: returns DiscoveredTool[] as before
├── storage/
│   ├── tool-registry.ts       # Modified: new staleness methods + query modifications
│   └── migrations.ts          # Modified: migration 19 adds status column
├── routing/
│   └── conversation-router.ts # Modified: filter demoted tools from suggestions
└── context/
    └── injection.ts           # Modified: filter stale/demoted from tool section
```

### Pattern 1: Config Diff for Removed Tool Detection (STAL-01)
**What:** At SessionStart, compare the set of tools returned by `scanConfigForTools()` against the set of tools in the registry with `source LIKE 'config:%'` for the same project. Tools in the registry but NOT in the scan results are marked `status = 'stale'`. Tools that reappear in a future scan are restored to `status = 'active'`.
**When to use:** Every SessionStart, after config scanning completes.
**Key insight:** Only compare config-sourced tools (source starts with `'config:'`). Tools discovered organically via `hook:PostToolUse` should NOT be marked stale just because they are absent from config files -- they were never config-sourced in the first place.

```typescript
// Pseudocode for the diff logic in session-lifecycle.ts
function detectRemovedTools(
  toolRegistry: ToolRegistryRepository,
  scannedTools: DiscoveredTool[],
  projectHash: string,
): void {
  // Get all config-sourced tools for this project currently marked active
  const registeredConfigTools = toolRegistry.getConfigSourcedTools(projectHash);

  // Build set of names from the fresh scan
  const scannedNames = new Set(scannedTools.map(t => t.name));

  // Mark missing tools as stale
  for (const registered of registeredConfigTools) {
    if (!scannedNames.has(registered.name)) {
      toolRegistry.markStale(registered.name, registered.project_hash);
    }
  }

  // Restore tools that reappeared (were stale but now scanned again)
  for (const scanned of scannedTools) {
    // upsert already updates updated_at; additionally restore status
    toolRegistry.markActive(scanned.name, scanned.projectHash);
  }
}
```

### Pattern 2: Age-Based Deprioritization (STAL-02)
**What:** Tools where both `last_used_at` and `updated_at` are older than 30 days ago are deprioritized. This does NOT mean changing their status to `stale` -- it means the ranking query applies a penalty to old tools.
**When to use:** In `getAvailableForSession` and `rankToolsByRelevance`, both of which are called during context assembly and routing.
**Key insight:** "Not seen in 30+ days" means neither discovered/updated nor used. Both `updated_at` and `last_used_at` must be older than 30 days. A tool that was re-discovered by config scan yesterday (updating `updated_at`) but never used is NOT stale -- it is still relevant. Use `MAX(COALESCE(last_used_at, discovered_at), updated_at)` as the "last seen" timestamp.

```sql
-- Add to getAvailableForSession ORDER BY clause:
-- Deprioritize tools not seen in 30+ days
ORDER BY
  CASE WHEN status = 'demoted' THEN 1 ELSE 0 END ASC,
  CASE WHEN status = 'stale' THEN 1 ELSE 0 END ASC,
  CASE WHEN MAX(COALESCE(last_used_at, discovered_at), updated_at) < datetime('now', '-30 days')
    THEN 1 ELSE 0 END ASC,
  -- existing ordering follows...
```

### Pattern 3: Failure-Driven Demotion (STAL-03)
**What:** When a tool accumulates failures, it gets `status = 'demoted'`. A single successful use resets it to `status = 'active'`. The demotion threshold should be based on consecutive failures or a high failure rate over recent events.
**When to use:** In the PostToolUse handler, after recording the usage event. Check failure rate on each failure event.
**Key insight:** Already, `recordOrCreate` in `tool-registry.ts` records success/failure. The check should happen inline after the event insert. Use a sliding window (last N events for this tool) rather than all-time stats to avoid permanently demoting tools that had early teething problems.

```typescript
// Pseudocode for failure-driven demotion
function checkAndDemote(
  toolRegistry: ToolRegistryRepository,
  toolName: string,
  projectHash: string,
): void {
  // Get last 5 events for this tool
  const recentEvents = toolRegistry.getRecentEventsForTool(toolName, projectHash, 5);

  // If 3+ of last 5 events are failures, demote
  const failures = recentEvents.filter(e => !e.success).length;
  if (failures >= 3) {
    toolRegistry.markDemoted(toolName, projectHash);
  }
}

// On success, always restore from demoted
function checkAndRestore(
  toolRegistry: ToolRegistryRepository,
  toolName: string,
  projectHash: string,
): void {
  toolRegistry.markActive(toolName, projectHash);
}
```

### Pattern 4: Existing Staleness Pattern Alignment
**What:** The codebase already has a staleness pattern for observations (`staleness_flags` table, `flagStaleObservation`, `getStaleObservations` in `src/graph/staleness.ts`). Tool staleness is conceptually different -- it is a first-class status property rather than advisory metadata. Observations are flagged as stale because contradictions are detected between content. Tools are marked stale because they no longer exist in config or have been failing. The column-on-registry approach is the right choice here.
**When to use:** When deciding between separate table vs column approach.

### Anti-Patterns to Avoid
- **Deleting stale tools from the registry:** Never delete. Only mark as stale. Deleted tools lose historical usage data that may be needed for debugging or if the tool returns.
- **Marking organically-discovered tools as stale during config rescan:** Config rescan should ONLY affect config-sourced tools (`source LIKE 'config:%'`). Tools discovered via `hook:PostToolUse` are seen in the wild and their presence is confirmed by actual usage, not config files.
- **Blocking SessionStart on staleness checks:** The existing SessionStart hook has a 2-second performance budget. Staleness checks must be fast (<50ms). Use prepared statements and index on `status`.
- **Cumulative all-time failure counting:** Using all-time failure rates permanently punishes tools that had early failures but have since been fixed. Use a sliding window of recent events.
- **Auto-removing tools from suggestions entirely:** Stale and demoted tools should be deprioritized (sorted lower), not filtered out entirely. The user may still want to use them.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Time-based age calculation | Custom JavaScript Date math for 30-day check | SQLite `datetime('now', '-30 days')` comparison | SQLite datetime arithmetic is atomic, timezone-safe, and avoids JS Date pitfalls |
| Failure rate calculation | Manual event counting with JS loops | SQL aggregate query on `tool_usage_events` with LIMIT | Single query is faster and avoids loading event rows into JS memory |
| Config tool set diffing | Custom JSON diff library | Simple Set comparison (`scannedNames.has(name)`) | The diff is just "is this name in the scanned set?" -- trivial Set logic |

**Key insight:** All three staleness mechanisms reduce to SQL queries and simple Set operations. No external libraries or complex algorithms are needed.

## Common Pitfalls

### Pitfall 1: Confusing Config-Sourced vs Organically-Discovered Tools
**What goes wrong:** Marking ALL registry tools as stale if they are missing from config scan results, including tools that were discovered via PostToolUse hooks and never appeared in any config file.
**Why it happens:** The config scan only sees tools defined in `.mcp.json`, `~/.claude.json`, commands, skills, and plugins. Many tools are discovered organically when the user actually calls them (via the PostToolUse hook). These tools have `source = 'hook:PostToolUse'`, not `source = 'config:...'`.
**How to avoid:** Filter by `source LIKE 'config:%'` when comparing against config scan results. Only config-sourced tools can be invalidated by config absence.
**Warning signs:** After SessionStart, large numbers of tools suddenly marked stale even though the user's config files have not changed.

### Pitfall 2: Global vs Project Scope Confusion in Config Diff
**What goes wrong:** Marking a global tool as stale because it was not found in the project-level config scan, or vice versa.
**Why it happens:** `scanConfigForTools()` returns tools from BOTH global (`~/.claude.json`, `~/.claude/commands`) and project-level (`.mcp.json`, `.claude/commands`) sources. The registry stores scope as `global` or `project`. A global tool should only be compared against global scan results, and project tools against project scan results.
**How to avoid:** When comparing scanned tools against registry entries, match on both `name` and `scope` (or equivalently, match on `name` and `project_hash` since global tools have `project_hash = NULL`).
**Warning signs:** Tools appearing and disappearing from suggestions between sessions depending on which project directory is used.

### Pitfall 3: SessionStart Performance Budget Exceeded
**What goes wrong:** The staleness detection adds enough overhead to push SessionStart beyond the 2-second budget, causing a visibly slow start.
**Why it happens:** Config scanning already runs at SessionStart. Adding staleness comparison, age checks, and failure rate queries without prepared statements or indexes could add significant latency.
**How to avoid:** Use prepared statements for all new queries. Add an index on `tool_registry.status`. Batch the status updates in a transaction. Keep the total staleness detection under 50ms (measured in debug logs, like existing `scanElapsed` pattern).
**Warning signs:** Debug log shows session lifecycle exceeding 500ms.

### Pitfall 4: Race Condition Between Hook and MCP Server
**What goes wrong:** The hook handler marks a tool as demoted via PostToolUseFailure, but the MCP server's background loop or a concurrent SessionStart reads stale data.
**Why it happens:** The hook process and MCP server process both access the same SQLite database. WAL mode handles concurrent reads/writes, but the status change may not be visible until the next read transaction starts.
**How to avoid:** This is already handled by the existing architecture -- WAL mode ensures readers see a consistent snapshot. The staleness status will be visible on the next query, which is the desired behavior (not real-time). No additional locking is needed.
**Warning signs:** None expected -- this is a non-issue given existing WAL mode architecture.

### Pitfall 5: MCP Server Wildcard Tools vs Individual Tools
**What goes wrong:** Config scanning discovers MCP servers as `mcp__servername__*` (wildcard entries), but PostToolUse records individual tools like `mcp__servername__specific_tool`. Comparing these directly misses the relationship.
**Why it happens:** The config scanner creates wildcard entries because `.mcp.json` only lists server names, not individual tools. Individual tool names are only known when they are actually used.
**How to avoid:** When checking for removed tools, treat wildcard MCP server entries specially: if a server entry `mcp__X__*` disappears from config, mark both the wildcard entry AND all individual `mcp__X__*` tools as stale. Use `name LIKE 'mcp__' || server_name || '__%'` to find related individual tools.
**Warning signs:** Server removed from `.mcp.json` but individual tool entries for that server remain active.

## Code Examples

### Migration 19: Add Status Column
```sql
-- Source: Follows pattern of existing migrations in src/storage/migrations.ts
ALTER TABLE tool_registry ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
CREATE INDEX idx_tool_registry_status ON tool_registry(status);
```

### Get Config-Sourced Tools for Comparison
```typescript
// New prepared statement in ToolRegistryRepository
private readonly stmtGetConfigSourced: BetterSqlite3.Statement;

// In constructor:
this.stmtGetConfigSourced = db.prepare(`
  SELECT * FROM tool_registry
  WHERE source LIKE 'config:%'
    AND (project_hash = ? OR project_hash IS NULL)
    AND status = 'active'
`);

getConfigSourcedTools(projectHash: string): ToolRegistryRow[] {
  return this.stmtGetConfigSourced.all(projectHash) as ToolRegistryRow[];
}
```

### Mark Tool as Stale
```typescript
// New prepared statement in ToolRegistryRepository
private readonly stmtMarkStale: BetterSqlite3.Statement;

// In constructor:
this.stmtMarkStale = db.prepare(`
  UPDATE tool_registry
  SET status = 'stale', updated_at = datetime('now')
  WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
    AND status != 'stale'
`);

markStale(name: string, projectHash: string | null): void {
  this.stmtMarkStale.run(name, projectHash);
}
```

### Mark Tool as Demoted (Failure-Driven)
```typescript
// New prepared statement in ToolRegistryRepository
private readonly stmtMarkDemoted: BetterSqlite3.Statement;

// In constructor:
this.stmtMarkDemoted = db.prepare(`
  UPDATE tool_registry
  SET status = 'demoted', updated_at = datetime('now')
  WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
`);

markDemoted(name: string, projectHash: string | null): void {
  this.stmtMarkDemoted.run(name, projectHash);
}
```

### Restore Tool to Active
```typescript
// New prepared statement in ToolRegistryRepository
private readonly stmtMarkActive: BetterSqlite3.Statement;

// In constructor:
this.stmtMarkActive = db.prepare(`
  UPDATE tool_registry
  SET status = 'active', updated_at = datetime('now')
  WHERE name = ? AND COALESCE(project_hash, '') = COALESCE(?, '')
    AND status != 'active'
`);

markActive(name: string, projectHash: string | null): void {
  this.stmtMarkActive.run(name, projectHash);
}
```

### Get Recent Events for Failure Rate Check
```typescript
// New method in ToolRegistryRepository
getRecentEventsForTool(
  toolName: string,
  projectHash: string,
  limit: number = 5,
): Array<{ success: boolean }> {
  const rows = this.db.prepare(`
    SELECT success FROM tool_usage_events
    WHERE tool_name = ? AND project_hash = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(toolName, projectHash, limit) as Array<{ success: number }>;
  return rows.map(r => ({ success: r.success === 1 }));
}
```

### Modified getAvailableForSession with Staleness Awareness
```typescript
// Replace existing stmtGetAvailableForSession:
this.stmtGetAvailableForSession = db.prepare(`
  SELECT * FROM tool_registry
  WHERE
    (scope = 'global'
      OR (scope = 'project' AND project_hash = ?)
      OR (scope = 'plugin' AND (project_hash IS NULL OR project_hash = ?)))
  ORDER BY
    CASE status
      WHEN 'active' THEN 0
      WHEN 'stale' THEN 1
      WHEN 'demoted' THEN 2
      ELSE 3
    END,
    CASE tool_type
      WHEN 'mcp_server' THEN 0
      WHEN 'slash_command' THEN 1
      WHEN 'skill' THEN 2
      WHEN 'plugin' THEN 3
      ELSE 4
    END,
    usage_count DESC,
    discovered_at DESC
`);
```

### Modified Ranking with Age Penalty
```typescript
// In rankToolsByRelevance (context/injection.ts), add age penalty:
const scored = tools.map(row => {
  let count = statsMap.get(row.name)?.usage_count;

  if (count === undefined && row.tool_type === 'mcp_server' && row.server_name) {
    count = serverStats.get(row.server_name)?.usage_count;
  }

  if (count === undefined) {
    return { row, score: 0 };
  }

  let score = count / totalEvents;

  // STAL-02: Age-based deprioritization
  // If tool status is stale or last activity > 30 days, halve the score
  if (row.status === 'stale' || row.status === 'demoted') {
    score *= 0.25;
  }

  return { row, score };
});
```

### Failure Check in PostToolUse Handler
```typescript
// In handler.ts processPostToolUseFiltered, after recordOrCreate:
if (toolRegistry && isFailure) {
  try {
    const recentEvents = toolRegistry.getRecentEventsForTool(toolName, projectHash ?? '', 5);
    const failures = recentEvents.filter(e => !e.success).length;
    if (failures >= 3) {
      toolRegistry.markDemoted(toolName, projectHash ?? null);
      debug('hook', 'Tool demoted due to failures', { tool: toolName, failures });
    }
  } catch {
    // Non-fatal: demotion is supplementary
  }
} else if (toolRegistry && !isFailure) {
  // Successful use restores demoted tools
  try {
    toolRegistry.markActive(toolName, projectHash ?? null);
  } catch {
    // Non-fatal
  }
}
```

### Staleness Detection in SessionStart
```typescript
// In session-lifecycle.ts handleSessionStart, after tool scanning:
if (toolRegistry) {
  try {
    detectRemovedTools(toolRegistry, tools, projectHash);
    debug('session', 'Staleness detection completed');
  } catch {
    debug('session', 'Staleness detection failed (non-fatal)');
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No staleness detection | Config scan populates but never invalidates | Phase 10 (current) | Registry grows monotonically, stale entries accumulate |
| No failure tracking | success column on tool_usage_events | Phase 12 (current) | Data exists but is not acted upon |
| No deprioritization | All tools ranked equally by usage frequency | Phase 13 (current) | Stale/failing tools compete equally with active ones |

**After Phase 16:**
- Config-removed tools are detected and deprioritized within one session restart
- Unused tools naturally sink in rankings after 30 days
- Failing tools are demoted within 3-5 failures, restored on next success

## Open Questions

1. **Should stale/demoted tools be shown in discover_tools search results?**
   - What we know: The `discover_tools` MCP tool uses `searchByKeyword` and `searchByVector` which query `tool_registry` directly.
   - What's unclear: Should search results include stale tools (perhaps with a `[stale]` marker) or filter them entirely?
   - Recommendation: Include them with a status indicator. The user may be searching specifically to see what tools they used to have. Add `status` to the formatted output.

2. **What is the right failure threshold for demotion?**
   - What we know: The current implementation records each tool call as a separate event. Some tools may fail once due to transient issues (network timeout, etc.).
   - What's unclear: Is 3 of 5 too aggressive? Should it be 5 of 5?
   - Recommendation: Start with 3 of 5 (60% failure rate). This is aggressive enough to catch genuinely broken tools but tolerant of the occasional transient failure. The instant-restore-on-success mechanism provides a safety valve.

3. **Should age-based deprioritization apply to organically-discovered tools?**
   - What we know: Organic tools are discovered via PostToolUse -- the user actually used them.
   - What's unclear: If a user stops using a tool for 30 days, should it be deprioritized even though it was never removed from config?
   - Recommendation: Yes. Age-based deprioritization applies to ALL tools regardless of source. The 30-day window is about relevance, not existence. A tool not seen in 30 days is less likely to be relevant now. It is not marked stale (status stays `active`), just ranked lower.

4. **Should the routing suggestion system (ConversationRouter) exclude stale/demoted tools?**
   - What we know: `ConversationRouter.evaluate()` gets tools from `getAvailableForSession()`. If stale/demoted tools sort last in that query, they will naturally be deprioritized.
   - What's unclear: Should the router actively exclude them from the suggestable set?
   - Recommendation: Filter stale/demoted tools from the suggestable set in `ConversationRouter._evaluate()`. Suggestions should only recommend tools in good standing. The user can still discover stale tools via `discover_tools` search.

## Sources

### Primary (HIGH confidence)
- `src/storage/tool-registry.ts` -- Full ToolRegistryRepository implementation, all prepared statements, search methods
- `src/storage/migrations.ts` -- Migration 16 (tool_registry), 17 (tool_usage_events), 18 (FTS5+vec0)
- `src/hooks/handler.ts` -- PostToolUse pipeline, organic discovery, failure event recording
- `src/hooks/session-lifecycle.ts` -- SessionStart handler, config scan invocation
- `src/hooks/config-scanner.ts` -- scanConfigForTools implementation
- `src/context/injection.ts` -- rankToolsByRelevance, formatToolSection, assembleSessionContext
- `src/routing/conversation-router.ts` -- ConversationRouter.evaluate, getAvailableForSession usage
- `src/shared/tool-types.ts` -- ToolRegistryRow, DiscoveredTool, ToolUsageEvent interfaces
- `src/graph/staleness.ts` -- Existing observation staleness pattern (architectural reference)

### Secondary (MEDIUM confidence)
- `.planning/ROADMAP.md` -- Phase 16 definition, success criteria, dependencies
- `.planning/REQUIREMENTS.md` -- STAL-01, STAL-02, STAL-03 requirement definitions
- `.planning/phases/12-usage-tracking/12-VERIFICATION.md` -- Confirmed success column works correctly

### Tertiary (LOW confidence)
- None. All findings are based on direct codebase analysis.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- zero new dependencies, all changes use existing better-sqlite3 patterns
- Architecture: HIGH -- all integration points examined at source level, patterns are straightforward SQL + Set operations
- Pitfalls: HIGH -- all pitfalls identified from actual code paths (config source filtering, scope matching, wildcard tools, performance budget)

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- no external dependencies, no API changes expected)
