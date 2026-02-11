# Phase 13: Context Enhancement - Research

**Researched:** 2026-02-10
**Domain:** Usage-based relevance ranking, context budget management, session context injection
**Confidence:** HIGH

## Summary

Phase 13 upgrades the existing "Available Tools" section in session context to rank tools by a relevance score combining usage frequency and recency, and enforces a 500-character sub-budget for the tool section. The infrastructure from Phase 11 (scope-filtered tool queries, `formatToolSection`, budget-aware trimming) and Phase 12 (temporal event tracking with `getUsageSince`) already provides everything needed. The work is a targeted modification to `formatToolSection` in `injection.ts` and the addition of a relevance scoring function.

The current implementation in `injection.ts` queries tools via `toolRegistry.getAvailableForSession(projectHash)`, which returns tools ordered by `tool_type` priority, then `usage_count DESC`, then `discovered_at DESC`. This ordering uses the aggregate `usage_count` on `tool_registry` rows (lifetime total), not the temporal event data from `tool_usage_events` that Phase 12 added. Phase 13 must replace this naive ordering with a relevance score that combines recent usage frequency (from `getUsageSince`) with recency weighting, and enforce a hard 500-character sub-budget on the tool section output.

The key changes are: (1) call `toolRegistry.getUsageSince(projectHash, '-7 days')` at context assembly time to get recent usage stats, (2) compute a relevance score for each tool combining recent frequency and recency, (3) sort tools by this score before formatting, and (4) add a 500-character cap to `formatToolSection` output with progressive entry trimming. No new database queries, tables, or external dependencies are needed. All building blocks exist.

**Primary recommendation:** Add a `rankToolsByRelevance` function in `injection.ts` that merges `ToolRegistryRow[]` with `ToolUsageStats[]` to produce a scored, sorted list, then modify `formatToolSection` to enforce a 500-character cap. The function stays module-internal (not exported) consistent with prior decision [11-01].

## Standard Stack

### Core (No New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | ^12.6.2 | Temporal usage queries via existing `getUsageSince` | Already in use; no new queries needed |
| Node.js built-ins | n/a | `Math.exp()` for exponential decay | No imports needed |

### Supporting (Already Present)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | ^3.2.1 | Testing ranking and budget logic | Unit tests for scoring correctness |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom decay formula | Import `calculateRecencyScore` from `graph/temporal.ts` | The existing `calculateRecencyScore` uses a 7-day half-life with `exp(-0.693 * ageDays / 7)`. This is exactly appropriate for tool recency. However, importing from `graph/temporal.ts` creates a dependency between context injection and the graph module. The formula is a single line -- duplicating it avoids the cross-module coupling. Either approach is valid. Recommendation: use the same formula inline (one line) with a comment referencing the graph module's constant, or import the function directly if the team prefers DRY. |
| SQL-level scoring (compute relevance in the query) | Application-level scoring (compute in TypeScript) | SQL scoring would require a new prepared statement with complex arithmetic. Application-level scoring is simpler: fetch recent usage stats + registry rows, merge in JS, sort. The tool_registry has at most tens of entries per session scope, so the in-memory sort is negligible. |
| Token-based sub-budget (500 tokens) | Character-based sub-budget (500 characters) | The requirement says "500-character sub-budget." The existing `MAX_CONTEXT_CHARS = 6000` is character-based. Use characters for consistency. |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure (Modifications Only)

```
src/
  context/
    injection.ts            # MODIFIED: add rankToolsByRelevance, enforce 500-char sub-budget
  context/
    injection.test.ts       # MODIFIED: add tests for ranking and budget enforcement
```

### Pattern 1: Relevance Score Computation

**What:** A function that computes a relevance score for each tool by combining recent usage frequency with recency weighting.
**When to use:** Called from `assembleSessionContext` before `formatToolSection`.

The relevance score formula:

```
score = normalizedFrequency * 0.7 + recencyScore * 0.3
```

