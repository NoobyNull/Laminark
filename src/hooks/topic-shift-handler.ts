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
//   - Plan 05 built adaptive threshold (AdaptiveThresholdManager)
//   - Plan 06 adds config (TopicDetectionConfig) and logging (DecisionLogger)
//   - This module connects them into the live hook flow
// ---------------------------------------------------------------------------

import { debug } from '../shared/debug.js';
import type { TopicShiftDetector } from '../intelligence/topic-detector.js';
import type { AdaptiveThresholdManager } from '../intelligence/adaptive-threshold.js';
import type { TopicShiftDecisionLogger, ShiftDecision } from '../intelligence/decision-logger.js';
import type { TopicDetectionConfig } from '../config/topic-detection-config.js';
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
 *
 * Core dependencies (detector, stashManager, observationStore) are required.
 * Optional dependencies (config, decisionLogger, adaptiveManager) enable
 * additional functionality when provided. When omitted, the handler falls
 * back to simpler behavior for backward compatibility and easier test setups.
 */
export interface TopicShiftHandlerDeps {
  detector: TopicShiftDetector;
  stashManager: StashManager;
  observationStore: ObservationRepository;
  /** Optional: config for enable/disable, manual override, sensitivity */
  config?: TopicDetectionConfig;
  /** Optional: logs every detection decision for debugging */
  decisionLogger?: TopicShiftDecisionLogger;
  /** Optional: adaptive threshold manager for EWMA updates */
  adaptiveManager?: AdaptiveThresholdManager;
}

/**
 * Orchestrates topic shift detection and automatic stashing.
 *
 * Full pipeline when all dependencies provided:
 *   1. Check config (enabled? manual override?)
 *   2. Run detector.detect(embedding)
 *   3. If adaptive manager: update EWMA and set new threshold
 *   4. Log decision via decision logger
 *   5. If shifted: gather observations, create stash, notify
 *   6. If not shifted: return no-op result
 *
 * When optional deps are omitted, steps 1/3/4 are skipped gracefully.
 */
export class TopicShiftHandler {
  private readonly detector: TopicShiftDetector;
  private readonly stashManager: StashManager;
  private readonly observationStore: ObservationRepository;
  private readonly config?: TopicDetectionConfig;
  private readonly decisionLogger?: TopicShiftDecisionLogger;
  private readonly adaptiveManager?: AdaptiveThresholdManager;

