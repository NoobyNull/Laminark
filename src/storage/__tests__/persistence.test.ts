import { describe, it, expect, afterEach } from 'vitest';

import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';
import { SearchEngine } from '../search.js';
import { createTempDb } from './test-utils.js';
import type { LaminarkDatabase } from '../database.js';

describe('Persistence: Cross-session data survival', () => {
  let ldb: LaminarkDatabase | null = null;
  let cleanup: () => void;

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    ldb = null;
    cleanup?.();
  });

  it('observations survive close/reopen with correct content and timestamps', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    const PROJECT_HASH = 'persist-test';

    // Session 1: write observations
    ldb = openDatabase(config);
    const repo1 = new ObservationRepository(ldb.db, PROJECT_HASH);

    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(
        repo1.create({
          content: `Observation about topic ${i}: detailed notes on persistence testing`,
          source: 'test-session-1',
        }),
      );
    }

    ldb.close();
    ldb = null;

    // Session 2: reopen and verify
    ldb = openDatabase(config);
    const repo2 = new ObservationRepository(ldb.db, PROJECT_HASH);

    const all = repo2.list({ limit: 10 });
    expect(all.length).toBe(5);

    // Verify each observation matches what was written
    for (const original of created) {
      const found = repo2.getById(original.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe(original.content);
      expect(found!.source).toBe(original.source);
      expect(found!.createdAt).toBe(original.createdAt);
      expect(found!.projectHash).toBe(PROJECT_HASH);
    }
  });

  it('FTS5 search works after database reopen', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    const PROJECT_HASH = 'fts-persist';

    // Session 1: write observations with searchable content
    ldb = openDatabase(config);
    const repo1 = new ObservationRepository(ldb.db, PROJECT_HASH);

    repo1.create({
      content: 'The quantum entanglement experiment yielded surprising results',
      source: 'test',
    });
    repo1.create({
      content: 'Classical mechanics provides a good approximation at low speeds',
      source: 'test',
    });
    repo1.create({
      content: 'Quantum computing uses superposition for parallel computation',
      source: 'test',
    });

    ldb.close();
    ldb = null;

    // Session 2: reopen and search
    ldb = openDatabase(config);
    const search2 = new SearchEngine(ldb.db, PROJECT_HASH);

    // FTS5 with porter stemmer: "quantum" should match
    const results = search2.searchKeyword('quantum');
    expect(results.length).toBe(2);

    // Verify results have valid observation data
    for (const r of results) {
      expect(r.observation.content).toBeTruthy();
      expect(r.score).toBeGreaterThan(0);
      expect(r.matchType).toBe('fts');
    }
  });
});

describe('Project Isolation: Cross-project data separation', () => {
  let ldb: LaminarkDatabase | null = null;
  let cleanup: () => void;

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    ldb = null;
    cleanup?.();
  });

  it('project A observations are never returned when querying project B', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    const PROJECT_A = 'aaaa1111';
    const PROJECT_B = 'bbbb2222';

    ldb = openDatabase(config);

    // Write to project A
    const repoA = new ObservationRepository(ldb.db, PROJECT_A);
    repoA.create({ content: 'Project A secret data', source: 'project-a' });
    repoA.create({ content: 'More project A information', source: 'project-a' });

    // Query from project B -- zero results
    const repoB = new ObservationRepository(ldb.db, PROJECT_B);
    const bObservations = repoB.list({ limit: 100 });
    expect(bObservations.length).toBe(0);

    // Search from project B -- zero results
    const searchB = new SearchEngine(ldb.db, PROJECT_B);
    const bSearchResults = searchB.searchKeyword('secret');
    expect(bSearchResults.length).toBe(0);

    // Search from project A -- finds data
    const searchA = new SearchEngine(ldb.db, PROJECT_A);
    const aSearchResults = searchA.searchKeyword('secret');
    expect(aSearchResults.length).toBe(1);
  });

  it('both projects see only their own data after writing to both', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    const PROJECT_A = 'aaaa1111';
    const PROJECT_B = 'bbbb2222';

    ldb = openDatabase(config);

    // Write to project A
    const repoA = new ObservationRepository(ldb.db, PROJECT_A);
    repoA.create({ content: 'Alpha project data', source: 'project-a' });
    repoA.create({ content: 'Alpha additional notes', source: 'project-a' });

    // Write to project B
    const repoB = new ObservationRepository(ldb.db, PROJECT_B);
    repoB.create({ content: 'Beta project data', source: 'project-b' });

    // Project A sees only its data
    const aList = repoA.list({ limit: 100 });
    expect(aList.length).toBe(2);
    for (const obs of aList) {
      expect(obs.projectHash).toBe(PROJECT_A);
    }

    // Project B sees only its data
    const bList = repoB.list({ limit: 100 });
    expect(bList.length).toBe(1);
    expect(bList[0].projectHash).toBe(PROJECT_B);

    // Counts are scoped
    expect(repoA.count()).toBe(2);
    expect(repoB.count()).toBe(1);
  });

  it('project isolation survives close/reopen', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    const PROJECT_A = 'aaaa1111';
    const PROJECT_B = 'bbbb2222';

    // Session 1: write to both projects
    ldb = openDatabase(config);
    const repoA1 = new ObservationRepository(ldb.db, PROJECT_A);
    const repoB1 = new ObservationRepository(ldb.db, PROJECT_B);

    repoA1.create({ content: 'Alpha persistent secret', source: 'a' });
    repoB1.create({ content: 'Beta persistent secret', source: 'b' });

    ldb.close();
    ldb = null;

    // Session 2: verify isolation after reopen
    ldb = openDatabase(config);
    const repoA2 = new ObservationRepository(ldb.db, PROJECT_A);
    const repoB2 = new ObservationRepository(ldb.db, PROJECT_B);

    const aList = repoA2.list({ limit: 100 });
    const bList = repoB2.list({ limit: 100 });

    expect(aList.length).toBe(1);
    expect(aList[0].content).toBe('Alpha persistent secret');
    expect(aList[0].projectHash).toBe(PROJECT_A);

    expect(bList.length).toBe(1);
    expect(bList[0].content).toBe('Beta persistent secret');
    expect(bList[0].projectHash).toBe(PROJECT_B);

    // FTS search is also isolated after reopen
    const searchA = new SearchEngine(ldb.db, PROJECT_A);
    const searchB = new SearchEngine(ldb.db, PROJECT_B);

    const aResults = searchA.searchKeyword('persistent');
    const bResults = searchB.searchKeyword('persistent');

    expect(aResults.length).toBe(1);
    expect(aResults[0].observation.projectHash).toBe(PROJECT_A);

    expect(bResults.length).toBe(1);
    expect(bResults[0].observation.projectHash).toBe(PROJECT_B);
  });
});

