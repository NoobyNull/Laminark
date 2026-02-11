# Phase 12: Usage Tracking - Research

**Researched:** 2026-02-10
**Domain:** Tool usage telemetry, event logging, SQLite schema design for analytics
**Confidence:** HIGH

## Summary

Phase 12 fills the gap between tool discovery (Phase 10) and intelligent routing (Phase 14). The existing codebase already has the foundational pieces: `ToolRegistryRepository.recordUsage()` increments `usage_count` and updates `last_used_at` on the `tool_registry` table, and `recordOrCreate()` is called from the PostToolUse handler. However, the current implementation has two critical gaps that Phase 12 must address:

1. **No session/project context on usage events.** The current `recordUsage(name, projectHash)` updates aggregates on the tool_registry row but does not record *which session* triggered the usage. Success criterion 2 requires "each usage event is recorded with its session ID and project association." This requires a new `tool_usage_events` table to store individual events.

2. **No temporal query capability.** Success criterion 3 requires "a tool used 50 times over the past week shows that history." The current `usage_count` is a monotonic counter with no time dimension -- you can't ask "how many times was Read used this week?" without individual event records.

**Primary recommendation:** Add a `tool_usage_events` table (migration 17) that stores one row per PostToolUse event with tool_name, session_id, project_hash, and timestamp. Wire the existing handler's organic discovery path to also insert an event row. The existing `usage_count`/`last_used_at` aggregate columns on `tool_registry` continue to serve as fast-path summary data, while the events table provides the temporal granularity needed for analytics and routing.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | (already in project) | Event storage, aggregation queries | Already the project's database layer; synchronous API matches hook handler requirements |
| SQLite | (already in project) | Relational storage with datetime functions | `datetime('now')`, `strftime()`, window functions for temporal queries |

### Supporting

No new dependencies needed. This phase is purely internal SQLite schema + repository code.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Individual event rows | Increment-only counters (status quo) | Counters lose temporal dimension -- can't answer "usage this week" or "usage per session" |
| Separate events table | JSON array column on tool_registry | JSON arrays grow unbounded, no indexing, terrible for aggregation queries |
| SQLite events table | External analytics store (ClickHouse, etc.) | Massive complexity for a local-first tool; SQLite handles this volume easily |

## Architecture Patterns

### Existing File Structure (No New Directories Needed)

```
src/
  storage/
    tool-registry.ts     # Extend with event recording methods
    migrations.ts        # Add migration 17 for tool_usage_events table
  hooks/
    handler.ts           # Wire session_id into recordOrCreate/recordUsage
  shared/
    tool-types.ts        # Add ToolUsageEvent type
```

### Pattern 1: Dual-Layer Usage Data (Aggregate + Events)

**What:** Keep the existing `usage_count`/`last_used_at` columns on `tool_registry` as fast aggregate summaries, AND add a `tool_usage_events` table for individual event records. The aggregate is updated atomically alongside the event insert.

**When to use:** When you need both fast summary reads (for context injection ranking) and temporal analytics (for routing intelligence).

**Why this pattern:** The existing codebase already uses `usage_count` for sorting in `getAvailableForSession()` and `getAll()` queries. Removing these columns would break Phase 11's scope resolution sorting. Adding events alongside preserves backward compatibility while enabling new capabilities.

**Example (from codebase pattern):**
```typescript
// Analogous to how ObservationRepository.create() inserts a row
// while SessionRepository tracks aggregate session state
recordUsageEvent(name: string, sessionId: string | null, projectHash: string | null): void {
  try {
    this.stmtInsertEvent.run(name, sessionId, projectHash);
    // Also increment the aggregate counter (existing behavior)
    this.stmtRecordUsage.run(name, projectHash);
  } catch (err) {
    debug('tool-registry', 'Failed to record usage event', { name, error: String(err) });
  }
}
```

### Pattern 2: Transaction Wrapping for Atomic Dual-Write

**What:** Wrap the event insert + aggregate update in a single transaction to ensure consistency.

**When to use:** When two related writes must succeed or fail together.

**Example:**
```typescript
// better-sqlite3 transaction pattern (already used in migrations.ts)
private readonly txnRecordUsage: BetterSqlite3.Transaction;

constructor(db: BetterSqlite3.Database) {
  this.txnRecordUsage = db.transaction((name: string, sessionId: string | null, projectHash: string | null) => {
    this.stmtInsertEvent.run(name, sessionId, projectHash);
    this.stmtRecordUsage.run(name, projectHash);
  });
}
```

### Pattern 3: Prepared Statements in Constructor (Project Convention)

**What:** All SQL statements are prepared in the constructor and stored as class fields, reused for every call.

**When to use:** Always -- this is the established convention in ToolRegistryRepository, ObservationRepository, SessionRepository.

