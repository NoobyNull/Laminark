---
phase: 02-mcp-interface-and-search
plan: 01
subsystem: api
tags: [mcp, stdio, fts5, zod, token-budget]

# Dependency graph
requires:
  - phase: 01-storage-engine
    provides: "ObservationRepository, SearchEngine, openDatabase, migrations, debug logging"
provides:
  - "MCP server scaffold with createServer() and startServer()"
  - "save_memory tool with auto-title generation"
  - "Migration 005: title column + FTS5 dual-column indexing"
  - "Token budget utility (estimateTokens, enforceTokenBudget)"
affects: [02-02 recall tool, 03 hook integration, 05 slash commands]

# Tech tracking
tech-stack:
  added: ["@modelcontextprotocol/sdk ^1.26.0"]
  patterns: ["registerTool() for MCP tool registration", "stdio transport for MCP", "auto-title generation from content"]

key-files:
  created:
    - src/mcp/server.ts
    - src/mcp/tools/save-memory.ts
    - src/mcp/token-budget.ts
  modified:
    - src/storage/migrations.ts
    - src/shared/types.ts
    - src/storage/observations.ts
    - src/storage/search.ts
    - src/index.ts
    - package.json

key-decisions:
  - "Used z.input instead of z.infer for ObservationInsert to correctly handle Zod v4 defaulted fields"
  - "FTS5 snippet column index updated from 0 to 1 after title column inserted at position 0"
  - "registerTool() used instead of deprecated tool() for MCP tool registration"

patterns-established:
  - "MCP tool registration: export registerXxx(server, db, projectHash) functions from src/mcp/tools/"
  - "Auto-title: first sentence (<=100 chars) or first 80 chars + ellipsis"
  - "Token budget: 2000 default, 4000 for full view, ~4 chars/token estimation"

# Metrics
duration: 6min
completed: 2026-02-08
---

# Phase 2 Plan 01: MCP Server Scaffold Summary

**MCP server on stdio transport with save_memory tool, migration 005 for title+FTS5, and token budget utility**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-08T22:16:05Z
- **Completed:** 2026-02-08T22:22:15Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Migration 005 adds title column to observations and rebuilds FTS5 with title+content dual-column indexing
- MCP server initializes with McpServer + StdioServerTransport, starts cleanly on stdio with zero stdout pollution
- save_memory tool registered via registerTool() accepts text, optional title, and source parameters
- Token budget utility ready for recall tool (estimateTokens, enforceTokenBudget, TOKEN_BUDGET, FULL_VIEW_BUDGET)
- All 78 existing tests pass without modification

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema migration 005 for title column and type updates** - `96fd76f` (feat)
2. **Task 2: MCP server scaffold and save_memory tool** - `4a20565` (feat)

## Files Created/Modified
- `src/mcp/server.ts` - MCP server lifecycle: createServer() and startServer() with stdio transport
- `src/mcp/tools/save-memory.ts` - save_memory tool registration with auto-title generation
- `src/mcp/token-budget.ts` - Token estimation and budget enforcement utility
- `src/storage/migrations.ts` - Migration 005: title column + FTS5 rebuild with title+content
- `src/shared/types.ts` - ObservationRow, Observation, ObservationInsert updated with title field
- `src/storage/observations.ts` - INSERT statement and create() updated for title column
- `src/storage/search.ts` - FTS5 snippet column index updated (0->1) for new FTS5 schema
- `src/index.ts` - Unified entry point: opens DB, registers tools, starts MCP server
- `package.json` - Added @modelcontextprotocol/sdk dependency

## Decisions Made
- Used `z.input<typeof ObservationInsertSchema>` instead of `z.infer` for ObservationInsert type. Zod v4's `z.infer` produces the output type where all defaulted fields are required. `z.input` correctly makes defaulted fields optional at the callsite. This was a pre-existing bug (not introduced by this plan).
- Updated FTS5 snippet column index from 0 to 1. After adding title as the first FTS5 column, the content column shifted from index 0 to 1. Without this fix, snippet extraction would return null for observations without titles.
- Used `registerTool()` instead of deprecated `server.tool()` for MCP tool registration, as recommended by MCP SDK v1.26.0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed z.infer vs z.input for ObservationInsert**
- **Found during:** Task 1 (Type updates)
- **Issue:** Pre-existing bug: `z.infer<typeof ObservationInsertSchema>` produces output type where defaulted fields (sessionId, embedding, etc.) are required. Test files passing `{ content, source }` failed TypeScript compilation.
- **Fix:** Changed `z.infer` to `z.input` which correctly makes fields with `.default()` optional in the input type.
- **Files modified:** src/shared/types.ts
- **Verification:** `npx tsc --noEmit` passes clean, all 78 tests pass
- **Committed in:** 96fd76f (Task 1 commit)

**2. [Rule 1 - Bug] Fixed FTS5 snippet column index after title column addition**
- **Found during:** Task 1 (Migration 005)
- **Issue:** FTS5 table now has columns (title, content) instead of (content). The `snippet()` function call used column index 0 (previously content, now title). Snippet returned null for observations without titles.
- **Fix:** Changed `snippet(observations_fts, 0, ...)` to `snippet(observations_fts, 1, ...)` in both searchKeyword and searchByPrefix.
- **Files modified:** src/storage/search.ts
- **Verification:** Search test "results include snippet with <mark> tags" passes
- **Committed in:** 96fd76f (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both auto-fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- MCP server scaffold is ready for recall tool registration (Plan 02-02)
- Token budget utility is ready for recall tool response formatting
- Title column and FTS5 dual-column indexing ready for title-based search in recall
- save_memory validates the full MCP stack end-to-end: SDK init, tool registration, DB interaction, stdio transport

---
*Phase: 02-mcp-interface-and-search*
*Completed: 2026-02-08*