Where:
- `normalizedFrequency = recentUsageCount / maxRecentUsageCount` (0 to 1, relative to the most-used tool)
- `recencyScore = exp(-0.693 * ageDays / 7)` (0 to 1, using the same 7-day half-life as `graph/temporal.ts`)
- `ageDays` is computed from `last_used` in the `ToolUsageStats` returned by `getUsageSince`

Frequency is weighted higher (0.7) because a tool used 50 times in the last week is clearly more relevant than one used once yesterday. Recency breaks ties and boosts tools used in the most recent session.

Tools with NO recent usage events (not in `getUsageSince` results) get score 0 and are sorted to the bottom, falling back to the existing `usage_count DESC` ordering from the registry row.

```typescript
interface RankedTool {
  row: ToolRegistryRow;
  relevanceScore: number;
}

function rankToolsByRelevance(
  tools: ToolRegistryRow[],
  usageStats: ToolUsageStats[],
): RankedTool[] {
  // Build lookup: tool_name -> { usage_count, last_used }
  const statsMap = new Map<string, ToolUsageStats>();
  for (const stat of usageStats) {
    statsMap.set(stat.tool_name, stat);
  }

  // Find max recent usage for normalization
  const maxUsage = Math.max(1, ...usageStats.map(s => s.usage_count));

  const ranked = tools.map(row => {
    const stat = statsMap.get(row.name);
    if (!stat) {
      // No recent usage: score is 0 (will sort after all recently-used tools)
      return { row, relevanceScore: 0 };
    }

    const normalizedFrequency = stat.usage_count / maxUsage;
    const ageDays = (Date.now() - new Date(stat.last_used).getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-0.693 * Math.max(0, ageDays) / 7);

    return {
      row,
      relevanceScore: normalizedFrequency * 0.7 + recencyScore * 0.3,
    };
  });

  // Sort by relevance descending; ties broken by lifetime usage_count
  ranked.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    return b.row.usage_count - a.row.usage_count;
  });

  return ranked;
}
```

**Source:** Scoring approach modeled on the existing `calculateRecencyScore` in `/data/Laminark/src/graph/temporal.ts` (lines 141-164) which uses the same exponential decay with a 7-day half-life. Confidence: HIGH (formula is a standard information retrieval pattern).

### Pattern 2: 500-Character Sub-Budget Enforcement

**What:** Enforcing a hard 500-character limit on the tool section output, trimming entries from the bottom until the section fits.
**When to use:** Inside `formatToolSection` after building lines.

```typescript
const TOOL_SECTION_BUDGET = 500;

function formatToolSection(tools: ToolRegistryRow[]): string {
  // ... existing dedup and builtin filtering ...

  const lines: string[] = ['## Available Tools'];

  for (const tool of limited) {
    // ... format each tool line ...
    lines.push(formatted);

    // Check budget after each addition
    const current = lines.join('\n');
    if (current.length > TOOL_SECTION_BUDGET) {
      lines.pop(); // Remove the line that caused overflow
      break;
    }
  }

  // Add overflow indicator if tools were dropped
  if (displayable.length > lines.length - 1) {
    const overflow = `(${displayable.length - (lines.length - 1)} more available)`;
    // Only add if it fits
    if ((lines.join('\n') + '\n' + overflow).length <= TOOL_SECTION_BUDGET) {
      lines.push(overflow);
    }
  }

  return lines.join('\n');
}
```

**Key constraint from requirement CTXT-02:** The sub-budget is 500 characters for the tool section itself. The overall 6000-char limit (`MAX_CONTEXT_CHARS`) is already enforced. The sub-budget prevents the tool section from using too much of the overall budget even when the total context is under 6000 chars.

### Pattern 3: Wiring Ranking into assembleSessionContext

**What:** The `assembleSessionContext` function already queries `toolRegistry.getAvailableForSession(projectHash)`. Phase 13 adds a second query (`getUsageSince`) and passes both to the ranking function before formatting.

