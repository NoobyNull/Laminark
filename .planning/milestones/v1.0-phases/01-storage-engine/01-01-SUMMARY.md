---
phase: 01-storage-engine
plan: 01
subsystem: database
tags: [typescript, sqlite, zod, tsdown, vitest, npm-package, esm]

# Dependency graph
requires: []
provides:
  - "@laminark/memory npm package scaffold with bin entry"
  - "Core type definitions (Observation, ObservationRow, ObservationInsert, Session, SearchResult, DatabaseConfig)"
  - "Zod validation schemas for database rows and inserts"
  - "rowToObservation mapping helper (snake_case DB to camelCase app layer)"
  - "Configuration utilities (getDbPath, getProjectHash, getConfigDir, getDatabaseConfig)"
  - "TypeScript toolchain (tsc, tsdown, vitest) configured for Node.js 22 ESM"
affects: [01-02, 01-03, 01-04, 02-mcp-server]

# Tech tracking
tech-stack:
  added: [better-sqlite3, sqlite-vec, zod, typescript, tsdown, vitest]
  patterns: [NodeNext ESM resolution, Zod schema-to-type inference, snake_case DB / camelCase app layer separation]

key-files:
  created:
    - package.json
    - tsconfig.json
    - tsdown.config.ts
    - vitest.config.ts
    - .gitignore
    - src/index.ts
    - src/storage/index.ts
    - src/shared/types.ts
    - src/shared/config.ts
  modified: []

key-decisions:
  - "tsdown outputOptions.entryFileNames set to [name].js to match package.json bin entry (tsdown defaults to .mjs for ESM)"
  - "Single database at ~/.laminark/data.db with project_hash scoping (user locked decision)"
  - "ObservationRow includes explicit integer rowid for FTS5 content_rowid compatibility"
  - "5000ms busy_timeout default to prevent SQLITE_BUSY under concurrent load"

patterns-established:
  - "snake_case for DB layer types (ObservationRow), camelCase for app layer (Observation)"
  - "Zod schemas for runtime validation with inferred TypeScript types"
  - "rowToObservation helper pattern for DB-to-app layer mapping"
  - "realpathSync + SHA-256 for deterministic project hashing"

# Metrics
duration: 3min
completed: 2026-02-08
---

# Phase 1 Plan 1: Project Scaffolding Summary

**@laminark/memory npm package with TypeScript ESM toolchain, Zod-validated core types, and ~/.laminark/data.db config utilities**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-08T18:54:48Z
- **Completed:** 2026-02-08T18:58:07Z
- **Tasks:** 2
- **Files created:** 9

## Accomplishments
- npm package @laminark/memory with bin entry `laminark-server` supporting both npx and global install
- Core type system: ObservationRow (DB layer with integer rowid for FTS5), Observation (app layer), ObservationInsert (Zod-validated input), Session, SearchResult, DatabaseConfig
- Configuration utilities resolving single database at ~/.laminark/data.db with SHA-256 project hashing
- Full TypeScript toolchain: tsc for type checking, tsdown for ESM builds with DTS, vitest for testing

## Task Commits

Each task was committed atomically:

1. **Task 1: Initialize npm package with TypeScript toolchain** - `b5fabd1` (feat)
2. **Task 2: Create core type definitions and configuration utilities** - `f48f741` (feat)

## Files Created/Modified
- `package.json` - @laminark/memory npm package manifest with Phase 1 deps and bin entry
- `tsconfig.json` - TypeScript config for Node.js 22 ESM with NodeNext resolution
- `tsdown.config.ts` - ESM build config with .js output and DTS generation
- `vitest.config.ts` - Test runner configured for src/**/*.test.ts
- `.gitignore` - Ignores node_modules, dist, *.db, .env, coverage
- `src/index.ts` - Package entry point with shebang for CLI execution
- `src/storage/index.ts` - Placeholder barrel export for storage module (Plan 01-02)
- `src/shared/types.ts` - Core type definitions with Zod schemas and rowToObservation helper
- `src/shared/config.ts` - Database path resolution, project hashing, config defaults

## Decisions Made
- **tsdown .js output:** tsdown defaults to `.mjs` extension for ESM format. Added `outputOptions.entryFileNames: '[name].js'` to produce `dist/index.js` matching the package.json bin and main entries.
- **Followed all locked decisions:** Single database at `~/.laminark/data.db`, package name `@laminark/memory`, bin entry `laminark-server`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tsdown .mjs output mismatch with package.json bin entry**
- **Found during:** Task 1 (build verification)
- **Issue:** tsdown produced `dist/index.mjs` but package.json bin and main pointed to `dist/index.js`
- **Fix:** Added `outputOptions: { entryFileNames: '[name].js' }` to tsdown.config.ts
- **Files modified:** tsdown.config.ts
- **Verification:** `npx tsdown` now produces `dist/index.js` with shebang preserved
- **Committed in:** b5fabd1 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary fix for correct npm bin entry resolution. No scope creep.

## Issues Encountered
- vitest exits with code 1 when no test files exist. This is expected behavior and not an error -- the test infrastructure is functional and will work once test files are added in later plans.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Types and config are ready for Plan 01-02 (database connection manager, migrations, CRUD)
- All subsequent plans can import from `src/shared/types.js` and `src/shared/config.js`
- Build toolchain verified: `npm run build`, `npm run check`, `npm test` all operational

## Self-Check: PASSED

- All 9 created files verified present on disk
- Commit b5fabd1 (Task 1) verified in git log
- Commit f48f741 (Task 2) verified in git log

---
*Phase: 01-storage-engine*
*Completed: 2026-02-08*
