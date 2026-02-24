# Phase 1: Storage Engine - Research

**Researched:** 2026-02-08
**Domain:** SQLite storage engine with WAL, FTS5, sqlite-vec, and npm package distribution
**Confidence:** HIGH

## Summary

Phase 1 builds a durable, concurrent-safe SQLite storage layer for observations with full-text indexing. The technology stack is well-proven: better-sqlite3 v12.6 for the synchronous SQLite driver, FTS5 for keyword search with BM25 ranking, and sqlite-vec v0.1.6 for future vector search. The package must be distributed as `@laminark/memory` on npm with both `npx` and global install support.

Research uncovered one critical schema design issue in the existing plan files: **FTS5 external content tables require a stable integer rowid for the `content_rowid` reference, but the existing plans define the observations table with `id TEXT PRIMARY KEY`**. SQLite's implicit rowid on such tables is NOT stable across VACUUM operations and can cause "database disk image is malformed" errors. The schema must use an explicit `INTEGER PRIMARY KEY` column (or use WITHOUT ROWID carefully, which is incompatible with FTS5 external content). The recommended fix is to add an explicit `rowid INTEGER PRIMARY KEY AUTOINCREMENT` and keep the text `id` as a UNIQUE indexed column.

Additionally, research confirms that `BEGIN IMMEDIATE` is required for write transactions to avoid the well-documented "upgrade from read to write" failure where `busy_timeout` is silently bypassed, returning SQLITE_BUSY instantly.

**Primary recommendation:** Use an explicit integer primary key on the observations table for FTS5 compatibility, use `BEGIN IMMEDIATE` for all write transactions, and keep WAL mode as the first PRAGMA after connection.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- npm package name: `@laminark/memory` (scoped, leaves room for future packages like `@laminark/cli`)
- Must be installable via Claude plugins -- never require users to clone and run from source
- Support both install methods:
  - **npx** (quick start, always latest): `claude mcp add laminark -- npx @laminark/memory`
  - **Global install** (pinned version): `npm i -g @laminark/memory`, then `claude mcp add laminark -- laminark-server`
- No other Claude official plugins required as dependencies -- self-contained MCP server
- SQLite database stored at `~/.laminark/data.db`
- Dedicated dot-directory in home (`~/.laminark/`) -- easy to find, back up, and delete
- Config file at `~/.laminark/config.json` alongside the database
- One directory for everything Laminark-related

### Claude's Discretion
- Database schema details and migration strategy
- WAL mode and concurrency implementation approach
- FTS5 configuration and tokenizer choice
- Project isolation mechanism (how project scoping works internally)
- Data retention defaults and observation size limits

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6 | Synchronous SQLite driver | 100x faster than async alternatives for local queries. Prebuilt binaries for Node 22 LTS. Supports `loadExtension()` for sqlite-vec. The fastest SQLite library for Node.js. **Confidence: HIGH** |
| SQLite FTS5 | (built into SQLite) | Full-text keyword search | Compiled into better-sqlite3's bundled SQLite. BM25 ranking, external content tables, porter stemmer. No additional dependency. **Confidence: HIGH** |
| sqlite-vec | ^0.1.6 | Vector similarity search (future) | Pure C, zero dependencies. Loads via `sqliteVec.load(db)`. Supports float, int8, binary vectors. Metadata columns, auxiliary columns, partition keys. **Confidence: MEDIUM** (alpha, but API is stable for our use case) |
| zod | ^4.3 | Schema validation | MCP SDK peer dependency. Also validates observation inserts at runtime. 2kb gzipped. **Confidence: HIGH** |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tsdown | ^0.20 | TypeScript bundler | Build ESM output with type declarations. Successor to tsup. Used for `npm run build`. **Confidence: MEDIUM** (0.x but functional) |
| vitest | ^4.0 | Testing | Out-of-box ESM + TypeScript. Fast parallel execution. Used for unit and acceptance tests. **Confidence: HIGH** |
| typescript | ~5.8 | Type checking | `tsc --noEmit` for type checking only. tsdown handles compilation. **Confidence: HIGH** |
| @types/better-sqlite3 | latest | Type definitions | TypeScript types for better-sqlite3 API. **Confidence: HIGH** |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| better-sqlite3 | node:sqlite (built-in) | Requires Node 23.5+ (not LTS). Cannot load extensions (needed for sqlite-vec). Less mature API. |
| better-sqlite3 | @libsql/client | Async API adds ~100x overhead for local queries. libSQL's value is remote/edge sync which we do not need. |
| FTS5 external content | FTS5 regular (stores content) | Doubles storage for observation text. External content is more complex but saves disk space. |
| tsdown | tsup ^8.5 | tsup is no longer actively maintained, recommends tsdown. Fallback if tsdown proves unstable. |

