---
phase: 15-tool-search
plan: 01
subsystem: search
tags: [fts5, vec0, hybrid-search, rrf, bm25, sqlite, embeddings]

# Dependency graph
requires:
  - phase: 10-tool-discovery-registry
    provides: tool_registry table, ToolRegistryRepository, ToolRegistryRow type
  - phase: 04-embedding-engine-and-semantic-search
    provides: vec0 table pattern, embedding infrastructure
provides:
  - "Migration 18: tool_registry_fts (FTS5) + tool_registry_embeddings (vec0) tables"
  - "ToolSearchResult type for search result representation"
  - "searchTools() hybrid FTS5+vector search via reciprocal rank fusion"
  - "searchByKeyword() FTS5 BM25 keyword search with scope filtering"
  - "searchByVector() vec0 KNN cosine similarity search"
  - "storeEmbedding() and findUnembeddedTools() for background embedding loop"
affects: [15-02-PLAN, discover_tools MCP tool, tool search pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns: [FTS5 external content with sync triggers for tool registry, reciprocal rank fusion for tool search, conditional vec0 via try/catch in functional migration]

key-files:
  created: []
  modified:
    - src/storage/migrations.ts
    - src/shared/tool-types.ts
    - src/storage/tool-registry.ts

key-decisions:
  - "FTS5 BM25 weights name 2x over description for tool name relevance boost"
  - "Functional migration with try/catch for vec0 -- FTS5 always runs, vec0 degrades gracefully"
  - "sanitizeQuery duplicated from SearchEngine (not imported) -- ToolRegistryRepository is not observation-scoped"
  - "searchByVector returns snake_case tool_id matching SQL column convention"

patterns-established:
  - "Tool search hybrid pattern: FTS5 keyword + vec0 vector + RRF fusion with graceful FTS-only fallback"
  - "Background embedding support: storeEmbedding/findUnembeddedTools pair for async indexing loop"

# Metrics
duration: 2min
completed: 2026-02-11
---

# Phase 15 Plan 01: Tool Registry Search Foundation Summary

**FTS5 + vec0 hybrid search on tool_registry with BM25 keyword, cosine vector, and reciprocal rank fusion**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-11T07:18:25Z
- **Completed:** 2026-02-11T07:20:26Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Migration 18 creates FTS5 external content table with porter+unicode61 tokenizer, three sync triggers, rebuild, and conditional vec0 embeddings table
- ToolSearchResult type provides unified result format for FTS, vector, and hybrid match types
- searchTools() orchestrates hybrid search: FTS5 keyword results fused with vec0 vector results via RRF, degrades to FTS5-only when embeddings unavailable
- Query sanitization strips FTS5 operators (AND, OR, NOT, NEAR) and special characters to prevent syntax errors from user input
- storeEmbedding() and findUnembeddedTools() support the background embedding loop that Plan 02 will wire

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration 18 and ToolSearchResult type** - `2bcfe48` (feat)
2. **Task 2: Hybrid search methods on ToolRegistryRepository** - `90f2868` (feat)

## Files Created/Modified
- `src/storage/migrations.ts` - Migration 18: tool_registry_fts FTS5 table, sync triggers, rebuild, and conditional tool_registry_embeddings vec0 table
- `src/shared/tool-types.ts` - Added ToolSearchResult interface (tool, score, matchType)
- `src/storage/tool-registry.ts` - Added 6 search methods: searchTools, searchByKeyword, searchByVector, sanitizeQuery, storeEmbedding, findUnembeddedTools

## Decisions Made
- FTS5 BM25 weights: name at 2.0, description at 1.0 -- tool name matches are more valuable than description matches
- Functional migration with internal try/catch for vec0 creation -- FTS5 portion always runs regardless of sqlite-vec availability
- sanitizeQuery logic duplicated from SearchEngine rather than imported -- ToolRegistryRepository operates cross-project (not observation-scoped)
- searchByVector returns `tool_id` (snake_case) matching the SQL column name convention used throughout

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Search foundation complete: FTS5 + vec0 + RRF hybrid search ready for Plan 02
- Plan 02 will create the discover_tools MCP tool that calls searchTools()
- Background embedding loop (storeEmbedding + findUnembeddedTools) ready for Plan 02 wiring
- All methods handle errors gracefully with debug logging and empty-array fallbacks

## Self-Check: PASSED

All 3 files verified present. All 2 commit hashes verified in git log.

---
*Phase: 15-tool-search*
*Completed: 2026-02-11*
