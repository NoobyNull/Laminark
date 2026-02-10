import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { createTempDb } from '../../storage/__tests__/test-utils.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

import { SaveGuard } from '../save-guard.js';

describe('SaveGuard', () => {
  let laminarkDb: LaminarkDatabase;
  let config: DatabaseConfig;
  let cleanup: () => void;
  let obsRepo: ObservationRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    ({ config, cleanup } = createTempDb());
    laminarkDb = openDatabase(config);
    obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // Duplicate detection (text-based)
  // ---------------------------------------------------------------------------

  describe('duplicate detection (text)', () => {
    it('rejects identical content', () => {
      const content = '[Write] Modified /src/components/App.tsx: replaced old code with new implementation';
      // Create with classification so it's visible in list()
      obsRepo.createClassified({ content, source: 'hook:Write' }, 'discovery');

      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync(content, 'hook:Write');

      expect(decision.save).toBe(false);
      expect(decision.reason).toBe('duplicate');
      expect(decision.duplicateOf).toBeDefined();
    });

    it('rejects near-duplicate content (~90% similar)', () => {
      const original = '[Write] Modified /src/components/App.tsx: replaced old rendering logic with new virtual DOM implementation';
      obsRepo.createClassified({ content: original, source: 'hook:Write' }, 'discovery');

      // Very similar but slightly different
      const similar = '[Write] Modified /src/components/App.tsx: replaced old rendering logic with new virtual DOM implementation code';
      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync(similar, 'hook:Write');

      expect(decision.save).toBe(false);
      expect(decision.reason).toBe('duplicate');
    });

    it('allows sufficiently different content (~50% similar)', () => {
      const original = '[Write] Modified /src/components/App.tsx: replaced old rendering logic with new virtual DOM implementation';
      obsRepo.createClassified({ content: original, source: 'hook:Write' }, 'discovery');

      const different = '[Bash] $ npm test -- running integration test suite for database migration module';
      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync(different, 'hook:Bash');

      expect(decision.save).toBe(true);
    });

    it('detects duplicates among unclassified observations', () => {
      // Create without classification (pending)
      const content = '[Write] Modified /src/app.ts: added new feature implementation';
      obsRepo.create({ content, source: 'hook:Write' });

      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync(content, 'hook:Write');

      expect(decision.save).toBe(false);
      expect(decision.reason).toBe('duplicate');
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate detection (vector-based, mocked)
  // ---------------------------------------------------------------------------

  describe('duplicate detection (vector)', () => {
    it('rejects when embeddingStore returns close distance', async () => {
      const mockWorker = {
        isReady: () => true,
        embed: async () => new Float32Array([0.1, 0.2, 0.3]),
      } as any;

      const mockEmbeddingStore = {
        search: () => [
          { observationId: 'existing-obs-123', distance: 0.03 },
        ],
      } as any;

      const guard = new SaveGuard(obsRepo, {
        worker: mockWorker,
        embeddingStore: mockEmbeddingStore,
      });

      const decision = await guard.evaluate(
        '[Write] Modified /src/app.ts with new feature code',
        'hook:Write',
      );

      expect(decision.save).toBe(false);
      expect(decision.reason).toBe('duplicate');
      expect(decision.duplicateOf).toBe('existing-obs-123');
    });

    it('falls through to text check when vector distance is above threshold', async () => {
      const mockWorker = {
        isReady: () => true,
        embed: async () => new Float32Array([0.1, 0.2, 0.3]),
      } as any;

      const mockEmbeddingStore = {
        search: () => [
          { observationId: 'existing-obs-456', distance: 0.5 },
        ],
      } as any;

      const guard = new SaveGuard(obsRepo, {
        worker: mockWorker,
        embeddingStore: mockEmbeddingStore,
      });

      const decision = await guard.evaluate(
        '[Write] Modified /src/components/NewFeature.tsx: created new component with routing logic',
        'hook:Write',
      );

      expect(decision.save).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // No relevance scoring (handled by background classifier now)
  // ---------------------------------------------------------------------------

  describe('no relevance filtering', () => {
    it('allows short content (relevance handled by classifier)', () => {
      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync('ok', 'hook:Bash');

      expect(decision.save).toBe(true);
    });

    it('allows repetitive content (relevance handled by classifier)', () => {
      const guard = new SaveGuard(obsRepo);
      const repetitive = 'test test test test test test test test test test test test test test test';
      const decision = guard.evaluateSync(repetitive, 'hook:Bash');

      expect(decision.save).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  describe('graceful degradation', () => {
    it('works without worker or embeddingStore', async () => {
      const guard = new SaveGuard(obsRepo);
      const decision = await guard.evaluate(
        '[Write] Created /src/new-feature.ts with comprehensive implementation',
        'hook:Write',
      );

      expect(decision.save).toBe(true);
    });

    it('falls back to text-only when worker is not ready', async () => {
      const mockWorker = {
        isReady: () => false,
        embed: async () => null,
      } as any;

      const guard = new SaveGuard(obsRepo, {
        worker: mockWorker,
        embeddingStore: {} as any,
      });

      const decision = await guard.evaluate(
        '[Bash] $ git log showing recent commit history with meaningful changes',
        'hook:Bash',
      );

      expect(decision.save).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty recent history
  // ---------------------------------------------------------------------------

  describe('empty recent history', () => {
    it('passes duplicate check when no prior observations exist', () => {
      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync(
        '[Write] Created /src/index.ts with initial project setup',
        'hook:Write',
      );

      expect(decision.save).toBe(true);
      expect(decision.reason).toBe('ok');
    });
  });

  // ---------------------------------------------------------------------------
  // Constructor overloads
  // ---------------------------------------------------------------------------

  describe('constructor overloads', () => {
    it('accepts db + projectHash', () => {
      const guard = new SaveGuard(laminarkDb.db, projectHash);
      const decision = guard.evaluateSync(
        '[Write] Created /src/test.ts with test utilities',
        'hook:Write',
      );

      expect(decision.save).toBe(true);
    });

    it('accepts ObservationRepository directly', () => {
      const guard = new SaveGuard(obsRepo);
      const decision = guard.evaluateSync(
        '[Write] Created /src/test.ts with test utilities',
        'hook:Write',
      );

      expect(decision.save).toBe(true);
    });

    it('accepts custom thresholds', () => {
      const content = '[Write] Modified /src/app.ts: updated config settings for database connection';
      obsRepo.createClassified({ content, source: 'hook:Write' }, 'discovery');

      // With very low threshold, nothing is a duplicate
      const guard = new SaveGuard(obsRepo, { duplicateThreshold: 0.99 });
      const decision = guard.evaluateSync(
        '[Write] Modified /src/app.ts: updated config settings for database connection pool',
        'hook:Write',
      );

      expect(decision.save).toBe(true);
    });
  });
});