**Installation:**
```bash
# Production
npm install better-sqlite3 sqlite-vec zod

# Development
npm install -D typescript @types/better-sqlite3 @types/node tsdown vitest
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  shared/
    types.ts        # Observation, Session, SearchResult types + Zod schemas
    config.ts       # Database path resolution, project hashing
  storage/
    database.ts     # Connection manager, WAL setup, extension loading
    migrations.ts   # Version-tracked schema migrations
    observations.ts # Observation CRUD with project scoping
    sessions.ts     # Session lifecycle management
    search.ts       # FTS5 keyword search with BM25
    index.ts        # Barrel export
  storage/__tests__/
    concurrency.test.ts  # Multi-process concurrent write tests
    crash-recovery.test.ts # WAL crash recovery tests
    persistence.test.ts  # Cross-session data persistence tests
```

### Pattern 1: WAL Mode PRAGMA Initialization Sequence
**What:** Configure SQLite connection with PRAGMAs in correct order immediately after opening.
**When to use:** Every time a database connection is opened.
**Why order matters:** WAL mode must be set first because `synchronous = NORMAL` is only safe when WAL is active. Setting synchronous before WAL means a brief window of reduced durability.

```typescript
// Source: SQLite official WAL docs + better-sqlite3 docs
import Database from 'better-sqlite3';

const db = new Database(dbPath);

// 1. WAL mode FIRST -- persistent, survives reconnection
db.pragma('journal_mode = WAL');

// 2. Busy timeout -- per-connection, must be set every time
db.pragma('busy_timeout = 5000');

// 3. Synchronous NORMAL -- safe with WAL, faster than FULL
//    Without WAL, this risks corruption on power loss
db.pragma('synchronous = NORMAL');

// 4. Cache size -- negative = KiB, positive = pages
db.pragma('cache_size = -64000'); // 64MB

// 5. Foreign keys -- per-connection, not persistent
db.pragma('foreign_keys = ON');

// 6. Temp store in memory
db.pragma('temp_store = MEMORY');

// 7. Auto-checkpoint threshold (default is 1000 pages, be explicit)
db.pragma('wal_autocheckpoint = 1000');
```

**Key insight from research:** WAL mode IS persistent across connections (stored in the database file). `busy_timeout` and `foreign_keys` are NOT persistent -- they must be set on every new connection.

### Pattern 2: FTS5 External Content with Integer Rowid
**What:** FTS5 external content table that reads from the observations table without storing text redundantly.
**When to use:** For the observations full-text index.
**Critical finding:** FTS5 `content_rowid` MUST reference a stable integer column. Implicit rowid on a table with `TEXT PRIMARY KEY` is NOT stable across VACUUM. SQLite core developer Dan Kennedy confirmed this in the SQLite forum.

```sql
-- Source: SQLite FTS5 official docs + SQLite forum confirmation

-- Observations table with explicit integer rowid for FTS5 compatibility
CREATE TABLE observations (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  project_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  session_id TEXT,
  embedding BLOB,
  embedding_model TEXT,
  embedding_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- FTS5 external content table -- references observations via rowid
CREATE VIRTUAL TABLE observations_fts USING fts5(
  content,
  content='observations',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Sync triggers (REQUIRED for external content tables)
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;

CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO observations_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;

CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;
```

**Why `porter unicode61` tokenizer:**
- `unicode61` handles UTF-8 properly and applies Unicode case folding
- `porter` wraps unicode61 with the Porter stemming algorithm (English)
- "correction" matches "corrected", "correcting", "corrections"
- Designed for English text, which is the primary use case

### Pattern 3: sqlite-vec Extension Loading with Graceful Degradation
**What:** Load sqlite-vec at startup, fall back to keyword-only search if it fails.
**When to use:** During database initialization.