```typescript
// In assembleSessionContext, modify the existing toolSection block:

let toolSection = '';
if (toolRegistry) {
  try {
    const availableTools = toolRegistry.getAvailableForSession(projectHash);
    const usageStats = toolRegistry.getUsageSince(projectHash, '-7 days');
    const ranked = rankToolsByRelevance(availableTools, usageStats);
    toolSection = formatToolSection(ranked.map(r => r.row));
  } catch {
    // Tool registry is supplementary -- never block context assembly
  }
}
```

This adds exactly ONE additional query (`getUsageSince`) which is already a prepared statement in `ToolRegistryRepository` (Phase 12). The query runs on `tool_usage_events` which has a `(project_hash, created_at DESC)` index. Performance impact is negligible.

### Anti-Patterns to Avoid

- **Sorting in SQL with a complex score expression:** The `getAvailableForSession` query's ORDER BY is already defined in a prepared statement. Do not modify it to include a relevance score calculation (it would require a JOIN or subquery to `tool_usage_events`). Fetch both result sets and merge in TypeScript -- simpler, testable, and the data volumes are tiny (tens of rows).

- **Using the lifetime `usage_count` from `tool_registry` instead of temporal stats from `tool_usage_events`:** The `usage_count` on `tool_registry` is a lifetime aggregate. A tool used 500 times 6 months ago but never recently should not rank above a tool used 10 times this week. The temporal `getUsageSince` stats are the correct data source.

- **Exporting `rankToolsByRelevance`:** Per decision [11-01], formatting/ranking functions in injection.ts are module-internal. Export only `assembleSessionContext` and `formatContextIndex`. Keep `rankToolsByRelevance` and `formatToolSection` as implementation details.

- **Breaking the 500-char sub-budget THEN checking:** Build the section incrementally and check after each line. Do not build the full section and then truncate it (string slicing would produce invalid output like cutting mid-line).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Relevance scoring formula | Complex ML-based scoring | Simple frequency * 0.7 + recency * 0.3 | The tool list is small (<50 entries). A weighted linear combination is sufficient and interpretable. No training data, no model overhead. |
| Temporal usage queries | New query methods or raw SQL | Existing `getUsageSince(projectHash, '-7 days')` | Phase 12 already built and tested these. Use them directly. |
| Character budget enforcement | Token estimation with `estimateTokens()` from token-budget.ts | Simple `string.length` check against 500 | The requirement specifies characters, not tokens. The existing `MAX_CONTEXT_CHARS` also uses character length. Stay consistent. |
| Exponential decay | Custom decay curve or lookup table | `Math.exp(-0.693 * ageDays / 7)` one-liner | Standard exponential decay formula. Same as `graph/temporal.ts` uses. One line of code. |

**Key insight:** Phase 13 is a thin integration layer. All the data infrastructure (temporal events, scope-filtered queries, context budget trimming) already exists from Phases 10-12. The new code is a scoring function (~30 lines) and a budget cap (~5 lines changed).

## Common Pitfalls

### Pitfall 1: Division by Zero in Normalization

**What goes wrong:** If `usageStats` is empty (no recent tool usage events at all), `maxUsage` computed as `Math.max(...usageStats.map(s => s.usage_count))` throws or returns `-Infinity`.
**Why it happens:** `Math.max()` with no arguments returns `-Infinity`. Spreading an empty array gives no arguments.
**How to avoid:** Default: `const maxUsage = Math.max(1, ...usageStats.map(s => s.usage_count))`. The `1` floor ensures no division by zero and handles the empty case.
**Warning signs:** `NaN` or `Infinity` in relevance scores. Test with zero usage stats.

### Pitfall 2: Stale `last_used` Timestamps Producing Negative Age

**What goes wrong:** If `last_used` is in the future (clock skew or test mocking), `ageDays` becomes negative, and `Math.exp` produces a score > 1.0.
**Why it happens:** System clock differences between the SQLite datetime('now') used in `getUsageSince` and JavaScript's `Date.now()`.
**How to avoid:** Clamp: `Math.max(0, ageDays)`. The existing `calculateRecencyScore` in `graph/temporal.ts` already does this (returns 1.0 for `ageDays <= 0`).
**Warning signs:** Relevance scores greater than 1.0 in tests.

