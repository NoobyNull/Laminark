# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-08)

**Core value:** You never lose context. Every thread is recoverable, every thought is findable.
**Current focus:** Phase 4 in progress - Embedding Engine and Semantic Search

## Current Position

Phase: 4 of 8 (Embedding Engine and Semantic Search)
Plan: 1 of 4 in current phase (04-01 complete)
Status: Executing Phase 4
Last activity: 2026-02-09 — Completed 04-01 embedding engine foundation

Progress: [████████░░░░░░░░░░░░] 34%

## Performance Metrics

**Velocity:**
- Total plans completed: 11
- Average duration: 4min
- Total execution time: 0.65 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-storage-engine | 4/4 | 13min | 3min |
| 02-mcp-interface-and-search | 3/3 | 12min | 4min |
| 03-hook-integration-and-capture | 3/3 | 11min | 4min |
| 04-embedding-engine-and-semantic-search | 1/4 | 3min | 3min |

**Recent Trend:**
- Last 5 plans: 03-01 (3min), 03-02 (5min), 03-03 (3min), 04-01 (3min)
- Trend: Consistent

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 8-phase structure derived from 51 requirements following storage -> interface -> capture -> intelligence -> visualization dependency chain
- [Roadmap]: Research suggests starting with simple static topic threshold before adding EWMA adaptivity (Phase 6)
- [Roadmap]: Knowledge graph deferred to Phase 7 to ensure schema stability before visualization in Phase 8
- [01-01]: tsdown outputOptions.entryFileNames set to [name].js to produce dist/index.js matching package.json bin entry
- [01-01]: ObservationRow includes explicit integer rowid for FTS5 content_rowid compatibility
- [01-01]: Single database at ~/.laminark/data.db with project_hash scoping (user locked decision confirmed)
- [01-02]: PRAGMAs set in strict order: WAL first, then busy_timeout, synchronous NORMAL, cache_size, foreign_keys, temp_store, wal_autocheckpoint
- [01-02]: FTS5 content_rowid references explicit INTEGER PRIMARY KEY AUTOINCREMENT per research critical finding
- [01-02]: Migration 004 (vec0) conditionally applied based on sqlite-vec availability
- [01-03]: Constructor-bound projectHash ensures every query is project-scoped -- callers cannot accidentally query wrong project
- [01-03]: ORDER BY includes rowid DESC as tiebreaker for deterministic ordering within same-second timestamps
- [01-03]: FTS5 query sanitization strips operators and special characters to prevent syntax errors
- [01-03]: BM25 score exposed as Math.abs(rank) since bm25() returns negative values
- [01-04]: tsx added as devDependency for child_process.fork() TypeScript support in multi-process tests
- [01-04]: Crash simulation uses separate crash-writer.ts forked as child process for true process-level WAL recovery testing
- [01-04]: All 5 Phase 1 success criteria proven by 12 acceptance tests (78 total)
- [quick-1]: Debug logging via stderr (process.stderr.write) to keep stdout clean for MCP protocol
- [quick-1]: Cached isDebugEnabled() boolean for zero-cost no-op path when debug disabled
- [quick-1]: Debug categories: db, obs, search, session -- use debug(category, message, data?) pattern
- [02-01]: Used z.input instead of z.infer for ObservationInsert -- Zod v4 z.infer produces output type where defaulted fields are required
- [02-01]: FTS5 snippet column index 1 (content) after title column added at FTS5 position 0
- [02-01]: registerTool() used for MCP tool registration (not deprecated server.tool())
- [02-01]: MCP tool pattern: export registerXxx(server, db, projectHash) from src/mcp/tools/
- [02-01]: Token budget: 2000 default, 4000 full view, ~4 chars/token estimation
- [02-02]: BM25 weights 2.0 (title) / 1.0 (content) for title-biased relevance ranking
- [02-02]: Single unified recall tool with action parameter (view/purge/restore) -- not separate tools
- [02-02]: Purge/restore require explicit IDs -- no blind bulk operations on search results
- [02-03]: .mcp.json uses top-level server name key (plugin-bundled format, not mcpServers wrapper)
- [02-03]: Integration tests exercise storage layer directly -- MCP SDK is trusted dependency, test our logic on top
- [03-01]: Stop events log only (no observation) -- Stop has no tool_name/tool_input per hook spec
- [03-01]: processPostToolUse is synchronous -- better-sqlite3 is inherently synchronous, no awaits needed
- [03-02]: API key patterns applied before env_variable with negative lookahead to prevent double-match on redacted values
- [03-02]: Write/Edit tools unconditionally admitted via HIGH_SIGNAL_TOOLS set -- content patterns only apply to Bash/Read
- [03-02]: Laminark self-referential MCP tools (mcp__laminark__*) rejected in admission filter
- [03-02]: Privacy patterns cached per-process with _resetPatternCache() escape hatch for testing
- [03-01]: Self-referential filter: skip tools with mcp__laminark__ prefix to prevent recursive capture
- [03-03]: Handler orchestrates pipeline (processPostToolUseFiltered) -- extract -> file exclusion -> privacy redaction -> admission filter -> store
- [03-03]: LAMINARK_DATA_DIR env var added to getConfigDir() for test isolation without mocking
- [03-03]: Privacy filter runs before admission filter to prevent secret content in debug logs
- [04-01]: EmbeddingEngine interface with 6 methods -- all consumers depend on interface, never concrete engines
- [04-01]: LocalOnnxEngine uses dynamic import('@huggingface/transformers') for zero startup cost (DQ-04)
- [04-01]: Float32Array.from(output.data) for ONNX pipeline output -- ArrayLike<number> not ArrayBuffer
- [04-01]: Migration 006 recreates vec0 table with distance_metric=cosine for normalized BGE embeddings

### Pending Todos

- [database] Add cross-project memory sharing between Claude instances
- ~~[general] Add debug logging for all interactions~~ -- DONE (quick-1)

### Blockers/Concerns

- ~~Phase 3 (Hooks): Claude Code hooks API must be verified against current SDK version during planning~~ -- DONE (Phase 3 complete)
- Phase 4 (Embeddings): @huggingface/transformers replaces archived fastembed-js -- integration needs validation
- Phase 6 (Topic Detection): EWMA parameter tuning is novel territory, expect iteration
- Phase 7 (Knowledge Graph): Entity extraction from casual conversation text is noisy, start conservative

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 1 | Add debug logging infrastructure with LAMINARK_DEBUG env var and config.json support | 2026-02-08 | aa7666c | [1-add-debug-logging-infrastructure-with-la](./quick/1-add-debug-logging-infrastructure-with-la/) |

## Session Continuity

Last session: 2026-02-09
Stopped at: Completed 04-01-PLAN.md embedding engine foundation
Resume file: None