```typescript
// Source: sqlite-vec official Node.js docs (alexgarcia.xyz/sqlite-vec/js.html)
import * as sqliteVec from 'sqlite-vec';
import Database from 'better-sqlite3';

const db = new Database(dbPath);
let hasVectorSupport = false;

try {
  sqliteVec.load(db);
  hasVectorSupport = true;
  // Verify it loaded correctly
  const version = db.prepare('SELECT vec_version()').pluck().get();
  console.log(`sqlite-vec ${version} loaded`);
} catch (err) {
  console.warn('sqlite-vec not available, vector search disabled:', err.message);
}
```

### Pattern 4: BEGIN IMMEDIATE for Write Transactions
**What:** Always use `BEGIN IMMEDIATE` for transactions that will write, not plain `BEGIN`.
**When to use:** Every write transaction (inserts, updates, deletes).
**Why:** With plain `BEGIN`, SQLite starts a read transaction. If it later needs to write, it must upgrade the lock. This upgrade can fail instantly with SQLITE_BUSY even if `busy_timeout` is set -- the timeout is bypassed for upgrade attempts. `BEGIN IMMEDIATE` acquires a write lock upfront, so `busy_timeout` works correctly.

```typescript
// Source: Bert Hubert's analysis + SQLite official docs

// BAD: Plain BEGIN can fail on lock upgrade
const insertBad = db.transaction((obs) => {
  // This starts with BEGIN -- if another process holds a write lock,
  // the upgrade from read to write can fail INSTANTLY despite busy_timeout
  stmt.run(obs);
});

// GOOD: better-sqlite3's db.transaction() uses BEGIN IMMEDIATE by default
// Verify this in better-sqlite3 source -- it does use IMMEDIATE
const insertGood = db.transaction((obs) => {
  stmt.run(obs);
});
// better-sqlite3's transaction() helper already uses BEGIN IMMEDIATE
```

**Key finding:** better-sqlite3's `db.transaction()` method uses `BEGIN IMMEDIATE` by default. This is the correct behavior. Use `db.transaction()` for all write operations rather than manual `BEGIN`/`COMMIT`.

### Pattern 5: Prepared Statement Reuse
**What:** Prepare SQL statements once, reuse them for all executions.
**When to use:** All database operations in repository classes.