  constructor(deps: TopicShiftHandlerDeps) {
    this.detector = deps.detector;
    this.stashManager = deps.stashManager;
    this.observationStore = deps.observationStore;
    this.config = deps.config;
    this.decisionLogger = deps.decisionLogger;
    this.adaptiveManager = deps.adaptiveManager;

    debug('hook', 'TopicShiftHandler initialized', {
      hasConfig: !!deps.config,
      hasDecisionLogger: !!deps.decisionLogger,
      hasAdaptiveManager: !!deps.adaptiveManager,
    });
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
    // 0. Config check: if detection is disabled, return early
    if (this.config && !this.config.enabled) {
      debug('hook', 'TopicShiftHandler: detection disabled by config');
      return { stashed: false, notification: null };
    }

    // 1. No embedding -> skip detection
    if (!observation.embedding) {
      debug('hook', 'TopicShiftHandler: no embedding, skipping', {
        id: observation.id,
      });
      return { stashed: false, notification: null };
    }

    // 2. Apply manual threshold override if configured
    if (this.config?.manualThreshold !== undefined && this.config.manualThreshold !== null) {
      this.detector.setThreshold(this.config.manualThreshold);
    }

    // 3. Run detector -- convert Float32Array to number[] for cosine distance
    const embeddingArray = Array.from(observation.embedding);
    const result = this.detector.detect(embeddingArray);

    debug('hook', 'TopicShiftHandler: detection result', {
      shifted: result.shifted,
      distance: result.distance,
      threshold: result.threshold,
    });

    // 4. Adaptive threshold update (if adaptive manager present and no manual override)
    if (this.adaptiveManager && !(this.config?.manualThreshold !== undefined && this.config.manualThreshold !== null)) {
      const newThreshold = this.adaptiveManager.update(result.distance);
      this.detector.setThreshold(newThreshold);
      debug('hook', 'TopicShiftHandler: adaptive threshold updated', {
        newThreshold,
      });
    }

    // 5. Determine stash ID (only available after stash creation below)
    let stashId: string | null = null;

    // 6. Handle shift: gather observations and create stash
    if (result.shifted) {
      // Gather previous topic observations (include unclassified -- observations
      // may not yet be classified by the background classifier when shift runs)
      const recentObservations = this.observationStore.list({
        sessionId,
        limit: 20,
        includeUnclassified: true,
      });

      // Filter to observations before the current one (by timestamp)
      const previousObservations = recentObservations.filter(
        (obs) => obs.createdAt < observation.createdAt,
      );

      // Nothing to stash (clean context / session start) -- skip
      if (previousObservations.length === 0) {
        debug('hook', 'TopicShiftHandler: no previous observations to stash, skipping');
        return { stashed: false, notification: null };
      }

      // Generate topic label from previous observations
      const topicLabel = this.generateTopicLabel(previousObservations);

      // Generate summary
      const summary = this.generateSummary(previousObservations);

      // Create stash observation snapshots
      const snapshots: StashObservation[] = previousObservations.map((obs) => ({
        id: obs.id,
        content: obs.content,
        type: obs.source,
        timestamp: obs.createdAt,
        embedding: obs.embedding ? Array.from(obs.embedding) : null,
      }));

      // Create stash
      const stash = this.stashManager.createStash({
        projectId,
        sessionId,
        topicLabel,
        summary,
        observations: snapshots,
      });

      stashId = stash.id;

      debug('hook', 'TopicShiftHandler: stash created', { topicLabel, stashId });

      // 7. Log decision (if logger present)
      if (this.decisionLogger) {
        const decision: ShiftDecision = {
          projectId,
          sessionId,
          observationId: observation.id,
          distance: result.distance,
          threshold: result.threshold,
          ewmaDistance: this.adaptiveManager?.getState().ewmaDistance ?? null,
          ewmaVariance: this.adaptiveManager?.getState().ewmaVariance ?? null,
          sensitivityMultiplier: this.config?.sensitivityMultiplier ?? 1.5,
          shifted: true,
          confidence: result.confidence,
          stashId,
        };
        this.decisionLogger.log(decision);
      }

      // Return notification
      const notification = `Topic shift detected. Previous context stashed: "${topicLabel}". Use /laminark:resume to return.`;
      return { stashed: true, notification };
    }

    // 8. Not shifted -- log decision and return no-op
    if (this.decisionLogger) {
      const decision: ShiftDecision = {
        projectId,
        sessionId,
        observationId: observation.id,
        distance: result.distance,
        threshold: result.threshold,
        ewmaDistance: this.adaptiveManager?.getState().ewmaDistance ?? null,
        ewmaVariance: this.adaptiveManager?.getState().ewmaVariance ?? null,
        sensitivityMultiplier: this.config?.sensitivityMultiplier ?? 1.5,
        shifted: false,
        confidence: result.confidence,
        stashId: null,
      };
      this.decisionLogger.log(decision);
    }

    return { stashed: false, notification: null };
  }

  /**
   * Generate a semantic topic label from the observations.
   *
   * Priority: use observation titles (most semantic), then fall back
   * to content. Scans all observations for the best available label
   * rather than just using the first one.
   */
  private generateTopicLabel(observations: Observation[]): string {
    if (observations.length === 0) {
      return 'Unknown topic';
    }

    // Prefer titled observations -- titles are explicitly authored and semantic
    for (const obs of observations) {
      if (obs.title) {
        const cleaned = obs.title.replace(/\n/g, ' ').trim();
        if (cleaned.length > 0) {
          return cleaned.slice(0, 80);
        }
      }
    }

    // Fallback: use the oldest observation's content (list is DESC)
    const oldest = observations[observations.length - 1];
    const raw = oldest.content.replace(/\n/g, ' ').trim();
    return raw.slice(0, 80) || 'Unknown topic';
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
