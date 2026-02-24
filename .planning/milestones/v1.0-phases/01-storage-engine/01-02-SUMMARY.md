---
phase: 01-storage-engine
plan: 02
subsystem: database
tags: [sqlite, wal, fts5, sqlite-vec, better-sqlite3, migrations]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Core types (DatabaseConfig, ObservationRow), config utilities (getDbPath, getDatabaseConfig), package scaffold"
provides:
  - "openDatabase() function returning configured WAL-mode SQLite with PRAGMAs, sqlite-vec, and migrations"
  - "LaminarkDatabase interface with close() and checkpoint() lifecycle methods"
  - "Version-tracked migration system with _migrations table"
  - "observations table with INTEGER PRIMARY KEY AUTOINCREMENT for FTS5 rowid stability"
  - "sessions table for session lifecycle"
  - "FTS5 external content table with porter+unicode61 tokenizer and sync triggers"
  - "Conditional vec0 table for 384-dim embeddings"
affects: [01-03, 01-04, 02-mcp-server]

# Tech tracking
tech-stack:
  added: []
  patterns: [WAL-first PRAGMA ordering, FTS5 external content with stable integer rowid, version-tracked migrations, sqlite-vec graceful degradation]

key-files:
  created:
    - src/storage/database.ts
    - src/storage/migrations.ts
    - src/storage/__tests__/database.test.ts
  modified:
    - src/storage/index.ts

key-decisions:
  - "PRAGMAs set in strict order: journal_mode WAL first, then busy_timeout, synchronous NORMAL, cache_size, foreign_keys, temp_store, wal_autocheckpoint"
  - "FTS5 content_rowid references explicit INTEGER PRIMARY KEY AUTOINCREMENT (not implicit rowid) per research critical finding"
  - "Migration 004 (vec0) conditionally applied based on hasVectorSupport flag -- silently skipped if sqlite-vec unavailable"
  - "close() attempts WAL checkpoint before db.close() for clean shutdown"

patterns-established:
  - "openDatabase() as single entry point for database lifecycle with LaminarkDatabase wrapper"
  - "Version-tracked migrations with _migrations table and idempotent runMigrations()"
  - "FTS5 sync triggers pattern: 3 triggers (ai/au/ad) keep external content table in sync"
  - "Conditional migration pattern: skip migration based on runtime capability"

# Metrics
duration: 3min
completed: 2026-02-08
---

# Phase 1 Plan 2: Database Initialization Summary

**SQLite WAL-mode database with 7 PRAGMAs in correct order, 4-migration schema (observations, sessions, FTS5 with sync triggers, conditional vec0), and sqlite-vec graceful degradation**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-08T19:00:43Z
- **Completed:** 2026-02-08T19:04:03Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Database connection manager (openDatabase) with WAL mode, 7 PRAGMAs in documented order, sqlite-vec loading with graceful degradation, and LaminarkDatabase lifecycle interface
- Version-tracked migration system that applies 4 migrations atomically and skips already-applied versions on reopen
- FTS5 external content table with porter+unicode61 tokenizer and 3 sync triggers (INSERT, UPDATE, DELETE) verified working
- 20 passing tests covering PRAGMAs, schema correctness, FTS5 trigger sync, data persistence across close/reopen, and migration idempotency

## Task Commits

Each task was committed atomically:

1. **Task 1: Create database connection manager with WAL mode, PRAGMAs, and sqlite-vec** - `4a2ff6f` (feat)
2. **Task 2: Create migration system and initial schema with FTS5 external content** - `7f16370` (feat)

## Files Created/Modified
- `src/storage/database.ts` - Database connection manager with WAL mode, PRAGMA setup, sqlite-vec loading, LaminarkDatabase interface
- `src/storage/migrations.ts` - Version-tracked migration system with 4 migrations: observations, sessions, FTS5, vec0
- `src/storage/index.ts` - Barrel export for openDatabase, LaminarkDatabase, runMigrations, MIGRATIONS
- `src/storage/__tests__/database.test.ts` - 20 tests covering PRAGMAs, schema, FTS5 triggers, persistence, idempotency

## Decisions Made
- **PRAGMA ordering enforced:** journal_mode WAL is set first because synchronous=NORMAL is only safe with WAL active. Verified via test that journal_mode returns 'wal'.
- **FTS5 rowid design:** observations uses explicit `rowid INTEGER PRIMARY KEY AUTOINCREMENT` per research critical finding. This ensures content_rowid stability across VACUUM operations.
- **Conditional vec0 migration:** Migration 004 is skipped when hasVectorSupport is false, allowing keyword-only operation. Will be applied on future reopen when sqlite-vec becomes available.
- **close() with checkpoint:** close() runs PRAGMA wal_checkpoint(PASSIVE) before db.close() for clean WAL flush. Wrapped in try/catch so close always completes even if checkpoint fails.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- openDatabase() is ready for Plan 01-03 (observation CRUD operations) and Plan 01-04 (search)
- LaminarkDatabase.db provides the raw better-sqlite3 connection for prepared statements
- hasVectorSupport flag enables conditional vector search paths
- All schema tables (observations, sessions, observations_fts, observation_embeddings) are created and indexed

## Self-Check: PASSED

- All 4 created/modified files verified present on disk
- Commit 4a2ff6f (Task 1) verified in git log
- Commit 7f16370 (Task 2) verified in git log

---
*Phase: 01-storage-engine*
*Completed: 2026-02-08*
