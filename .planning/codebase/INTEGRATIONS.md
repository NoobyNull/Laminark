# External Integrations

**Analysis Date:** 2026-02-08

## APIs & External Services

**None:**
- This is a local-first library with no external API dependencies
- All functionality runs on local filesystem

## Data Storage

**Databases:**
- SQLite3 (via better-sqlite3)
  - Connection: Local file at `~/.laminark/data.db`
  - Client: better-sqlite3 (synchronous SQLite bindings)
  - Mode: WAL (Write-Ahead Logging)
  - Extensions: sqlite-vec for vector similarity search (optional)

**File Storage:**
- Local filesystem only
  - Database file: `~/.laminark/data.db`
  - WAL files: `~/.laminark/data.db-wal`, `~/.laminark/data.db-shm`
  - Config directory: `~/.laminark/`

**Caching:**
- SQLite page cache (64MB configured via PRAGMA `cache_size = -64000`)
- No external caching layer

## Authentication & Identity

**Auth Provider:**
- None - Local filesystem access only
  - Implementation: Relies on OS-level file permissions

**Project Scoping:**
- SHA-256 hash of canonical directory path
  - Implementation: `src/shared/config.ts` `getProjectHash()`
  - Single database with multi-project isolation via `project_hash` column

## Monitoring & Observability

**Error Tracking:**
- None - Library consumers handle error reporting

**Logs:**
- Console warnings only (e.g., WAL mode activation failures)
- No structured logging framework
- Location: `src/storage/database.ts` line 44-47

## CI/CD & Deployment

**Hosting:**
- npm registry (package name: `@laminark/memory`)

**CI Pipeline:**
- None detected (no `.github/workflows/` directory)

**Build Process:**
- Local: `npm run build` (via tsdown)
- Pre-publish: `prepublishOnly` script runs build automatically

## Environment Configuration

**Required env vars:**
- None - All configuration is code-based

**Secrets location:**
- Not applicable - No secrets required for local-only operation

**Configuration:**
- Database path: Hardcoded to `~/.laminark/data.db` in `src/shared/config.ts`
- Busy timeout: 5000ms default in `src/shared/config.ts`
- All config exposed via `getDatabaseConfig()` function

## Webhooks & Callbacks

**Incoming:**
- None - Library/CLI tool with no HTTP server

**Outgoing:**
- None - No external service calls

## Extension Architecture

**SQLite Extensions:**
- sqlite-vec (optional vector search)
  - Loaded at runtime in `src/storage/database.ts` line 71-75
  - Graceful degradation if unavailable (hasVectorSupport flag)
  - Creates vec0 virtual table when available (migration 004)

**Integration Points:**
- FTS5 (Full-Text Search) - Built-in SQLite extension
  - Virtual table: `observations_fts`
  - Tokenizer: `porter unicode61`
  - Sync triggers maintain index automatically

---

*Integration audit: 2026-02-08*
