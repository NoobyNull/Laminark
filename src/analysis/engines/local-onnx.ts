/**
 * Local ONNX embedding engine using @huggingface/transformers.
 *
 * Loads BGE Small EN v1.5 (quantized q8) via dynamic import() for
 * zero startup cost (DQ-04). Model files are cached in ~/.laminark/models/.
 */

import { join } from 'node:path';

import { getConfigDir } from '../../shared/config.js';
import type { EmbeddingEngine } from '../embedder.js';

// Pipeline type from @huggingface/transformers -- kept as `unknown` to avoid
// hard dependency on the library's type definitions at import time.
type Pipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: ArrayLike<number> }>;

/**
 * Embedding engine backed by BGE Small EN v1.5 running locally via ONNX Runtime.
 *
 * All public methods catch errors internally and return null/false.
 */
export class LocalOnnxEngine implements EmbeddingEngine {
  private pipe: Pipeline | null = null;
  private ready = false;

  /**
   * Lazily loads the model via dynamic import().
   *
   * - Uses `@huggingface/transformers` loaded at runtime (not bundled)
   * - Caches model files in ~/.laminark/models/
   * - Returns false on any error (missing runtime, download failure, etc.)
   */
  async initialize(): Promise<boolean> {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');

      // Cache models in user config directory
      env.cacheDir = join(getConfigDir(), 'models');

      this.pipe = (await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
        dtype: 'q8',
      })) as unknown as Pipeline;

      this.ready = true;
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  /**
   * Embeds a single text string into a 384-dimensional vector.
   *
   * Returns null if:
   * - Engine not initialized
   * - Input is empty/whitespace
   * - Pipeline throws
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.ready || !this.pipe) {
      return null;
    }

    if (!text || text.trim().length === 0) {
      return null;
    }

    try {
      const output = await this.pipe(text, { pooling: 'cls', normalize: true });
      return Float32Array.from(output.data);
    } catch {
      return null;
    }
  }

  /**
   * Embeds multiple texts, preserving order.
   *
   * Returns null for any text that was empty or failed.
   */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const results: (Float32Array | null)[] = [];

    for (const text of texts) {
      if (!text || text.trim().length === 0) {
        results.push(null);
      } else {
        results.push(await this.embed(text));
      }
    }

    return results;
  }

  /** BGE Small EN v1.5 produces 384-dimensional embeddings. */
  dimensions(): number {
    return 384;
  }

  /** Engine identifier. */
  name(): string {
    return 'bge-small-en-v1.5-q8';
  }

  /** Whether the model loaded successfully. */
  isReady(): boolean {
    return this.ready;
  }
}
