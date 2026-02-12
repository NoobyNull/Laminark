import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { extractEntities, extractAndPersist } from '../entity-extractor.js';
import { initGraphSchema, getNodesByType, getNodeByNameAndType } from '../schema.js';
import {
  filePathRule,
  decisionRule,
  referenceRule,
  problemRule,
  solutionRule,
  projectRule,
} from '../extraction-rules.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = join(
    tmpdir(),
    `laminark-entity-test-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const db = new Database(join(tmpDir, 'test.db'));
  initGraphSchema(db);
  return { db, tmpDir };
}

// ---------------------------------------------------------------------------
// Individual Rule Tests
// ---------------------------------------------------------------------------

describe('Extraction Rules', () => {
  describe('filePathRule', () => {
    it('extracts file path from observation text', () => {
      const matches = filePathRule('Modified src/components/Header.tsx to fix responsive layout');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('src/components/Header.tsx');
      expect(matches[0].type).toBe('File');
      expect(matches[0].confidence).toBe(0.95);
    });

    it('strips leading ./ from paths', () => {
      const matches = filePathRule('Edited ./config/settings.ts');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('config/settings.ts');
    });

    it('extracts multiple file paths', () => {
      const matches = filePathRule('Changed src/a.ts and src/b.ts');
      expect(matches).toHaveLength(2);
    });

    it('matches standalone filenames like package.json', () => {
      const matches = filePathRule('Updated package.json to add dependencies');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('package.json');
    });

    it('returns empty for text without file paths', () => {
      const matches = filePathRule('Just a regular comment about coding');
      expect(matches).toHaveLength(0);
    });
  });

  describe('decisionRule', () => {
    it('extracts decision after "decided to"', () => {
      const matches = decisionRule('Decided to use Tailwind CSS instead of styled-components for consistency');
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('Decision');
      expect(matches[0].name).toContain('use Tailwind CSS');
      expect(matches[0].confidence).toBe(0.7);
    });

    it('extracts decision after "chose"', () => {
      const matches = decisionRule('Chose to implement caching at the API layer');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toContain('implement caching');
    });

    it('extracts decision after "went with"', () => {
      const matches = decisionRule('Went with SQLite for the local database');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toContain('SQLite');
    });

    it('trims decision clause to max 100 chars', () => {
      const longDecision = 'Decided to ' + 'a'.repeat(200);
      const matches = decisionRule(longDecision);
      expect(matches).toHaveLength(1);
      expect(matches[0].name.length).toBeLessThanOrEqual(100);
    });

    it('returns empty for text without decision language', () => {
      const matches = decisionRule('The function processes data efficiently');
      expect(matches).toHaveLength(0);
    });
  });

  describe('referenceRule', () => {
    it('extracts URL from observation text', () => {
      const matches = referenceRule('See https://docs.example.com/api for details');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('https://docs.example.com/api');
      expect(matches[0].type).toBe('Reference');
      expect(matches[0].confidence).toBe(0.9);
    });

    it('extracts multiple URLs', () => {
      const matches = referenceRule('Check https://foo.com and https://bar.com for info');
      expect(matches).toHaveLength(2);
    });

    it('deduplicates same URL appearing multiple times', () => {
      const matches = referenceRule('See https://foo.com and also https://foo.com again');
      expect(matches).toHaveLength(1);
    });

    it('returns empty for text without URLs', () => {
      const matches = referenceRule('Just a regular comment about coding');
      expect(matches).toHaveLength(0);
    });
  });

  describe('problemRule', () => {
    it('extracts problem after "bug in"', () => {
      const matches = problemRule('Found a bug in the authentication flow');
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('Problem');
      expect(matches[0].name).toContain('authentication flow');
    });

    it('extracts problem after "issue with"', () => {
      const matches = problemRule('There was an issue with memory allocation');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toContain('memory allocation');
    });

    it('returns empty for text without problem indicators', () => {
      const matches = problemRule('Everything works perfectly');
      expect(matches).toHaveLength(0);
    });
  });

  describe('solutionRule', () => {
    it('extracts solution after "fixed by"', () => {
      const matches = solutionRule('Fixed by adding a null check before the call');
      expect(matches).toHaveLength(1);
      expect(matches[0].type).toBe('Solution');
      expect(matches[0].name).toContain('adding a null check');
    });

    it('extracts solution after "workaround:"', () => {
      const matches = solutionRule('Workaround: use a polyfill for the missing API');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toContain('use a polyfill');
    });

    it('returns empty for text without solution indicators', () => {
      const matches = solutionRule('The code needs more investigation');
      expect(matches).toHaveLength(0);
    });
  });

  describe('projectRule', () => {
    it('extracts org/repo pattern', () => {
      const matches = projectRule('Cloned from facebook/react for reference');
      expect(matches.length).toBeGreaterThanOrEqual(1);
      const names = matches.map((m) => m.name);
      expect(names).toContain('facebook/react');
    });

    it('extracts scoped npm package', () => {
      const matches = projectRule('Installed @laminark/memory from the registry');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('@laminark/memory');
    });

    it('returns empty for text without project names', () => {
      const matches = projectRule('Just a comment about code');
      expect(matches).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Entity Extraction Pipeline Tests
// ---------------------------------------------------------------------------

describe('extractEntities', () => {
  it('extracts File entity from observation with file path', () => {
    const result = extractEntities(
      'Modified src/components/Header.tsx to fix responsive layout',
      'obs-001',
    );
    expect(result.observationId).toBe('obs-001');
    const fileEntities = result.entities.filter((e) => e.type === 'File');
    expect(fileEntities).toHaveLength(1);
    expect(fileEntities[0].name).toBe('src/components/Header.tsx');
    expect(fileEntities[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('extracts Decision entity from decision language', () => {
    const result = extractEntities(
      'Decided to use Tailwind CSS instead of styled-components for consistency',
      'obs-002',
    );
    const decisions = result.entities.filter((e) => e.type === 'Decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].name).toContain('use Tailwind CSS');
    expect(decisions[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('extracts Reference entity from URL in text', () => {
    const result = extractEntities(
      'See https://docs.example.com/api for the specification',
      'obs-003',
    );
    const refs = result.entities.filter((e) => e.type === 'Reference');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('https://docs.example.com/api');
    expect(refs[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('extracts multiple entity types from complex observation', () => {
    const result = extractEntities(
      'Found a bug in the auth layer in src/auth/middleware.ts. See https://docs.example.com/fix for details',
      'obs-004',
    );

    const types = new Set(result.entities.map((e) => e.type));
    // Should find File (src/auth/middleware.ts), Problem, and Reference entities at minimum
    expect(types.has('File')).toBe(true);
    expect(types.has('Problem')).toBe(true);
    expect(result.entities.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for observation with no recognizable entities', () => {
    const result = extractEntities(
      'This is a general comment with nothing specific',
      'obs-005',
    );
    expect(result.entities).toHaveLength(0);
  });

  it('deduplicates same entity appearing multiple times', () => {
    const result = extractEntities(
      'Modified src/auth/login.ts and updated src/auth/login.ts with new validation',
      'obs-006',
    );
    const fileEntities = result.entities.filter(
      (e) => e.name === 'src/auth/login.ts' && e.type === 'File',
    );
    expect(fileEntities).toHaveLength(1);
  });

  it('respects minimum confidence threshold', () => {
    // At low threshold (0.5), Decision entities (0.7) and Problem entities (0.65) should appear
    const resultLow = extractEntities(
      'Decided to refactor the module. Found a bug in the cache layer',
      'obs-007',
      { minConfidence: 0.5 },
    );
    const decisionsLow = resultLow.entities.filter((e) => e.type === 'Decision');
    expect(decisionsLow.length).toBeGreaterThanOrEqual(1);

    // At high threshold (0.9), Decision (0.7) and Problem (0.65) should be filtered out
    const resultHigh = extractEntities(
      'Decided to refactor the module. Found a bug in the cache layer',
      'obs-008',
      { minConfidence: 0.9 },
    );
    const decisionsHigh = resultHigh.entities.filter((e) => e.type === 'Decision');
    const problemsHigh = resultHigh.entities.filter((e) => e.type === 'Problem');
    expect(decisionsHigh).toHaveLength(0);
    expect(problemsHigh).toHaveLength(0);
  });

  it('returns entities sorted by confidence descending', () => {
    const result = extractEntities(
      'Modified src/auth/login.ts and decided to use bcrypt. Found a bug in the hash logic',
      'obs-009',
    );
    // Entities should be sorted: File(0.95) > Decision(0.7) > Problem(0.65)
    expect(result.entities.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < result.entities.length; i++) {
      expect(result.entities[i - 1].confidence).toBeGreaterThanOrEqual(
        result.entities[i].confidence,
      );
    }
  });

  it('includes extractedAt timestamp', () => {
    const result = extractEntities('Some observation text', 'obs-010');
    expect(result.extractedAt).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(result.extractedAt).getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Persistence Tests (extractAndPersist)
// ---------------------------------------------------------------------------

describe('extractAndPersist', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists extracted entities as graph nodes', () => {
    const nodes = extractAndPersist(
      db,
      'Modified src/auth/login.ts to add JWT support',
      'obs-100',
      { isChangeObservation: true },
    );

    expect(nodes.length).toBeGreaterThanOrEqual(1);

    // Verify File node was persisted
    const fileNode = getNodeByNameAndType(db, 'src/auth/login.ts', 'File');
    expect(fileNode).not.toBeNull();
    expect(fileNode!.observation_ids).toContain('obs-100');
  });

  it('merges observation_ids on repeated extraction', () => {
    extractAndPersist(
      db,
      'Modified src/auth/login.ts to fix a bug',
      'obs-200',
      { isChangeObservation: true },
    );
    extractAndPersist(
      db,
      'Updated src/auth/login.ts with new validation',
      'obs-201',
      { isChangeObservation: true },
    );

    const fileNode = getNodeByNameAndType(db, 'src/auth/login.ts', 'File');
    expect(fileNode).not.toBeNull();
    expect(fileNode!.observation_ids).toContain('obs-200');
    expect(fileNode!.observation_ids).toContain('obs-201');
  });

  it('persists multiple entity types from one observation', () => {
    const nodes = extractAndPersist(
      db,
      'Decided to restructure src/config/lint.ts for better maintainability',
      'obs-300',
      { isChangeObservation: true },
    );

    expect(nodes.length).toBeGreaterThanOrEqual(2);

    const decisionNodes = getNodesByType(db, 'Decision');
    expect(decisionNodes.length).toBeGreaterThanOrEqual(1);

    const fileNodes = getNodesByType(db, 'File');
    expect(fileNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty extraction gracefully', () => {
    const nodes = extractAndPersist(
      db,
      'This is just a general comment',
      'obs-400',
      { isChangeObservation: true },
    );

    expect(nodes).toHaveLength(0);
  });

  it('stores confidence in node metadata', () => {
    extractAndPersist(
      db,
      'Modified src/auth/login.ts',
      'obs-500',
      { isChangeObservation: true },
    );

    const node = getNodeByNameAndType(db, 'src/auth/login.ts', 'File');
    expect(node).not.toBeNull();
    expect(node!.metadata.confidence).toBe(0.95);
  });
});