### Pitfall 3: Tool Section Exceeding Sub-Budget Due to Header

**What goes wrong:** The `"## Available Tools"` header line itself consumes ~20 characters. If the budget check only counts tool entry lines, the header pushes the total over 500 characters.
**Why it happens:** The header is added first, then tools are appended. If the check does not include the header in the running total, the section exceeds the 500-char cap.
**How to avoid:** Include the header line in the running character count from the start. Initialize `lines = ['## Available Tools']` and check `lines.join('\n').length` after each addition.
**Warning signs:** Tool section output being 520+ characters despite the 500-char cap. Test with a header and many tools.

### Pitfall 4: Dedup Happens BEFORE Ranking, Producing Inaccurate Scores

**What goes wrong:** The current `formatToolSection` deduplicates MCP servers vs individual MCP tools (preferring server entries). If ranking runs on the raw `getAvailableForSession` list (before dedup), the scores are correct. But if dedup runs first, the individual MCP tool rows (which have their own usage events) are discarded, and the server row (which may have fewer direct usage events) gets a lower score.
**Why it happens:** Config scanning creates `mcp_server` entries (e.g., `mcp__context7__*`). Organic discovery creates `mcp_tool` entries (e.g., `mcp__context7__query_docs`). Usage events are recorded against the individual tool name (from PostToolUse), not the server wildcard name. So `getUsageSince` returns stats for `mcp__context7__query_docs`, not for `mcp__context7__*`.
**How to avoid:** Two approaches: (a) Aggregate usage stats across all tools sharing the same `server_name` before scoring server entries, or (b) run ranking AFTER dedup and match usage stats by `server_name` prefix (any tool starting with the server's name prefix counts toward the server's score). Approach (a) is cleaner: build a server-level usage aggregation from the `usageStats` array before computing scores.
**Warning signs:** MCP servers always scoring 0 despite their individual tools being heavily used. Test with MCP server + tool usage events.

### Pitfall 5: Regression in Budget Trimming Priority

**What goes wrong:** The existing `assembleSessionContext` drops the tool section first when the total context exceeds 6000 chars (per decision [11-01]). Phase 13 must not break this priority.
**Why it happens:** If the Phase 13 changes restructure how `toolSection` is assembled or appended, the existing trimming logic (lines 357-368 in injection.ts) may not function correctly.
**How to avoid:** Keep the exact same structure: `toolSection` is a string, appended after `formatContextIndex`, dropped first on budget overflow. Only the internals of how `toolSection` is produced change (ranking + sub-budget). The trimming logic does not need to change.
**Warning signs:** Tool section surviving while observations are trimmed. Verify the existing trimming test still passes.

## Code Examples

### Complete Relevance Ranking (Ready for Implementation)

