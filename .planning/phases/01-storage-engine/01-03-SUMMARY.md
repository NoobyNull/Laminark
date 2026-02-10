---
phase: 01-storage-engine
plan: 03
subsystem: database
tags: [sqlite, better-sqlite3, fts5, bm25, crud, prepared-statements, project-scoping]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Core types (Observation, ObservationInsert, Session, SearchResult, rowToObservation), Zod schemas, config utilities"
  - phase: 01-02
    provides: "openDatabase() with WAL mode, migrations (observations, sessions, FTS5 tables with sync triggers)"
provides:
  - "ObservationRepository: project-scoped CRUD with prepared statements (create, getById, list, update, softDelete, restore, count)"
  - "SessionRepository: project-scoped session lifecycle (create, end, getById, getLatest, getActive)"
  - "SearchEngine: FTS5 keyword search with BM25 ranking, snippets, prefix search, query sanitization"
  - "Complete storage barrel export (openDatabase, repos, search, types, config)"
affects: [01-04, 02-mcp-server]

# Tech tracking
tech-stack:
  added: []
  patterns: [constructor-bound project scoping, prepared statements for static queries, FTS5 MATCH with BM25 ordering, query sanitization for FTS5 safety, rowid DESC tiebreaker for deterministic ordering]

key-files:
  created:
    - src/storage/observations.ts
    - src/storage/sessions.ts
    - src/storage/search.ts
    - src/storage/__tests__/repositories.test.ts
    - src/storage/__tests__/search.test.ts
  modified:
    - src/storage/index.ts

key-decisions:
  - "Constructor-bound projectHash ensures every query is project-scoped -- callers cannot accidentally query wrong project"
  - "ORDER BY includes rowid DESC as tiebreaker for deterministic ordering within same-second timestamps"
  - "FTS5 query sanitization strips operators (NEAR, OR, AND, NOT) and special characters to prevent syntax errors"
  - "BM25 score exposed as Math.abs(rank) since bm25() returns negative values"

patterns-established:
  - "Repository pattern: constructor takes db + projectHash, prepares statements once, all methods auto-scope"
  - "Dynamic WHERE clause building for optional filters (sessionId, since) in list/search"
  - "FTS5 query sanitization: strip special chars, filter operator keywords, join with spaces for implicit AND"
  - "rowid DESC tiebreaker pattern for deterministic ordering with second-precision timestamps"

# Metrics
duration: 4min
completed: 2026-02-08
---

# Phase 1 Plan 3: Data Access Layer Summary

**Project-scoped ObservationRepository, SessionRepository, and FTS5 SearchEngine with BM25 ranking, prepared statements, and 46 tests proving cross-project isolation**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-08T19:06:33Z
- **Completed:** 2026-02-08T19:10:35Z
- **Tasks:** 2
- **Files created/modified:** 6

## Accomplishments
- ObservationRepository with 7 methods (create, getById, list, update, softDelete, restore, count) all enforcing project_hash scoping via constructor-bound prepared statements
- SessionRepository with 5 methods (create, end, getById, getLatest, getActive) all project-scoped
- FTS5 SearchEngine with BM25 ranking, snippet extraction, prefix search for autocomplete, and query sanitization preventing injection/syntax errors
- Complete barrel export from src/storage/index.ts providing the full storage API for Phase 2 consumption
- 46 new tests (28 repository + 18 search) proving project isolation, soft-delete exclusion, embedding roundtrip, BM25 ranking, and FTS5 safety

## Task Commits

Each task was committed atomically:

1. **Task 1: Create ObservationRepository and SessionRepository with project-scoped CRUD** - `94cb69b` (feat)
2. **Task 2: Create FTS5 search engine with BM25 ranking, snippets, and project scoping** - `eb443ae` (feat)

## Files Created/Modified
- `src/storage/observations.ts` - ObservationRepository with project-scoped CRUD and prepared statements (231 lines)
- `src/storage/sessions.ts` - SessionRepository with session lifecycle management (141 lines)
- `src/storage/search.ts` - FTS5 SearchEngine with BM25 ranking, snippets, prefix search, query sanitization (179 lines)
- `src/storage/index.ts` - Updated barrel export with all storage modules, types, and config re-exports
- `src/storage/__tests__/repositories.test.ts` - 28 tests for observation CRUD and session lifecycle
- `src/storage/__tests__/search.test.ts` - 18 tests for FTS5 search, project isolation, sanitization

## Decisions Made
- **Constructor-bound project scoping:** projectHash is set once at construction time and baked into every query. Callers cannot accidentally query the wrong project -- this is the MEM-06/SRC-05 isolation guarantee.
- **rowid DESC tiebreaker:** SQLite datetime('now') has second-level precision, so rows created in rapid succession share timestamps. Added `ORDER BY created_at DESC, rowid DESC` to guarantee deterministic insertion-order results.
- **FTS5 query sanitization:** Strips quotes, parentheses, asterisks, and FTS5 operator keywords (NEAR, OR, AND, NOT) to prevent syntax errors from user input. Returns empty array for all-operator queries.
- **BM25 score as absolute value:** bm25() returns negative values (more negative = more relevant). Exposed as `Math.abs(rank)` in SearchResult.score for intuitive positive scoring.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Non-deterministic ordering within same-second timestamps**
- **Found during:** Task 1 (repository tests)
- **Issue:** `ORDER BY created_at DESC` produced non-deterministic results when multiple rows had identical timestamps (SQLite second-precision datetime)
- **Fix:** Added `rowid DESC` as tiebreaker to both ObservationRepository.list() and SessionRepository.getLatest()
- **Files modified:** src/storage/observations.ts, src/storage/sessions.ts
- **Verification:** Ordering tests now pass deterministically
- **Committed in:** 94cb69b (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix for deterministic query ordering. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The complete storage API (ObservationRepository, SessionRepository, SearchEngine) is ready for Plan 01-04 (CLI integration) and Phase 2 (MCP server)
- All 66 tests pass (20 database + 28 repository + 18 search)
- Build succeeds with `npx tsdown` -- all modules bundled correctly
- Barrel export provides single import point: `import { openDatabase, ObservationRepository, SessionRepository, SearchEngine } from './storage/index.js'`

## Self-Check: PASSED

- All 6 created/modified files verified present on disk
- Commit 94cb69b (Task 1) verified in git log
- Commit eb443ae (Task 2) verified in git log

---
*Phase: 01-storage-engine*
*Completed: 2026-02-08*
