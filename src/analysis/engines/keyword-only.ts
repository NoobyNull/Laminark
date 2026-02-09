/**
 * Null fallback embedding engine for graceful degradation (DQ-03).
 *
 * Used when the ONNX runtime or model is unavailable.
 * All embedding methods return null -- search falls back to keyword-only (FTS5).
 */

import type { EmbeddingEngine } from '../embedder.js';

/**
 * Embedding engine that produces no embeddings.
 *
 * Acts as a silent fallback so that the rest of the system can
 * operate in keyword-only mode without special-casing missing engines.
 */
export class KeywordOnlyEngine implements EmbeddingEngine {
  /** Always returns null -- no model available. */
  async embed(): Promise<Float32Array | null> {
    return null;
  }

  /** Returns array of nulls matching input length. */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    return texts.map(() => null);
  }

  /** No dimensions -- no model. */
  dimensions(): number {
    return 0;
  }

  /** Engine identifier. */
  name(): string {
    return 'keyword-only';
  }

  /** Intentionally returns false -- this engine has no model. */
  async initialize(): Promise<boolean> {
    return false;
  }

  /** Always false -- no model loaded. */
  isReady(): boolean {
    return false;
  }
}
