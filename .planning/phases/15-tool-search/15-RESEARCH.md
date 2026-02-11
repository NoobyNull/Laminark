# Phase 15: Tool Search - Research

**Researched:** 2026-02-10
**Domain:** MCP tool registration, FTS5 text search, sqlite-vec vector search, tool registry querying
**Confidence:** HIGH

## Summary

Phase 15 exposes the tool registry (built in Phase 10, enriched with usage data in Phase 12) as an explicitly searchable MCP tool called `discover_tools`. The existing codebase already has all the infrastructure needed: the `tool_registry` table with `name`, `description`, `scope`, `usage_count`, and `last_used_at` columns; the `ToolRegistryRepository` with cross-scope querying; and the MCP tool registration pattern used by `recall`, `query_graph`, `save_memory`, `status`, and `graph_stats`. The work is primarily integration -- building a new search layer for the tool registry that mirrors the existing hybrid search (FTS5 + vector) from the observations subsystem.

The key design challenge is SRCH-02: indexing tool descriptions for semantic search. The tool_registry has at most hundreds of entries (not thousands), so full FTS5 external content tables with sync triggers (as used for observations) are heavyweight for this scale. However, the requirement explicitly says to use "the existing hybrid search infrastructure," which means FTS5 + vec0 + reciprocal rank fusion. The approach is to create a dedicated `tool_registry_fts` FTS5 table for keyword matching on name + description, a `tool_registry_embeddings` vec0 table for semantic matching, and reuse the existing `reciprocalRankFusion` function and `AnalysisWorker.embed()` for query-time embedding. Tool description embeddings are computed lazily in the MCP server's background loop (the same 5-second interval that processes observation embeddings).

The MCP tool itself follows the exact pattern of `registerRecall` and `registerQueryGraph`: it takes a keyword query and optional scope filter, runs hybrid search against the tool registry's FTS5 + vector tables, and returns formatted results with scope, usage count, and last-used timestamp. Registration happens in `index.ts` alongside the existing tools.

**Primary recommendation:** Add migration 18 for `tool_registry_fts` and `tool_registry_embeddings` tables, create `src/mcp/tools/discover-tools.ts` following the existing MCP tool pattern, add a background embedding loop for tool descriptions in `index.ts`, and wire registration in the MCP server startup.

## Standard Stack

### Core (No New Dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | (in project) | FTS5 + vec0 tables for tool search | Already used for all Laminark storage |
| `@modelcontextprotocol/sdk` | (in project) | MCP tool registration for `discover_tools` | Already used by all MCP tools |
| `zod` | (in project) | Input schema validation for tool parameters | Already used by all MCP tools |
| `sqlite-vec` | (in project) | vec0 virtual table for semantic tool search | Already used by observation_embeddings |

### Supporting (Already Present)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `src/search/hybrid.ts` | N/A | `reciprocalRankFusion` function | Reuse for merging FTS5 + vector results |
| `src/analysis/worker-bridge.ts` | N/A | `AnalysisWorker.embed()` | Query-time embedding for semantic search |
| `src/mcp/token-budget.ts` | N/A | `enforceTokenBudget` | Cap result output to token budget |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| FTS5 for tool descriptions | Plain SQL LIKE queries | LIKE is simpler and sufficient for hundreds of rows, but requirement SRCH-02 explicitly mandates "existing hybrid search infrastructure (FTS5 + vector)." Use FTS5 to satisfy the requirement and provide consistent search quality. |
| Dedicated vec0 table for tools | Reuse observation_embeddings table | Tool descriptions are conceptually different from observations. A separate vec0 table avoids polluting observation search results with tool metadata. Clean separation. |
| Background embedding of all tools | On-demand embedding at query time | Background is better: query latency stays low (~5ms for FTS5 + vec0 lookup), embedding happens asynchronously. The 5-second background loop already exists for observations -- extend it for tools. |
| New hybrid search function | Reuse `hybridSearch()` from `src/search/hybrid.ts` | The existing `hybridSearch` is tightly coupled to the observations table (uses `ObservationRepository`, `SearchEngine`, `EmbeddingStore`). Creating a simpler tool-specific function that directly uses `reciprocalRankFusion` (exported from hybrid.ts) avoids forcing the observations-specific code path. |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure (Additions Only)

