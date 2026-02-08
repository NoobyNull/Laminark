# Phase 2: MCP Interface and Search - Research

**Researched:** 2026-02-08
**Domain:** MCP server tools, FTS5 search interface, progressive disclosure, token budget management
**Confidence:** HIGH

## Summary

Phase 2 builds the Claude-facing MCP tool interface on top of the Phase 1 storage engine. The core deliverable is two MCP tools: `save_memory` (persist observations with optional title) and `recall` (unified search + view/purge/restore). The `recall` tool consolidates what was originally planned as 5 separate tools into a single unified interface with a multi-step interaction pattern: search first, select results, then act.

The MCP SDK v1.26.0 is the current stable release. The `server.tool()` method is deprecated -- use `server.registerTool()` instead, which takes a config object with `title`, `description`, `inputSchema`, and `annotations`. The SDK has full Zod v4 compatibility through its internal zod-compat layer. Tool names must follow the SEP specification: `[A-Za-z0-9._-]{1,128}`.

A critical finding: the Phase 1 observations schema has no `title` column. The CONTEXT.md specifies "optional title parameter" for save_memory, so Phase 2 needs a schema migration (migration version 5) to add a `title TEXT` column to the observations table, and the FTS5 table needs updating to index title content alongside the existing content column.

**Primary recommendation:** Build two MCP tools (`save_memory` and `recall`) with the unified recall pattern. Use `server.registerTool()` (not deprecated `server.tool()`). Add migration 005 for the title column. Enforce token budgets at the tool response level using character-based estimation (~4 chars/token). Configure `.mcp.json` at project root for Claude Code plugin integration using `tsx` for TypeScript execution.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **Save behavior (save_memory tool):** Optional title parameter -- caller can provide a title, auto-generated from text if omitted. System should track additions and subtractions to code. Save is a simple persist operation with no confirmation flow.
- **Unified recall tool:** Single `recall` tool replaces separate forget/restore/get_observations tools. Interface pattern: `search [textFST|Id|title] [view|purge|restore]`. Search by full-text (FTS5), observation ID, or title. Actions after search: view, purge (soft-delete), or restore (un-delete).
- **Multi-result selection:** Search returns a compact list of matches. Caller selects one, multiple, or all/none before applying an action. No blind "act on all matches" -- always list first, then select, then act.
- **Purge and restore semantics:** Purge is soft-delete: flags memory with deleted_at timestamp, hides from normal search, keeps in DB. Restore un-deletes a previously purged memory. No hard delete exposed in MCP tools.
- **View behavior (progressive disclosure):** View uses 3-layer progressive disclosure: compact index -> timeline context -> full details. Respects token budgets for large result sets. Claude requests more detail as needed rather than receiving everything upfront.

### Claude's Discretion

- Tool naming conventions and exact parameter schemas
- Error message wording and empty-result formatting
- Token budget thresholds and truncation strategy
- Auto-title generation algorithm

### Deferred Ideas (OUT OF SCOPE)

- `/laminark:recall` slash command interface -- Phase 5 (this phase builds the MCP tool that powers it)
- `/laminark:remember` slash command -- Phase 5

