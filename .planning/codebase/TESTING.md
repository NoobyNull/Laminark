# Testing Patterns

**Analysis Date:** 2026-02-14

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in (Jest-compatible API)

**Run Commands:**
```bash
npm test                # Run all tests once
npm run test:watch      # Watch mode
# No coverage command in package.json
```

**Framework Configuration:**
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
```

## Test File Organization

**Location:**
- Co-located with source code in `__tests__/` directories
- Pattern: `src/{module}/__tests__/{name}.test.ts`

**Examples:**
- `src/analysis/__tests__/embedder.test.ts` tests `src/analysis/embedder.ts`
- `src/hooks/__tests__/handler.test.ts` tests `src/hooks/handler.ts`
- `src/graph/__tests__/temporal.test.ts` tests `src/graph/temporal.ts`

**Naming:**
- Test files: `*.test.ts` suffix
- One test file per source module (matching source filename)
- Exception: `src/context/injection.test.ts` (co-located, no `__tests__/` directory)

**Structure:**
```
src/
├── analysis/
│   ├── __tests__/
│   │   ├── embedder.test.ts
│   │   ├── hybrid-selector.test.ts
│   │   └── piggyback.test.ts
│   ├── embedder.ts
│   └── hybrid-selector.ts
├── hooks/
│   ├── __tests__/
│   │   ├── handler.test.ts
│   │   ├── capture.test.ts
│   │   └── ...
│   └── handler.ts
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Feature or Function Name', () => {
  // Setup/teardown
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test cases
  it('describes expected behavior', () => {
    // Arrange
    const input = 'test data';

    // Act
    const result = functionUnderTest(input);

    // Assert
    expect(result).toBe(expected);
  });
});
```

**Patterns:**
- Top-level `describe()` blocks for major features or classes
- Nested `describe()` blocks for grouping related behaviors (rare)
- Section separators using comments:
```typescript
// =============================================================================
// Test Helpers
// =============================================================================

// =============================================================================
// Recency Score Tests
// =============================================================================
```
- `beforeEach` / `afterEach` for setup/teardown (database instances, temp files)
- Test names follow "it describes the expected behavior" pattern (no "should" prefix)

**Example from `src/graph/__tests__/temporal.test.ts`:**
```typescript
describe('calculateRecencyScore', () => {
  it('returns 1.0 for an observation created just now', () => {
    const now = new Date();
    const score = calculateRecencyScore(now.toISOString(), now);
    expect(score).toBe(1.0);
  });

  it('returns approximately 0.5 for an observation 7 days old', () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const score = calculateRecencyScore(sevenDaysAgo.toISOString(), now);
    expect(score).toBeCloseTo(0.5, 1);
  });
});
```

## Mocking

**Framework:** Vitest built-in (`vi` utilities)

**Patterns:**
```typescript
import { vi } from 'vitest';

// Mock interfaces/implementations
const mockStashManager: StashManager = {
  create: vi.fn().mockResolvedValue({ id: 'test-id', /* ... */ }),
  // ...
};

// Verify calls
expect(mockStashManager.create).toHaveBeenCalledWith(expect.objectContaining({
  kind: 'context',
}));
```

**What to Mock:**
- External dependencies not under test (repositories, stores)
- Expensive operations (LLM calls, file I/O in isolated tests)
- Side effects (console output, network calls)

**What NOT to Mock:**
- Database operations in integration tests (use real SQLite in temp directory)
- Simple pure functions (test directly)
- TypeScript type system (prefer real implementations where possible)

## Fixtures and Factories

**Test Data:**
```typescript
// Helper functions for test data creation
function insertObservation(
  db: Database.Database,
  opts: { id: string; content: string; createdAt: string; projectHash?: string },
): void {
  db.prepare(
    `INSERT INTO observations (id, project_hash, content, source, created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, ?)`,
  ).run(
    opts.id,
    opts.projectHash ?? 'test-project',
    opts.content,
    opts.createdAt,
    opts.createdAt,
  );
}
```

**Location:**
- Co-located in test files as helper functions (e.g., `insertObservation()`, `setupDb()`)
- Shared test utilities in `src/storage/__tests__/test-utils.ts`:
```typescript
export function createTempDb(): {
  config: DatabaseConfig;
  cleanup: () => void;
}
```

**Pattern:**
- Factory functions return both resource and cleanup callback
- Use descriptive defaults (`projectHash ?? 'test-project'`)
- Minimal viable data (only required fields)

## Coverage

**Requirements:** None enforced (no coverage commands in `package.json`)

**View Coverage:**
- Not configured in project

## Test Types

**Unit Tests:**
- Test individual functions in isolation
- Examples: `embedder.test.ts`, `temporal.test.ts`
- Mock external dependencies
- Fast execution (no real I/O)

**Integration Tests:**
- Test multiple components working together
- Examples: `handler.test.ts`, `graph-wiring-integration.test.ts`
- Use real database instances in temp directories
- Clean up resources in `afterEach`
- Pattern:
```typescript
beforeEach(() => {
  ({ config, cleanup } = createTempDb());
  laminarkDb = openDatabase(config);
  repo = new Repository(laminarkDb.db, projectHash);
});