```typescript
// In src/context/injection.ts (module-internal, not exported)

import type { ToolUsageStats } from '../shared/tool-types.js';

/**
 * Maximum character budget for the "## Available Tools" section.
 * Prevents tool listings from consuming too much of the 6000-char overall budget.
 */
const TOOL_SECTION_BUDGET = 500;

/**
 * Ranks tools by relevance using a weighted combination of recent usage
 * frequency and recency. Tools with no recent usage score 0.
 *
 * Formula: score = (recentCount / maxRecentCount) * 0.7 + recency * 0.3
 * where recency = exp(-0.693 * ageDays / 7)
 */
function rankToolsByRelevance(
  tools: ToolRegistryRow[],
  usageStats: ToolUsageStats[],
): ToolRegistryRow[] {
  if (usageStats.length === 0) return tools; // No temporal data: keep existing order

  // Aggregate usage stats by server_name for MCP server entries
  const statsMap = new Map<string, { usage_count: number; last_used: string }>();
  for (const stat of usageStats) {
    statsMap.set(stat.tool_name, stat);
  }

  // Also aggregate by server prefix for MCP server rows
  const serverStats = new Map<string, { usage_count: number; last_used: string }>();
  for (const stat of usageStats) {
    // Match mcp__<server>__<tool> to server name <server>
    const match = stat.tool_name.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
    if (match) {
      const serverName = match[1];
      const existing = serverStats.get(serverName);
      if (existing) {
        existing.usage_count += stat.usage_count;
        if (stat.last_used > existing.last_used) {
          existing.last_used = stat.last_used;
        }
      } else {
        serverStats.set(serverName, {
          usage_count: stat.usage_count,
          last_used: stat.last_used,
        });
      }
    }
  }

  // Find max recent usage for normalization
  const allCounts = [...statsMap.values(), ...serverStats.values()].map(s => s.usage_count);
  const maxUsage = Math.max(1, ...allCounts);
  const now = Date.now();

  const scored = tools.map(row => {
    // For MCP server rows, use aggregated server stats
    let stat = statsMap.get(row.name);
    if (!stat && row.tool_type === 'mcp_server' && row.server_name) {
      stat = serverStats.get(row.server_name) ?? undefined;
    }

    if (!stat) {
      return { row, score: 0 };
    }

    const normalizedFrequency = stat.usage_count / maxUsage;
    const ageDays = Math.max(0, (now - new Date(stat.last_used).getTime()) / (1000 * 60 * 60 * 24));
    const recencyScore = Math.exp(-0.693 * ageDays / 7);

    return {
      row,
      score: normalizedFrequency * 0.7 + recencyScore * 0.3,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.row.usage_count - a.row.usage_count;
  });

  return scored.map(s => s.row);
}
```

### Modified formatToolSection with Sub-Budget

```typescript
function formatToolSection(tools: ToolRegistryRow[]): string {
  if (tools.length === 0) return '';

  // Existing dedup logic (unchanged)...
  const seenServers = new Set<string>();
  const deduped: ToolRegistryRow[] = [];
  for (const tool of tools) {
    if (tool.tool_type === 'mcp_server') {
      seenServers.add(tool.server_name ?? tool.name);
      deduped.push(tool);
    }
  }
  for (const tool of tools) {
    if (tool.tool_type !== 'mcp_server') {
      if (tool.tool_type === 'mcp_tool' && tool.server_name && seenServers.has(tool.server_name)) {
        continue;
      }
      deduped.push(tool);
    }
  }
  const displayable = deduped.filter(t => t.tool_type !== 'builtin');
  if (displayable.length === 0) return '';

  const lines: string[] = ['## Available Tools'];

  for (const tool of displayable) {
    // ... format line as before ...
    const candidateLine = formatToolLine(tool);  // extract line formatting to helper
    const candidate = [...lines, candidateLine].join('\n');

    if (candidate.length > TOOL_SECTION_BUDGET) {
      // Adding this line would exceed budget -- stop
      break;
    }
    lines.push(candidateLine);
  }

  // Overflow indicator
  const added = lines.length - 1; // subtract header
  if (displayable.length > added && added > 0) {
    const overflow = `(${displayable.length - added} more available)`;
    if ((lines.join('\n') + '\n' + overflow).length <= TOOL_SECTION_BUDGET) {
      lines.push(overflow);
    }
  }

  return lines.join('\n');
}
```

### Modified assembleSessionContext Integration Point

```typescript
// In assembleSessionContext, replace lines 339-347:

let toolSection = '';
if (toolRegistry) {
  try {
    const availableTools = toolRegistry.getAvailableForSession(projectHash);
    const usageStats = toolRegistry.getUsageSince(projectHash, '-7 days');
    const ranked = rankToolsByRelevance(availableTools, usageStats);
    toolSection = formatToolSection(ranked);
  } catch {
    // Tool registry is supplementary -- never block context assembly
  }
}
```

## Existing Code Inventory (What Already Works)