```
src/
  mcp/
    tools/
      discover-tools.ts     # NEW: MCP tool registration for discover_tools
  storage/
    tool-registry.ts         # MODIFIED: add search methods (FTS5, vector, hybrid)
    migrations.ts            # MODIFIED: add migration 18 (tool_registry_fts + tool_registry_embeddings)
  shared/
    tool-types.ts            # MODIFIED: add ToolSearchResult type
  index.ts                   # MODIFIED: register discover_tools, add tool embedding loop
```

### Pattern 1: MCP Tool Registration (following existing pattern)

**What:** A `registerDiscoverTools` function that registers the `discover_tools` tool on the MCP server.
**When to use:** Called from `index.ts` alongside the other `register*` calls.

```typescript
// src/mcp/tools/discover-tools.ts
// Source: follows pattern from src/mcp/tools/recall.ts and src/mcp/tools/query-graph.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';

import { debug } from '../../shared/debug.js';
import type { NotificationStore } from '../../storage/notifications.js';
import type { ToolRegistryRepository } from '../../storage/tool-registry.js';
import type { AnalysisWorker } from '../../analysis/worker-bridge.js';
import { reciprocalRankFusion } from '../../search/hybrid.js';
import { enforceTokenBudget, TOKEN_BUDGET } from '../token-budget.js';

export function registerDiscoverTools(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHash: string,
  toolRegistry: ToolRegistryRepository,
  worker: AnalysisWorker | null = null,
  hasVectorSupport: boolean = false,
  notificationStore: NotificationStore | null = null,
): void {
  server.registerTool(
    'discover_tools',
    {
      title: 'Discover Tools',
      description:
        'Search the tool registry to find available tools by keyword or description. ' +
        'Supports semantic search -- "file manipulation" finds tools described as "read and write files". ' +
        'Returns scope, usage count, and last used timestamp for each result.',
      inputSchema: {
        query: z.string().min(1).describe('Search query: keywords or natural language description'),
        scope: z.enum(['global', 'project', 'plugin'])
          .optional()
          .describe('Optional scope filter: global, project, or plugin'),
        limit: z.number().int().min(1).max(50).default(20)
          .describe('Maximum results to return (default: 20)'),
      },
    },
    async (args) => {
      // ... implementation
    },
  );
}
```

**Key design decisions:**
- The function signature matches the existing MCP tool pattern: `(server, db, projectHash, ...dependencies)`
- `query` is the primary search parameter (SRCH-01)
- `scope` is optional filter (SRCH-01: "optionally filter by scope")
- Uses Zod schemas for input validation (project convention)

### Pattern 2: Tool Registry FTS5 Table (Migration 18)

**What:** An FTS5 external content table for `tool_registry` with name + description indexing, plus a vec0 table for semantic search on tool descriptions.
**When to use:** Applied automatically via the migration system.

```sql
-- Migration 18: tool_registry_fts + tool_registry_embeddings

-- FTS5 external content table indexed on name and description
CREATE VIRTUAL TABLE tool_registry_fts USING fts5(
  name,
  description,
  content='tool_registry',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Sync triggers to keep FTS5 in sync with tool_registry
CREATE TRIGGER tool_registry_ai AFTER INSERT ON tool_registry BEGIN
  INSERT INTO tool_registry_fts(rowid, name, description)
    VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER tool_registry_au AFTER UPDATE ON tool_registry BEGIN
  INSERT INTO tool_registry_fts(tool_registry_fts, rowid, name, description)
    VALUES('delete', old.id, old.name, old.description);
  INSERT INTO tool_registry_fts(rowid, name, description)
    VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER tool_registry_ad AFTER DELETE ON tool_registry BEGIN
  INSERT INTO tool_registry_fts(tool_registry_fts, rowid, name, description)
    VALUES('delete', old.id, old.name, old.description);
END;

-- Rebuild FTS5 from existing tool_registry rows
INSERT INTO tool_registry_fts(tool_registry_fts) VALUES('rebuild');

-- vec0 table for semantic search on tool descriptions (conditional on sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS tool_registry_embeddings USING vec0(
  tool_id INTEGER PRIMARY KEY,
  embedding float[384] distance_metric=cosine
);
```