**Why:** better-sqlite3 performance best practice. Avoids re-parsing SQL on every call.

### Anti-Patterns to Avoid

- **Storing event data in memory and flushing periodically:** The hook handler is a short-lived process (one invocation per hook event). There is no persistent in-memory state between invocations. Every PostToolUse is a separate process.
- **Using the MCP server process for event recording:** The MCP server (index.ts) runs as a long-lived process but does NOT see PostToolUse events. The hook handler (handler.ts) is the separate CLI entry point that receives hook events. All recording must happen in handler.ts.
- **Adding columns to tool_registry instead of a new table:** Adding session_id to tool_registry would violate its cardinality (one row per tool+project). Events are many-to-one.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Temporal aggregation | Custom date math in TypeScript | SQLite `strftime()`, `datetime()`, `julianday()` | SQLite's date functions handle timezone, leap seconds, edge cases correctly |
| Rolling window queries | Manual buffer/array management | SQL `WHERE created_at >= datetime('now', '-7 days')` | Declarative, uses indexes, no memory overhead |
| Duplicate event prevention | Application-level dedup | Database-level (no unique constraint needed -- events are append-only) | Events are naturally non-unique; each tool use is a distinct event |

**Key insight:** The hook handler is a short-lived CLI process. There is no in-process state to manage. Every design decision must assume stateless execution -- data goes into SQLite and queries read it back.

## Common Pitfalls

### Pitfall 1: Forgetting that handler.ts is a short-lived process

**What goes wrong:** Designing for in-memory accumulation, batch processing, or deferred writes.
**Why it happens:** The MCP server (index.ts) IS long-lived, but the hook handler (handler.ts) is invoked fresh for every hook event via the Claude Code hooks system.
**How to avoid:** Every usage event must be written to SQLite synchronously in the same process invocation. No batching, no deferred writes, no in-memory state.
**Warning signs:** Code that stores data in module-level variables for later flushing.

### Pitfall 2: Breaking the organic discovery recordOrCreate flow

**What goes wrong:** Adding event recording that runs AFTER recordOrCreate, but recordOrCreate already increments usage_count. Now usage_count is incremented twice.
**Why it happens:** recordOrCreate calls stmtRecordUsage internally (which does `usage_count = usage_count + 1`). If you add a separate recordUsage call, the count doubles.
**How to avoid:** Modify `recordOrCreate` to also accept sessionId and insert the event row in the same flow. Do NOT add a separate call path. The event insertion should be part of the existing recordOrCreate method, not a separate step in handler.ts.
**Warning signs:** usage_count growing at 2x the rate of events in tool_usage_events.

### Pitfall 3: Unbounded event table growth

**What goes wrong:** tool_usage_events grows forever, eventually slowing queries and bloating the database.
**Why it happens:** Every tool invocation across every session generates a row. Heavy usage could produce thousands of rows per day.
**How to avoid:** Add an index on `created_at` for efficient range queries. Plan for a future cleanup mechanism (Phase 16 staleness management can handle this). For now, the table is write-heavy/read-light and SQLite handles append-only workloads well. Consider adding a retention note but do NOT implement cleanup in this phase.
**Warning signs:** Queries on tool_usage_events without WHERE clauses on time range.

### Pitfall 4: Not threading session_id through to the recording call

**What goes wrong:** Events are recorded without session_id, making per-session analysis impossible.
**Why it happens:** The handler.ts currently passes `toolRegistry` to `processPostToolUseFiltered`, but `processPostToolUseFiltered` does not forward `input.session_id` to `toolRegistry.recordOrCreate()`. The session_id is available in the input payload but never reaches the recording layer.
**How to avoid:** Thread `session_id` from the input payload through `recordOrCreate` to the event insert. The input JSON from Claude Code includes `session_id` on every PostToolUse event.
**Warning signs:** All tool_usage_events rows have NULL session_id.

### Pitfall 5: Non-fatal error handling regression

**What goes wrong:** A new prepared statement or transaction throws during construction (e.g., migration not yet applied), crashing the hook handler.
**Why it happens:** ToolRegistryRepository is already instantiated inside a try/catch in handler.ts main(). But if you add new prepared statements that reference the `tool_usage_events` table, and migration 17 hasn't run yet, the constructor will throw.
**How to avoid:** The existing pattern handles this -- ToolRegistryRepository construction is already in try/catch. But if you split event recording into a separate repository class, that class also needs a try/catch instantiation. Recommendation: keep event recording in ToolRegistryRepository (same class), so the existing try/catch covers it.
**Warning signs:** Hook handler crashes on databases that haven't been upgraded to migration 17.

## Code Examples

Verified patterns from the existing codebase:

### Migration Pattern (from migrations.ts)