afterEach(() => {
  laminarkDb.close();
  cleanup();
});
```

**E2E Tests:**
- Not detected in codebase

## Common Patterns

**Async Testing:**
```typescript
it('creates and initializes an embedding engine', async () => {
  const engine = await createEmbeddingEngine();
  expect(engine).toBeDefined();
});

it('LocalOnnxEngine.embed() returns null when not initialized', async () => {
  const engine = new LocalOnnxEngine();
  const result = await engine.embed('test text');
  expect(result).toBeNull();
});
```

**Error Testing:**
```typescript
it('produces no observation for .env file', () => {
  processPostToolUseFiltered(
    {
      session_id: 'sess-4',
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: '/project/.env',
        content: 'DATABASE_URL=postgres://localhost/db',
      },
    },
    obsRepo,
  );

  const observations = obsRepo.list({ limit: 10, includeUnclassified: true });
  expect(observations).toHaveLength(0);
});
```

**Parametric Testing:**
```typescript
it('produces monotonically decreasing values for older observations', () => {
  const now = new Date();
  const scores: number[] = [];
  for (let days = 0; days <= 30; days += 5) {
    const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    scores.push(calculateRecencyScore(date.toISOString(), now));
  }

  for (let i = 1; i < scores.length; i++) {
    expect(scores[i]).toBeLessThan(scores[i - 1]);
  }
});
```

**Database Testing:**
```typescript
it('stores observation for Write tool with clean content', () => {
  processPostToolUseFiltered(
    {
      session_id: 'sess-1',
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/src/app.ts', content: 'const x = 1;' },
    },
    obsRepo,
  );

  const observations = obsRepo.list({ limit: 10, includeUnclassified: true });
  expect(observations).toHaveLength(1);
  expect(observations[0].source).toBe('hook:Write');
  expect(observations[0].content).toContain('[Write] Created /src/app.ts');
  expect(observations[0].content).toContain('const x = 1;');
});
```

**Assertions:**
- Exact equality: `expect(x).toBe(y)`
- Deep equality: `expect(x).toEqual(y)`
- Array length: `expect(arr).toHaveLength(n)`
- Approximate numbers: `expect(num).toBeCloseTo(target, precision)`
- Truthiness: `expect(x).toBeTruthy()` / `expect(x).toBeFalsy()`
- Null checks: `expect(x).toBeNull()` / `expect(x).not.toBeNull()`
- Type checks: `expect(typeof x).toBe('function')`
- Object shape: `expect(obj).toMatchObject({ key: value })`
- Containment: `expect(str).toContain('substring')`

**Test Lifecycle:**
- `beforeEach` creates isolated test environments (temp databases)
- `afterEach` cleans up resources (close DB, remove temp files)
- Try-catch in cleanup for robustness:
```typescript
afterEach(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Environment Isolation:**
- Each test suite creates its own temporary database: `mkdtempSync(join(tmpdir(), 'laminark-test-'))`
- Tests use distinct `projectHash` values to avoid cross-contamination
- Database migrations run fresh for each test database

---

*Testing analysis: 2026-02-14*
