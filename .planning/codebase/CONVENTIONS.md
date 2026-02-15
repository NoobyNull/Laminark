# Coding Conventions

**Analysis Date:** 2026-02-14

## Naming Patterns

**Files:**
- Source files: kebab-case with suffix (e.g., `entity-extractor.ts`, `hybrid-selector.ts`, `topic-shift-handler.ts`)
- Test files: `*.test.ts` suffix, co-located with source in `__tests__/` directories
- Config files: kebab-case (e.g., `topic-detection-config.ts`, `graph-extraction-config.ts`)
- Type definition files: singular nouns (e.g., `types.ts`, `schema.ts`)

**Functions:**
- camelCase for all functions (e.g., `extractEntities()`, `processUnembedded()`, `calculateRecencyScore()`)
- Async functions: no special naming convention, rely on `async` keyword
- Factory functions: `create` prefix (e.g., `createEmbeddingEngine()`, `createServer()`, `createTempDb()`)
- Boolean predicates: `is` or `should` prefix (e.g., `isExcludedFile()`, `shouldAdmit()`, `isReady()`)

**Variables:**
- camelCase for local variables (e.g., `embeddingStore`, `projectHash`, `statusCache`)
- SCREAMING_SNAKE_CASE for constants (e.g., `TOKEN_BUDGET`, `RESEARCH_TOOLS`, `TOPIC_SHIFT_SOURCES`)
- Constants organized as Sets when used for membership checks: `const RESEARCH_TOOLS = new Set(['Read', 'Glob', 'Grep'])`

**Types:**
- PascalCase for types and interfaces (e.g., `ObservationRepository`, `EmbeddingEngine`, `GraphNode`)
- Database row types: `*Row` suffix with snake_case properties matching SQL (e.g., `ObservationRow`)
- Application types: camelCase properties (e.g., `Observation`, `Session`)
- Schema validation: Zod schemas with `*Schema` suffix (e.g., `ObservationInsertSchema`, `ClassificationSchema`)
- Input types: `*Insert` suffix (e.g., `ObservationInsert`, `CreateStashInput`)

## Code Style

**Formatting:**
- No explicit formatter config detected (no .prettierrc, .eslintrc files)
- TypeScript compiler enforces strict mode via `tsconfig.json`
- Indentation: 2 spaces (observed from source files)
- String literals: Single quotes for strings, double quotes in JSON
- Line length: Appears to follow ~100 character soft limit

**Linting:**
- No linter config files detected
- TypeScript strict mode enabled in `tsconfig.json`:
  - `"strict": true`
  - `"target": "ES2024"`
  - `"module": "NodeNext"`
  - `"moduleResolution": "NodeNext"`

## Import Organization

**Order:**
1. Node.js built-ins (e.g., `import { randomBytes } from 'node:crypto'`)
2. Third-party packages (e.g., `import Database from 'better-sqlite3'`, `import { z } from 'zod'`)
3. Local imports from parent/sibling directories (e.g., `import { openDatabase } from './storage/database.js'`)
4. Type-only imports grouped separately when needed (e.g., `import type BetterSqlite3 from 'better-sqlite3'`)

**Example from `src/hooks/handler.ts`:**
```typescript
import { openDatabase } from '../storage/database.js';
import { getDatabaseConfig, getProjectHash } from '../shared/config.js';
import { ObservationRepository } from '../storage/observations.js';
// ... more imports
```

**Path Aliases:**
- None used - all imports are relative paths with explicit `.js` extensions
- `.js` extension required for all TypeScript imports (ESM compatibility)

## Error Handling

**Patterns:**
- Graceful degradation: Functions return `null` or `false` on failure rather than throwing (e.g., `embed()` returns `null`, `initialize()` returns `false`)
- Try-catch blocks wrap non-critical features:
```typescript
try {
  toolRegistry = new ToolRegistryRepository(db.db);
} catch {
  debug('mcp', 'Tool registry not available (pre-migration-16)');
}
```
- Errors in background tasks are caught and logged but don't crash the process:
```typescript
processUnembedded().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  debug('embed', 'Background embedding error', { error: message });
});
```
- Type narrowing for error objects: `err instanceof Error ? err.message : String(err)`

**Critical Constraints:**
- Hook handlers MUST NEVER throw - always exit 0 (non-zero exits surface as errors to Claude)
- Worker thread failures are non-fatal - system degrades to keyword-only mode

## Logging