```typescript
// Migration 16 pattern -- source: src/storage/migrations.ts:430
{
  version: 17,
  name: 'create_tool_usage_events',
  up: `
    CREATE TABLE tool_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      session_id TEXT,
      project_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_tool_usage_events_tool
      ON tool_usage_events(tool_name, created_at DESC);
    CREATE INDEX idx_tool_usage_events_session
      ON tool_usage_events(session_id) WHERE session_id IS NOT NULL;
    CREATE INDEX idx_tool_usage_events_project_time
      ON tool_usage_events(project_hash, created_at DESC);
  `,
},
```

### Repository Method Pattern (from tool-registry.ts:recordOrCreate)

```typescript
// Source: src/storage/tool-registry.ts:139-149
// recordOrCreate pattern -- extend this to also insert event
recordOrCreate(name: string, defaults: Omit<DiscoveredTool, 'name'>, sessionId?: string | null): void {
  try {
    const result = this.stmtRecordUsage.run(name, defaults.projectHash);
    if (result.changes === 0) {
      this.upsert({ name, ...defaults });
    }
    // NEW: Insert usage event
    if (sessionId !== undefined) {
      this.stmtInsertEvent.run(name, sessionId, defaults.projectHash);
    }
    debug('tool-registry', 'recordOrCreate completed', { name, created: result.changes === 0 });
  } catch (err) {
    debug('tool-registry', 'Failed recordOrCreate', { name, error: String(err) });
  }
}
```

### Query Pattern for Temporal Analysis

```typescript
// Query: usage count per tool in the last 7 days
// Supports Success Criterion 3
const stmt = db.prepare(`
  SELECT tool_name, COUNT(*) as usage_count, MAX(created_at) as last_used
  FROM tool_usage_events
  WHERE project_hash = ? AND created_at >= datetime('now', '-7 days')
  GROUP BY tool_name
  ORDER BY usage_count DESC
`);
```

### Query Pattern for Per-Session Analysis

```typescript
// Query: tools used in a specific session
// Supports Success Criterion 2
const stmt = db.prepare(`
  SELECT tool_name, COUNT(*) as count
  FROM tool_usage_events
  WHERE session_id = ?
  GROUP BY tool_name
  ORDER BY count DESC
`);
```

### Handler Wiring Pattern (from handler.ts:79-86)

```typescript
// Source: src/hooks/handler.ts:79-86
// Current organic discovery -- extend to pass session_id
if (toolRegistry) {
  try {
    const sessionId = input.session_id as string | undefined;
    toolRegistry.recordOrCreate(toolName, {
      toolType: inferToolType(toolName),
      scope: inferScope(toolName),
      source: 'hook:PostToolUse',
      projectHash: projectHash ?? null,
      description: null,
      serverName: extractServerName(toolName),
    }, sessionId ?? null);
  } catch {
    // Non-fatal: registry is supplementary to core memory function
  }
}
```

## Existing Infrastructure Analysis

### What Already Exists (HIGH confidence -- verified from source code)

| Component | Location | Status | Phase 12 Impact |
|-----------|----------|--------|-----------------|
| `usage_count` column | tool_registry table (migration 16) | Exists, working | Keep as aggregate; supplement with events table |
| `last_used_at` column | tool_registry table (migration 16) | Exists, working | Already updated by `recordUsage()` |
| `recordUsage()` method | tool-registry.ts:123-129 | Exists, working | Continue calling -- updates aggregates |
| `recordOrCreate()` method | tool-registry.ts:139-149 | Exists, working | Extend to accept sessionId, insert event row |
| `processPostToolUseFiltered()` | handler.ts:60-203 | Exists, working | Modify to pass session_id to recordOrCreate |
| `session_id` in hook input | handler.ts (from Claude Code) | Available but unused by registry | Thread through to event recording |
| `projectHash` in handler | handler.ts:217, line 244 | Available, already passed | Already threaded to recordOrCreate |
| `getAvailableForSession()` | tool-registry.ts:163-165 | Exists, sorts by usage_count | No change needed for Phase 12 |

### What Must Be Built

| Component | Description | Files Modified |
|-----------|-------------|----------------|
| Migration 17 | `tool_usage_events` table with indexes | src/storage/migrations.ts |
| `ToolUsageEvent` type | TypeScript interface for event rows | src/shared/tool-types.ts |
| Event insert prepared statement | `stmtInsertEvent` in ToolRegistryRepository | src/storage/tool-registry.ts |
| `recordOrCreate` sessionId param | Thread session_id through the recording path | src/storage/tool-registry.ts |
| Handler session_id threading | Pass `input.session_id` to recordOrCreate | src/hooks/handler.ts |
| Query methods for events | `getUsageForTool()`, `getUsageForSession()`, `getUsageSince()` | src/storage/tool-registry.ts |

