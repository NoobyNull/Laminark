// ---------------------------------------------------------------------------
// Topic Shift Handler -- Integration Layer
// ---------------------------------------------------------------------------
// Orchestrates topic detection and context stashing. When a new observation
// embedding has high cosine distance from the previous one, the current
// context thread is automatically stashed and the user is notified.
//
// This is the integration layer that makes topic detection active:
//   - Plan 01 built the detector (TopicShiftDetector)
//   - Plan 02 built storage (StashManager)
//   - This module connects them into the live hook flow
// ---------------------------------------------------------------------------

import { debug } from '../shared/debug.js';
import type { TopicShiftDetector } from '../intelligence/topic-detector.js';
import type { StashManager } from '../storage/stash-manager.js';
import type { ObservationRepository } from '../storage/observations.js';
import type { StashObservation } from '../types/stash.js';
import type { Observation } from '../shared/types.js';

/**
 * Result of handling an observation through the topic shift pipeline.
 */
export interface TopicShiftHandlerResult {
  /** Whether a stash was created due to topic shift */
  stashed: boolean;
  /** Notification message to surface to the user, or null if no shift */
  notification: string | null;
}

/**
 * Dependencies required by TopicShiftHandler.
 */
export interface TopicShiftHandlerDeps {
  detector: TopicShiftDetector;
  stashManager: StashManager;
  observationStore: ObservationRepository;
}

/**
 * Orchestrates topic shift detection and automatic stashing.
 *
 * On each observation:
 *   1. If no embedding, skip detection
 *   2. Run detector.detect(embedding)
 *   3. If shifted: gather previous observations, create stash, return notification
 *   4. If not shifted: return no-op result
 */
export class TopicShiftHandler {
  private readonly detector: TopicShiftDetector;
  private readonly stashManager: StashManager;
  private readonly observationStore: ObservationRepository;

  constructor(deps: TopicShiftHandlerDeps) {
    this.detector = deps.detector;
    this.stashManager = deps.stashManager;
    this.observationStore = deps.observationStore;

    debug('hook', 'TopicShiftHandler initialized');
  }

  /**
   * Evaluate an observation for topic shift.
   *
   * If a shift is detected, gathers recent observations from the previous
   * topic, creates a stash snapshot, and returns a notification message
   * for the user.
   */
  async handleObservation(
    observation: Observation,
    sessionId: string,
    projectId: string,
  ): Promise<TopicShiftHandlerResult> {
    // 1. No embedding -> skip detection
    if (!observation.embedding) {
      debug('hook', 'TopicShiftHandler: no embedding, skipping', {
        id: observation.id,
      });
      return { stashed: false, notification: null };
    }

    // 2. Run detector -- convert Float32Array to number[] for cosine distance
    const embeddingArray = Array.from(observation.embedding);
    const result = this.detector.detect(embeddingArray);

    debug('hook', 'TopicShiftHandler: detection result', {
      shifted: result.shifted,
      distance: result.distance,
      threshold: result.threshold,
    });

    // 3. Not shifted -> no-op
    if (!result.shifted) {
      return { stashed: false, notification: null };
    }

    // 4. Shifted -- gather previous topic observations
    //    Query recent observations from the same session, before this observation
    const recentObservations = this.observationStore.list({
      sessionId,
      limit: 20,
    });

    // Filter to observations before the current one (by timestamp)
    const previousObservations = recentObservations.filter(
      (obs) => obs.createdAt < observation.createdAt,
    );

    // 5. Generate topic label from first previous observation
    const topicLabel = this.generateTopicLabel(previousObservations);

    // 6. Generate summary
    const summary = this.generateSummary(previousObservations);

    // 7. Create stash observation snapshots
    const snapshots: StashObservation[] = previousObservations.map((obs) => ({
      id: obs.id,
      content: obs.content,
      type: obs.source,
      timestamp: obs.createdAt,
      embedding: obs.embedding ? Array.from(obs.embedding) : null,
    }));

    // 8. Create stash
    this.stashManager.createStash({
      projectId,
      sessionId,
      topicLabel,
      summary,
      observations: snapshots,
    });

    debug('hook', 'TopicShiftHandler: stash created', { topicLabel });

    // 9. Return notification
    const notification = `Topic shift detected. Previous context stashed: "${topicLabel}". Use /laminark:resume to return.`;

    return { stashed: true, notification };
  }

  /**
   * Generate a topic label from the first observation's content.
   * Uses first 50 characters, trimmed and cleaned.
   */
  private generateTopicLabel(observations: Observation[]): string {
    if (observations.length === 0) {
      return 'Unknown topic';
    }

    const first = observations[observations.length - 1]; // oldest (list is DESC)
    const raw = first.content.replace(/\n/g, ' ').trim();
    return raw.slice(0, 50) || 'Unknown topic';
  }

  /**
   * Generate a brief summary by concatenating the first 3 observation contents,
   * truncated to 200 characters total.
   */
  private generateSummary(observations: Observation[]): string {
    if (observations.length === 0) {
      return '';
    }

    // Take up to 3 oldest observations (list is DESC, so take from the end)
    const oldest = observations.slice(-3).reverse();
    const joined = oldest
      .map((obs) => obs.content.replace(/\n/g, ' ').trim())
      .join(' | ');

    return joined.slice(0, 200);
  }
}
