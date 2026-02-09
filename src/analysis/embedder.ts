/**
 * EmbeddingEngine interface and factory.
 *
 * Defines the pluggable abstraction for text embedding.
 * All consumers depend on this interface -- never on concrete engines.
 */

import { LocalOnnxEngine } from './engines/local-onnx.js';
import { KeywordOnlyEngine } from './engines/keyword-only.js';

/**
 * Pluggable embedding engine abstraction.
 *
 * All methods that can fail return null/false -- engines NEVER throw.
 * This is critical for graceful degradation (DQ-03).
 */
export interface EmbeddingEngine {
  /** Embed a single text string. Returns null on failure or empty input. */
  embed(text: string): Promise<Float32Array | null>;

  /** Embed multiple texts. Returns null for any that failed or were empty. */
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;

  /** Embedding dimensions (384 for BGE Small, 0 for keyword-only). */
  dimensions(): number;

  /** Engine identifier string. */
  name(): string;

  /** Lazy initialization. Returns true on success, false on failure. */
  initialize(): Promise<boolean>;

  /** Whether initialize() has been called and succeeded. */
  isReady(): boolean;
}

/**
 * Creates and initializes an embedding engine.
 *
 * Attempts LocalOnnxEngine first. If initialization fails (missing model,
 * ONNX runtime unavailable, etc.), falls back to KeywordOnlyEngine.
 *
 * Never throws -- always returns a valid engine.
 */
export async function createEmbeddingEngine(): Promise<EmbeddingEngine> {
  const onnxEngine = new LocalOnnxEngine();
  const success = await onnxEngine.initialize();

  if (success) {
    return onnxEngine;
  }

  return new KeywordOnlyEngine();
}