### Data Flow (Current vs. Phase 12)

**Current flow:**
```
PostToolUse event -> handler.ts -> toolRegistry.recordOrCreate(name, defaults)
                                   -> stmtRecordUsage.run(name, projectHash)   [aggregate only]
                                   -> upsert if new                            [discovery only]
```

**Phase 12 flow:**
```
PostToolUse event -> handler.ts -> toolRegistry.recordOrCreate(name, defaults, sessionId)
                                   -> stmtRecordUsage.run(name, projectHash)   [aggregate, unchanged]
                                   -> stmtInsertEvent.run(name, sessionId, projectHash) [NEW: event row]
                                   -> upsert if new                            [discovery, unchanged]
```

## Requirements Mapping

| Requirement | Success Criterion | What Satisfies It |
|-------------|-------------------|-------------------|
| UTRK-01 | Every PostToolUse increments usage_count and updates last_used_at | **Already implemented** by `recordOrCreate()` -> `stmtRecordUsage`. Phase 12 ensures this continues working. |
| UTRK-02 | Usage event recorded with session_id and project association | New `tool_usage_events` table; `recordOrCreate` extended with sessionId parameter |
| UTRK-03 | Usage data persists across sessions for routing intelligence | SQLite persistence (inherent); query methods for temporal analysis added to repository |

### Critical Observation: UTRK-01 Is Already Satisfied

The existing `recordOrCreate()` method (Phase 10) already increments `usage_count` and updates `last_used_at` via `stmtRecordUsage`. Phase 12's work for UTRK-01 is verification and ensuring no regression, not implementation.

The actual new work is UTRK-02 (session/project context on events) and UTRK-03 (temporal queryability).

## Open Questions

1. **Event table cleanup policy**
   - What we know: Phase 16 (Staleness Management) handles age-based deprioritization and cleanup.
   - What's unclear: Should tool_usage_events have a retention policy from day one, or is it fine to let it grow until Phase 16?
   - Recommendation: No cleanup in Phase 12. SQLite handles tens of thousands of rows without issue. Add a comment noting Phase 16 will address retention.

2. **Should failed tool uses (PostToolUseFailure) be recorded as events?**
   - What we know: The current `processPostToolUseFiltered` handles both PostToolUse and PostToolUseFailure through the same code path. `recordOrCreate` is called for both.
   - What's unclear: Should failure events be recorded differently for Phase 16's failure-driven demotion?
   - Recommendation: Record all events. Add an optional `success` boolean column (default TRUE) to the events table. Set it to FALSE for PostToolUseFailure events. This costs nothing now and enables Phase 16 without a migration.

3. **Should Laminark's own tools have usage events recorded?**
   - What we know: Per decision [10-02], organic discovery runs BEFORE the self-referential filter, so Laminark's own tools ARE registered in tool_registry. The self-referential filter only prevents observation capture, not registry updates.
   - What's unclear: Should Laminark's own tool invocations (mcp__laminark__recall, etc.) appear in tool_usage_events?
   - Recommendation: Yes. The event recording happens at the same point as recordOrCreate (before the self-referential filter). This is consistent with Phase 10's decision and provides data on how often Laminark itself is used.

## Sources

### Primary (HIGH confidence)

- `src/storage/tool-registry.ts` -- Existing ToolRegistryRepository with recordUsage, recordOrCreate, and all prepared statements. Verified line by line.
- `src/storage/migrations.ts` -- Migration 16 schema for tool_registry table with usage_count and last_used_at columns. Verified.
- `src/hooks/handler.ts` -- PostToolUse handler with organic discovery at lines 77-89, showing current data flow. Verified.
- `src/shared/tool-types.ts` -- ToolRegistryRow interface showing existing columns (usage_count: number, last_used_at: string | null). Verified.
- `src/hooks/session-lifecycle.ts` -- Session lifecycle showing how session_id is handled. Verified.
- `.planning/phases/10-tool-discovery-registry/10-VERIFICATION.md` -- Phase 10 verification confirming all discovery paths operational.
- `.planning/phases/11-scope-resolution/11-VERIFICATION.md` -- Phase 11 verification confirming scope-filtered queries use usage_count for sorting.

### Secondary (MEDIUM confidence)

- SQLite documentation for datetime functions (strftime, datetime modifiers) -- well-established, stable API.
- better-sqlite3 transaction API -- used extensively in existing codebase (migrations.ts:498).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new dependencies; pure SQLite + better-sqlite3 (already in project)
- Architecture: HIGH - Follows established patterns from Phase 10 (migration + repository extension)
- Pitfalls: HIGH - Identified from direct codebase analysis, not speculation
- Requirements mapping: HIGH - UTRK-01 already satisfied; UTRK-02/03 have clear implementation path

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- no external dependencies to change)
