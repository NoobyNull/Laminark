import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../../storage/database.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

import { TopicShiftHandler } from '../topic-shift-handler.js';
import { TopicShiftDetector } from '../../intelligence/topic-detector.js';
import { AdaptiveThresholdManager } from '../../intelligence/adaptive-threshold.js';
import { TopicShiftDecisionLogger } from '../../intelligence/decision-logger.js';
import { StashManager } from '../../storage/stash-manager.js';
import { ObservationRepository } from '../../storage/observations.js';
import { NotificationStore } from '../../storage/notifications.js';
import type { Observation } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_HASH = 'test-proj-integration';

/**
 * Create a synthetic embedding vector of given dimension.
 * The vector is normalized to unit length for realistic cosine distance behavior.
 */
function makeEmbedding(dim: number, seed: number[]): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < seed.length && i < dim; i++) {
    arr[i] = seed[i];
  }
  // Normalize to unit length
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += arr[i] * arr[i];
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < dim; i++) arr[i] /= mag;
  }
  return arr;
}

/**
 * Create two orthogonal embeddings (cosine distance = 1.0, guaranteed shift).
 */
function orthogonalPair(dim: number): [Float32Array, Float32Array] {
  const a = new Float32Array(dim);
  a[0] = 1.0;
  const b = new Float32Array(dim);
  b[1] = 1.0;
  return [a, b];
}

/**
 * Create two nearly identical embeddings (cosine distance ~ 0, no shift).
 */
function similarPair(dim: number): [Float32Array, Float32Array] {
  const a = makeEmbedding(dim, [1, 0.01, 0]);
  const b = makeEmbedding(dim, [1, 0.02, 0]);
  return [a, b];
}

