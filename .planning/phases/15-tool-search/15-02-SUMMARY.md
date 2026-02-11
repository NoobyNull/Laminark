---
phase: 15-tool-search
plan: 02
subsystem: search
tags: [mcp-tool, hybrid-search, fts5, vec0, semantic-search, tool-discovery, background-embedding]

# Dependency graph
requires:
  - phase: 15-tool-search
    provides: "FTS5+vec0 migration, searchTools() hybrid method, storeEmbedding/findUnembeddedTools on ToolRegistryRepository"
  - phase: 10-tool-discovery-registry
    provides: "tool_registry table, ToolRegistryRepository, organic tool discovery"
  - phase: 04-embedding-engine-and-semantic-search
    provides: "vec0 table pattern, AnalysisWorker embedding infrastructure, background embedding loop"
provides:
  - "discover_tools MCP tool for Claude to search tool registry by keyword/semantic query"
  - "Scope filtering (global/project/plugin) with cross-scope default"
  - "MCP server vs individual tool deduplication in search results"
  - "Background tool description embedding in existing 5-second interval loop"
  - "registerDiscoverTools() function for MCP server registration"
affects: [tool-search-pipeline, session-context, handler-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [MCP tool registration for tool registry search, background tool embedding piggybacking on existing interval, deduplication pattern matching injection.ts]

key-files:
  created:
    - src/mcp/tools/discover-tools.ts
  modified:
    - src/index.ts

key-decisions:
  - "discover_tools uses enforceTokenBudget at 2000 tokens matching recall.ts pattern"
  - "Deduplication logic mirrors injection.ts formatToolSection: server-level entries suppress individual mcp_tool entries"
  - "processUnembeddedTools added to existing 5-second setInterval -- no new timer created"
  - "ToolRegistryRepository wrapped in try/catch at module level for pre-migration graceful degradation"

patterns-established:
  - "Tool search MCP tool pattern: hybrid search with scope filtering and deduplication"
  - "Background embedding extension: add new embedding targets to existing interval rather than creating new timers"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 15 Plan 02: Discover Tools MCP Tool and Background Embedding Summary

**discover_tools MCP tool with hybrid FTS5+vector search, scope filtering, server/tool deduplication, and background tool description embedding**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T07:22:54Z
- **Completed:** 2026-02-11T07:24:44Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created discover_tools MCP tool that Claude can call to search the tool registry by keyword or natural language description
- Hybrid search (FTS5 keyword + vec0 vector via reciprocal rank fusion) with graceful FTS5-only fallback
- Scope filtering narrows to global/project/plugin when specified; omitting scope searches all scopes
- Results include scope tag, usage count, last used timestamp, and match score for each tool
- MCP server entries deduplicated against individual tool entries (server-level preferred)
- Background tool description embedding runs in existing 5-second interval loop for semantic search
- Token budget enforcement at 2000 tokens prevents oversized responses

## Task Commits

Each task was committed atomically:

1. **Task 1: discover_tools MCP tool implementation** - `06db6c5` (feat)
2. **Task 2: Wire discover_tools registration and background tool embedding** - `05ed3d4` (feat)

## Files Created/Modified
- `src/mcp/tools/discover-tools.ts` - New MCP tool: registerDiscoverTools with hybrid search, scope filtering, deduplication, formatting, token budget, notifications
- `src/index.ts` - Import and register discover_tools, create ToolRegistryRepository instance, add processUnembeddedTools to 5-second background loop

## Decisions Made
- discover_tools uses enforceTokenBudget with TOKEN_BUDGET (2000) matching the recall.ts response size pattern
- Deduplication logic mirrors injection.ts formatToolSection: first-pass collects server names from mcp_server results, second-pass filters out mcp_tool entries whose server_name is in the set
- processUnembeddedTools piggybacks on existing 5-second setInterval rather than creating a new timer -- simpler lifecycle, consistent with the embedding loop pattern
- ToolRegistryRepository instance wrapped in try/catch at module level -- gracefully degrades for databases that haven't run migration 16 yet

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 15 (Tool Search) is fully complete: both search foundation (Plan 01) and user-facing tool (Plan 02)
- Claude can now call discover_tools to find any registered tool by keyword or semantic description
- Background embedding ensures semantic search improves over time as tool descriptions are vectorized
- Ready to proceed to Phase 16 (final phase of v2.0 milestone)

## Self-Check: PASSED

All 2 files verified present. All 2 commit hashes verified in git log.

---
*Phase: 15-tool-search*
*Completed: 2026-02-11*