This section catalogs what Phase 13 can reuse without modification.

### Already Implemented (Phase 11)

| Component | Location | Status |
|-----------|----------|--------|
| `formatToolSection()` | `src/context/injection.ts:257-312` | Exists. Needs modification for sub-budget and ranked input. |
| `assembleSessionContext()` with toolRegistry param | `src/context/injection.ts:323-403` | Exists. Needs minor modification to add `getUsageSince` call. |
| `MAX_TOOLS_IN_CONTEXT = 10` | `src/context/injection.ts:25` | Exists. May be superseded by 500-char sub-budget as the effective limit. |
| MCP server deduplication | `src/context/injection.ts:260-279` | Exists. No changes needed. |
| Built-in tool exclusion | `src/context/injection.ts:282` | Exists. No changes needed. |
| Budget trimming (tool section dropped first) | `src/context/injection.ts:357-368` | Exists. No changes needed. |
| `getAvailableForSession()` | `src/storage/tool-registry.ts:206-208` | Exists. No changes needed. |

### Already Implemented (Phase 12)

| Component | Location | Status |
|-----------|----------|--------|
| `getUsageSince(projectHash, timeModifier)` | `src/storage/tool-registry.ts:252-255` | Exists. Returns `ToolUsageStats[]`. Ready to use. |
| `getUsageForTool()` | `src/storage/tool-registry.ts:237-240` | Exists. Not needed for Phase 13 but available. |
| `tool_usage_events` table | Migration 17 | Exists. Has indexes on `(project_hash, created_at DESC)`. |
| `ToolUsageStats` type | `src/shared/tool-types.ts:58-62` | Exists. `{ tool_name, usage_count, last_used }`. |

### Test Infrastructure

| Component | Location | Status |
|-----------|----------|--------|
| `injection.test.ts` | `src/context/injection.test.ts` | Exists. Tests `formatContextIndex`, `assembleSessionContext`, etc. **Note: 8 pre-existing test failures from Phase 11** due to `formatContextIndex` signature change (from flat `Observation[]` to sections object). These are NOT blockers for Phase 13 but may need to be fixed as part of this work. |
| Database test setup pattern | `injection.test.ts:200-210` | Exists. `openDatabase` + `mkdtempSync` for isolated test DB. |
| No dedicated tool section tests | -- | Gap. Phase 13 should add tests for `formatToolSection` via `assembleSessionContext` integration tests or by temporarily exporting the function for testing. |

## State of the Art

| Old Approach (Phase 11) | New Approach (Phase 13) | Impact |
|--------------------------|-------------------------|--------|
| Tools ordered by type priority then lifetime usage_count | Tools ranked by relevance (recent frequency + recency) | Most-used recent tools appear first, not lifetime most-used |
| No sub-budget for tool section (limited only by MAX_TOOLS_IN_CONTEXT = 10) | 500-character hard sub-budget | Tool section stays compact even with many tools |
| `getAvailableForSession` is the only query | `getAvailableForSession` + `getUsageSince` | Two queries per session start (both fast, both indexed) |

## Open Questions

1. **Should MAX_TOOLS_IN_CONTEXT be removed or kept alongside the 500-char sub-budget?**
   - What we know: The current `MAX_TOOLS_IN_CONTEXT = 10` limits entries to 10. The new 500-char sub-budget will typically limit to fewer than 10 entries anyway (each line is ~40-60 chars, so 500 chars holds ~8-10 lines including the header).
   - What's unclear: Whether to keep both limits or let the sub-budget be the sole limiter.
   - Recommendation: Keep `MAX_TOOLS_IN_CONTEXT` as a safety ceiling but let the 500-char budget be the primary limiter. The constant is cheap insurance against pathological cases (tools with very short names that fit many into 500 chars). No functional harm in keeping it.

