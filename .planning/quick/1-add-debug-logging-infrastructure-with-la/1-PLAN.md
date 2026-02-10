---
phase: quick-debug-logging
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - src/shared/debug.ts
  - src/shared/config.ts
  - src/storage/database.ts
  - src/storage/observations.ts
  - src/storage/search.ts
  - src/storage/sessions.ts
  - src/storage/index.ts
autonomous: true

must_haves:
  truths:
    - "When LAMINARK_DEBUG=1 or config.json has debug:true, debug messages appear on stderr or in ~/.laminark/debug.log"
    - "When debug is off (default), zero output is produced by the debug logger"
    - "Database operations, search queries, and CRUD operations log their actions with timing when debug is enabled"
  artifacts:
    - path: "src/shared/debug.ts"
      provides: "Debug logger module with env var and config.json detection"
      exports: ["debug"]
    - path: "src/shared/config.ts"
      provides: "Updated config with debug config reading"
      exports: ["getConfigDir", "getDbPath", "getProjectHash", "getDatabaseConfig", "isDebugEnabled"]
  key_links:
    - from: "src/shared/debug.ts"
      to: "src/shared/config.ts"
      via: "isDebugEnabled() check"
      pattern: "isDebugEnabled"
    - from: "src/storage/database.ts"
      to: "src/shared/debug.ts"
      via: "debug() calls in openDatabase"
      pattern: "debug\\("
    - from: "src/storage/search.ts"
      to: "src/shared/debug.ts"
      via: "debug() calls with timing in search methods"
      pattern: "debug\\("
---

<objective>
Add cross-cutting debug logging infrastructure to Laminark controlled by `LAMINARK_DEBUG=1` env var or `~/.laminark/config.json` `"debug": true`.

Purpose: Enable developers and future phases to trace database operations, search queries, and CRUD activity for debugging without affecting normal operation (silent by default).

Output: `src/shared/debug.ts` logger module, updated config.ts with debug detection, and debug() calls wired into all storage layer modules.
</objective>

<execution_context>
@/home/matthew/.claude/get-shit-done/workflows/execute-plan.md
@/home/matthew/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/shared/config.ts
@src/shared/types.ts
@src/storage/database.ts
@src/storage/observations.ts
@src/storage/search.ts
@src/storage/sessions.ts
@src/storage/index.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create debug logger module and update config</name>
  <files>src/shared/debug.ts, src/shared/config.ts, src/storage/index.ts</files>
  <action>
Create `src/shared/debug.ts` with the following:

1. **`isDebugEnabled()` function** in `src/shared/config.ts`:
   - Check `process.env.LAMINARK_DEBUG` -- if `"1"` or `"true"`, return true
   - If env var not set, try reading `~/.laminark/config.json` using `readFileSync` in a try/catch (file may not exist). Parse JSON, return `config.debug === true`
   - Cache the result after first call (debug mode doesn't change mid-process)
   - Export from config.ts

2. **`debug()` function** in `src/shared/debug.ts`:
   - Signature: `debug(category: string, message: string, data?: Record<string, unknown>): void`
   - On first call, check `isDebugEnabled()`. If false, set an internal flag and all future calls are no-ops (zero cost path).
   - When enabled, format as: `[LAMINARK:{category}] {message}` followed by JSON-stringified data if present
   - Write to stderr using `process.stderr.write()` (not console.log -- keeps stdout clean for MCP)
   - Include ISO timestamp prefix: `[2026-02-08T12:00:00.000Z] [LAMINARK:db] message`

3. **`debugTimed()` helper** in `src/shared/debug.ts`:
   - Signature: `debugTimed<T>(category: string, message: string, fn: () => T): T`
   - Wraps a synchronous function, measures `performance.now()` before/after, logs `{message} ({duration}ms)` via `debug()`
   - When debug is disabled, just calls `fn()` directly with zero overhead (check the cached flag, don't wrap in timing)

4. **Export** `debug` and `debugTimed` from `src/storage/index.ts` and add `isDebugEnabled` to the config re-exports.

Do NOT use `fs.appendFileSync` to write to a log file -- stderr is sufficient. The log file approach adds complexity and can be added later if needed.
  </action>
  <verify>
Run `npx tsc --noEmit` to confirm no type errors. Manually verify the module exports are correct by checking the barrel file.
  </verify>
  <done>
`debug()` and `debugTimed()` exist in `src/shared/debug.ts`, `isDebugEnabled()` exists in `src/shared/config.ts`, all exported from barrel. When `LAMINARK_DEBUG` is unset, `debug()` is a no-op. When set to `"1"`, messages appear on stderr with timestamp, category, and message.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire debug logging into all storage layer modules</name>
  <files>src/storage/database.ts, src/storage/observations.ts, src/storage/search.ts, src/storage/sessions.ts</files>
  <action>
Add `debug()` and `debugTimed()` calls to all 4 storage modules. Import from `../shared/debug.js`.

**`src/storage/database.ts` (openDatabase):**
- After PRAGMA setup: `debug('db', 'PRAGMAs configured', { journalMode, busyTimeout: config.busyTimeout })`
- After sqlite-vec load attempt: `debug('db', hasVectorSupport ? 'sqlite-vec loaded' : 'sqlite-vec unavailable, keyword-only mode')`
- After migrations: `debug('db', 'Database opened', { path: config.dbPath, hasVectorSupport })`
- In close(): `debug('db', 'Database closed')`

**`src/storage/observations.ts` (ObservationRepository):**
- In constructor: `debug('obs', 'ObservationRepository initialized', { projectHash })`
- In create(): `debug('obs', 'Creating observation', { source: validated.source, contentLength: validated.content.length })` before insert, and `debug('obs', 'Observation created', { id })` after
- In list(): `debug('obs', 'Listing observations', { ...options })` and after: `debug('obs', 'Listed observations', { count: rows.length })`
- In softDelete(): `debug('obs', 'Soft-deleting observation', { id })` and result logging
- In update(): `debug('obs', 'Updating observation', { id })` and result logging

**`src/storage/search.ts` (SearchEngine):**
- In searchKeyword(): Use `debugTimed('search', 'FTS5 keyword search', () => { ...query execution... })` to wrap the actual query + mapping. Log query text and result count: `debug('search', 'Keyword search completed', { query: sanitized, resultCount: results.length })`
- In searchByPrefix(): Same pattern -- wrap with debugTimed, log prefix and result count
- In rebuildIndex(): `debug('search', 'Rebuilding FTS5 index')`

**`src/storage/sessions.ts` (SessionRepository):**
- In constructor: `debug('session', 'SessionRepository initialized', { projectHash })`
- In create(): `debug('session', 'Session created', { id })`
- In end(): `debug('session', 'Session ended', { id, hasSummary: !!summary })`

Keep all debug calls lightweight -- never stringify large data (observation content, embeddings). Only log IDs, counts, and metadata.
  </action>
  <verify>
Run `npx tsc --noEmit` to confirm no type errors. Run `npm test` to confirm all 78 existing tests still pass. Then run `LAMINARK_DEBUG=1 npx tsx -e "const { openDatabase, getDatabaseConfig } = require('./src/storage/index.js'); const db = openDatabase(getDatabaseConfig()); db.close();"` (or equivalent ESM import) to see debug output on stderr.
  </verify>
  <done>
All 4 storage modules emit debug logs when `LAMINARK_DEBUG=1` is set. All 78 existing tests pass unchanged. Debug output includes timestamps, categories (db, obs, search, session), and relevant metadata. When debug is off, zero output is produced.
  </done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` passes with zero errors
2. `npm test` passes all 78 existing tests (debug logging does not interfere)
3. `LAMINARK_DEBUG=1 npm test 2>debug.log && cat debug.log` shows debug output from test runs
4. Without LAMINARK_DEBUG set, `npm test 2>debug.log && wc -l debug.log` shows zero debug lines (only test runner output)
</verification>

<success_criteria>
- `src/shared/debug.ts` exports `debug()` and `debugTimed()` functions
- `src/shared/config.ts` exports `isDebugEnabled()` checking env var then config.json
- All 4 storage modules (database, observations, search, sessions) have debug instrumentation
- Silent by default -- zero output when debug is off
- All existing tests pass without modification
</success_criteria>

<output>
After completion, create `.planning/quick/1-add-debug-logging-infrastructure-with-la/1-SUMMARY.md`
</output>
