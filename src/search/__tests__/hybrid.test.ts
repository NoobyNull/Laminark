import { describe, it, expect, vi } from 'vitest';
import { reciprocalRankFusion, hybridSearch } from '../hybrid.js';
import type { HybridSearchParams } from '../hybrid.js';
import type { SearchResult, Observation } from '../../shared/types.js';
import type { SearchEngine } from '../../storage/search.js';
import type { EmbeddingStore, EmbeddingSearchResult } from '../../storage/embeddings.js';
import type { AnalysisWorker } from '../../analysis/worker-bridge.js';

// ---------------------------------------------------------------------------
// Helpers: mock factories
// ---------------------------------------------------------------------------

function makeObservation(id: string, content = 'test content'): Observation {
  return {
    rowid: Math.floor(Math.random() * 10000),
    id,
    projectHash: 'test-project',
    content,
    title: null,
    source: 'test',
    sessionId: null,
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}

function makeSearchResult(id: string, score: number, content = 'test'): SearchResult {
  return {
    observation: makeObservation(id, content),
    score,
    matchType: 'fts',
    snippet: `...${content}...`,
  };
}

function makeMockSearchEngine(results: SearchResult[]): SearchEngine {
  return {
    searchKeyword: vi.fn().mockReturnValue(results),
    searchByPrefix: vi.fn().mockReturnValue([]),
    rebuildIndex: vi.fn(),
  } as unknown as SearchEngine;
}

function makeMockEmbeddingStore(results: EmbeddingSearchResult[]): EmbeddingStore {
  return {
    search: vi.fn().mockReturnValue(results),
    store: vi.fn(),
    delete: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    findUnembedded: vi.fn().mockReturnValue([]),
  } as unknown as EmbeddingStore;
}

function makeMockWorker(options: {
  ready?: boolean;
  embedding?: Float32Array | null;
  engineName?: string;
}): AnalysisWorker {
  const { ready = true, embedding = new Float32Array(384), engineName = 'test-engine' } = options;
  return {
    isReady: vi.fn().mockReturnValue(ready),
    embed: vi.fn().mockResolvedValue(embedding),
    embedBatch: vi.fn().mockResolvedValue([embedding]),
    getEngineName: vi.fn().mockReturnValue(engineName),
    getDimensions: vi.fn().mockReturnValue(384),
    start: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnalysisWorker;
}

// Mock db and ObservationRepository for hybridSearch
function makeMockDb(): import('better-sqlite3').Database {
  // hybridSearch creates an ObservationRepository internally for vector-only results.
  // We mock the db's prepare() to return observation data when getById is called.
  const mockGet = vi.fn().mockReturnValue(undefined);
  const mockPrepare = vi.fn().mockReturnValue({
    get: mockGet,
    all: vi.fn().mockReturnValue([]),
    run: vi.fn(),
  });
  return { prepare: mockPrepare } as unknown as import('better-sqlite3').Database;
}

// ---------------------------------------------------------------------------
// reciprocalRankFusion
// ---------------------------------------------------------------------------

describe('reciprocalRankFusion', () => {
  it('Single list returns items in same order with RRF scores', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = reciprocalRankFusion([list]);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
    expect(result[2].id).toBe('c');

    // Verify RRF scores: 1/(60+0+1), 1/(60+1+1), 1/(60+2+1)
    expect(result[0].fusedScore).toBeCloseTo(1 / 61, 10);
    expect(result[1].fusedScore).toBeCloseTo(1 / 62, 10);
    expect(result[2].fusedScore).toBeCloseTo(1 / 63, 10);
  });

  it('Two identical lists produce same ranking (scores double)', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const result = reciprocalRankFusion([list, list]);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');

    // Scores should be double the single-list scores
    expect(result[0].fusedScore).toBeCloseTo(2 / 61, 10);
    expect(result[1].fusedScore).toBeCloseTo(2 / 62, 10);
  });

  it('Document appearing in both lists ranks higher than document in only one', () => {
    const list1 = [{ id: 'shared' }, { id: 'only-in-1' }];
    const list2 = [{ id: 'only-in-2' }, { id: 'shared' }];
    const result = reciprocalRankFusion([list1, list2]);

    // 'shared' appears in both lists: 1/(60+0+1) + 1/(60+1+1) = 1/61 + 1/62
    // 'only-in-1' appears in one: 1/(60+1+1) = 1/62
    // 'only-in-2' appears in one: 1/(60+0+1) = 1/61
    // So: shared > only-in-2 > only-in-1
    expect(result[0].id).toBe('shared');
    expect(result[0].fusedScore).toBeCloseTo(1 / 61 + 1 / 62, 10);
  });

  it('Empty lists produce empty results', () => {
    const result = reciprocalRankFusion([[], []]);
    expect(result).toEqual([]);
  });

  it('k parameter affects score magnitude but not ranking order', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    const resultK60 = reciprocalRankFusion([list], 60);
    const resultK10 = reciprocalRankFusion([list], 10);

    // Same order regardless of k
    expect(resultK60.map((r) => r.id)).toEqual(resultK10.map((r) => r.id));

    // But different score magnitudes
    expect(resultK10[0].fusedScore).toBeGreaterThan(resultK60[0].fusedScore);
  });

  it('Handles lists of different lengths correctly', () => {
    const list1 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const list2 = [{ id: 'b' }];

    const result = reciprocalRankFusion([list1, list2]);

    // 'b' in both lists (rank 1 in list1, rank 0 in list2)
    // 'a' only in list1 (rank 0)
    // 'c' only in list1 (rank 2)
    expect(result).toHaveLength(3);

    // 'b' should rank highest: 1/62 + 1/61
    expect(result[0].id).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// SC-2: Hybrid search combines keyword and semantic scores
// ---------------------------------------------------------------------------

describe('SC-2: Hybrid search combines keyword and semantic scores', () => {
  it('When both keyword and vector results exist, hybridSearch returns hybrid matchType for overlapping results', async () => {
    const sharedId = 'obs-shared';

    const keywordResults = [makeSearchResult(sharedId, 5.0, 'shared content')];
    const vectorResults: EmbeddingSearchResult[] = [
      { observationId: sharedId, distance: 0.1 },
    ];

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore(vectorResults),
      worker: makeMockWorker({ ready: true }),
      query: 'test query',
      db: makeMockDb(),
      projectHash: 'test-project',
    });

    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe('hybrid');
  });

  it("Results from keyword-only have matchType 'fts'", async () => {
    const keywordResults = [
      makeSearchResult('kw-only', 5.0, 'keyword content'),
    ];
    const vectorResults: EmbeddingSearchResult[] = [
      { observationId: 'vec-only', distance: 0.1 },
    ];

    // Mock db to return observation for vector-only result
    const mockDb = makeMockDb();
    const prepareReturn = (mockDb.prepare as ReturnType<typeof vi.fn>).getMockImplementation;
    // Override get to return obs for vec-only
    (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockImplementation((...args: unknown[]) => {
        if (args[0] === 'vec-only') {
          return {
            rowid: 1,
            id: 'vec-only',
            project_hash: 'test-project',
            content: 'vector content',
            title: null,
            source: 'test',
            session_id: null,
            embedding: null,
            embedding_model: null,
            embedding_version: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          };
        }
        return undefined;
      }),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    });

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore(vectorResults),
      worker: makeMockWorker({ ready: true }),
      query: 'test query',
      db: mockDb,
      projectHash: 'test-project',
    });

    const ftsResults = result.filter((r) => r.matchType === 'fts');
    expect(ftsResults.length).toBeGreaterThanOrEqual(1);
    expect(ftsResults[0].observation.id).toBe('kw-only');
  });

  it("Results from vector-only have matchType 'vector'", async () => {
    const keywordResults: SearchResult[] = [];
    const vectorResults: EmbeddingSearchResult[] = [
      { observationId: 'vec-only', distance: 0.1 },
    ];

    const mockDb = makeMockDb();
    (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      get: vi.fn().mockImplementation((...args: unknown[]) => {
        if (args[0] === 'vec-only') {
          return {
            rowid: 1,
            id: 'vec-only',
            project_hash: 'test-project',
            content: 'vector only content',
            title: null,
            source: 'test',
            session_id: null,
            embedding: null,
            embedding_model: null,
            embedding_version: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          };
        }
        return undefined;
      }),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    });

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore(vectorResults),
      worker: makeMockWorker({ ready: true }),
      query: 'test query',
      db: mockDb,
      projectHash: 'test-project',
    });

    const vectorOnly = result.filter((r) => r.matchType === 'vector');
    expect(vectorOnly.length).toBe(1);
    expect(vectorOnly[0].observation.id).toBe('vec-only');
  });

  it('When worker is null, hybridSearch falls back to keyword-only', async () => {
    const keywordResults = [makeSearchResult('kw-1', 5.0)];

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore([]),
      worker: null,
      query: 'test query',
      db: makeMockDb(),
      projectHash: 'test-project',
    });

    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe('fts');
  });

  it('When worker.isReady() is false, hybridSearch falls back to keyword-only', async () => {
    const keywordResults = [makeSearchResult('kw-1', 5.0)];

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore([]),
      worker: makeMockWorker({ ready: false }),
      query: 'test query',
      db: makeMockDb(),
      projectHash: 'test-project',
    });

    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe('fts');
  });

  it('When worker.embed() returns null for query, hybridSearch falls back to keyword-only', async () => {
    const keywordResults = [makeSearchResult('kw-1', 5.0)];

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore([]),
      worker: makeMockWorker({ ready: true, embedding: null }),
      query: 'test query',
      db: makeMockDb(),
      projectHash: 'test-project',
    });

    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe('fts');
  });

  it('Limit parameter is respected in final output', async () => {
    // Create 5 keyword results
    const keywordResults = Array.from({ length: 5 }, (_, i) =>
      makeSearchResult(`kw-${i}`, 5.0 - i),
    );
    // Create 5 vector results
    const vectorResults: EmbeddingSearchResult[] = Array.from({ length: 5 }, (_, i) => ({
      observationId: `kw-${i}`, // same IDs to get hybrid matches
      distance: 0.1 * (i + 1),
    }));

    const result = await hybridSearch({
      searchEngine: makeMockSearchEngine(keywordResults),
      embeddingStore: makeMockEmbeddingStore(vectorResults),
      worker: makeMockWorker({ ready: true }),
      query: 'test query',
      db: makeMockDb(),
      projectHash: 'test-project',
      options: { limit: 3 },
    });

    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// SC-3: Non-blocking embedding
// ---------------------------------------------------------------------------

describe('SC-3: Non-blocking embedding', () => {
  it('AnalysisWorker.embed() returns a Promise (not synchronous)', () => {
    const worker = makeMockWorker({ ready: true });
    const result = worker.embed('test text');

    // embed() should return a thenable (Promise)
    expect(result).toBeInstanceOf(Promise);
  });

  it('AnalysisWorker constructor does not block (measure time < 100ms)', async () => {
    // Import the actual AnalysisWorker class
    const { AnalysisWorker } = await import('../../analysis/worker-bridge.js');

    const start = performance.now();
    // Provide a non-existent path so it doesn't actually try to load a worker
    const _worker = new AnalysisWorker('/nonexistent/path/worker.js');
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// SC-5: Zero startup latency
// ---------------------------------------------------------------------------

describe('SC-5: Zero startup latency', () => {
  it('AnalysisWorker.start() returns a Promise (non-blocking, fire-and-forget API)', async () => {
    const { AnalysisWorker } = await import('../../analysis/worker-bridge.js');

    const worker = new AnalysisWorker('/nonexistent/path/worker.js');

    // start() returns a Promise -- the caller can fire-and-forget with .catch()
    // This is the DQ-04 pattern: server starts immediately, model loads in background
    const startResult = worker.start();
    expect(startResult).toBeInstanceOf(Promise);

    // Clean up -- don't await the full 30s timeout, just let the rejection go
    startResult.catch(() => {
      // Expected: worker file doesn't exist, will eventually timeout
    });

    // Shutdown immediately to terminate any pending timers
    await worker.shutdown();
  });

  it('embed() returns null when worker is not yet ready (before start completes)', async () => {
    const { AnalysisWorker } = await import('../../analysis/worker-bridge.js');

    const worker = new AnalysisWorker('/nonexistent/path/worker.js');

    // Without calling start(), embed should return null
    const result = await worker.embed('test text');
    expect(result).toBeNull();
  });
});