2. **What time window for `getUsageSince`?**
   - What we know: The success criterion says "usage frequency and recency." The `getUsageSince` method accepts a SQLite datetime modifier like `'-7 days'`.
   - What's unclear: Whether 7 days is the right window, or if 14 or 30 days would be better.
   - Recommendation: Use `'-7 days'`. It matches the 7-day half-life of the recency decay formula. Tools unused in the past 7 days still appear (from the registry) but with score 0, sorted to the bottom. A longer window would dilute recency signal.

3. **Should the relevance score be persisted or is it compute-only?**
   - What we know: The score is computed at session start from temporal data. It changes every session.
   - What's unclear: Whether future phases need access to the computed scores.
   - Recommendation: Compute-only. Do not persist. Phase 14 (conversation routing) can recompute if needed. Persisting adds schema complexity for a value that is cheap to compute and changes every session.

4. **How to handle the pre-existing injection.test.ts failures?**
   - What we know: Phase 11 changed `formatContextIndex` from `(session, observations[])` to `(session, sections)`. The test file still uses the old signature in some tests (lines 118, 131, 138).
   - What's unclear: Whether to fix these tests as part of Phase 13 or leave them.
   - Recommendation: Fix the broken tests as a prerequisite task in Phase 13. They test `formatContextIndex`, which is unmodified by Phase 13, but having a clean test suite is necessary to verify no regressions.

## Sources

### Primary (HIGH confidence)
- `/data/Laminark/src/context/injection.ts` - Current `formatToolSection` implementation, `assembleSessionContext` with tool registry integration, budget trimming logic, `MAX_CONTEXT_CHARS = 6000`, `MAX_TOOLS_IN_CONTEXT = 10`
- `/data/Laminark/src/storage/tool-registry.ts` - `getAvailableForSession`, `getUsageSince`, `ToolRegistryRepository` with all prepared statements
- `/data/Laminark/src/shared/tool-types.ts` - `ToolRegistryRow`, `ToolUsageStats` (usage_count, last_used fields)
- `/data/Laminark/src/hooks/session-lifecycle.ts` - `handleSessionStart` wiring of toolRegistry into assembleSessionContext
- `/data/Laminark/src/graph/temporal.ts` - `calculateRecencyScore` with exponential decay formula (7-day half-life, `DECAY_CONSTANT = 0.693 / 7`)
- `/data/Laminark/src/storage/migrations.ts` - Migration 16 (tool_registry schema), Migration 17 (tool_usage_events with indexes)
- `/data/Laminark/.planning/phases/11-scope-resolution/11-01-SUMMARY.md` - Phase 11 decisions on formatToolSection, budget trimming priority, module-internal functions
- `/data/Laminark/.planning/phases/12-usage-tracking/12-01-PLAN.md` - Phase 12 temporal query methods design
- `/data/Laminark/.planning/REQUIREMENTS.md` - CTXT-01, CTXT-02, CTXT-03 requirement definitions

### Secondary (MEDIUM confidence)
- `/data/Laminark/src/mcp/token-budget.ts` - `estimateTokens` and `enforceTokenBudget` utilities (not directly used but pattern reference for budget enforcement)
- `/data/Laminark/src/context/injection.test.ts` - Existing test patterns for context assembly (NOTE: 8 tests have pre-existing failures from signature change)

### Tertiary (LOW confidence)
- None. All findings verified from primary sources (codebase analysis).

## Metadata

**Confidence breakdown:**
- Relevance scoring approach: HIGH - Standard frequency + recency formula with well-understood exponential decay; same formula used in graph/temporal.ts
- Integration points: HIGH - All building blocks exist and are verified from source code; changes are confined to injection.ts
- Budget enforcement: HIGH - Character-based cap is straightforward; consistent with existing MAX_CONTEXT_CHARS pattern
- MCP server usage aggregation (Pitfall 4): MEDIUM - The server_name prefix matching regex needs testing with real MCP tool names to ensure correct extraction
- Test strategy: MEDIUM - Pre-existing test failures in injection.test.ts need to be addressed before Phase 13 tests can reliably pass

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (implementation patterns are stable; no external dependencies to change)