</user_constraints>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | ^1.26.0 | MCP server with stdio transport | Official SDK. Use `McpServer` class from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`. v1.x is stable for production. |
| zod | ^4.3.6 | Tool input schema validation | Already a project dependency. MCP SDK peer dependency (supports ^3.25 or ^4.0). Full v4 compatibility via SDK's zod-compat layer. |
| better-sqlite3 | ^12.6.2 | SQLite database (from Phase 1) | Already installed. Synchronous API. All MCP tool handlers use the Phase 1 storage layer. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tsx | ^4.21.0 | TypeScript execution in dev | Already installed. Use in `.mcp.json` command to run TypeScript source directly during development: `npx tsx src/index.ts`. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `registerTool()` | `server.tool()` (deprecated) | `tool()` still works but is frozen as of protocol version 2025-03-26. `registerTool()` supports `title`, `outputSchema`, and `_meta` that `tool()` does not. |
| tsx for dev | tsdown build + node dist/index.js | Prefer tsx for development iteration speed. Use built dist/index.js for production `.mcp.json`. |

**Installation:**
```bash
npm install @modelcontextprotocol/sdk
# zod, better-sqlite3, tsx already installed from Phase 1
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── index.ts                    # Entry point: init DB, start MCP server
├── mcp/
│   ├── server.ts               # McpServer creation, tool registration, stdio transport
│   ├── token-budget.ts         # Token estimation and budget enforcement utility
│   └── tools/
│       ├── save-memory.ts      # save_memory tool registration
│       └── recall.ts           # recall tool registration (unified search+action)
├── storage/                    # Phase 1 (unchanged)
│   ├── database.ts
│   ├── observations.ts
│   ├── search.ts
│   ├── sessions.ts
│   ├── migrations.ts
│   └── index.ts
└── shared/
    ├── types.ts                # Add MCP-layer types (CompactEntry, ToolResponse shapes)
    ├── config.ts
    └── debug.ts