```typescript
// Source: better-sqlite3 performance docs
class ObservationRepository {
  private insertStmt: Statement;
  private getByIdStmt: Statement;

  constructor(private db: Database, private projectHash: string) {
    // Prepare once in constructor
    this.insertStmt = db.prepare(`
      INSERT INTO observations (id, project_hash, content, source, session_id,
        embedding, embedding_model, embedding_version)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getByIdStmt = db.prepare(`
      SELECT * FROM observations
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `);
  }

  create(input: ObservationInsert): Observation {
    const result = this.insertStmt.run(
      this.projectHash, input.content, input.source,
      input.sessionId ?? null,
      input.embedding ? Buffer.from(input.embedding.buffer) : null,
      input.embeddingModel ?? null,
      input.embeddingVersion ?? null
    );
    // Use lastInsertRowid to fetch the created row
    return this.getByRowid(result.lastInsertRowid);
  }
}
```

### Pattern 6: npm Package with bin Entry for MCP Server
**What:** Configure package.json so `npx @laminark/memory` and `laminark-server` both work.
**When to use:** Package distribution setup (Plan 01-01).

```json
{
  "name": "@laminark/memory",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "laminark-server": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "build": "tsdown",
    "check": "tsc --noEmit",
    "test": "vitest run",
    "prepublishOnly": "npm run build"
  }
}
```

The entry file (`dist/index.js`) MUST start with the shebang line:
```
#!/usr/bin/env node
```

**How this enables both install methods:**
- `npx @laminark/memory` -- downloads package, runs the single bin entry
- `npm i -g @laminark/memory` then `laminark-server` -- installs globally, `laminark-server` is symlinked to `dist/index.js`

### Anti-Patterns to Avoid

- **TEXT PRIMARY KEY with FTS5 external content:** Implicit rowid is not stable across VACUUM. Use explicit INTEGER PRIMARY KEY AUTOINCREMENT. Keep the TEXT id as a UNIQUE secondary column.
- **Plain BEGIN for write transactions:** Lock upgrade from read to write bypasses busy_timeout, causing instant SQLITE_BUSY errors. Always use BEGIN IMMEDIATE (or better-sqlite3's `db.transaction()` which does this automatically).
- **Multiple database connections writing concurrently in the same process:** SQLite WAL allows one writer at a time. Use a single connection for all writes. Reads can use the same connection since better-sqlite3 is synchronous.
- **Setting synchronous = NORMAL before journal_mode = WAL:** NORMAL synchronous is only safe with WAL mode. If WAL fails to set (e.g., read-only filesystem), NORMAL synchronous risks corruption on power loss.
- **Forgetting to set busy_timeout on every connection:** busy_timeout is per-connection, not persistent. Default is 0ms (instant SQLITE_BUSY). Must be set to >=5000ms on every connection open.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Full-text search | Custom inverted index or LIKE queries | SQLite FTS5 with BM25 | FTS5 is compiled into SQLite, handles tokenization, stemming, ranking, snippets. Hand-rolled search is orders of magnitude slower and lacks BM25 scoring. |
| Vector similarity | Manual cosine similarity in JS | sqlite-vec extension | sqlite-vec uses SIMD-accelerated distance calculations in C. JS-based vector operations are 10-100x slower for float32 arrays. |
| Schema migrations | Ad-hoc ALTER TABLE scripts | Version-tracked migration table | A `_migrations` table with version numbers prevents re-running migrations, tracks state, and supports incremental schema evolution safely. |
| Random IDs | uuid library | `lower(hex(randomblob(16)))` in SQLite | Native SQLite function, no dependency needed. Produces 32 hex char IDs (same entropy as UUID v4). |
| Connection pooling | Custom pool for concurrent access | Single better-sqlite3 connection | better-sqlite3 is synchronous. Connection pooling adds complexity for zero benefit since JS is single-threaded. WAL mode handles multi-process concurrency at the SQLite level. |
| FTS5 index sync | Manual INSERT/DELETE into FTS table | Database triggers | Triggers guarantee FTS stays in sync with the content table. Manual sync is error-prone and misses edge cases. |

**Key insight:** SQLite provides most of what this phase needs natively -- FTS5, WAL, transactions, random IDs. The only external dependency beyond the driver is sqlite-vec for vector search.

## Common Pitfalls

### Pitfall 1: FTS5 External Content with Unstable Rowid
**What goes wrong:** Observations table uses `id TEXT PRIMARY KEY` with no explicit integer primary key. FTS5 external content table references the implicit rowid via `content_rowid='rowid'`. After a `VACUUM` operation, implicit rowids can change, causing the FTS index to point to wrong rows. Queries return "database disk image is malformed" errors.
**Why it happens:** Implicit rowid on a table without INTEGER PRIMARY KEY is an implementation detail, not a contract. SQLite may reassign rowids during VACUUM.
**How to avoid:** Add `rowid INTEGER PRIMARY KEY AUTOINCREMENT` as an explicit column. Keep the TEXT `id` as `UNIQUE NOT NULL`. Reference `content_rowid='rowid'` in the FTS5 table definition.
**Warning signs:** FTS5 search returns wrong observations, or "database disk image is malformed" after VACUUM.
**Source:** SQLite forum (Dan Kennedy, SQLite core developer), SQLite FTS5 official docs.

### Pitfall 2: SQLITE_BUSY Despite busy_timeout
**What goes wrong:** Under concurrent load, write operations fail with SQLITE_BUSY even though `busy_timeout = 5000` is set. The timeout appears to be ignored.
**Why it happens:** A read transaction attempts to upgrade to a write transaction. SQLite rejects the upgrade immediately without consulting busy_timeout, because allowing the upgrade would violate serializable isolation (the read snapshot may have been invalidated by another writer).
**How to avoid:** Use `BEGIN IMMEDIATE` for all transactions that will write. better-sqlite3's `db.transaction()` does this by default. Never use a plain `SELECT` followed by `INSERT`/`UPDATE` outside of an IMMEDIATE transaction.
**Warning signs:** Sporadic SQLITE_BUSY errors that only appear under concurrent load. Works fine in single-process testing.
**Source:** Bert Hubert's analysis (berthub.eu), SQLite official docs on busy_timeout.

### Pitfall 3: WAL File Growth Without Bounds
**What goes wrong:** The WAL file grows to hundreds of MB because checkpoints never complete. The database becomes slow and uses excessive disk space.
**Why it happens:** With persistent reader connections (like the MCP server process), automatic PASSIVE checkpoints cannot fully transfer WAL content back to the main database. Readers holding read transactions prevent the WAL from being truncated.
**How to avoid:** Run `PRAGMA wal_checkpoint(PASSIVE)` on graceful shutdown. Set `wal_autocheckpoint = 1000` (default, but be explicit). Monitor WAL file size. Run periodic PASSIVE checkpoints during idle periods. Only use TRUNCATE or RESTART checkpoint modes during maintenance windows when no readers are active.
**Warning signs:** WAL file (`.db-wal`) growing beyond 10MB during normal operation. Read performance degrading over time.
**Source:** SQLite WAL official docs, better-sqlite3 performance docs.

### Pitfall 4: Per-Project Database Files vs. Single Database with Project Scoping
**What goes wrong:** The existing plan files show `getDbPath` returning `~/.laminark/data/<projectHash>/laminark.db` -- one database file per project. But the user decision says `~/.laminark/data.db` -- a single database file.
**Why it matters:** A single database is simpler (one file to back up, one connection), but requires project_hash filtering on every query. Multiple databases per project avoid cross-project contamination at the file level but complicate management.
**How to resolve:** Follow the user's locked decision: single database at `~/.laminark/data.db`. Use `project_hash` column on observations and sessions tables with mandatory filtering. This is simpler and matches the stated requirement.
**Source:** CONTEXT.md locked decision.

### Pitfall 5: sqlite-vec NULL Metadata Limitation
**What goes wrong:** sqlite-vec metadata columns do not support NULL values. Inserting NULL into a metadata column causes an error.
**Why it matters:** The observations table has nullable `embedding` columns. If the vec0 table references observation metadata that could be NULL, insertions will fail.
**How to avoid:** Keep the vec0 virtual table separate from the observations table. Only insert into the vec0 table when an embedding is actually available (not NULL). Use the observation's integer rowid as the primary key in the vec0 table to join back.
**Source:** sqlite-vec metadata blog post (alexgarcia.xyz).

### Pitfall 6: FTS5 Delete Command Must Match Exact Values
**What goes wrong:** When deleting or updating FTS5 external content, the `'delete'` command requires the EXACT current column values. If the values in the delete command do not match what is currently indexed, the FTS5 index becomes corrupted (phantom entries or missing entries).
**Why it happens:** FTS5 needs the original token set to know which index entries to remove. Mismatched values mean wrong tokens are removed.
**How to avoid:** Use database triggers (not manual FTS operations) to keep the index in sync. The trigger automatically uses `old.content` which is guaranteed to match. Never manually insert 'delete' commands into the FTS table.
**Source:** SQLite FTS5 official docs.

## Code Examples

### Complete Database Initialization
```typescript
// Source: better-sqlite3 docs + SQLite WAL docs + sqlite-vec Node.js docs
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DatabaseConfig {
  dbPath: string;
  busyTimeout: number;
}