**Framework:** Custom `debug()` utility in `src/shared/debug.ts`

**Patterns:**
```typescript
debug('category', 'Human-readable message', { structuredData });
```

**Categories used:**
- `'db'` - Database operations
- `'obs'` - Observation CRUD
- `'mcp'` - MCP server lifecycle
- `'embed'` - Embedding operations
- `'hook'` - Hook event processing
- `'search'` - Search operations
- `'session'` - Session lifecycle

**When to log:**
- Initialization events (e.g., repository creation, database opened)
- State changes (e.g., observation created, session ended)
- Non-fatal errors (e.g., degraded mode, missing optional features)
- Performance-sensitive operations via `debugTimed()`

**Debug mode:**
- Controlled by `LAMINARK_DEBUG` environment variable
- Cached on first call (zero overhead when disabled)
- Logs to stderr (stdout reserved for MCP protocol/hook output)

## Comments

**When to Comment:**
- Module-level JSDoc explaining purpose and constraints
- Critical design decisions (e.g., "MUST be first -- synchronous = NORMAL is only safe with WAL")
- Non-obvious business logic (e.g., filter pipeline steps)
- Deprecated functions with migration path
- Test section headers using `// ===` separators

**JSDoc/TSDoc:**
- Used for public API functions and interfaces
- Includes parameter descriptions and return value semantics
- Example from `src/analysis/embedder.ts`:
```typescript
/**
 * Pluggable embedding engine abstraction.
 *
 * All methods that can fail return null/false -- engines NEVER throw.
 * This is critical for graceful degradation (DQ-03).
 */
export interface EmbeddingEngine {
  /** Embed a single text string. Returns null on failure or empty input. */
  embed(text: string): Promise<Float32Array | null>;
  // ...
}
```

**Inline comments:**
- Mark design constraints (e.g., `// Single connection per process by design`)
- Reference ticket IDs (e.g., `// SC-4: Graceful degradation`)
- Explain PRAGMA order requirements
- Clarify non-obvious variable purposes

## Function Design

**Size:**
- Entry points can be large (e.g., `src/index.ts` ~347 lines) due to initialization
- Business logic functions: typically 20-100 lines
- Helper functions: 5-20 lines
- Test functions: 10-40 lines per test case

**Parameters:**
- Prefer explicit parameters over options objects for 1-3 args
- Use options objects with TypeScript for 4+ parameters:
```typescript
list(options?: {
  limit?: number;
  offset?: number;
  sessionId?: string;
  since?: string;
  kind?: string;
  includeUnclassified?: boolean;
}): Observation[]
```
- Repository pattern: pass dependencies via constructor, prepared statements as private fields

**Return Values:**
- Return `null` for "not found" or failure cases
- Return empty arrays `[]` for "no results" queries
- Return objects with explicit success/failure fields for complex outcomes:
```typescript
{ save: boolean, reason: string, duplicateOf?: string }
```
- Use typed results for search/analysis operations:
```typescript
type ClassificationResult = {
  signal: 'noise' | 'signal';
  classification: ObservationClassification | null;
  reason: string;
}
```

## Module Design

**Exports:**
- Named exports for all modules (no default exports observed)
- Re-export from index files for public API: `export * from './storage/index.js'`
- Type-only exports when needed: `export type { LaminarkDatabase }`

**Barrel Files:**
- Used sparingly: `src/storage/index.ts` exports storage API
- Most directories lack barrel files - imports reference specific modules directly

**Architecture Patterns:**
- Repository pattern for data access (e.g., `ObservationRepository`, `SessionRepository`)
- Factory pattern for complex initialization (e.g., `createEmbeddingEngine()`, `createServer()`)
- Agent pattern for async LLM operations (e.g., `HaikuProcessor`, `CurationAgent`)
- Worker threads for CPU-intensive operations (embedding generation)

## Type Safety

**Database Layer vs Application Layer:**
- Database rows use snake_case matching SQL columns (e.g., `created_at`, `session_id`)
- Application types use camelCase for TypeScript idioms (e.g., `createdAt`, `sessionId`)
- Conversion function bridges the gap: `rowToObservation(row)`

**Runtime Validation:**
- Zod schemas for all input validation:
```typescript
const validated = ObservationInsertSchema.parse(input);
```

**Type Guards:**
- Used sparingly - prefer TypeScript narrowing via `instanceof` or type predicates
- Example: `err instanceof Error ? err.message : String(err)`

---

*Convention analysis: 2026-02-14*
