// ---------------------------------------------------------------------------
// Topic Shift Detection -- Static Threshold
// ---------------------------------------------------------------------------
// Computes cosine distance between consecutive observation embeddings and
// determines whether a topic shift has occurred based on a static threshold.
// Foundation for all topic detection in Phase 6 -- adaptive EWMA layered on
// in Plan 05.
// ---------------------------------------------------------------------------

/**
 * Result of a topic shift detection check.
 */
export interface TopicShiftResult {
  /** Whether a topic shift was detected */
  shifted: boolean;
  /** Cosine distance between current and previous embedding */
  distance: number;
  /** Threshold used for this detection */
  threshold: number;
  /** Confidence 0-1 -- how far past the threshold (0 if not shifted) */
  confidence: number;
  /** Previous embedding (null if first observation) */
  previousEmbedding: number[] | null;
  /** Current embedding that was evaluated */
  currentEmbedding: number[];
}

/**
 * Compute cosine distance between two vectors.
 *
 * Returns 1 - cosineSimilarity(a, b).
 * Range: [0, 2] where 0 = identical, 1 = orthogonal, 2 = opposite.
 * Handles zero vectors gracefully by returning 0 (not NaN).
 */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitudeProduct = Math.sqrt(magA) * Math.sqrt(magB);

  // Zero vector: treat as no distance (graceful, no NaN)
  if (magnitudeProduct === 0) {
    return 0;
  }

  const similarity = dot / magnitudeProduct;

  // Clamp to [-1, 1] to handle floating-point rounding
  const clampedSimilarity = Math.max(-1, Math.min(1, similarity));

  return 1 - clampedSimilarity;
}

/**
 * Detects topic shifts by comparing consecutive observation embeddings
 * against a static cosine distance threshold.
 */
export class TopicShiftDetector {
  private lastEmbedding: number[] | null = null;
  private threshold: number;

  constructor(options?: { threshold?: number }) {
    this.threshold = options?.threshold ?? 0.3;
  }

  /**
   * Evaluate a new embedding for topic shift against the previous one.
   * Updates internal state with the new embedding after evaluation.
   */
  detect(embedding: number[]): TopicShiftResult {
    const previous = this.lastEmbedding;
    this.lastEmbedding = embedding;

    // First observation -- no prior to compare against
    if (previous === null) {
      return {
        shifted: false,
        distance: 0,
        threshold: this.threshold,
        confidence: 0,
        previousEmbedding: null,
        currentEmbedding: embedding,
      };
    }

    const distance = cosineDistance(previous, embedding);
    const shifted = distance > this.threshold;
    const confidence = shifted
      ? Math.min((distance - this.threshold) / this.threshold, 1.0)
      : 0;

    return {
      shifted,
      distance,
      threshold: this.threshold,
      confidence,
      previousEmbedding: previous,
      currentEmbedding: embedding,
    };
  }

  /** Clear last embedding state -- next detect is treated as first observation */
  reset(): void {
    this.lastEmbedding = null;
  }

  /** Get current threshold value */
  getThreshold(): number {
    return this.threshold;
  }

  /** Set threshold value, bounded to [0.05, 0.95] */
  setThreshold(value: number): void {
    this.threshold = Math.max(0.05, Math.min(0.95, value));
  }
}