**Key design decisions:**
- Uses `content='tool_registry'` and `content_rowid='id'` for external content (matches the observations_fts pattern exactly)
- The `tool_registry` table uses `id INTEGER PRIMARY KEY AUTOINCREMENT`, so `content_rowid='id'` works directly
- Indexes both `name` and `description` -- the name carries signal for keyword searches (e.g., "playwright" matches `mcp__playwright__*`)
- Porter stemming + unicode61 tokenizer matches the observations FTS5 configuration
- The vec0 table uses `tool_id INTEGER PRIMARY KEY` mapping to `tool_registry.id`
- Dimension is 384 (matching the existing ONNX model used by `AnalysisWorker`)
- The vec0 migration is conditional on sqlite-vec support (same pattern as migration 6)

### Pattern 3: Hybrid Search for Tool Registry

**What:** A search function that combines FTS5 keyword results and vec0 vector results using the existing `reciprocalRankFusion` function.
**When to use:** Called by the `discover_tools` MCP tool handler.

```typescript
// In src/storage/tool-registry.ts or src/mcp/tools/discover-tools.ts

// Step 1: FTS5 keyword search
const ftsResults = db.prepare(`
  SELECT tr.*, bm25(tool_registry_fts, 2.0, 1.0) AS rank
  FROM tool_registry_fts
  JOIN tool_registry tr ON tr.id = tool_registry_fts.rowid
  WHERE tool_registry_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`).all(sanitizedQuery, limit) as (ToolRegistryRow & { rank: number })[];

// Step 2: Vector search (if worker ready + embedding available)
let vectorResults: Array<{ tool_id: number; distance: number }> = [];
if (worker?.isReady() && hasVectorSupport) {
  const queryEmbedding = await worker.embed(query);
  if (queryEmbedding) {
    vectorResults = db.prepare(`
      SELECT tool_id, distance
      FROM tool_registry_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(queryEmbedding, limit * 2) as Array<{ tool_id: number; distance: number }>;
  }
}

// Step 3: Fuse with RRF
const ftsRanked = ftsResults.map(r => ({ id: String(r.id) }));
const vecRanked = vectorResults.map(r => ({ id: String(r.tool_id) }));
const fused = reciprocalRankFusion([ftsRanked, vecRanked]);
```

**Key design decisions:**
- The `reciprocalRankFusion` function from `src/search/hybrid.ts` is already exported and takes `Array<Array<{ id: string }>>` -- we can use it directly
- BM25 weights of (2.0, 1.0) give higher weight to name matches vs description matches (same weighting as observations_fts title vs content)
- Vector search fetches `limit * 2` results to improve fusion quality (same pattern as `hybridSearch`)
- Falls back to FTS5-only when worker is not ready or vec0 is unavailable (same degradation pattern as observations)

### Pattern 4: Background Tool Description Embedding

**What:** Extend the existing 5-second background embedding loop in `index.ts` to also embed tool descriptions.
**When to use:** Runs alongside the existing `processUnembedded()` function.

```typescript
// In index.ts, add after processUnembedded():

async function processUnembeddedTools(): Promise<void> {
  if (!embeddingStore || !worker.isReady()) return;
  // Only run if vec0 table exists
  if (!db.hasVectorSupport) return;

  try {
    // Find tool_registry rows with descriptions that have no embedding
    const unembedded = laminarkDb.db.prepare(`
      SELECT id, name, description FROM tool_registry
      WHERE description IS NOT NULL
        AND id NOT IN (SELECT tool_id FROM tool_registry_embeddings)
      LIMIT 5
    `).all() as Array<{ id: number; name: string; description: string }>;

    for (const tool of unembedded) {
      const text = `${tool.name} ${tool.description}`;
      const embedding = await worker.embed(text);
      if (embedding) {
        laminarkDb.db.prepare(
          'INSERT OR REPLACE INTO tool_registry_embeddings(tool_id, embedding) VALUES (?, ?)'
        ).run(tool.id, embedding);
      }
    }
  } catch {
    // Non-fatal
  }
}