describe('Schema Completeness: Embedding and metadata roundtrip', () => {
  let ldb: LaminarkDatabase | null = null;
  let cleanup: () => void;

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    ldb = null;
    cleanup?.();
  });

  it('Float32Array embedding roundtrips correctly with model metadata', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    ldb = openDatabase(config);
    const repo = new ObservationRepository(ldb.db, 'schema-test');

    // Create a 384-dimension embedding (matching model spec)
    const embeddingValues = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      embeddingValues[i] = (i / 384) * 2 - 1; // Range [-1, 1]
    }

    const created = repo.create({
      content: 'Observation with full embedding data',
      source: 'embedding-test',
      embedding: embeddingValues,
      embeddingModel: 'all-MiniLM-L6-v2',
      embeddingVersion: '1.0.0',
    });

    // Read back
    const retrieved = repo.getById(created.id);
    expect(retrieved).not.toBeNull();

    // Verify embedding is Float32Array
    expect(retrieved!.embedding).toBeInstanceOf(Float32Array);
    expect(retrieved!.embedding!.length).toBe(384);

    // Verify values match within floating point tolerance
    for (let i = 0; i < 384; i++) {
      expect(retrieved!.embedding![i]).toBeCloseTo(embeddingValues[i], 5);
    }

    // Verify model metadata
    expect(retrieved!.embeddingModel).toBe('all-MiniLM-L6-v2');
    expect(retrieved!.embeddingVersion).toBe('1.0.0');
  });

  it('observation with all fields populated roundtrips correctly', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    ldb = openDatabase(config);
    const repo = new ObservationRepository(ldb.db, 'schema-full');

    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);

    const created = repo.create({
      content: 'Full schema observation with all fields',
      source: 'schema-test',
      embedding,
      embeddingModel: 'test-model',
      embeddingVersion: '2.0.0',
    });

    const retrieved = repo.getById(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.content).toBe('Full schema observation with all fields');
    expect(retrieved!.source).toBe('schema-test');
    expect(retrieved!.projectHash).toBe('schema-full');
    expect(retrieved!.embedding).toBeInstanceOf(Float32Array);
    expect(retrieved!.embedding!.length).toBe(5);
    expect(retrieved!.embeddingModel).toBe('test-model');
    expect(retrieved!.embeddingVersion).toBe('2.0.0');
    expect(retrieved!.createdAt).toBeTruthy();
    expect(retrieved!.updatedAt).toBeTruthy();
    expect(retrieved!.deletedAt).toBeNull();
  });

  it('observation without embedding fields has null for optional fields', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    ldb = openDatabase(config);
    const repo = new ObservationRepository(ldb.db, 'schema-minimal');

    const created = repo.create({
      content: 'Minimal observation without embedding',
      source: 'schema-test',
    });

    const retrieved = repo.getById(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('Minimal observation without embedding');
    expect(retrieved!.source).toBe('schema-test');
    expect(retrieved!.embedding).toBeNull();
    expect(retrieved!.embeddingModel).toBeNull();
    expect(retrieved!.embeddingVersion).toBeNull();
    expect(retrieved!.sessionId).toBeNull();
  });

  it('embedding persists across close/reopen', () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    const embedding = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      embedding[i] = Math.sin(i / 10);
    }

    // Session 1: write
    ldb = openDatabase(config);
    const repo1 = new ObservationRepository(ldb.db, 'embed-persist');

    const created = repo1.create({
      content: 'Embedding persistence check',
      source: 'test',
      embedding,
      embeddingModel: 'sentence-transformers',
      embeddingVersion: '3.0.0',
    });

    const createdId = created.id;
    ldb.close();
    ldb = null;

    // Session 2: verify
    ldb = openDatabase(config);
    const repo2 = new ObservationRepository(ldb.db, 'embed-persist');

    const retrieved = repo2.getById(createdId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.embedding).toBeInstanceOf(Float32Array);
    expect(retrieved!.embedding!.length).toBe(384);

    // Verify values match
    for (let i = 0; i < 384; i++) {
      expect(retrieved!.embedding![i]).toBeCloseTo(embedding[i], 5);
    }

    expect(retrieved!.embeddingModel).toBe('sentence-transformers');
    expect(retrieved!.embeddingVersion).toBe('3.0.0');
  });
});
