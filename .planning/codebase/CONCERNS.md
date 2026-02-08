# Codebase Concerns

**Analysis Date:** 2026-02-08

## Tech Debt

**Missing BEGIN IMMEDIATE for write transactions:**
- Issue: All write operations (inserts, updates) use automatic transaction handling without explicit `BEGIN IMMEDIATE`. Per SQLite research, upgrading from read to write transaction bypasses busy_timeout and returns SQLITE_BUSY instantly under concurrent access.
- Files: `src/storage/observations.ts` (create, update, softDelete, restore methods), `src/storage/sessions.ts` (create, end methods)
- Impact: Under concurrent write load, operations may fail with SQLITE_BUSY despite 5000ms busy_timeout being configured. Users running multiple Claude sessions will see intermittent write failures.
- Fix approach: Wrap write operations in explicit `db.transaction()` or use manual `BEGIN IMMEDIATE` / `COMMIT` blocks. Better-sqlite3 supports `db.transaction(fn)` which handles this correctly.

**No write transaction usage:**
- Issue: Repository methods use individual prepared statements without transaction wrappers. Each statement runs in autocommit mode.
- Files: `src/storage/observations.ts`, `src/storage/sessions.ts`
- Impact: Multi-step operations (insert + read-back) are not atomic. Under concurrent access, another writer could interleave operations, causing inconsistent reads. Performance penalty from excessive WAL checkpoints.
- Fix approach: Use better-sqlite3's `db.transaction()` wrapper for multi-statement operations. Single-statement operations are already atomic but would benefit from explicit transactions under high concurrency.

**FTS5 query sanitization may be too aggressive:**
- Issue: `SearchEngine.sanitizeQuery()` strips all FTS5 operators (NEAR, OR, AND, NOT) to prevent syntax errors. This prevents users from using intentional boolean search.
- Files: `src/storage/search.ts` (lines 117-145)
- Impact: Power users cannot perform advanced searches like "react AND (hooks OR context)" or "bug NEAR/3 authentication". Forced to use implicit AND only.
- Fix approach: Add a `strict` parameter to `searchKeyword()` defaulting to `true` (safe mode). When false, allow operators through with validation. Or provide a separate `searchAdvanced()` method for power users.

**Hardcoded embedding dimensions:**
- Issue: Migration 004 hardcodes `embedding float[384]` for vec0 table. Switching to a model with different dimensions (e.g., 768 or 1536) requires schema migration.
- Files: `src/storage/migrations.ts` (line 103)
- Impact: Locked to 384-dim models (all-MiniLM-L6-v2, BGE Small EN v1.5). Using larger models like text-embedding-3-small (1536-dim) or Jina v2 (768-dim) requires dropping and recreating vec0 table.
- Fix approach: Phase 4 implementation should detect model dimensions dynamically and create vec0 table with matching dimension. Store dimension metadata in schema or config. Accept migration cost as one-time penalty.

**sqlite-vec is alpha software:**
- Issue: sqlite-vec v0.1.7-alpha.2 is pre-1.0 and may have API breaking changes or stability issues in production.
- Files: `src/storage/database.ts` (line 2), `src/storage/migrations.ts` (migration 004), `package.json` (line 41)
- Impact: Future sqlite-vec updates may require migration rewrites or introduce breaking changes. Alpha software carries higher risk of bugs affecting vector search accuracy.
- Fix approach: Monitor sqlite-vec releases. Pin to specific alpha version in package.json. Graceful degradation is already implemented (line 69-75 in database.ts) - vector search failure does not break keyword search. Consider this acceptable risk for Phase 1-3, reevaluate at Phase 4.

## Known Bugs

**None currently identified:**
- All 78 tests pass
- No TODO/FIXME comments found in production code
- Phase 1 verification completed successfully per 01-VERIFICATION.md

## Security Considerations

