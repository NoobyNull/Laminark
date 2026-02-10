import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';
import { EmbeddingStore } from '../embeddings.js';
import type { LaminarkDatabase } from '../database.js';
import type { DatabaseConfig } from '../../shared/types.js';

// Helper: create a synthetic 384-dim Float32Array embedding
function randomEmbedding(dims = 384): Float32Array {
  const arr = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  return arr;
}

// Helper: create a "similar" embedding by adding slight noise to a base
function similarEmbedding(base: Float32Array, noise = 0.05): Float32Array {
  const arr = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    arr[i] = base[i] + (Math.random() * 2 - 1) * noise;
  }
  return arr;
}

describe('EmbeddingStore', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;
  let store: EmbeddingStore;
  let repo: ObservationRepository;
  const projectHash = 'test-project-embed';

  // Determine at module level if vec support is available
  let hasVecSupport = false;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-embed-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
    hasVecSupport = ldb.hasVectorSupport;

    if (hasVecSupport) {
      store = new EmbeddingStore(ldb.db, projectHash);
      repo = new ObservationRepository(ldb.db, projectHash);
    }
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('store() inserts an embedding and has() returns true', () => {
    if (!hasVecSupport) return;

    const obs = repo.create({ content: 'Test observation for embedding' });
    const emb = randomEmbedding();

    store.store(obs.id, emb);

    expect(store.has(obs.id)).toBe(true);
  });

  it('store() with same ID replaces existing embedding (INSERT OR REPLACE)', () => {
    if (!hasVecSupport) return;

    const obs = repo.create({ content: 'Replaceable observation' });
    const emb1 = randomEmbedding();
    const emb2 = randomEmbedding();

    store.store(obs.id, emb1);
    expect(store.has(obs.id)).toBe(true);

    // Replace with different embedding -- should not throw
    store.store(obs.id, emb2);
    expect(store.has(obs.id)).toBe(true);
  });

  it('search() returns results ordered by cosine distance', () => {
    if (!hasVecSupport) return;

    const queryEmb = randomEmbedding();

    // Create observations with embeddings at varying similarity
    const obs1 = repo.create({ content: 'Very similar observation' });
    const similar = similarEmbedding(queryEmb, 0.01); // very close
    store.store(obs1.id, similar);

    const obs2 = repo.create({ content: 'Less similar observation' });
    const dissimilar = randomEmbedding(); // random = far away
    store.store(obs2.id, dissimilar);

    const obs3 = repo.create({ content: 'Moderately similar observation' });
    const moderate = similarEmbedding(queryEmb, 0.3);
    store.store(obs3.id, moderate);

    const results = store.search(queryEmb, 10);

    expect(results.length).toBeGreaterThanOrEqual(2);

    // Results should be ordered by ascending distance
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }

    // The most similar (close to query) should be first
    expect(results[0].observationId).toBe(obs1.id);
  });

  it('search() respects project scoping (observations from other projects not returned)', () => {
    if (!hasVecSupport) return;

    const queryEmb = randomEmbedding();

    // Create observation in our project
    const ourObs = repo.create({ content: 'Our project observation' });
    store.store(ourObs.id, similarEmbedding(queryEmb, 0.01));

    // Create observation in different project
    const otherRepo = new ObservationRepository(ldb.db, 'other-project');
    const otherObs = otherRepo.create({ content: 'Other project observation' });
    // Store embedding for other project's observation (embedding store is project-scoped via search query)
    const otherStore = new EmbeddingStore(ldb.db, 'other-project');
    otherStore.store(otherObs.id, similarEmbedding(queryEmb, 0.01));

    const results = store.search(queryEmb, 10);
    const resultIds = results.map((r) => r.observationId);

    expect(resultIds).toContain(ourObs.id);
    expect(resultIds).not.toContain(otherObs.id);
  });

  it('search() excludes soft-deleted observations', () => {
    if (!hasVecSupport) return;

    const queryEmb = randomEmbedding();

    const obs = repo.create({ content: 'Will be deleted' });
    store.store(obs.id, similarEmbedding(queryEmb, 0.01));

    // Verify it's found before deletion
    let results = store.search(queryEmb, 10);
    expect(results.map((r) => r.observationId)).toContain(obs.id);

    // Soft-delete the observation
    repo.softDelete(obs.id);

    // Should no longer appear in search
    results = store.search(queryEmb, 10);
    expect(results.map((r) => r.observationId)).not.toContain(obs.id);
  });

  it('search() respects limit parameter', () => {
    if (!hasVecSupport) return;

    const queryEmb = randomEmbedding();

    // Create 5 observations with embeddings
    for (let i = 0; i < 5; i++) {
      const obs = repo.create({ content: `Observation ${i}` });
      store.store(obs.id, similarEmbedding(queryEmb, 0.1));
    }

    const results = store.search(queryEmb, 2);
    expect(results).toHaveLength(2);
  });

  it('delete() removes embedding and has() returns false', () => {
    if (!hasVecSupport) return;

    const obs = repo.create({ content: 'Deletable observation' });
    const emb = randomEmbedding();

    store.store(obs.id, emb);
    expect(store.has(obs.id)).toBe(true);

    store.delete(obs.id);
    expect(store.has(obs.id)).toBe(false);
  });

  it('findUnembedded() returns observation IDs that lack embeddings', () => {
    if (!hasVecSupport) return;

    const obs1 = repo.create({ content: 'Has embedding' });
    const obs2 = repo.create({ content: 'No embedding yet' });
    const obs3 = repo.create({ content: 'Also no embedding' });

    store.store(obs1.id, randomEmbedding());

    const unembedded = store.findUnembedded(10);
    expect(unembedded).toContain(obs2.id);
    expect(unembedded).toContain(obs3.id);
    expect(unembedded).not.toContain(obs1.id);
  });

  it('findUnembedded() excludes soft-deleted observations', () => {
    if (!hasVecSupport) return;

    const obs1 = repo.create({ content: 'Active observation' });
    const obs2 = repo.create({ content: 'Deleted observation' });

    // Soft-delete obs2
    repo.softDelete(obs2.id);

    const unembedded = store.findUnembedded(10);
    expect(unembedded).toContain(obs1.id);
    expect(unembedded).not.toContain(obs2.id);
  });

  it('findUnembedded() excludes observations that already have embeddings', () => {
    if (!hasVecSupport) return;

    const obs1 = repo.create({ content: 'Already embedded' });
    const obs2 = repo.create({ content: 'Not embedded' });

    store.store(obs1.id, randomEmbedding());

    const unembedded = store.findUnembedded(10);
    expect(unembedded).not.toContain(obs1.id);
    expect(unembedded).toContain(obs2.id);
  });

  it('All methods return empty/false gracefully when table is empty', () => {
    if (!hasVecSupport) return;

    expect(store.has('nonexistent-id')).toBe(false);
    expect(store.search(randomEmbedding(), 10)).toEqual([]);
    expect(store.findUnembedded(10)).toEqual([]);

    // delete on nonexistent should not throw
    expect(() => store.delete('nonexistent-id')).not.toThrow();
  });
});
