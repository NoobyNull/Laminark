# Architecture

**Analysis Date:** 2026-02-08

## Pattern Overview

**Overall:** Repository Pattern with Database-First Design

**Key Characteristics:**
- Single SQLite database with project-scoped multi-tenancy via `project_hash`
- Repository classes encapsulate all data access with prepared statements
- Strict separation between database layer (snake_case) and application layer (camelCase)
- No ORM - direct SQL with better-sqlite3 for synchronous operations

## Layers

**Storage Layer:**
- Purpose: Direct database operations, schema migrations, and SQLite configuration
- Location: `src/storage/`
- Contains: Database connection, migrations, repository classes, search engine
- Depends on: better-sqlite3, sqlite-vec, Node.js crypto/fs/path
- Used by: Application entry point (`src/index.ts`)

**Repository Classes:**
- Purpose: Domain-specific data access with automatic project scoping
- Location: `src/storage/observations.ts`, `src/storage/sessions.ts`, `src/storage/search.ts`
- Contains: ObservationRepository, SessionRepository, SearchEngine
- Depends on: Database instance, shared types
- Used by: Future MCP server (Phase 2), application consumers

**Shared Layer:**
- Purpose: Type definitions and configuration utilities
- Location: `src/shared/`
- Contains: TypeScript interfaces, Zod schemas, config helpers
- Depends on: Zod, Node.js crypto/fs/os
- Used by: Storage layer, application consumers

**Entry Point:**
- Purpose: Public API surface for npm package
- Location: `src/index.ts`
- Contains: Re-exports from storage and shared layers
- Depends on: Storage layer
- Used by: External consumers via `@laminark/memory` package

## Data Flow

**Observation Creation Flow:**

1. Consumer calls `ObservationRepository.create(input)` with application-layer types
2. Input validated at runtime via Zod schema (`ObservationInsertSchema`)
3. Generate random ID using `randomBytes(16).toString('hex')`
4. Convert Float32Array embedding to Buffer for SQLite storage
5. Execute prepared INSERT statement with project_hash scoping
6. Fetch created row from database (includes auto-generated timestamps, rowid)
7. Map snake_case row to camelCase Observation via `rowToObservation()`
8. Return typed Observation to consumer

**Search Flow:**

1. Consumer calls `SearchEngine.searchKeyword(query)` or `searchByPrefix(prefix)`
2. Query sanitized to prevent FTS5 injection (remove operators, special chars)
3. Execute prepared statement with FTS5 MATCH and project_hash scoping
4. FTS5 returns BM25 rank (negative values) and HTML snippets
5. JOIN with observations table to get full row data
6. Map rows to SearchResult[] with absolute rank scores
7. Return results ordered by relevance (best match first)

**Database Initialization Flow:**

1. Application calls `openDatabase(config)` with path and timeout
2. Create database directory if missing (`mkdirSync`)
3. Open connection with better-sqlite3
4. Set PRAGMAs in critical order: WAL mode first, then synchronous, cache, foreign keys
5. Attempt to load sqlite-vec extension (graceful degradation if missing)
6. Run schema migrations via `runMigrations(db, hasVectorSupport)`
7. Return `LaminarkDatabase` wrapper with close/checkpoint methods

**State Management:**
- No in-memory state - database is source of truth
- Prepared statements cached in repository constructors (better-sqlite3 best practice)
- WAL mode provides concurrency without application-level locking

## Key Abstractions

**LaminarkDatabase:**
- Purpose: Lifecycle wrapper around better-sqlite3 connection
- Examples: `src/storage/database.ts`
- Pattern: Facade with explicit resource management (close, checkpoint)

**Repository Pattern:**
- Purpose: Project-scoped data access with prepared statements
- Examples: `src/storage/observations.ts`, `src/storage/sessions.ts`
- Pattern: Constructor receives `db` and `projectHash`, all queries auto-scoped

**Type Mapping:**
- Purpose: Convert between database snake_case and application camelCase
- Examples: `rowToObservation()` in `src/shared/types.ts`, `rowToSession()` in `src/storage/sessions.ts`
- Pattern: Explicit mapping functions that handle Buffer ↔ Float32Array conversion

**Migration System:**
- Purpose: Versioned schema evolution with conditional features
- Examples: `src/storage/migrations.ts`
- Pattern: Array of `{version, name, up}` migrations applied in transaction

## Entry Points

**Package Entry Point:**
- Location: `src/index.ts`
- Triggers: Import/require of `@laminark/memory` package
- Responsibilities: Re-export public API (repositories, types, config helpers)

**CLI Entry Point:**
- Location: `dist/index.js` (compiled from `src/index.ts`)
- Triggers: `laminark-server` command (bin configuration in package.json)
- Responsibilities: Future MCP server startup (Phase 2 - not yet implemented)

**Database Initialization:**
- Location: `src/storage/database.ts` - `openDatabase()`
- Triggers: First call from application code
- Responsibilities: Create connection, run migrations, configure SQLite

**Repository Instantiation:**
- Location: Repository constructors in `src/storage/observations.ts`, `src/storage/sessions.ts`, `src/storage/search.ts`
- Triggers: Manual instantiation by consumer (e.g., `new ObservationRepository(db, projectHash)`)
- Responsibilities: Prepare all SQL statements once, scope all queries to project

## Error Handling

**Strategy:** Fail-fast with descriptive errors, graceful degradation for optional features

**Patterns:**
- Runtime validation: Zod schemas throw ZodError on invalid input (`ObservationInsertSchema.parse()`)
- Database errors: better-sqlite3 throws on SQL errors (e.g., constraint violations, busy database)
- Feature detection: sqlite-vec loading wrapped in try-catch, sets `hasVectorSupport` flag
- WAL checkpoint failures: Ignored in `close()` to ensure cleanup continues
- Missing entities: Return `null` (e.g., `getById()`) or empty array (e.g., `list()`) rather than throwing
- Query sanitization: FTS5 search returns empty array for invalid queries rather than throwing

## Cross-Cutting Concerns

**Logging:** Console.warn for non-critical issues (e.g., WAL mode not active), no structured logging yet

**Validation:** Zod schemas at input boundaries (`ObservationInsertSchema`), runtime parsing before database writes

**Authentication:** Not implemented - repository pattern assumes trusted caller with valid `projectHash`

**Project Isolation:** Every query scoped to `project_hash` via prepared statement parameters, prevents cross-project data leaks

**Concurrency:** SQLite WAL mode + busy_timeout (5000ms) handles concurrent access, no application-level locking needed

**Resource Management:** Explicit `close()` method on LaminarkDatabase, consumers responsible for cleanup

**Data Integrity:** Foreign keys enabled, soft deletes via `deleted_at` timestamp, transactional migrations

---

*Architecture analysis: 2026-02-08*