**No secret detection in observation admission:**
- Risk: If Claude outputs API keys, tokens, or credentials in tool responses, they will be stored in observations table and searchable via MCP tools or web UI.
- Files: Future Phase 3 admission filter (not yet implemented)
- Current mitigation: None - Phase 1 has no admission filtering
- Recommendations: Phase 3 must implement secret pattern detection before PostToolUse hook captures real data. Regex patterns for common formats: `sk-[a-zA-Z0-9]{32,}`, `ghp_[a-zA-Z0-9]{36}`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z-_]{35}`, etc. Reject or redact observations matching patterns.

**Database file permissions not enforced:**
- Risk: Default file creation uses system umask. On multi-user systems, other users may read `~/.laminark/data.db` containing conversation history.
- Files: `src/storage/database.ts` (line 33 - mkdirSync creates directory but doesn't set file permissions)
- Current mitigation: Database stored in user home directory (~/.laminark/) provides basic isolation
- Recommendations: After database creation, explicitly set file permissions to 0600 (owner read/write only) using `fs.chmodSync()`. Apply to both .db and WAL/SHM files.

**No CORS or authentication on future web UI:**
- Risk: Phase 8 web server will bind to localhost but may be accessible to other processes on the same machine. No authentication layer planned.
- Files: Future Phase 8 implementation
- Current mitigation: None - web UI not implemented yet
- Recommendations: Phase 8 must bind to 127.0.0.1 only (not 0.0.0.0). Generate session token on server start and require it for WebSocket connections. Add CORS headers restricting to same-origin.

## Performance Bottlenecks

**No progressive retrieval implemented yet:**
- Problem: Phase 2 MCP tools will return full observation content in search results. Research (PITFALLS.md) warns this causes context window poisoning at ~2000 tokens per search.
- Files: Future Phase 2 MCP tool implementations
- Cause: 3-layer progressive disclosure pattern (compact index → timeline → full details) is planned but not yet implemented in Phase 1 storage layer
- Improvement path: Phase 2 must implement token-limited response format. Return `id`, `snippet`, `score` only by default. Full content on explicit drill-down via separate tool call.

**FTS5 searches are not cached:**
- Problem: Repeated identical searches recompute BM25 ranking every time
- Files: `src/storage/search.ts` (searchKeyword method)
- Cause: Stateless SearchEngine class with no query cache
- Improvement path: Add LRU cache for last N search results keyed by (query, projectHash, sessionId, limit). 50-100 entry cache would cover typical usage. Invalidate on new observations. This is optional optimization for Phase 4+, not critical for MVP.

**Observation list queries scale linearly:**
- Problem: `ObservationRepository.list()` builds dynamic SQL with optional filters and loads full rows into memory
- Files: `src/storage/observations.ts` (list method around line 107-147 based on test coverage)
- Cause: No pagination, no streaming, no limit enforcement. Returns entire result set.
- Improvement path: Add cursor-based pagination using `rowid > ?` for continuation. Enforce sane default limit (100-500). Phase 5 context loading will benefit most from this.

## Fragile Areas

**Migration 004 conditional application:**
- Files: `src/storage/migrations.ts` (lines 157-160)
- Why fragile: Migration 004 (vec0 table) is skipped when sqlite-vec fails to load. If a user installs sqlite-vec AFTER first run, the migration won't auto-apply on next startup because maxVersion tracking shows migration 004 as "attempted but skipped."
- Safe modification: When adding Phase 4 vector search code, check `hasVectorSupport` AND verify vec0 table exists. If hasVectorSupport=true but table missing, manually apply migration 004. Do not assume maxVersion >= 4 means vec0 exists.
- Test coverage: No test for "sqlite-vec installed after initial run" scenario

**FTS5 content_rowid dependency on explicit rowid:**
- Files: `src/storage/migrations.ts` (migration 001 line 29, migration 003 line 72)
- Why fragile: FTS5 external content table references `observations.rowid` via `content_rowid='rowid'`. SQLite implicit rowids are NOT stable across VACUUM when using TEXT PRIMARY KEY. Migration 001 correctly uses `rowid INTEGER PRIMARY KEY AUTOINCREMENT`, but changing this breaks FTS5.
- Safe modification: NEVER change observations table to use `id TEXT PRIMARY KEY` without explicit integer rowid. NEVER use `WITHOUT ROWID` on observations table. If schema changes are needed, test FTS5 sync triggers after VACUUM.
- Test coverage: No test verifying FTS5 survives VACUUM operation

**Project scoping relies on constructor-bound hash:**
- Files: `src/storage/observations.ts`, `src/storage/sessions.ts`, `src/storage/search.ts`
- Why fragile: Project isolation is enforced by passing projectHash at repository construction time. Callers must correctly compute project hash. No runtime validation that projectHash matches actual project.
- Safe modification: When integrating with MCP server (Phase 2), verify project hash computation is consistent. Do not create multiple repository instances with different hashes for same project. Consider adding a `validateProject(projectHash)` method.
- Test coverage: Cross-project isolation tested in repositories.test.ts and search.test.ts, but no test for "wrong projectHash passed to constructor"

**WAL checkpoint only on explicit close:**
- Files: `src/storage/database.ts` (close method lines 85-92)
- Why fragile: WAL checkpoints only occur on clean shutdown via `laminark.close()`. If process crashes or is killed (SIGKILL), WAL file persists and grows across sessions. Under sustained write load without clean shutdown, WAL can grow to hundreds of MB.
- Safe modification: Add periodic checkpoint triggers (e.g., on session end, after N writes). Phase 3 should call `laminark.checkpoint()` at session boundaries. Set `wal_autocheckpoint` pragma (already set to 1000 pages) as backstop.
- Test coverage: crash-recovery.test.ts verifies WAL recovery after unclean shutdown but doesn't measure WAL file growth

## Scaling Limits

**Single database file:**
- Current capacity: Tested with thousands of observations in concurrency tests, performs well
- Limit: SQLite WAL mode supports unlimited readers but only ONE writer at a time across all processes. Concurrent writers serialize via busy_timeout. Beyond 5-10 concurrent sessions with heavy write load, latency will increase.
- Scaling path: For >10 concurrent sessions, consider per-project database files instead of single shared database. Or: reader/writer split with separate read-only connections for search and single writer process with message queue.

**FTS5 index rebuild on schema change:**
- Current capacity: ~10k observations reindex in <1 second
- Limit: FTS5 rebuild scales linearly. At 100k+ observations, full reindex takes multiple seconds and blocks writes.
- Scaling path: Phase 2+ should implement partial reindex (only new/modified observations) and background reindex scheduling.

**No observation size limits enforced:**
- Current capacity: Zod schema limits content to 100,000 chars (ObservationInsertSchema line 62 in types.ts)
- Limit: No aggregate database size limit. User could accumulate GB of observations over months/years.
- Scaling path: Implement retention policy (auto-delete observations older than N months with low retrieval score). Add `laminark vacuum` command to VACUUM and reclaim space. Phase 5+ should add observation admission filter with size/value heuristics.

## Dependencies at Risk

**better-sqlite3 native compilation:**
- Risk: Requires C++ build toolchain (python, make, gcc/clang) on install. Fails on machines without build tools.
- Impact: Installation fails with cryptic node-gyp errors. Users on locked-down corporate machines or minimal Docker images cannot install.
- Migration plan: Node 23.5+ includes built-in `node:sqlite` but it's not LTS yet and lacks extension loading (needed for sqlite-vec). For Phase 2-3, accept better-sqlite3 as-is. For Phase 4+, evaluate prebuilt binaries or bundling compiled sqlite-vec. Document installation prereqs clearly.

**sqlite-vec alpha status:**
- Risk: Pre-1.0 software may have breaking API changes or be abandoned
- Impact: Phase 4 vector search would break on sqlite-vec updates
- Migration plan: If sqlite-vec stalls or breaks, fallback options: (1) Compile sqlite-vec from C source and bundle, (2) Use libsql/Turso's vector support (requires libSQL client instead of better-sqlite3), (3) Implement custom vector search in JavaScript (slow but functional). Graceful degradation already handles missing sqlite-vec by skipping migration 004.

**zod v4.3 is recent:**
- Risk: Zod v4 released recently, may have undiscovered bugs
- Impact: Schema validation could fail unexpectedly or allow invalid data
- Migration plan: Pin exact version in package.json. Monitor Zod releases. If v4 proves unstable, rollback to zod@3.x (API is mostly compatible).

## Missing Critical Features

**No admission filtering (Phase 3 requirement):**
- Problem: MEM-10 requires noise filtering but Phase 1 stores everything
- Blocks: Phase 3 hook integration cannot ship without admission policy
- Priority: High - must be implemented before PostToolUse hook captures production data

**No embedding model metadata persistence (Phase 4 requirement):**
- Problem: INT-01 requires pluggable embedding strategies but schema only tracks model version string, not strategy type or configuration
- Blocks: Phase 4 cannot implement hybrid embedding strategy (ONNX + Claude piggyback) without knowing which observations used which strategy
- Priority: Medium - schema change needed before Phase 4 starts

**No session context loading (Phase 5 requirement):**
- Problem: CTX-01 requires progressive disclosure index on SessionStart but no API to fetch "high-value observations from last session"
- Blocks: Phase 5 session summaries cannot implement 2-second context load without ranked retrieval API
- Priority: Medium - can be added to ObservationRepository in Phase 2-3 as preparation

## Test Coverage Gaps

**No VACUUM stability tests:**
- What's not tested: FTS5 content_rowid stability after VACUUM, embedding BLOB integrity after VACUUM
- Files: All test files in `src/storage/__tests__/`
- Risk: Schema uses correct explicit rowid but VACUUM scenario is untested. Could surface corruption bugs in production.
- Priority: Medium - add in Phase 2 as regression test

**No migration downgrade tests:**
- What's not tested: What happens if user downgrades package version and runs older code against newer schema
- Files: `src/storage/migrations.ts`
- Risk: Migration tracking table has no version bounds checking. Old code running against new schema could cause silent data corruption or crashes.
- Priority: Low - npm packages rarely downgrade, but add `MAX_SUPPORTED_VERSION` check in Phase 2

**No concurrent read-during-write tests:**
- What's not tested: Reader sessions querying while writer session is mid-transaction
- Files: `src/storage/__tests__/concurrency.test.ts`
- Risk: WAL mode should handle this correctly, but behavior under high concurrency is untested
- Priority: Low - concurrency.test.ts covers concurrent writes (harder case), reads should work

**No large dataset performance tests:**
- What's not tested: Behavior with 100k+ observations, FTS5 search performance degradation over time
- Files: All test files
- Risk: No performance regression detection. Could ship Phase 2-3 with queries that don't scale.
- Priority: Medium - add benchmark test fixture with 50k-100k synthetic observations in Phase 2

---

*Concerns audit: 2026-02-08*
