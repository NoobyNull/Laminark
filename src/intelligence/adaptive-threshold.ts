// ---------------------------------------------------------------------------
// EWMA Adaptive Topic Threshold
// ---------------------------------------------------------------------------
// Adjusts the topic shift detection threshold per-session based on observed
// cosine distances using an Exponentially Weighted Moving Average (EWMA).
//
// A scattered session (high distances) raises the threshold over time.
// A focused session (low distances) lowers the threshold over time.
// New sessions seed from historical averages for cold start handling.
// ---------------------------------------------------------------------------

/**
 * Internal state of the adaptive threshold computation.
 */
export interface ThresholdState {
  /** Exponentially weighted moving average of observed distances */
  ewmaDistance: number;
  /** Exponentially weighted variance of observed distances */
  ewmaVariance: number;
  /** Decay factor for EWMA (0 < alpha <= 1) */
  alpha: number;
  /** Standard deviations above the mean for threshold */
  sensitivityMultiplier: number;
  /** Number of distance observations processed */
  observationCount: number;
}

/** Default EWMA distance when no history exists */
const DEFAULT_EWMA_DISTANCE = 0.3;

/** Default EWMA variance when no history exists */
const DEFAULT_EWMA_VARIANCE = 0.01;

/** Default decay factor */
const DEFAULT_ALPHA = 0.3;

/** Default sensitivity (standard deviations above mean) */
const DEFAULT_SENSITIVITY_MULTIPLIER = 1.5;

/** Hard lower bound for threshold -- prevents over-sensitive detection */
const THRESHOLD_MIN = 0.15;

/** Hard upper bound for threshold -- prevents ignoring real shifts */
const THRESHOLD_MAX = 0.6;

/**
 * Manages an EWMA-based adaptive threshold for topic shift detection.
 *
 * After each topic distance observation, call `update(distance)` to refine
 * the threshold. The threshold adapts:
 * - High distances (scattered topics) push the threshold up
 * - Low distances (focused topics) push the threshold down
 * - Threshold is bounded within [0.15, 0.6] to prevent extreme drift
 *
 * For cold start, call `seedFromHistory(avgDistance, avgVariance)` with
 * averages loaded from the ThresholdStore.
 */
export class AdaptiveThresholdManager {
  private ewmaDistance: number;
  private ewmaVariance: number;
  private alpha: number;
  private sensitivityMultiplier: number;
  private observationCount: number;

  constructor(options?: {
    alpha?: number;
    sensitivityMultiplier?: number;
  }) {
    this.alpha = options?.alpha ?? DEFAULT_ALPHA;
    this.sensitivityMultiplier =
      options?.sensitivityMultiplier ?? DEFAULT_SENSITIVITY_MULTIPLIER;
    this.ewmaDistance = DEFAULT_EWMA_DISTANCE;
    this.ewmaVariance = DEFAULT_EWMA_VARIANCE;
    this.observationCount = 0;
  }

  /**
   * Feed a new cosine distance observation and update the EWMA state.
   *
   * EWMA update formula:
   * 1. ewmaDistance = alpha * distance + (1 - alpha) * ewmaDistance
   * 2. diff = distance - ewmaDistance (after update)
   * 3. ewmaVariance = alpha * (diff * diff) + (1 - alpha) * ewmaVariance
   * 4. threshold = clamp(ewmaDistance + sensitivityMultiplier * sqrt(ewmaVariance), 0.15, 0.6)
   *
   * @param distance - Cosine distance from the latest topic detection
   * @returns The new adaptive threshold value
   */
  update(distance: number): number {
    // Step 1: Update EWMA distance
    this.ewmaDistance =
      this.alpha * distance + (1 - this.alpha) * this.ewmaDistance;

    // Step 2: Compute deviation from new mean
    const diff = distance - this.ewmaDistance;

    // Step 3: Update EWMA variance
    this.ewmaVariance =
      this.alpha * (diff * diff) + (1 - this.alpha) * this.ewmaVariance;

    // Step 4: Increment observation count
    this.observationCount++;

    // Step 5: Return clamped threshold
    return this.getThreshold();
  }

  /**
   * Seed the EWMA state from historical session averages (cold start).
   * Does not reset observation count -- only updates the statistical seed.
   */
  seedFromHistory(averageDistance: number, averageVariance: number): void {
    this.ewmaDistance = averageDistance;
    this.ewmaVariance = averageVariance;
  }

  /**
   * Compute the current threshold from EWMA state, clamped to bounds.
   *
   * Formula: ewmaDistance + sensitivityMultiplier * sqrt(ewmaVariance)
   * Bounded to [0.15, 0.6]
   */
  getThreshold(): number {
    const raw =
      this.ewmaDistance +
      this.sensitivityMultiplier * Math.sqrt(this.ewmaVariance);
    return Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, raw));
  }

  /**
   * Return a snapshot of the current EWMA state.
   */
  getState(): ThresholdState {
    return {
      ewmaDistance: this.ewmaDistance,
      ewmaVariance: this.ewmaVariance,
      alpha: this.alpha,
      sensitivityMultiplier: this.sensitivityMultiplier,
      observationCount: this.observationCount,
    };
  }

  /**
   * Reset all EWMA state to defaults.
   */
  reset(): void {
    this.ewmaDistance = DEFAULT_EWMA_DISTANCE;
    this.ewmaVariance = DEFAULT_EWMA_VARIANCE;
    this.observationCount = 0;
  }
}
