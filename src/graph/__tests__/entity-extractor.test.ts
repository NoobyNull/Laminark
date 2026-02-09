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
  toolRule,
  personRule,
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

  describe('toolRule', () => {
    it('extracts known tool names case-insensitively', () => {
      const matches = toolRule('Configured ESLint with the recommended TypeScript rules');
      expect(matches.length).toBeGreaterThanOrEqual(2);
      const names = matches.map((m) => m.name);
      expect(names).toContain('eslint');
      expect(names).toContain('typescript');
    });

    it('deduplicates same tool appearing multiple times', () => {
      const matches = toolRule('Used eslint to lint, then ran eslint --fix');
      const eslintMatches = matches.filter((m) => m.name === 'eslint');
      expect(eslintMatches).toHaveLength(1);
    });

    it('extracts database tools', () => {
      const matches = toolRule('Migrated from MySQL to PostgreSQL');
      const names = matches.map((m) => m.name);
      expect(names).toContain('mysql');
      expect(names).toContain('postgresql');
    });

    it('returns empty for text without tool names', () => {
      const matches = toolRule('A general observation about code quality');
      expect(matches).toHaveLength(0);
    });
  });

  describe('personRule', () => {
    it('extracts @-mentions', () => {
      const matches = personRule('Review from @john-doe on the PR');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('@john-doe');
      expect(matches[0].type).toBe('Person');
    });

    it('extracts "by [Name]" pattern', () => {
      const matches = personRule('Code reviewed by Jane Smith');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('Jane Smith');
    });

    it('extracts "worked with [Name]" pattern', () => {
      const matches = personRule('Paired with Alice Johnson on the feature');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('Alice Johnson');
    });

    it('returns empty for text without names', () => {
      const matches = personRule('Implemented the feature independently');
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

  it('extracts Tool entity from known tool name', () => {
    const result = extractEntities(
      'Configured eslint with the recommended TypeScript rules',
      'obs-003',
    );
    const tools = result.entities.filter((e) => e.type === 'Tool');
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain('eslint');
    expect(names).toContain('typescript');
  });

  it('extracts multiple entity types from complex observation', () => {
    const result = extractEntities(
      'Fixed the authentication bug in src/auth/middleware.ts by switching from jsonwebtoken to jose library',
      'obs-004',
    );

    const types = new Set(result.entities.map((e) => e.type));
    // Should find File (src/auth/middleware.ts) and Tool entities at minimum
    expect(types.has('File')).toBe(true);
    expect(types.has('Tool')).toBe(true);
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
      'Used eslint to lint the code, then ran eslint --fix',
      'obs-006',
    );
    const eslintEntities = result.entities.filter(
      (e) => e.name === 'eslint' && e.type === 'Tool',
    );
    expect(eslintEntities).toHaveLength(1);
  });

  it('respects minimum confidence threshold', () => {
    // At default threshold (0.5), person entities (0.6) should appear
    const resultLow = extractEntities(
      'Review from @alice on the PR',
      'obs-007',
      { minConfidence: 0.5 },
    );
    const personLow = resultLow.entities.filter((e) => e.type === 'Person');
    expect(personLow.length).toBeGreaterThanOrEqual(1);

    // At high threshold (0.8), person entities (0.6) should be filtered out
    const resultHigh = extractEntities(
      'Review from @alice on the PR',
      'obs-008',
      { minConfidence: 0.8 },
    );
    const personHigh = resultHigh.entities.filter((e) => e.type === 'Person');
    expect(personHigh).toHaveLength(0);
  });

  it('returns entities sorted by confidence descending', () => {
    const result = extractEntities(
      'Modified src/auth/login.ts and decided to use bcrypt. Review from @alice',
      'obs-009',
    );
    // Entities should be sorted: File(0.95) > Decision(0.7) > Person(0.6)
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
    );
    extractAndPersist(
      db,
      'Updated src/auth/login.ts with new validation',
      'obs-201',
    );

    const fileNode = getNodeByNameAndType(db, 'src/auth/login.ts', 'File');
    expect(fileNode).not.toBeNull();
    expect(fileNode!.observation_ids).toContain('obs-200');
    expect(fileNode!.observation_ids).toContain('obs-201');
  });

  it('persists multiple entity types from one observation', () => {
    const nodes = extractAndPersist(
      db,
      'Configured eslint with the recommended TypeScript rules in src/config/lint.ts',
      'obs-300',
    );

    expect(nodes.length).toBeGreaterThanOrEqual(2);

    const toolNodes = getNodesByType(db, 'Tool');
    expect(toolNodes.length).toBeGreaterThanOrEqual(1);

    const fileNodes = getNodesByType(db, 'File');
    expect(fileNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty extraction gracefully', () => {
    const nodes = extractAndPersist(
      db,
      'This is just a general comment',
      'obs-400',
    );

    expect(nodes).toHaveLength(0);
  });

  it('stores confidence in node metadata', () => {
    extractAndPersist(
      db,
      'Modified src/auth/login.ts',
      'obs-500',
    );

    const node = getNodeByNameAndType(db, 'src/auth/login.ts', 'File');
    expect(node).not.toBeNull();
    expect(node!.metadata.confidence).toBe(0.95);
  });
});