```

### Pattern 1: MCP Server with registerTool (Current SDK API)

**What:** Use `McpServer` class with `registerTool()` method instead of deprecated `tool()`.
**When to use:** All tool registrations in this phase.
**Example:**
```typescript
// Source: @modelcontextprotocol/sdk v1.26.0 mcp.d.ts (verified from installed package)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'laminark', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// registerTool(name, config, callback)
server.registerTool(
  'save_memory',
  {
    title: 'Save Memory',
    description: 'Save a new memory observation.',
    inputSchema: {
      text: z.string().min(1).max(10000).describe('The text content to save'),
      title: z.string().max(200).optional().describe('Optional title for the memory'),
      source: z.string().default('manual').describe('Source of the memory'),
    },
  },
  async (args, extra) => {
    // args is typed as { text: string, title?: string, source: string }
    // Return CallToolResult
    return {
      content: [{ type: 'text', text: `Memory saved (id: ${id})` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Pattern 2: Unified Recall Tool with Multi-Step Interaction

**What:** Single `recall` tool that handles search, view, purge, and restore through parameter modes.
**When to use:** The recall tool is the primary memory retrieval and management interface.
**Example:**
```typescript
server.registerTool(
  'recall',
  {
    title: 'Recall Memories',
    description: 'Search, view, purge, or restore memories. First search to find matches, then act on results.',
    inputSchema: {
      // Search mode: find memories
      query: z.string().optional().describe('FTS5 keyword search query'),
      id: z.string().optional().describe('Direct lookup by observation ID'),
      title: z.string().optional().describe('Search by title'),

      // Action mode: act on found memories
      action: z.enum(['view', 'purge', 'restore']).default('view')
        .describe('Action to take: view (show details), purge (soft-delete), restore (un-delete)'),

      // Selection for multi-result actions
      ids: z.array(z.string()).optional()
        .describe('Specific IDs to act on (from a previous search result)'),

      // View detail level
      detail: z.enum(['compact', 'timeline', 'full']).default('compact')
        .describe('Detail level: compact (index), timeline (chronological), full (complete text)'),

      // Pagination
      limit: z.number().int().min(1).max(20).default(10)
        .describe('Maximum results to return'),

      // Include purged items
      include_purged: z.boolean().default(false)
        .describe('Include soft-deleted items in results (for restore operations)'),
    },
  },
  async (args, extra) => {
    // Implementation handles search, then action based on parameters
    // ...
  }
);
```

### Pattern 3: Token Budget Enforcement

**What:** Every MCP tool response is checked against a token budget before returning.
**When to use:** All tool responses that return variable-length content.
**Example:**
```typescript
const TOKEN_BUDGET = 2000;

function estimateTokens(text: string): number {
  // ~4 characters per token (conservative overestimate)
  return Math.ceil(text.length / 4);
}

function enforceTokenBudget<T>(
  results: T[],
  formatResult: (item: T) => string,
  budget: number = TOKEN_BUDGET,
): { items: T[]; truncated: boolean; tokenEstimate: number } {
  const METADATA_RESERVE = 100; // tokens for response envelope
  const effectiveBudget = budget - METADATA_RESERVE;
  let totalTokens = 0;
  const items: T[] = [];

  for (const result of results) {
    const formatted = formatResult(result);
    const tokens = estimateTokens(formatted);
    if (totalTokens + tokens > effectiveBudget && items.length > 0) {
      return { items, truncated: true, tokenEstimate: totalTokens };
    }
    items.push(result);
    totalTokens += tokens;
  }

  return { items, truncated: false, tokenEstimate: totalTokens };
}
```

### Pattern 4: Schema Migration for Title Column

**What:** Add migration version 5 to add title column to observations table and update FTS5 index.
**When to use:** Before implementing save_memory tool.
**Example:**
```typescript
// Migration 005: add title column and update FTS5 index
{
  version: 5,
  name: 'add_observation_title',
  up: `
    ALTER TABLE observations ADD COLUMN title TEXT;

    -- Rebuild FTS5 to include title
    DROP TRIGGER observations_ai;
    DROP TRIGGER observations_au;
    DROP TRIGGER observations_ad;
    DROP TABLE observations_fts;

    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title,
      content,
      content='observations',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    -- Re-sync triggers (now including title)
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content)
        VALUES (new.rowid, new.title, new.content);
    END;

    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content)
        VALUES('delete', old.rowid, old.title, old.content);
      INSERT INTO observations_fts(rowid, title, content)
        VALUES (new.rowid, new.title, new.content);
    END;

    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content)
        VALUES('delete', old.rowid, old.title, old.content);
    END;

    -- Rebuild the index with existing data
    INSERT INTO observations_fts(observations_fts) VALUES('rebuild');
  `,
}
```

### Anti-Patterns to Avoid

- **Multiple tools for CRUD:** The user locked "unified recall tool." Do NOT create separate `forget`, `restore`, `get_observations`, `timeline` tools. All memory retrieval and management goes through `recall`.
- **Returning full observation text in search results:** Compact index should return only id, score, snippet (~100 chars), title, and date. Full text is only returned when `detail: 'full'` is requested.
- **Using `server.tool()` instead of `server.registerTool()`:** The deprecated `tool()` method does not support `title` or `outputSchema`. Use `registerTool()` for all registrations.
- **Blocking MCP server startup on database issues:** If the database cannot be opened, return error responses from tools rather than crashing the server. The MCP server process must stay alive.
- **Writing to stdout from non-MCP code:** MCP uses stdio transport. Any `console.log()` would corrupt the MCP protocol stream. Use `process.stderr.write()` (the debug module already does this correctly).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP protocol handling | Custom JSON-RPC over stdio | `McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk` | Protocol is complex (initialization handshake, capability negotiation, transport framing). SDK handles all of this. |
| Tool input validation | Manual type checking / casting | Zod schemas via `registerTool({ inputSchema: {...} })` | SDK integrates Zod validation automatically. Invalid input returns proper MCP error codes (ErrorCode.InvalidParams). |
| FTS5 query sanitization | Custom regex for FTS5 operators | Use `SearchEngine.sanitizeQuery()` from Phase 1 | Already implemented and tested. Strips FTS5 operators (OR, AND, NOT, ^, *, quotes, parens). |
| Token counting | tiktoken or full tokenizer | Simple `Math.ceil(text.length / 4)` heuristic | Tokenizer libraries are 10+ MB. The heuristic is conservative (overestimates) and sufficient for budget enforcement. Claude Code itself uses 25K token max output limit. |
| Observation CRUD | Direct SQL in MCP tool handlers | `ObservationRepository` and `SearchEngine` from Phase 1 | Already project-scoped, prepared-statement-optimized, and debug-instrumented. |

**Key insight:** Phase 2 is a thin interface layer. Almost all business logic already exists in Phase 1's storage layer. The MCP tools are essentially parameter validation + storage layer calls + response formatting. Do not duplicate storage logic.

## Common Pitfalls

### Pitfall 1: stdout Pollution Crashes MCP Protocol
**What goes wrong:** Any `console.log()` in the server process writes to stdout, which corrupts the MCP JSON-RPC protocol stream. Claude Code sees malformed JSON and disconnects.
**Why it happens:** Developers add console.log for debugging. Third-party libraries (like sqlite-vec loading) may print to stdout.
**How to avoid:** Use `process.stderr.write()` for all logging (the existing `debug()` module does this). Redirect any third-party stdout output. Never use `console.log()` anywhere in the MCP server process.
**Warning signs:** Claude Code shows "Connection closed" errors or "failed to parse JSON" errors from the MCP server.

### Pitfall 2: Synchronous Database Calls in Async Tool Handlers
**What goes wrong:** MCP SDK tool handlers are async, but better-sqlite3 is synchronous. Developers wrap sync calls in unnecessary `await` or try to use async database libraries.
**Why it happens:** Misunderstanding that better-sqlite3's synchronous API is intentional and faster than async alternatives.
**How to avoid:** Call better-sqlite3 methods directly in the tool handler. They return immediately (microsecond-scale for typical queries). No need for async wrappers. The tool handler can be `async` (required by MCP SDK) while internally using sync database calls.
**Warning signs:** Unnecessary Promise wrapping around database operations.

### Pitfall 3: FTS5 Query Injection
**What goes wrong:** User-provided search queries containing FTS5 operators (AND, OR, NOT, ^, *, ") cause SQLite errors or unintended search behavior.
**Why it happens:** FTS5 MATCH clause interprets special characters as operators.
**How to avoid:** Always use the Phase 1 `SearchEngine.sanitizeQuery()` method which strips operators. For direct ID or title lookups (non-FTS5 paths in recall), use parameterized WHERE clauses, not FTS5 MATCH.
**Warning signs:** SQLite errors mentioning "fts5 syntax error" or "no such column" in test outputs.

### Pitfall 4: Missing Project Scoping in Recall Tool
**What goes wrong:** Recall returns observations from all projects because the query forgot to include `project_hash` filtering.
**Why it happens:** The recall tool has multiple query paths (FTS5 search, ID lookup, title search) and each needs project scoping independently.
**How to avoid:** Use the Phase 1 repository classes (ObservationRepository, SearchEngine) which have constructor-bound `projectHash`. Never write raw SQL in tool handlers. The repository enforces project scoping automatically.
**Warning signs:** Results showing observations with different `projectHash` values in tests.

### Pitfall 5: Tool Name Validation Warnings
**What goes wrong:** Tool names with special characters cause warnings from the MCP SDK's SEP validation. While not fatal, these warnings clutter stderr and may indicate future incompatibility.
**Why it happens:** SEP specification restricts tool names to `[A-Za-z0-9._-]{1,128}`.
**How to avoid:** Use lowercase names with underscores: `save_memory`, `recall`. Avoid spaces, slashes, or other special characters.
**Warning signs:** Console warnings starting with "Tool name validation warning."

### Pitfall 6: FTS5 Rebuild After Schema Migration
**What goes wrong:** After adding the title column to FTS5, existing observations have no title indexed. Searches by title fail for pre-existing data.
**Why it happens:** FTS5 external content tables are synced via triggers, but ALTER TABLE + DROP/CREATE FTS does not automatically re-index existing rows.
**How to avoid:** Include `INSERT INTO observations_fts(observations_fts) VALUES('rebuild')` at the end of migration 005. This re-indexes all existing rows from the content table.
**Warning signs:** Title searches return no results for observations created before the migration.

## Code Examples

Verified patterns from official sources and the actual installed SDK:

### MCP Server Entry Point
```typescript
// Source: @modelcontextprotocol/sdk v1.26.0 (verified from installed package)
// File: src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase, getDatabaseConfig, getProjectHash } from './storage/index.js';
import { debug } from './shared/debug.js';

const db = openDatabase(getDatabaseConfig());
const projectHash = getProjectHash(process.cwd());

const server = new McpServer(
  { name: 'laminark', version: '0.1.0' },
  {
    capabilities: { tools: { listChanged: true } },
    // Instructions help Claude understand when to search for tools (Tool Search feature)
    instructions: 'Laminark provides persistent memory for Claude Code. Use save_memory to store important information and recall to search, view, purge, or restore memories.',
  }
);

// Register tools (each tool module exports a register function)
registerSaveMemory(server, db.db, projectHash);
registerRecall(server, db.db, projectHash);

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  debug('mcp', 'Uncaught exception', { error: err.message });
  db.close();
  process.exit(1);
});
```

### Tool Handler Return Type (CallToolResult)
```typescript
// Source: @modelcontextprotocol/sdk v1.26.0 types.d.ts (verified from installed package)
// CallToolResult shape:
{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'audio'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } }
  >;
  isError?: boolean;
  structuredContent?: Record<string, unknown>; // Only with outputSchema
}

// Error response pattern:
return {
  content: [{ type: 'text', text: 'No observations found matching "query".' }],
  isError: true,
};
```

### .mcp.json for Claude Code Plugin (Project Scope)
```json
// Source: https://code.claude.com/docs/en/mcp (verified 2026-02-08)
// File: .mcp.json (project root)
// Note: Plugin .mcp.json uses server names as top-level keys (NOT wrapped in mcpServers)
{
  "laminark": {
    "command": "npx",
    "args": ["tsx", "src/index.ts"],
    "env": {}
  }
}
```

### Auto-Title Generation (Claude's Discretion)
```typescript
// Simple auto-title: first sentence or first N characters of content
function generateTitle(content: string): string {
  // Try first sentence (up to 100 chars)
  const firstSentence = content.match(/^[^.!?\n]+[.!?]?/);
  if (firstSentence && firstSentence[0].length <= 100) {
    return firstSentence[0].trim();
  }
  // Fall back to first 80 chars + ellipsis
  if (content.length <= 80) return content.trim();
  return content.slice(0, 80).trim() + '...';
}
```

### Compact Index Format for Search Results
```typescript
// Each search result as a compact index entry (~80 tokens)
interface CompactEntry {
  id: string;          // observation ID
  title: string;       // title (auto-generated or user-provided)
  score: number;       // BM25 relevance score (higher = better)
  snippet: string;     // first 100 chars of content with FTS5 highlight markers
  source: string;      // e.g., 'manual', 'hook:PostToolUse'
  created: string;     // ISO datetime
}

// Response format for recall tool in search/compact mode
interface RecallSearchResponse {
  results: CompactEntry[];
  total: number;       // total matches (may exceed returned count)
  query: string;       // echoed back for context
  truncated: boolean;  // true if token budget caused truncation
  tokenEstimate: number;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `server.tool(name, description, schema, cb)` | `server.registerTool(name, config, cb)` | MCP SDK v1.26 (protocol 2025-03-26) | Old method is deprecated but functional. New method adds `title`, `outputSchema`, `_meta` support. Use `registerTool()` for all new code. |
| Separate `search`, `forget`, `get_observations` tools | Unified `recall` tool | User decision in CONTEXT.md | Reduces cognitive load for Claude. Single tool handles all retrieval and management. |
| MCP `.mcp.json` with `mcpServers` wrapper | Plugin `.mcp.json` uses flat format | Claude Code plugin system | Plugin-bundled MCP servers use server names as top-level keys. Project-scoped `.mcp.json` for non-plugins uses `mcpServers` wrapper. |
| `@modelcontextprotocol/sdk` v1 monolith | v2 split packages planned | Expected Q1 2026 (not shipped yet) | Stay on v1.26.0. v2 splits into `@modelcontextprotocol/server`, `/client`, `/core`. Migration path available when v2 ships. |

**Deprecated/outdated:**
- `server.tool()`: Frozen as of protocol version 2025-03-26. Use `server.registerTool()`.
- `@modelcontextprotocol/sdk/server/mcp.js` deep path import: Still works in v1.26. May change in v2 to `@modelcontextprotocol/server`.

## Open Questions

1. **Auto-title generation quality**
   - What we know: Simple first-sentence extraction works for most text. The user decided titles are optional with auto-generation fallback.
   - What's unclear: Whether the simple heuristic produces good enough titles for code-heavy observations (e.g., "Added authentication middleware to Express routes" vs. "// auth middleware\nconst authMiddleware = ...").
   - Recommendation: Start with first-sentence extraction. Refine based on real usage. This is in Claude's Discretion.

2. **Recall tool interaction model: stateless vs. stateful**
   - What we know: The user wants multi-result selection (list first, then select, then act). MCP tool calls are stateless -- each call is independent with no server-side session state.
   - What's unclear: How to implement "select from previous results" in a stateless protocol. The caller (Claude) must pass IDs explicitly.
   - Recommendation: The recall tool works in two modes: (1) search mode returns compact results with IDs, (2) action mode accepts explicit `ids` array to act on. Claude holds the state (the IDs) between calls. This is pure stateless and works perfectly with MCP.

3. **Token budget threshold: 2000 vs. Claude Code limits**
   - What we know: Claude Code warns at 10K tokens, caps at 25K by default. The requirement says 2000 tokens max per tool response.
   - What's unclear: Whether 2000 is too conservative for detailed view responses.
   - Recommendation: Keep 2000 for compact/timeline views. Allow up to 4000 for `detail: 'full'` view of a single observation. Document the rationale.

4. **FTS5 title column weight**
   - What we know: FTS5 supports column weights in bm25() scoring: `bm25(observations_fts, title_weight, content_weight)`.
   - What's unclear: Optimal weight ratio between title and content.
   - Recommendation: Weight title 2x content: `bm25(observations_fts, 2.0, 1.0)`. Title matches should rank higher since titles are curated summaries.

5. **Title column in FTS5: searching title vs. content**
   - What we know: Current FTS5 table only indexes `content`. Adding `title` requires dropping/recreating FTS5 table and triggers.
   - What's unclear: Whether to use separate FTS5 columns or a single concatenated column.
   - Recommendation: Use separate FTS5 columns (title, content) with column weights. This allows the recall tool to search by title specifically (`title:query` FTS5 syntax) or across both.

## Sources

### Primary (HIGH confidence)
- `@modelcontextprotocol/sdk` v1.26.0 installed package -- examined `mcp.d.ts`, `mcp.js`, `stdio.d.ts`, `index.js`, `zod-compat.d.ts`, `toolNameValidation.js` directly from `node_modules`
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- `.mcp.json` format, plugin MCP servers, scoping, Tool Search feature, token limits
- Phase 1 codebase -- `src/storage/`, `src/shared/` examined in full for API surface and existing types

### Secondary (MEDIUM confidence)
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- v2 roadmap info, migration notes
- [NPM @modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- version 1.26.0 confirmed as latest
- `.planning/research/ARCHITECTURE.md` and `.planning/research/STACK.md` -- prior research findings

### Tertiary (LOW confidence)
- v2 SDK timeline ("Q1 2026"): Multiple sources mention this but v2 has not shipped as of 2026-02-08. Not actionable -- stay on v1.26.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- MCP SDK v1.26.0 verified from installed package, Zod v4 compatibility confirmed via zod-compat layer
- Architecture: HIGH -- registerTool API, StdioServerTransport, and CallToolResult shape verified from SDK source
- Pitfalls: HIGH -- stdout corruption, FTS5 query injection, and project scoping issues verified from Phase 1 code and MCP protocol behavior
- Schema migration: MEDIUM -- FTS5 rebuild after ALTER TABLE is standard SQLite practice but the exact trigger recreation for title+content needs testing
- Token budget: MEDIUM -- 4 chars/token heuristic is standard but not calibrated for this specific use case

**Research date:** 2026-02-08
**Valid until:** 2026-03-10 (30 days -- MCP SDK v1.x is stable, v2 may ship and change recommendations)