export function openDatabase(config: DatabaseConfig): Database.Database {
  // Ensure directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);

  // PRAGMAs in correct order
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${config.busyTimeout}`);
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma('wal_autocheckpoint = 1000');

  // Load sqlite-vec (graceful degradation)
  try {
    sqliteVec.load(db);
  } catch {
    // Vector search unavailable -- keyword-only search still works
  }

  return db;
}
```

### FTS5 Search with BM25 and Project Scoping
```typescript
// Source: SQLite FTS5 official docs
function searchKeyword(
  db: Database.Database,
  query: string,
  projectHash: string,
  limit: number = 20
) {
  return db.prepare(`
    SELECT
      o.*,
      bm25(observations_fts) AS rank,
      snippet(observations_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet
    FROM observations_fts
    JOIN observations o ON o.rowid = observations_fts.rowid
    WHERE observations_fts MATCH ?
      AND o.project_hash = ?
      AND o.deleted_at IS NULL
    ORDER BY rank  -- bm25() returns negative: more negative = more relevant
    LIMIT ?
  `).all(query, projectHash, limit);
}
```

**Note on BM25:** `bm25()` returns negative values where more negative means more relevant. `ORDER BY rank` (ascending) puts best matches first without needing `DESC`.

### sqlite-vec Vector Insert and KNN Query
```typescript
// Source: sqlite-vec official demo (github.com/asg017/sqlite-vec/examples/simple-node/demo.mjs)
// Only used when hasVectorSupport is true

// Create vec0 table with observation_id as TEXT primary key
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0(
    observation_id TEXT PRIMARY KEY,
    embedding float[384]
  )
`);

// Insert a vector
const insertVec = db.prepare(`
  INSERT INTO observation_embeddings(observation_id, embedding)
  VALUES (?, ?)
`);
insertVec.run(observationId, new Float32Array(embedding));

// KNN search
const results = db.prepare(`
  SELECT observation_id, distance
  FROM observation_embeddings
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT ?
`).all(new Float32Array(queryEmbedding), limit);
```

### Batch Insert with Transaction
```typescript
// Source: better-sqlite3 performance docs
const insertMany = db.transaction((observations: ObservationInsert[]) => {
  for (const obs of observations) {
    insertStmt.run(/* params */);
  }
});

// better-sqlite3's transaction() uses BEGIN IMMEDIATE automatically
// This is safe for concurrent access
insertMany(batchOfObservations);
```

### Migration System
```typescript
// Source: better-sqlite3-migrations pattern + custom implementation
interface Migration {
  version: number;
  name: string;
  up: string; // SQL to execute
}

function runMigrations(db: Database.Database, migrations: Migration[]): void {
  // Create tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const maxVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) FROM _migrations'
  ).pluck().get() as number;

  const applyMigration = db.transaction((m: Migration) => {
    db.exec(m.up);
    db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
  });

  for (const migration of migrations) {
    if (migration.version > maxVersion) {
      applyMigration(migration);
    }
  }
}
```

### Project Hash for Database Path
```typescript
// Source: Node.js crypto docs
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export function getProjectHash(projectDir: string): string {
  // Canonicalize path to prevent multiple paths to same directory
  const canonical = realpathSync(resolve(projectDir));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function getDbPath(): string {
  // User decision: single database at ~/.laminark/data.db
  return join(homedir(), '.laminark', 'data.db');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| sqlite-vss (Faiss-based) | sqlite-vec (pure C) | 2024 | Lighter, no C++ deps, runs anywhere. sqlite-vss deprecated. |
| fastembed-js | @huggingface/transformers ^3.8 | Jan 2026 | fastembed-js archived. HuggingFace transformers.js is the maintained successor. |
| FTS5 contentless tables | FTS5 external content tables | N/A (both exist) | External content avoids data duplication while allowing snippet() and highlight(). Contentless cannot do snippet(). |
| tsup | tsdown | 2025 | tsup no longer maintained. tsdown built on Rolldown (Rust), ESM-first. |
| node:sqlite | better-sqlite3 | Ongoing | node:sqlite available since Node 22 but cannot loadExtension, has less mature API. better-sqlite3 remains faster and more capable for production use. |

**Deprecated/outdated:**
- fastembed-js: Archived January 2026. Use @huggingface/transformers instead.
- sqlite-vss: Deprecated in favor of sqlite-vec. Based on Faiss, heavier.
- tsup: No longer actively maintained. Recommends tsdown.

## Open Questions

1. **vec0 table with TEXT primary key vs integer primary key**
   - What we know: sqlite-vec supports `TEXT PRIMARY KEY` in vec0 tables. The observation text `id` column is TEXT.
   - What's unclear: Whether using the text `id` or the integer `rowid` as the vec0 primary key is more performant for JOINs with the observations table.
   - Recommendation: Use the text `id` as the vec0 primary key since it is the stable identifier. The integer rowid is an internal detail. This keeps the API clean.

2. **sqlite-vec v0.1.6 stability for production**
   - What we know: v0.1.6 is the latest stable release (Nov 2024). v0.1.7-alpha.2 exists (Jan 2025) with segfault fixes. The API for basic vec0 tables is stable.
   - What's unclear: Whether the npm package includes prebuilt binaries for all platforms (especially macOS ARM, Linux ARM).
   - Recommendation: Use ^0.1.6 with graceful degradation. If sqlite-vec fails to load on a platform, fall back to keyword-only search. This is already planned.

3. **Single database file size limits**
   - What we know: User decision is `~/.laminark/data.db` -- single file for all projects. SQLite handles databases up to 256TB. FTS5 and sqlite-vec add index overhead.
   - What's unclear: At what observation count does a single database become slow for FTS5 search. Estimates from research suggest FTS5 remains fast up to millions of rows.
   - Recommendation: Start with single file. Add monitoring for query latency. If it becomes a problem (unlikely for personal tool), shard by project or time period in a future phase.

4. **tsdown shebang injection for bin entry**
   - What we know: The bin entry file needs `#!/usr/bin/env node` as its first line. tsdown compiles TypeScript to JavaScript.
   - What's unclear: Whether tsdown automatically preserves or injects the shebang from source files.
   - Recommendation: Add the shebang to the source TypeScript entry file. If tsdown strips it, use a post-build script to prepend it. Verify during Plan 01-01 execution.

## Sources

### Primary (HIGH confidence)
- [SQLite FTS5 Extension](https://www.sqlite.org/fts5.html) -- External content tables, porter tokenizer, BM25 ranking, snippet function, rebuild command, delete command syntax
- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html) -- WAL mode persistence, autocheckpoint, concurrency model, crash recovery, checkpoint modes
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) -- v12.6.2, pragma API, transaction API, prepared statements
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) -- WAL mode, checkpoint starvation management, synchronous NORMAL
- [sqlite-vec official Node.js docs](https://alexgarcia.xyz/sqlite-vec/js.html) -- load() API, Float32Array usage, better-sqlite3 integration
- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec) -- v0.1.6, vec0 virtual table, KNN queries
- [sqlite-vec demo (Node.js)](https://github.com/asg017/sqlite-vec/blob/main/examples/simple-node/demo.mjs) -- Complete working example with better-sqlite3
- [sqlite-vec metadata blog post](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html) -- Metadata columns, auxiliary columns, partition keys, NULL limitation
- [SQLite Forum: FTS5 external content with TEXT primary key](https://sqlite.org/forum/forumpost/acdc2aa30a) -- Dan Kennedy confirming implicit rowid instability
- [Publishing MCP Server to npm](https://www.aihero.dev/publish-your-mcp-server-to-npm) -- bin entry, shebang, npx execution, scoped package publish

### Secondary (MEDIUM confidence)
- [Understanding SQLite PRAGMA with better-sqlite3](https://dev.to/lovestaco/understanding-sqlite-pragma-and-how-better-sqlite3-makes-it-nicer-1ap0) -- PRAGMA syntax, WAL, cache_size, foreign_keys
- [SQLITE_BUSY despite busy_timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/) -- Lock upgrade failure, BEGIN IMMEDIATE recommendation
- [better-sqlite3-migrations](https://github.com/BlackGlory/better-sqlite3-migrations) -- Migration pattern with user_version tracking
- [Switching from tsup to tsdown](https://alan.norbauer.com/articles/tsdown-bundler/) -- Migration guide, ESM-first behavior, config differences
- [tsdown declaration files docs](https://tsdown.dev/options/dts) -- DTS generation configuration
- [MCP Server executables explained](https://dev.to/leomarsh/mcp-server-executables-explained-npx-uvx-docker-and-beyond-1i1n) -- npx, global install, MCP server distribution patterns
- [SQLite performance tuning](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/) -- Comprehensive PRAGMA recommendations, WAL checkpoint management

### Tertiary (LOW confidence)
- [SQLite concurrent writes analysis](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/) -- Internal locking mechanics (useful for understanding but not directly actionable)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries verified via official docs, npm, and working examples
- Architecture: HIGH -- patterns drawn from official SQLite docs, better-sqlite3 docs, and sqlite-vec docs
- Pitfalls: HIGH -- FTS5 rowid issue verified by SQLite core developer; SQLITE_BUSY upgrade issue documented by multiple independent sources; WAL checkpoint management from official SQLite docs

**Research date:** 2026-02-08
**Valid until:** 2026-03-08 (30 days -- stack is stable, no fast-moving components)