function makeObservation(
  repo: ObservationRepository,
  content: string,
  sessionId: string,
): Observation {
  return repo.create({
    content,
    title: content.slice(0, 50),
    source: 'test',
    sessionId,
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Topic Shift Integration Tests', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-topic-int-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
  });

  afterEach(() => {
    ldb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // SC1: Topic shift detection triggers stash creation
  // -------------------------------------------------------------------------

  describe('SC1: Topic shift detection triggers stash creation', () => {
    it('creates stash when embeddings diverge significantly', async () => {
      const detector = new TopicShiftDetector({ threshold: 0.3 });
      const stashManager = new StashManager(ldb.db);
      const obsRepo = new ObservationRepository(ldb.db, PROJECT_HASH);
      const decisionLogger = new TopicShiftDecisionLogger(ldb.db);

      const handler = new TopicShiftHandler({
        detector,
        stashManager,
        observationStore: obsRepo,
        decisionLogger,
      });

      // Create two observations with very different embeddings
      const [embA, embB] = orthogonalPair(384);

      const obs1 = makeObservation(obsRepo, 'Working on authentication module with JWT tokens', 'sess-001');
      // Backdate obs1 so its created_at is strictly before obs2's
      ldb.db.prepare("UPDATE observations SET created_at = datetime('now', '-2 seconds') WHERE id = ?").run(obs1.id);
      obs1.createdAt = (ldb.db.prepare('SELECT created_at FROM observations WHERE id = ?').get(obs1.id) as { created_at: string }).created_at;

      const obs2 = makeObservation(obsRepo, 'Switching to database migration system design', 'sess-001');

      // Feed first observation (no shift -- first observation)
      const result1 = await handler.handleObservation(
        { ...obs1, embedding: embA },
        'sess-001',
        PROJECT_HASH,
      );
      expect(result1.stashed).toBe(false);
      expect(result1.notification).toBeNull();

      // Feed second observation with orthogonal embedding (guaranteed shift)
      const result2 = await handler.handleObservation(
        { ...obs2, embedding: embB },
        'sess-001',
        PROJECT_HASH,
      );
      expect(result2.stashed).toBe(true);
      expect(result2.notification).toContain('Topic shift detected');
      expect(result2.notification).toContain('/laminark:resume');

      // Verify stash was persisted
      const stashes = stashManager.listStashes(PROJECT_HASH);
      expect(stashes).toHaveLength(1);
      expect(stashes[0].topicLabel).toBeTruthy();
      expect(stashes[0].sessionId).toBe('sess-001');

      // Verify decisions were logged (2 decisions: one not-shifted, one shifted)
      const decisions = decisionLogger.getSessionDecisions(PROJECT_HASH, 'sess-001');
      expect(decisions).toHaveLength(2);
      const shiftedDecisions = decisions.filter(d => d.shifted);
      const notShiftedDecisions = decisions.filter(d => !d.shifted);
      expect(shiftedDecisions).toHaveLength(1);
      expect(notShiftedDecisions).toHaveLength(1);
    });

    it('does not create stash when embeddings are similar', async () => {
      const detector = new TopicShiftDetector({ threshold: 0.3 });
      const stashManager = new StashManager(ldb.db);
      const obsRepo = new ObservationRepository(ldb.db, PROJECT_HASH);

      const handler = new TopicShiftHandler({
        detector,
        stashManager,
        observationStore: obsRepo,
      });

      const [embA, embB] = similarPair(384);

      const obs1 = makeObservation(obsRepo, 'Working on auth module', 'sess-001');
      const obs2 = makeObservation(obsRepo, 'Still working on auth module', 'sess-001');

      await handler.handleObservation(
        { ...obs1, embedding: embA },
        'sess-001',
        PROJECT_HASH,
      );

      const result2 = await handler.handleObservation(
        { ...obs2, embedding: embB },
        'sess-001',
        PROJECT_HASH,
      );

      expect(result2.stashed).toBe(false);
      expect(result2.notification).toBeNull();

      // No stashes created
      const stashes = stashManager.listStashes(PROJECT_HASH);
      expect(stashes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SC2: Notification stored and consumed via NotificationStore
  // -------------------------------------------------------------------------

  describe('SC2: NotificationStore add/consume lifecycle', () => {
    it('stores and consumes pending notifications', () => {
      const store = new NotificationStore(ldb.db);

      // Add a notification
      store.add(PROJECT_HASH, 'Topic shift detected. Previous context stashed: "auth module".');

      // Consume returns the notification
      const pending = store.consumePending(PROJECT_HASH);
      expect(pending).toHaveLength(1);
      expect(pending[0].message).toContain('Topic shift detected');
      expect(pending[0].projectId).toBe(PROJECT_HASH);

      // Second consume returns empty (already consumed)
      const empty = store.consumePending(PROJECT_HASH);
      expect(empty).toHaveLength(0);
    });

    it('handles multiple pending notifications', () => {
      const store = new NotificationStore(ldb.db);

      store.add(PROJECT_HASH, 'First notification');
      store.add(PROJECT_HASH, 'Second notification');

      const pending = store.consumePending(PROJECT_HASH);
      expect(pending).toHaveLength(2);
      expect(pending[0].message).toBe('First notification');
      expect(pending[1].message).toBe('Second notification');

      // All consumed
      const empty = store.consumePending(PROJECT_HASH);
      expect(empty).toHaveLength(0);
    });

    it('scopes notifications to project', () => {
      const store = new NotificationStore(ldb.db);

      store.add('project-a', 'For project A');
      store.add('project-b', 'For project B');

      const pendingA = store.consumePending('project-a');
      expect(pendingA).toHaveLength(1);
      expect(pendingA[0].message).toBe('For project A');

      // Project B still has its notification
      const pendingB = store.consumePending('project-b');
      expect(pendingB).toHaveLength(1);
      expect(pendingB[0].message).toBe('For project B');
    });
  });

  // -------------------------------------------------------------------------
  // SC1 + SC2: Full pipeline from embedding to notification
  // -------------------------------------------------------------------------

  describe('SC1+SC2: Full pipeline from detection to notification delivery', () => {
    it('end-to-end: shift detected -> stash created -> notification stored -> consumed', async () => {
      const detector = new TopicShiftDetector({ threshold: 0.3 });
      const stashManager = new StashManager(ldb.db);
      const obsRepo = new ObservationRepository(ldb.db, PROJECT_HASH);
      const decisionLogger = new TopicShiftDecisionLogger(ldb.db);
      const notificationStore = new NotificationStore(ldb.db);
      const adaptiveManager = new AdaptiveThresholdManager({
        sensitivityMultiplier: 1.5,
        alpha: 0.3,
      });

      const handler = new TopicShiftHandler({
        detector,
        stashManager,
        observationStore: obsRepo,
        decisionLogger,
        adaptiveManager,
      });

      // Create observations
      const obs1 = makeObservation(obsRepo, 'Building REST API endpoints for user management', 'sess-full');
      // Backdate obs1 so its created_at is strictly before obs2's
      ldb.db.prepare("UPDATE observations SET created_at = datetime('now', '-2 seconds') WHERE id = ?").run(obs1.id);
      obs1.createdAt = (ldb.db.prepare('SELECT created_at FROM observations WHERE id = ?').get(obs1.id) as { created_at: string }).created_at;

      const obs2 = makeObservation(obsRepo, 'Completely different: designing the CI/CD pipeline', 'sess-full');

      const [embA, embB] = orthogonalPair(384);

      // Process first observation (no shift)
      await handler.handleObservation(
        { ...obs1, embedding: embA },
        'sess-full',
        PROJECT_HASH,
      );

      // Process second observation (shift triggers)
      const result = await handler.handleObservation(
        { ...obs2, embedding: embB },
        'sess-full',
        PROJECT_HASH,
      );

      // Shift detected
      expect(result.stashed).toBe(true);
      expect(result.notification).toBeTruthy();

      // Store notification (simulating what processUnembedded does)
      notificationStore.add(PROJECT_HASH, result.notification!);

      // Consume notification (simulating what MCP tool does)
      const pending = notificationStore.consumePending(PROJECT_HASH);
      expect(pending).toHaveLength(1);
      expect(pending[0].message).toContain('Topic shift detected');
      expect(pending[0].message).toContain('/laminark:resume');

      // Second consume returns empty
      const empty = notificationStore.consumePending(PROJECT_HASH);
      expect(empty).toHaveLength(0);

      // Verify stash exists
      const stashes = stashManager.listStashes(PROJECT_HASH);
      expect(stashes).toHaveLength(1);

      // Verify decision log has both entries
      const decisions = decisionLogger.getSessionDecisions(PROJECT_HASH, 'sess-full');
      expect(decisions).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Graceful degradation: detection disabled
  // -------------------------------------------------------------------------

  describe('Graceful degradation', () => {
    it('config.enabled=false disables detection without side effects', async () => {
      const detector = new TopicShiftDetector({ threshold: 0.3 });
      const stashManager = new StashManager(ldb.db);
      const obsRepo = new ObservationRepository(ldb.db, PROJECT_HASH);

      const handler = new TopicShiftHandler({
        detector,
        stashManager,
        observationStore: obsRepo,
        config: {
          enabled: false,
          sensitivityPreset: 'balanced',
          sensitivityMultiplier: 1.5,
          manualThreshold: null,
          ewmaAlpha: 0.3,
          thresholdBounds: { min: 0.15, max: 0.6 },
        },
      });

      const [embA, embB] = orthogonalPair(384);
      const obs = makeObservation(obsRepo, 'Some content', 'sess-disabled');

      // Even with orthogonal embedding, no shift because disabled
      const result = await handler.handleObservation(
        { ...obs, embedding: embA },
        'sess-disabled',
        PROJECT_HASH,
      );

      expect(result.stashed).toBe(false);
      expect(result.notification).toBeNull();

      // No stashes created
      const stashes = stashManager.listStashes(PROJECT_HASH);
      expect(stashes).toHaveLength(0);
    });

    it('observation without embedding skips detection gracefully', async () => {
      const detector = new TopicShiftDetector({ threshold: 0.3 });
      const stashManager = new StashManager(ldb.db);
      const obsRepo = new ObservationRepository(ldb.db, PROJECT_HASH);

      const handler = new TopicShiftHandler({
        detector,
        stashManager,
        observationStore: obsRepo,
      });

      const obs = makeObservation(obsRepo, 'No embedding here', 'sess-no-embed');

      const result = await handler.handleObservation(
        { ...obs, embedding: null },
        'sess-no-embed',
        PROJECT_HASH,
      );

      expect(result.stashed).toBe(false);
      expect(result.notification).toBeNull();
    });
  });
});
