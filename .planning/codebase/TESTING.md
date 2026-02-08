# Testing Patterns

**Analysis Date:** 2026-02-08

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in assertions (Jest-compatible API)

**Run Commands:**
```bash
npm test                 # Run all tests once
npm run test:watch       # Watch mode
```

**Coverage:**
```bash
# No coverage command configured in package.json
# Can be added with: vitest run --coverage
```

## Test File Organization

**Location:**
- Co-located with source in `__tests__/` subdirectories
- Example: `src/storage/__tests__/database.test.ts` tests `src/storage/database.ts`

**Naming:**
- Pattern: `*.test.ts` suffix
- Descriptive names matching the module under test (e.g., `database.test.ts`, `repositories.test.ts`, `search.test.ts`)
- Specialized test files: `concurrency.test.ts`, `crash-recovery.test.ts`, `persistence.test.ts`

**Structure:**
```
src/storage/
├── database.ts
├── observations.ts
├── sessions.ts
├── search.ts
└── __tests__/
    ├── database.test.ts
    ├── repositories.test.ts
    ├── search.test.ts
    ├── concurrency.test.ts
    ├── crash-recovery.test.ts
    ├── persistence.test.ts
    ├── test-utils.ts
    ├── concurrent-writer.ts
    └── crash-writer.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('ComponentName', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    // Setup: create temp database
    tmp = mkdtempSync(join(tmpdir(), 'laminark-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
  });

  afterEach(() => {
    // Teardown: close database and clean up temp files
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('describes expected behavior in present tense', () => {
    // Arrange
    const repo = new ObservationRepository(ldb.db, 'test-project');

    // Act
    const result = repo.create({ content: 'Test observation' });

    // Assert
    expect(result).toBeDefined();
    expect(result.content).toBe('Test observation');
  });
});
```

**Patterns:**
- Each test file has one or more `describe` blocks
- Each feature or method gets its own `describe` block
- Setup in `beforeEach`, teardown in `afterEach`
- Tests follow Arrange-Act-Assert pattern (not explicitly commented)
- Test names are descriptive sentences (e.g., `'creates observations and lists them'`)

## Mocking

**Framework:**
- No mocking framework used (vitest has built-in mocking, but not used in this codebase)

**Patterns:**
- Real dependencies preferred over mocks (integration testing approach)
- No mocks for database operations
- Temporary databases for test isolation (each test gets its own SQLite file)

**What to Mock:**
- Not applicable in current codebase

**What NOT to Mock:**
- Database operations (use real SQLite in temp directories)
- File system operations (use real temp directories)
- Better-sqlite3 database driver (use real instance)

## Fixtures and Factories

**Test Data:**
- Helper functions create realistic test data:
  ```typescript
  function seedObservations() {
    const repoA = new ObservationRepository(ldb.db, 'aaa');
    const repoB = new ObservationRepository(ldb.db, 'bbb');

    repoA.create({
      content: 'Implementing user authentication with JWT tokens',
    });
    repoA.create({
      content: 'Database schema design for observations table',
    });
    // ...
  }
  ```
- Inline fixture data in tests (no separate fixture files)
- Test utilities for common setup patterns

**Location:**
- Test utilities: `src/storage/__tests__/test-utils.ts`
- Example utility:
  ```typescript
  export function createTempDb(): {
    config: DatabaseConfig;
    cleanup: () => void;
  } {
    const tmp = mkdtempSync(join(tmpdir(), 'laminark-acceptance-'));
    const config: DatabaseConfig = {
      dbPath: join(tmp, 'test.db'),
      busyTimeout: 5000,
    };
    const cleanup = () => {
      rmSync(tmp, { recursive: true, force: true });
    };
    return { config, cleanup };
  }
  ```

## Coverage

**Requirements:**
- No explicit coverage threshold configured
- Test files excluded from compilation: `"exclude": ["node_modules", "dist", "**/*.test.ts"]` in `tsconfig.json`

**View Coverage:**
```bash
# Not configured by default
# Can be run with: npx vitest run --coverage
```

**Coverage Approach:**
- Comprehensive test coverage evident from test files
- Each public method has multiple test cases
- Edge cases explicitly tested (e.g., project isolation, null returns, soft deletes)

## Test Types

**Unit Tests:**
- Test individual functions and methods in isolation
- Examples: `database.test.ts` tests PRAGMA settings, migration application
- Focus: Correctness of single components

**Integration Tests:**
- Test multiple components working together
- Examples: `repositories.test.ts` tests repositories with real database, `search.test.ts` tests search with FTS5
- Focus: Component interactions and data flow

**System Tests:**
- Test real-world scenarios with multiple processes
- Examples: `concurrency.test.ts` tests multi-process database access, `crash-recovery.test.ts` tests resilience
- Focus: Concurrency, durability, crash recovery
- Uses `fork()` to spawn separate Node.js processes

