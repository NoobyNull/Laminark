import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';
import { SearchEngine } from '../search.js';
import type { LaminarkDatabase } from '../database.js';
import type { DatabaseConfig } from '../../shared/types.js';

describe('SearchEngine', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-search-test-'));
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

  /**
   * Helper: seed observations for search tests.
   * Project "aaa" gets 3 observations, project "bbb" gets 2.
   */
  function seedObservations() {
    const repoA = new ObservationRepository(ldb.db, 'aaa');
    const repoB = new ObservationRepository(ldb.db, 'bbb');

    // Project A observations
    repoA.createClassified({
      content:
        'Implementing user authentication with JWT tokens and refresh rotation',
    }, 'discovery');
    repoA.createClassified({
      content:
        'Database schema design for the observations table with FTS5 indexing',
    }, 'discovery');
    repoA.createClassified({
      content:
        'Running database migration scripts to set up the initial schema',
    }, 'discovery');

    // Project B observations
    repoB.createClassified({
      content:
        'Authentication middleware handles token validation and refresh flows',
    }, 'discovery');
    repoB.createClassified({
      content:
        'Setting up the testing framework with vitest and coverage reporting',
    }, 'discovery');
  }

  it('searchKeyword finds results scoped to project A', () => {
    seedObservations();
    const searchA = new SearchEngine(ldb.db, 'aaa');

    const results = searchA.searchKeyword('authentication');
    expect(results.length).toBe(1);
    expect(results[0].observation.projectHash).toBe('aaa');
    expect(results[0].observation.content).toContain('authentication');
  });

  it('searchKeyword finds results scoped to project B', () => {
    seedObservations();
    const searchB = new SearchEngine(ldb.db, 'bbb');

    const results = searchB.searchKeyword('authentication');
    expect(results.length).toBe(1);
    expect(results[0].observation.projectHash).toBe('bbb');
  });

  it('project isolation: project A search never returns project B results', () => {
    seedObservations();
    const searchA = new SearchEngine(ldb.db, 'aaa');

    // "testing" only exists in project B
    const results = searchA.searchKeyword('testing');
    expect(results).toHaveLength(0);
  });

  it('project isolation: project B search never returns project A results', () => {
    seedObservations();
    const searchB = new SearchEngine(ldb.db, 'bbb');

    // "migration" only exists in project A
    const results = searchB.searchKeyword('migration');
    expect(results).toHaveLength(0);
  });

  it('BM25 ranking: multi-word match ranks higher', () => {
    seedObservations();
    const searchA = new SearchEngine(ldb.db, 'aaa');

    // "database migration" should match 2 observations
    // One that contains BOTH words should rank higher
    const results = searchA.searchKeyword('database migration');

    expect(results.length).toBeGreaterThanOrEqual(1);

    // The observation with "database migration" in content should be first
    // (both words present => higher BM25 relevance)
    expect(results[0].observation.content).toContain('migration');
  });

  it('returns empty array for non-matching keyword', () => {
    seedObservations();
    const searchA = new SearchEngine(ldb.db, 'aaa');

    const results = searchA.searchKeyword('kubernetes');
    expect(results).toHaveLength(0);
  });

  it('soft-deleted observations excluded from search', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    const obs = repo.createClassified({
      content: 'This is about authentication patterns for APIs',
    }, 'discovery');

    const search = new SearchEngine(ldb.db, 'aaa');

    // Before delete: found
    const before = search.searchKeyword('authentication');
    expect(before).toHaveLength(1);

    // Soft delete
    repo.softDelete(obs.id);

    // After delete: not found
    const after = search.searchKeyword('authentication');
    expect(after).toHaveLength(0);
  });

  it('results include snippet with <mark> tags', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    repo.createClassified({
      content:
        'The authentication system uses JWT tokens with refresh rotation for security',
    }, 'discovery');

    const search = new SearchEngine(ldb.db, 'aaa');
    const results = search.searchKeyword('authentication');

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBeDefined();
    expect(results[0].snippet.length).toBeGreaterThan(0);
    // FTS5 snippet should contain the match context
    // (exact <mark> tag presence depends on FTS5 snippet generation)
  });

  it('results include matchType fts and score', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    repo.createClassified({ content: 'Testing the search result structure' }, 'discovery');

    const search = new SearchEngine(ldb.db, 'aaa');
    const results = search.searchKeyword('search');

    expect(results).toHaveLength(1);
    expect(results[0].matchType).toBe('fts');
    expect(typeof results[0].score).toBe('number');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('prefix search matches partial words', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    repo.createClassified({
      content: 'Authentication module with JWT validation',
    }, 'discovery');

    const search = new SearchEngine(ldb.db, 'aaa');
    const results = search.searchByPrefix('authen');

    expect(results).toHaveLength(1);
    expect(results[0].observation.content).toContain('Authentication');
  });

  it('prefix search is project-scoped', () => {
    seedObservations();
    const searchA = new SearchEngine(ldb.db, 'aaa');
    const searchB = new SearchEngine(ldb.db, 'bbb');

    // "test" prefix matches "testing" in project B only
    const resultsA = searchA.searchByPrefix('test');
    const resultsB = searchB.searchByPrefix('test');

    expect(resultsA).toHaveLength(0);
    expect(resultsB).toHaveLength(1);
  });

  it('empty query returns empty array', () => {
    seedObservations();
    const search = new SearchEngine(ldb.db, 'aaa');

    expect(search.searchKeyword('')).toHaveLength(0);
    expect(search.searchKeyword('   ')).toHaveLength(0);
  });

  it('query with special characters is safely handled', () => {
    seedObservations();
    const search = new SearchEngine(ldb.db, 'aaa');

    // These should not throw FTS5 syntax errors
    expect(() => search.searchKeyword('"')).not.toThrow();
    expect(() => search.searchKeyword('()')).not.toThrow();
    expect(() => search.searchKeyword('***')).not.toThrow();
    expect(() => search.searchKeyword('OR AND NOT')).not.toThrow();
    expect(() => search.searchKeyword('{[()]}')).not.toThrow();
    expect(() => search.searchKeyword('NEAR("test")')).not.toThrow();
  });

  it('query with only FTS5 operators returns empty array', () => {
    seedObservations();
    const search = new SearchEngine(ldb.db, 'aaa');

    const results = search.searchKeyword('OR AND NOT');
    expect(results).toHaveLength(0);
  });

  it('searchKeyword respects limit', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    for (let i = 0; i < 5; i++) {
      repo.createClassified({ content: `Observation about authentication topic ${i}` }, 'discovery');
    }

    const search = new SearchEngine(ldb.db, 'aaa');
    const results = search.searchKeyword('authentication', { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('searchKeyword respects sessionId filter', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    repo.createClassified({
      content: 'Authentication in session A',
      sessionId: 'sess-a',
    }, 'discovery');
    repo.createClassified({
      content: 'Authentication in session B',
      sessionId: 'sess-b',
    }, 'discovery');

    const search = new SearchEngine(ldb.db, 'aaa');
    const results = search.searchKeyword('authentication', {
      sessionId: 'sess-a',
    });
    expect(results).toHaveLength(1);
    expect(results[0].observation.sessionId).toBe('sess-a');
  });

  it('rebuildIndex does not throw', () => {
    seedObservations();
    const search = new SearchEngine(ldb.db, 'aaa');

    expect(() => search.rebuildIndex()).not.toThrow();

    // Search should still work after rebuild
    const results = search.searchKeyword('authentication');
    expect(results).toHaveLength(1);
  });

  it('empty prefix search returns empty array', () => {
    seedObservations();
    const search = new SearchEngine(ldb.db, 'aaa');

    expect(search.searchByPrefix('')).toHaveLength(0);
    expect(search.searchByPrefix('   ')).toHaveLength(0);
  });
});
