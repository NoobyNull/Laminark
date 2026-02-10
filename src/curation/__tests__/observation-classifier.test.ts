import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { createTempDb } from '../../storage/__tests__/test-utils.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

import { ObservationClassifier } from '../observation-classifier.js';

function createMockMcpServer(responseText: string, shouldThrow = false) {
  return {
    server: {
      createMessage: vi.fn().mockImplementation(async () => {
        if (shouldThrow) {
          throw new Error('Sampling not supported');
        }
        return {
          content: { type: 'text', text: responseText },
          model: 'test-model',
          stopReason: 'endTurn',
        };
      }),
    },
  } as any;
}

describe('ObservationClassifier', () => {
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
  // Classification flow
  // ---------------------------------------------------------------------------

  describe('classification flow', () => {
    it('classifies unclassified observations via LLM', async () => {
      // Create unclassified observations
      const obs1 = obsRepo.create({
        content: '[Read] /src/auth/handler.ts — found validateToken calls deprecated API',
        source: 'hook:Read',
      });
      const obs2 = obsRepo.create({
        content: '[Edit] Modified /src/auth/handler.ts: replaced deprecated validateToken with verifyJWT',
        source: 'hook:Edit',
      });

      const responseJson = JSON.stringify([
        { id: obs1.id, classification: 'discovery', reason: 'Found deprecated API' },
        { id: obs2.id, classification: 'solution', reason: 'Fixed the deprecated API call' },
      ]);

      const mockServer = createMockMcpServer(responseJson);
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { batchSize: 20, fallbackTimeoutMs: 999_999_999 },
      );

      const results = await classifier.runOnce();

      expect(results).toHaveLength(2);
      expect(results[0].classification).toBe('discovery');
      expect(results[1].classification).toBe('solution');

      // Verify database was updated
      const updated1 = obsRepo.getById(obs1.id);
      expect(updated1?.classification).toBe('discovery');
      expect(updated1?.classifiedAt).toBeTruthy();

      const updated2 = obsRepo.getById(obs2.id);
      expect(updated2?.classification).toBe('solution');
    });
  });

  // ---------------------------------------------------------------------------
  // Context window
  // ---------------------------------------------------------------------------

  describe('context window', () => {
    it('includes surrounding observations in the prompt', async () => {
      // Create some classified context observations
      obsRepo.createClassified({
        content: '[Grep] searched for "handleAuth" across codebase',
        source: 'hook:Grep',
      }, 'noise');

      // Create an unclassified observation
      const pending = obsRepo.create({
        content: '[Read] /src/auth/handler.ts — found the bug',
        source: 'hook:Read',
      });

      // Create more context after
      obsRepo.createClassified({
        content: '[Bash] npm test -- auth (3 failures)',
        source: 'hook:Bash',
      }, 'problem');

      const responseJson = JSON.stringify([
        { id: pending.id, classification: 'discovery', reason: 'Found the bug' },
      ]);

      const mockServer = createMockMcpServer(responseJson);
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { contextWindow: 5, fallbackTimeoutMs: 999_999_999 },
      );

      await classifier.runOnce();

      // Verify createMessage was called with a prompt containing context
      const callArgs = mockServer.server.createMessage.mock.calls[0][0];
      const promptText = callArgs.messages[0].content.text;
      expect(promptText).toContain('[context]');
      expect(promptText).toContain('[PENDING]');
      expect(promptText).toContain(pending.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Noise deletion
  // ---------------------------------------------------------------------------

  describe('noise deletion', () => {
    it('soft-deletes observations classified as noise', async () => {
      const obs = obsRepo.create({
        content: '[Grep] searched for "foo" in /tmp',
        source: 'hook:Grep',
      });

      const responseJson = JSON.stringify([
        { id: obs.id, classification: 'noise', reason: 'Routine search' },
      ]);

      const mockServer = createMockMcpServer(responseJson);
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { fallbackTimeoutMs: 999_999_999 },
      );

      await classifier.runOnce();

      // Should be soft-deleted (getById filters deleted_at IS NULL)
      const deleted = obsRepo.getById(obs.id);
      expect(deleted).toBeNull();

      // But still exists when including deleted
      const existing = obsRepo.getByIdIncludingDeleted(obs.id);
      expect(existing).not.toBeNull();
      expect(existing!.classification).toBe('noise');
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  describe('graceful degradation', () => {
    it('does not crash when createMessage throws', async () => {
      const obs = obsRepo.create({
        content: '[Read] /src/something.ts — checking implementation',
        source: 'hook:Read',
      });

      const mockServer = createMockMcpServer('', true);
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { fallbackTimeoutMs: 999_999_999 },
      );

      // Should not throw
      const results = await classifier.runOnce();

      // No classifications applied
      expect(results).toHaveLength(0);

      // Observation remains unclassified
      const unchanged = obsRepo.getById(obs.id);
      expect(unchanged?.classification).toBeNull();
    });

    it('handles malformed LLM response gracefully', async () => {
      obsRepo.create({
        content: '[Read] /src/test.ts — reading file',
        source: 'hook:Read',
      });

      // Return invalid response
      const mockServer = createMockMcpServer('Sorry, I cannot classify these.');
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { fallbackTimeoutMs: 999_999_999 },
      );

      const results = await classifier.runOnce();
      expect(results).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback timeout
  // ---------------------------------------------------------------------------

  describe('fallback timeout', () => {
    it('auto-promotes observations unclassified for >fallbackTimeout', async () => {
      // Create an observation with an old timestamp
      const obs = obsRepo.create({
        content: '[Read] /src/old-code.ts — reading legacy code',
        source: 'hook:Read',
      });

      // Backdate the observation to 10 minutes ago
      laminarkDb.db.prepare(
        "UPDATE observations SET created_at = datetime('now', '-10 minutes') WHERE id = ?"
      ).run(obs.id);

      const mockServer = createMockMcpServer('[]', true); // LLM will fail
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { fallbackTimeoutMs: 5 * 60 * 1000 }, // 5 minutes
      );

      const results = await classifier.runOnce();

      // Should have auto-promoted the stale observation
      expect(results).toHaveLength(1);
      expect(results[0].classification).toBe('discovery');
      expect(results[0].reason).toContain('fallback');

      // Verify database updated
      const updated = obsRepo.getById(obs.id);
      expect(updated?.classification).toBe('discovery');
    });
  });

  // ---------------------------------------------------------------------------
  // User saves bypass classifier
  // ---------------------------------------------------------------------------

  describe('user saves bypass', () => {
    it('createClassified makes observations immediately visible', () => {
      const obs = obsRepo.createClassified({
        content: 'Important finding about the auth system',
        source: 'manual',
      }, 'discovery');

      expect(obs.classification).toBe('discovery');
      expect(obs.classifiedAt).toBeTruthy();

      // Should be visible in normal list (not filtered out)
      const listed = obsRepo.list({ limit: 10 });
      expect(listed.some(o => o.id === obs.id)).toBe(true);
    });

    it('unclassified observations are not visible in normal list', () => {
      const obs = obsRepo.create({
        content: '[Grep] searching for something',
        source: 'hook:Grep',
      });

      const listed = obsRepo.list({ limit: 10 });
      expect(listed.some(o => o.id === obs.id)).toBe(false);

      // But visible with includeUnclassified
      const allListed = obsRepo.list({ limit: 10, includeUnclassified: true });
      expect(allListed.some(o => o.id === obs.id)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty batch
  // ---------------------------------------------------------------------------

  describe('empty batch', () => {
    it('returns early with no API call when no unclassified observations exist', async () => {
      const mockServer = createMockMcpServer('[]');
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
      );

      const results = await classifier.runOnce();

      expect(results).toHaveLength(0);
      expect(mockServer.server.createMessage).not.toHaveBeenCalled();
    });

    it('does not call LLM when only classified observations exist', async () => {
      obsRepo.createClassified({
        content: 'Already classified observation',
        source: 'manual',
      }, 'discovery');

      const mockServer = createMockMcpServer('[]');
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
      );

      const results = await classifier.runOnce();

      expect(results).toHaveLength(0);
      expect(mockServer.server.createMessage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Start/stop lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('start and stop work without errors', () => {
      const mockServer = createMockMcpServer('[]');
      const classifier = new ObservationClassifier(
        laminarkDb.db, projectHash, mockServer,
        { intervalMs: 60_000 },
      );

      classifier.start();
      classifier.start(); // Double start should be safe
      classifier.stop();
      classifier.stop(); // Double stop should be safe
    });
  });
});