// Add to the existing setInterval:
const embedTimer = setInterval(() => {
  processUnembedded().catch(...);
  processUnembeddedTools().catch((err) => {
    debug('embed', 'Tool embedding error', { error: String(err) });
  });
}, 5000);
```

**Key design decisions:**
- Runs in the same 5-second interval as observation embedding (no new timers)
- Processes 5 tools per cycle (fast -- tool descriptions are short)
- Embeds `name + description` concatenated (the name carries important keywords like "playwright", "laminark")
- Uses INSERT OR REPLACE so re-embedding after description update is safe
- Tools without descriptions (`description IS NULL`) are skipped -- nothing to embed

### Pattern 5: Result Formatting

**What:** Format search results as readable text with scope, usage, and timing metadata.
**When to use:** Inside the `discover_tools` handler to format the response.

```typescript
function formatToolResult(tool: ToolRegistryRow, index: number, score: number): string {
  const scopeTag = `[${tool.scope}]`;
  const usageStr = tool.usage_count > 0
    ? `${tool.usage_count} uses`
    : 'never used';
  const lastUsedStr = tool.last_used_at
    ? `last: ${tool.last_used_at.slice(0, 10)}`
    : '';
  const desc = tool.description
    ? ` -- ${tool.description}`
    : '';
  const meta = [scopeTag, usageStr, lastUsedStr].filter(Boolean).join(' | ');

  return `${index}. ${tool.name}${desc}\n   ${meta} | score: ${score.toFixed(2)}`;
}
```

**Key design decisions:**
- Each result shows: name, description, scope, usage count, last used date, match score (SRCH-03)
- Format is compact (2 lines per result) to fit within token budget
- Score is included for transparency (matches how `recall` shows relevance scores)

### Anti-Patterns to Avoid

- **Querying observations_fts for tool search:** The observations FTS5 table indexes observation content, not tool descriptions. These are separate data domains. Create dedicated tool_registry_fts.
- **Creating a separate ToolSearchEngine class:** The SearchEngine class in `storage/search.ts` is tightly coupled to observations (uses `ObservationRow`, `observations_fts`). Do not subclass or extend it. Build tool search directly in the MCP tool handler or in ToolRegistryRepository methods.
- **Embedding tool descriptions in the hook handler:** The hook handler (`handler.ts`) is a short-lived CLI process. It has no access to the embedding worker (which runs in the MCP server process). Tool embeddings must happen in the MCP server's background loop.
- **Applying scope filter AFTER hybrid search:** Apply scope filter at the FTS5 query level (JOIN with WHERE clause) so you do not waste FTS5/vector capacity on out-of-scope results. The scope filter should be part of the SQL, not a post-filter.
- **Forgetting to handle tools with NULL descriptions in FTS5:** Many tools discovered organically (via PostToolUse) have `description = NULL`. The FTS5 trigger must handle NULL gracefully. FTS5 treats NULL as empty string in content columns, so inserts work fine, but searches on description alone will not match these tools. The name column ensures they are still findable by name keyword.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Text search ranking | Custom scoring algorithm | FTS5 BM25 via `bm25()` function | BM25 handles term frequency, inverse doc frequency, field weighting correctly |
| Semantic similarity | Cosine distance computation in JS | sqlite-vec vec0 `WHERE embedding MATCH ?` | Database-level KNN is orders of magnitude faster than JS loop |
| Rank fusion | Custom merge logic | `reciprocalRankFusion()` from `src/search/hybrid.ts` | Already tested, handles edge cases (missing IDs, single-list fallback) |
| FTS5 query sanitization | Custom regex | Copy `sanitizeQuery` pattern from `SearchEngine` | FTS5 operator injection is a real risk; existing sanitizer handles all edge cases |
| Token budget enforcement | Manual string length checks | `enforceTokenBudget()` from `src/mcp/token-budget.ts` | Generic, tested, handles truncation indicators |

**Key insight:** Phase 15 is an integration phase, not an invention phase. Every building block exists -- FTS5, vec0, RRF, token budgets, MCP tool registration, background embedding. The work is wiring them together for a new data domain (tool registry instead of observations).

## Common Pitfalls

### Pitfall 1: FTS5 content_rowid Mismatch with tool_registry.id

**What goes wrong:** The `tool_registry` table uses `id INTEGER PRIMARY KEY AUTOINCREMENT`. The FTS5 `content_rowid` must reference an integer column. If the FTS5 table is created with `content_rowid='rowid'` (implicit), it may not align with `tool_registry.id`.
**Why it happens:** SQLite's implicit `rowid` and an explicit `INTEGER PRIMARY KEY AUTOINCREMENT` column are the same thing -- but only if the column is the first column and typed as `INTEGER PRIMARY KEY`. The `tool_registry.id` column IS the rowid alias (confirmed from migration 16: `id INTEGER PRIMARY KEY AUTOINCREMENT`).
**How to avoid:** Use `content_rowid='id'` in the FTS5 CREATE statement. This is equivalent to `content_rowid='rowid'` because `id` is an alias for rowid in this table. Be explicit to avoid confusion.
**Warning signs:** FTS5 queries return wrong tool data or crash with "content table mismatch" errors.

### Pitfall 2: Scope Filter Not Applied to Vector Search

**What goes wrong:** FTS5 results are scope-filtered (via JOIN + WHERE), but vector results come from the vec0 table which has no scope column. Out-of-scope tools appear in results.
**Why it happens:** The vec0 table only stores `tool_id` and `embedding` -- it has no scope column for filtering.
**How to avoid:** After retrieving vector results by `tool_id`, look up the full `ToolRegistryRow` and apply scope filtering before fusion. Alternatively, apply scope filtering after RRF fusion when assembling the final result list (simpler, and the result count is small enough that post-filtering is fine).
**Warning signs:** Tools from project A appearing when searching from project B context.

### Pitfall 3: Empty Description Tools Dominating FTS5 Results

**What goes wrong:** Many tools discovered organically have `description = NULL`. If only `name` is indexed, a search for "playwright" matches the server-level entry `mcp__playwright__*` AND every individual tool `mcp__playwright__browser_screenshot`, `mcp__playwright__navigate`, etc. The result list is flooded with individual tools.
**Why it happens:** The tool_registry contains both server-level entries (from config scanning) and individual tool entries (from organic discovery). Both share the server name in their tool name.
**How to avoid:** Deduplicate results at the formatting stage (same pattern as `formatToolSection` in `injection.ts`): prefer server-level entries (`tool_type = 'mcp_server'`) over individual tool entries when both match. Also, limit results to `args.limit` (default 20).
**Warning signs:** Search results dominated by dozens of tools from the same MCP server.

### Pitfall 4: Migration 18 Failing on Pre-Existing Databases

**What goes wrong:** The `tool_registry_fts` rebuild (`INSERT INTO tool_registry_fts(tool_registry_fts) VALUES('rebuild')`) references `tool_registry`. If the database was created before migration 16 (which creates `tool_registry`), migration 18 would fail because the content table does not exist.
**Why it happens:** Migrations run in order, but migration 16 might have been skipped if the database was in an unusual state.
**How to avoid:** The migration system applies migrations in order -- migration 18 runs after 16 and 17. The version check in `runMigrations` ensures this. Additionally, the FTS5 rebuild is non-destructive: if the content table is empty, the rebuild produces an empty FTS index.
**Warning signs:** Migration errors in debug logs during database open.

### Pitfall 5: vec0 Table Not Created When sqlite-vec Unavailable

**What goes wrong:** Migration 18 includes both FTS5 and vec0 table creation. If sqlite-vec is not loaded, the vec0 CREATE statement fails, blocking the entire migration.
**Why it happens:** The existing migration system handles this for migrations 4 and 6 by skipping them entirely when `hasVectorSupport` is false. Migration 18 needs the same treatment.
**How to avoid:** Split migration 18 into two parts: 18a (FTS5, always applied) and 18b (vec0, conditional on `hasVectorSupport`). Or, use a functional migration that checks for vec0 support and conditionally creates the table. The simplest approach: make it a single functional migration that creates FTS5 unconditionally and vec0 conditionally.
**Warning signs:** `SQLITE_ERROR: no such module: vec0` during migration on systems without sqlite-vec.

### Pitfall 6: FTS5 Query Sanitization Not Applied

**What goes wrong:** The user's search query contains FTS5 operators (AND, OR, NOT, quotes, parentheses) that cause syntax errors or unexpected behavior.
**Why it happens:** The `discover_tools` tool receives arbitrary user input via the `query` parameter.
**How to avoid:** Apply the same sanitization as `SearchEngine.sanitizeQuery()` -- remove quotes, parentheses, asterisks, and FTS5 operator keywords. Copy or extract the sanitization logic into a shared utility.
**Warning signs:** `SQLITE_ERROR: fts5: syntax error` in debug logs when users search for queries containing "AND", "OR", or quoted strings.

## Code Examples

Verified patterns from the existing codebase:

### MCP Tool Registration Pattern (from recall.ts)

```typescript
// Source: src/mcp/tools/recall.ts:106-114
server.registerTool(
  'recall',
  {
    title: 'Recall Memories',
    description: 'Search, view, purge, or restore memories...',
    inputSchema: {
      query: z.string().optional().describe('FTS5 keyword search query'),
      // ...
    },
  },
  async (args) => {
    // ... handler implementation
  },
);
```

### FTS5 External Content Pattern (from migration 5)

```sql
-- Source: src/storage/migrations.ts:132-158
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title,
  content,
  content='observations',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content)
    VALUES (new.rowid, new.title, new.content);
