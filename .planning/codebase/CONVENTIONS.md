# Coding Conventions

**Analysis Date:** 2026-02-08

## Naming Patterns

**Files:**
- Source files: `kebab-case.ts` (e.g., `database.ts`, `observations.ts`, `search.ts`)
- Test files: `*.test.ts` suffix in `__tests__/` subdirectories (e.g., `database.test.ts`, `repositories.test.ts`)
- Test utilities: descriptive names (e.g., `test-utils.ts`, `concurrent-writer.ts`, `crash-writer.ts`)

**Functions:**
- Public API methods: `camelCase` (e.g., `openDatabase`, `getById`, `softDelete`)
- Private methods: `camelCase` with `private` modifier (e.g., `sanitizeQuery`, `sanitizeWord`)
- Helper functions: `camelCase` (e.g., `rowToObservation`, `rowToSession`)

**Variables:**
- Local variables: `camelCase` (e.g., `ldb`, `config`, `sanitized`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `DEFAULT_BUSY_TIMEOUT`, `MIGRATIONS`)
- Configuration objects: `camelCase` (e.g., `config`, `dbPath`)

**Types:**
- Interfaces: `PascalCase` (e.g., `LaminarkDatabase`, `Observation`, `SearchResult`)
- Type aliases: `PascalCase` (e.g., `ObservationInsert`, `DatabaseConfig`)
- Enum-like constants: `SCREAMING_SNAKE_CASE` arrays (e.g., `MIGRATIONS`)

**Database Layer Naming:**
- SQL column names: `snake_case` (e.g., `project_hash`, `created_at`, `deleted_at`)
- SQL table names: `snake_case` (e.g., `observations`, `sessions`, `observations_fts`)
- Database row types: `snake_case` properties (e.g., `ObservationRow`, `SessionRow`)

**Application Layer Naming:**
- Application types: `camelCase` properties (e.g., `Observation.projectHash`, `Observation.createdAt`)
- Mapping functions: `rowTo*` pattern (e.g., `rowToObservation`, `rowToSession`)

## Code Style

**Formatting:**
- No explicit formatter config detected (no `.prettierrc` or similar in root)
- Indentation: 2 spaces (consistent across all files)
- Line length: Pragmatic approach (SQL strings and comments may exceed typical limits)
- Semicolons: Always used
- Quotes: Single quotes for strings, backticks for template literals
- Trailing commas: Used in multi-line arrays and objects

**Linting:**
- No explicit linting config in project root (no `.eslintrc` or `eslint.config.js`)
- TypeScript strict mode: Enabled in `tsconfig.json` with `"strict": true`
- Type safety: All functions and methods fully typed with explicit return types

**TypeScript Configuration:**
- Target: `ES2024`
- Module system: `NodeNext` with `"type": "module"` in `package.json`
- Strict mode: Enabled (includes all strictness checks)
- Source maps: Enabled for debugging
- Declaration files: Generated for library distribution

## Import Organization

**Order:**
1. External dependencies (e.g., `better-sqlite3`, `zod`, `node:*` built-ins)
2. Relative imports from parent directories (e.g., `../shared/types.js`)
3. Relative imports from sibling directories (e.g., `./database.js`)

**Path Aliases:**
- None configured
- All imports use relative paths with explicit `.js` extension (ESM requirement)

**Import Style:**
- Type-only imports: `import type` for types (e.g., `import type { DatabaseConfig } from './types.js'`)
- Named imports preferred over default imports
- Type imports from same module as value imports use `type` keyword inline (e.g., `import { func, type Type } from './module.js'`)

**Extension Requirements:**
- All imports include `.js` extension (ESM/NodeNext requirement)
- Example: `import { openDatabase } from './database.js'`

## Error Handling

**Patterns:**
- Throw `Error` for unexpected failures (e.g., `throw new Error('Failed to retrieve newly created observation')`)
- Return `null` for expected "not found" cases (e.g., `getById` returns `Observation | null`)
- Return `boolean` for success/failure operations (e.g., `softDelete` returns `boolean`)
- Try-catch with graceful degradation for optional features (e.g., sqlite-vec loading in `openDatabase`)
- Try-catch with silent failure for cleanup operations (e.g., checkpoint before close)

**Validation:**
- Runtime validation with Zod schemas for external input (e.g., `ObservationInsertSchema.parse(input)`)
- TypeScript compile-time validation for internal APIs
- SQL injection prevention via parameterized queries (always use `?` placeholders)

## Logging

**Framework:** Standard console methods (no external logging library)