**E2E Tests:**
- Not applicable (library/storage layer, no end-to-end UI/API)

## Common Patterns

**Database Setup:**
```typescript
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'laminark-test-'));
  config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
  ldb = openDatabase(config);
});

afterEach(() => {
  try {
    ldb?.close();
  } catch {
    // already closed
  }
  rmSync(tmp, { recursive: true, force: true });
});
```

**Testing Null Returns:**
```typescript
it('getById returns null for non-existent observation', () => {
  const repo = new ObservationRepository(ldb.db, 'aaa');
  expect(repo.getById('nonexistent')).toBeNull();
});
```

**Testing Project Isolation:**
```typescript
it('enforces project isolation - project B cannot see project A data', () => {
  const repoA = new ObservationRepository(ldb.db, 'aaa');
  const repoB = new ObservationRepository(ldb.db, 'bbb');

  repoA.create({ content: 'Project A data' });

  expect(repoB.list()).toHaveLength(0);
  expect(repoB.count()).toBe(0);
});
```

**Testing with Type Assertions:**
```typescript
const row = ldb.db
  .prepare('SELECT version, name FROM _migrations')
  .all() as { version: number; name: string }[];

expect(rows[0]).toEqual({ version: 1, name: 'create_observations' });
```

**Testing Array Operations:**
```typescript
it('list returns results ordered by created_at DESC', () => {
  const repo = new ObservationRepository(ldb.db, 'aaa');

  const obs1 = repo.create({ content: 'First' });
  const obs2 = repo.create({ content: 'Second' });
  const obs3 = repo.create({ content: 'Third' });

  const all = repo.list();
  expect(all[0].id).toBe(obs3.id); // Most recent first
  expect(all[2].id).toBe(obs1.id); // Oldest last
});
```

**Testing Floating Point Values:**
```typescript
it('embedding roundtrip: Float32Array -> Buffer -> Float32Array', () => {
  const originalEmbedding = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0]);
  const created = repo.create({
    content: 'Test',
    embedding: originalEmbedding,
  });

  for (let i = 0; i < originalEmbedding.length; i++) {
    expect(created.embedding![i]).toBeCloseTo(originalEmbedding[i], 5);
  }
});
```

**Testing Exceptions:**
```typescript
it('query with special characters is safely handled', () => {
  const search = new SearchEngine(ldb.db, 'aaa');

  expect(() => search.searchKeyword('"')).not.toThrow();
  expect(() => search.searchKeyword('()')).not.toThrow();
  expect(() => search.searchKeyword('***')).not.toThrow();
});
```

**Testing Multi-Process Operations:**
```typescript
it('handles concurrent writes from multiple processes', async () => {
  const { config, cleanup } = createTempDb();

  // Spawn 3 concurrent writer processes
  const writers = [
    fork(writerPath, ['0', config.dbPath, '10']),
    fork(writerPath, ['1', config.dbPath, '10']),
    fork(writerPath, ['2', config.dbPath, '10']),
  ];

  // Wait for all to complete
  await Promise.all(writers.map(waitForExit));

  // Verify all writes succeeded
  const ldb = openDatabase(config);
  const repo = new ObservationRepository(ldb.db, 'concurrent-test');
  expect(repo.count()).toBe(30);

  ldb.close();
  cleanup();
}, 30000); // 30-second timeout for process tests
```

## Test Organization Guidelines

**Test Naming:**
- Use descriptive sentences that explain expected behavior
- Start with the action or condition being tested
- Use present tense (e.g., `'creates'`, `'returns'`, `'enforces'`)
- Include context when needed (e.g., `'project isolation: project B cannot see project A results'`)

**Test Independence:**
- Each test creates its own temporary database
- No shared state between tests
- Tests can run in any order

**Test Focus:**
- One logical assertion per test (may have multiple `expect()` calls for related checks)
- Test both success and failure paths
- Test edge cases explicitly

**Describe Block Organization:**
- Top-level `describe` per class or module
- Nested `describe` blocks for related functionality (e.g., `describe('migrations')`)
- Shared setup/teardown at appropriate level

## Specialized Testing Patterns

**Concurrency Testing:**
- Uses Node.js `fork()` to spawn separate processes
- Each process writes to same database file
- Verifies SQLite WAL mode handles concurrent access
- Located in `src/storage/__tests__/concurrency.test.ts`

**Crash Recovery Testing:**
- Spawns process that writes data and crashes mid-operation
- Verifies database remains consistent after crash
- Tests WAL recovery mechanisms
- Located in `src/storage/__tests__/crash-recovery.test.ts`

**Persistence Testing:**
- Tests data survives close/reopen cycles
- Verifies migrations don't re-run
- Tests FTS5 index persistence
- Located in `src/storage/__tests__/persistence.test.ts`

---

*Testing analysis: 2026-02-08*
