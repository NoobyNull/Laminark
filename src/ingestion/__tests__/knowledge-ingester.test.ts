import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeIngester } from '../knowledge-ingester.js';
import { ObservationRepository } from '../../storage/observations.js';
import { runMigrations } from '../../storage/migrations.js';

describe('KnowledgeIngester', () => {
  let db: Database.Database;
  let testDir: string;
  const projectHash = 'test-project-hash';

  beforeEach(async () => {
    // Create in-memory database
    db = new Database(':memory:');

    // Run migrations to set up schema
    runMigrations(db);

    // Create temporary test directory
    testDir = `/tmp/laminark-test-${Date.now()}`;
    await mkdir(testDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('ingestDirectory', () => {
    it('ingests a directory with 2 markdown files -> correct IngestionStats, observations created with kind=reference and source=ingest:{filename}', async () => {
      // Write 2 markdown files
      await writeFile(
        join(testDir, 'FILE1.md'),
        `# Doc One

## Section 1A
Content for 1A.

## Section 1B
Content for 1B.`,
      );

      await writeFile(
        join(testDir, 'FILE2.md'),
        `# Doc Two

## Section 2A
Content for 2A.`,
      );

      const ingester = new KnowledgeIngester(db, projectHash);
      const stats = await ingester.ingestDirectory(testDir);

      // Check stats
      expect(stats.filesProcessed).toBe(2);
      expect(stats.sectionsCreated).toBe(3); // 2 from FILE1, 1 from FILE2
      expect(stats.sectionsRemoved).toBe(0);

      // Verify observations were created
      const repo = new ObservationRepository(db, projectHash);
      const obs = repo.list({ limit: 100, includeUnclassified: true });

      expect(obs).toHaveLength(3);

      // Check first observation
      const obs1 = obs.find((o) => o.title === 'Doc One > Section 1A');
      expect(obs1).toBeDefined();
      expect(obs1?.kind).toBe('reference');
      expect(obs1?.source).toBe('ingest:FILE1.md');
      expect(obs1?.classification).toBe('discovery');
      expect(obs1?.content).toBe('Content for 1A.');

      // Check another observation
      const obs2a = obs.find((o) => o.title === 'Doc Two > Section 2A');
      expect(obs2a).toBeDefined();
      expect(obs2a?.source).toBe('ingest:FILE2.md');
    });

    it('re-ingest same directory -> old observations soft-deleted, new ones created (idempotent)', async () => {
      // First ingestion
      await writeFile(
        join(testDir, 'FILE.md'),
        `# Doc

## Section A
Content A.

## Section B
Content B.`,
      );

      const ingester = new KnowledgeIngester(db, projectHash);
      const stats1 = await ingester.ingestDirectory(testDir);

      expect(stats1.sectionsCreated).toBe(2);
      expect(stats1.sectionsRemoved).toBe(0);

      // Get IDs of created observations
      const repo = new ObservationRepository(db, projectHash);
      const obsAfterFirst = repo.list({ limit: 100, includeUnclassified: true });
      const firstIds = obsAfterFirst.map((o) => o.id);

      // Modify the markdown file
      await writeFile(
        join(testDir, 'FILE.md'),
        `# Doc

## Section A
Content A (modified).

## Section C
New content C.`,
      );

      // Second ingestion
      const stats2 = await ingester.ingestDirectory(testDir);

      expect(stats2.filesProcessed).toBe(1);
      expect(stats2.sectionsCreated).toBe(2); // 2 new sections created
      expect(stats2.sectionsRemoved).toBe(2); // 2 old sections soft-deleted

      // Check that old observations are soft-deleted
      const obsAfterSecond = repo.list({ limit: 100, includeUnclassified: true });
      expect(obsAfterSecond).toHaveLength(2); // Only new ones (old are soft-deleted)

      const newIds = obsAfterSecond.map((o) => o.id);
      expect(newIds).not.toEqual(firstIds);

      // Check content is updated
      const sectionA = obsAfterSecond.find((o) => o.title === 'Doc > Section A');
      expect(sectionA?.content).toBe('Content A (modified).');

      const sectionC = obsAfterSecond.find((o) => o.title === 'Doc > Section C');
      expect(sectionC?.content).toBe('New content C.');

      // Verify Section B is gone
      const sectionB = obsAfterSecond.find((o) => o.heading === 'Section B');
      expect(sectionB).toBeUndefined();
    });

    it('file removed between ingestions -> its observations get cleaned up', async () => {
      // First ingestion: 2 files
      await writeFile(
        join(testDir, 'FILE1.md'),
        `# Doc One

## Section 1A
Content 1A.`,
      );

      await writeFile(
        join(testDir, 'FILE2.md'),
        `# Doc Two

## Section 2A
Content 2A.`,
      );

      const ingester = new KnowledgeIngester(db, projectHash);
      const stats1 = await ingester.ingestDirectory(testDir);

      expect(stats1.sectionsCreated).toBe(2);

      // Remove FILE2
      rmSync(join(testDir, 'FILE2.md'));

      // Re-ingest FILE1 again (as if we're updating just that file)
      // Second ingestion
      const stats2 = await ingester.ingestDirectory(testDir);

      expect(stats2.filesProcessed).toBe(1);
      expect(stats2.sectionsCreated).toBe(1); // Only FILE1 recreated
      expect(stats2.sectionsRemoved).toBe(1); // FILE1's old observation soft-deleted

      // After second ingestion: FILE1's new observation + FILE2's old observation (not updated)
      const repo = new ObservationRepository(db, projectHash);
      const obs = repo.list({ limit: 100, includeUnclassified: true });

      expect(obs).toHaveLength(2); // FILE1 new + FILE2 old (still visible)
      const file1Obs = obs.find((o) => o.source === 'ingest:FILE1.md');
      const file2Obs = obs.find((o) => o.source === 'ingest:FILE2.md');
      expect(file1Obs).toBeDefined();
      expect(file2Obs).toBeDefined();
    });

    it('empty directory -> 0 stats, no errors', async () => {
      const ingester = new KnowledgeIngester(db, projectHash);
      const stats = await ingester.ingestDirectory(testDir);

      expect(stats.filesProcessed).toBe(0);
      expect(stats.sectionsCreated).toBe(0);
      expect(stats.sectionsRemoved).toBe(0);
    });

    it('non-existent directory -> 0 stats, no errors', async () => {
      const ingester = new KnowledgeIngester(db, projectHash);
      const stats = await ingester.ingestDirectory('/non/existent/path');

      expect(stats.filesProcessed).toBe(0);
      expect(stats.sectionsCreated).toBe(0);
      expect(stats.sectionsRemoved).toBe(0);
    });
  });

  describe('detectKnowledgeDir', () => {
    it('returns .planning/codebase if it exists', async () => {
      const projectRoot = testDir;
      await mkdir(join(projectRoot, '.planning', 'codebase'), { recursive: true });

      const detected = KnowledgeIngester.detectKnowledgeDir(projectRoot);
      expect(detected).toBe(join(projectRoot, '.planning', 'codebase'));
    });

    it('returns .laminark/codebase if .planning/codebase does not exist', async () => {
      const projectRoot = testDir;
      await mkdir(join(projectRoot, '.laminark', 'codebase'), { recursive: true });

      const detected = KnowledgeIngester.detectKnowledgeDir(projectRoot);
      expect(detected).toBe(join(projectRoot, '.laminark', 'codebase'));
    });

    it('prefers .planning/codebase over .laminark/codebase', async () => {
      const projectRoot = testDir;
      await mkdir(join(projectRoot, '.planning', 'codebase'), { recursive: true });
      await mkdir(join(projectRoot, '.laminark', 'codebase'), { recursive: true });

      const detected = KnowledgeIngester.detectKnowledgeDir(projectRoot);
      expect(detected).toBe(join(projectRoot, '.planning', 'codebase'));
    });

    it('returns null if neither directory exists', () => {
      const projectRoot = testDir;

      const detected = KnowledgeIngester.detectKnowledgeDir(projectRoot);
      expect(detected).toBeNull();
    });
  });
});