END;
```

### Reciprocal Rank Fusion (from hybrid.ts)

```typescript
// Source: src/search/hybrid.ts:56-77
export function reciprocalRankFusion(
  rankedLists: Array<Array<RankedItem>>,
  k = 60,
): FusedResult[] {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const current = scores.get(item.id) ?? 0;
      scores.set(item.id, current + 1 / (k + rank + 1));
    }
  }
  // ... sort descending by fusedScore
}
```

### vec0 Table Pattern (from migration 6)

```sql
-- Source: src/storage/migrations.ts:163-168
CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
  observation_id TEXT PRIMARY KEY,
  embedding float[384] distance_metric=cosine
);
```

### Background Embedding Loop Pattern (from index.ts)

```typescript
// Source: src/index.ts:118-298
async function processUnembedded(): Promise<void> {
  if (!embeddingStore || !worker.isReady()) return;
  const ids = embeddingStore.findUnembedded(10);
  for (const id of ids) {
    const obs = obsRepo.getById(id);
    if (!obs) continue;
    const text = obs.title ? `${obs.title}\n${obs.content}` : obs.content;
    const embedding = await worker.embed(text);
    if (embedding) {
      embeddingStore.store(id, embedding);
    }
  }
}
// Runs every 5 seconds via setInterval
```

### Token Budget Pattern (from token-budget.ts)

```typescript
// Source: src/mcp/token-budget.ts:8-29
export function enforceTokenBudget<T>(
  results: T[],
  formatResult: (item: T) => string,
  budget: number = TOKEN_BUDGET,
): { items: T[]; truncated: boolean; tokenEstimate: number } {
  // Iterates results, sums estimated tokens, stops when budget exceeded
}
```

### FTS5 Query Sanitization Pattern (from search.ts)

```typescript
// Source: src/storage/search.ts:159-194
private sanitizeQuery(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const sanitizedWords = words
    .map((w) => this.sanitizeWord(w))
    .filter(Boolean);
  if (sanitizedWords.length === 0) return null;
  return sanitizedWords.join(' ');
}