**Patterns:**
- Warnings: `console.warn()` for degraded functionality (e.g., WAL mode not active)
- No verbose logging in production code
- No debug logs in current codebase

**When to Log:**
- Configuration issues that don't prevent operation (e.g., WAL mode fallback)
- Graceful degradation scenarios (sqlite-vec unavailable)

## Comments

**When to Comment:**
- File headers: Purpose and phase information (e.g., `// Laminark MCP server entry point (Phase 2)`)
- Complex algorithms: Explain non-obvious behavior (e.g., PRAGMA order in `openDatabase`)
- Important decisions: Document "why" not "what" (e.g., "// Single connection per process by design")
- SQL queries: Inline comments for complex logic
- Migration explanations: Each migration has a detailed comment block

**JSDoc/TSDoc:**
- Comprehensive JSDoc for all public functions and classes
- Includes `@param` and `@returns` tags
- Documents edge cases and scoping rules
- Example from `src/storage/database.ts`:
  ```typescript
  /**
   * Opens a SQLite database with WAL mode, correct PRAGMA order,
   * optional sqlite-vec extension loading, and schema migrations.
   *
   * Single connection per process by design -- better-sqlite3 is synchronous,
   * so connection pooling adds zero benefit.
   *
   * @param config - Database path and busy timeout configuration
   * @returns A configured LaminarkDatabase instance
   */
  ```

**Inline Comments:**
- Numbered steps for sequential operations (e.g., `// 1. Ensure directory exists`)
- Explanations for non-obvious SQL or algorithmic choices
- References to external sources (e.g., "per research", "SQLite docs")

## Function Design

**Size:**
- Single responsibility principle
- Most functions 10-50 lines
- Complex operations broken into private helper methods

**Parameters:**
- Required parameters first, options object last
- Options objects for multiple optional parameters (e.g., `list(options?: { limit?: number; offset?: number })`)
- Destructuring with defaults for options

**Return Values:**
- Explicit return types always declared
- `null` for "not found" scenarios
- `boolean` for success/failure operations
- Strongly typed objects for complex returns
- Arrays for list operations

**Async/Await:**
- Not used (better-sqlite3 is synchronous)
- All database operations are synchronous by design

## Module Design

**Exports:**
- Named exports preferred (no default exports)
- Re-export pattern in index files (e.g., `src/storage/index.ts`)
- Export both classes and types from same file

**Barrel Files:**
- `src/storage/index.ts` serves as public API surface
- Re-exports all public classes and types
- Simplifies imports for consumers

**Module Structure:**
- One main class or set of related functions per file
- Types defined in dedicated `types.ts` files
- Configuration in dedicated `config.ts`
- Tests in `__tests__/` subdirectories

## Class Design

**Pattern:**
- Repository pattern for data access (e.g., `ObservationRepository`, `SessionRepository`)
- All repositories accept `db` and `projectHash` in constructor for scoping
- Prepared statements stored as private class fields, created once in constructor
- Example from `src/storage/observations.ts`:
  ```typescript
  export class ObservationRepository {
    private readonly db: BetterSqlite3.Database;
    private readonly projectHash: string;
    private readonly stmtInsert: BetterSqlite3.Statement;
    // ... other prepared statements

    constructor(db: BetterSqlite3.Database, projectHash: string) {
      this.db = db;
      this.projectHash = projectHash;
      this.stmtInsert = db.prepare(`INSERT INTO ...`);
      // ... prepare other statements
    }
  }
  ```

**Immutability:**
- All class fields marked `readonly`
- No mutation of constructor parameters

**Method Visibility:**
- Public methods: No modifier (TypeScript default)
- Private methods: `private` keyword

## Data Mapping

**Pattern:**
- Database layer uses `snake_case` (matches SQL)
- Application layer uses `camelCase` (idiomatic TypeScript)
- Explicit mapping functions (e.g., `rowToObservation`, `rowToSession`)
- Binary data conversions handled in mapping layer (e.g., `Buffer` ↔ `Float32Array`)

**Example:**
```typescript
export function rowToObservation(row: ObservationRow): Observation {
  return {
    rowid: row.rowid,
    id: row.id,
    projectHash: row.project_hash, // snake_case → camelCase
    // ...
  };
}
```

## Security

**SQL Injection Prevention:**
- All queries use parameterized statements (never string interpolation)
- Prepared statements for all operations
- Query sanitization for FTS5 search (removes special characters and operators)

**Input Validation:**
- Zod schemas validate all external input at runtime
- Length limits enforced (e.g., content max 100,000 characters)
- Type safety enforced at compile time

---

*Convention analysis: 2026-02-08*