private sanitizeWord(word: string): string {
  let cleaned = word.replace(/["*()^{}[\]]/g, '');
  if (/^(NEAR|OR|AND|NOT)$/i.test(cleaned)) return '';
  cleaned = cleaned.replace(/[^\w\-]/g, '');
  return cleaned;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No tool search capability | Passive context injection of tool names (Phase 13) | Phase 13 (2026-02-11) | Tools listed but not searchable |
| LIKE queries for tool lookup | FTS5 + vec0 hybrid search | Phase 15 (new) | Semantic search: "file manipulation" finds "read and write files" |
| Tool suggestions only via notifications | Explicit on-demand search via MCP tool | Phase 15 (new) | Claude can proactively explore the tool registry |

**Not applicable to Phase 15:**
- Staleness detection / removal (Phase 16)
- Config rescan (Phase 16)
- Failure-driven demotion (Phase 16)

## Open Questions

1. **Should discover_tools scope filtering include "all" (cross-scope)?**
   - What we know: The `scope` parameter accepts `global`, `project`, or `plugin`. The current `ToolRegistryRepository` queries already span scopes by default (per decision [10-01]).
   - What's unclear: Should there be an explicit "all" option, or should omitting the scope parameter default to cross-scope (all tools regardless of scope)?
   - Recommendation: Omitting `scope` means search all scopes (no filter). This aligns with [10-01] that the registry is NOT project-scoped and queries span all scopes. The scope parameter is purely additive filtering.

2. **Should MCP server entries be expanded into individual tools in results?**
   - What we know: Config scanning creates server-level entries (`mcp__playwright__*`) while organic discovery creates individual tool entries (`mcp__playwright__browser_screenshot`).
   - What's unclear: Should search results show the server-level entry OR all individual tools, or deduplicate?
   - Recommendation: Deduplicate in results (prefer server-level entries when they exist). Show individual tools only if they are the ONLY entries for that server. This mirrors `formatToolSection` in `injection.ts`.

3. **How to handle the FTS5 rebuild for existing tool_registry rows?**
   - What we know: Migration 18 creates the FTS5 table. Any tools already in tool_registry (from Phases 10-12) need to be indexed.
   - What's unclear: Will the FTS5 `rebuild` command correctly index existing rows via the external content table reference?
   - Recommendation: Yes. The FTS5 `rebuild` command reads all rows from the content table and rebuilds the index. This is exactly how migration 5 handled adding FTS5 to existing observations. Include the rebuild in the migration.

4. **Should discover_tools show built-in tools?**
   - What we know: Per decision [11-01], "Built-in tools excluded from Available Tools display since Claude already knows them." This applies to session context injection.
   - What's unclear: Should the explicit search tool also exclude built-in tools, or should it show everything in the registry?
   - Recommendation: Include built-in tools in search results -- the user is explicitly asking to explore the registry. But rank them lower than MCP/slash/skill tools since Claude already knows builtins. This differs from context injection where space is at a premium.

## Sources

### Primary (HIGH confidence)
- `src/storage/migrations.ts` -- Migration 16 (tool_registry schema), migration 5 (FTS5 external content pattern), migration 6 (vec0 table pattern). Line-by-line analysis.
- `src/storage/tool-registry.ts` -- ToolRegistryRepository with all prepared statements. Complete read.
- `src/mcp/tools/recall.ts` -- MCP tool registration pattern with Zod schemas, hybrid search integration, token budget enforcement. Complete read.
- `src/mcp/tools/query-graph.ts` -- Alternative MCP tool pattern with graph traversal. Complete read.
- `src/search/hybrid.ts` -- `reciprocalRankFusion()` export, `hybridSearch()` implementation. Complete read.
- `src/storage/search.ts` -- `SearchEngine` FTS5 query pattern, BM25 ranking, query sanitization. Complete read.
- `src/storage/embeddings.ts` -- `EmbeddingStore` vec0 operations, project-scoped KNN search. Complete read.
- `src/index.ts` -- MCP server setup, background embedding loop, tool registration wiring. Complete read.
- `src/shared/tool-types.ts` -- ToolRegistryRow, ToolScope, ToolType definitions. Complete read.
- `src/context/injection.ts` -- Tool section formatting, deduplication logic, scope filtering. Complete read.
- `src/mcp/token-budget.ts` -- `enforceTokenBudget` pattern. Complete read.
- `.planning/phases/10-tool-discovery-registry/10-RESEARCH.md` -- Phase 10 design decisions and architecture. Complete read.
- `.planning/phases/12-usage-tracking/12-RESEARCH.md` -- Phase 12 event table design. Complete read.
- `.planning/ROADMAP.md` -- Phase 15 requirements and success criteria. Complete read.

### Secondary (MEDIUM confidence)
- [SQLite FTS5 documentation](https://sqlite.org/fts5.html) -- External content tables, BM25 ranking, content_rowid usage. Verified via web search.

### Tertiary (LOW confidence)
- None. All findings are from direct codebase analysis and official SQLite documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Zero new dependencies; all building blocks exist in codebase
- Architecture: HIGH - Follows exact patterns from existing MCP tools and FTS5/vec0 usage
- Migration design: HIGH - Mirrors migration 5 (FTS5) and migration 6 (vec0) patterns exactly
- Pitfalls: HIGH - Identified from actual schema analysis and known FTS5/vec0 edge cases

**Research date:** 2026-02-10
**Valid until:** 2026-03-10 (stable -- no external dependencies to change)
