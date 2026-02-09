/**
 * Piggyback embedding strategy.
 *
 * Uses semantic signals extracted from Claude's response text during
 * PostToolUse hook processing to augment or replace ONNX embeddings.
 *
 * The "piggyback" concept: Claude is already processing text, so we
 * extract semantic features from its response at zero added latency.
 * These features are blended with the local ONNX embedding to produce
 * a higher-quality vector.
 *
 * Fallback chain:
 *   1. Hybrid: 70% ONNX + 30% keyword features from semantic signals
 *   2. ONNX-only: If no signals available, use fallback strategy directly
 *   3. Keyword-only: If no fallback configured, produce sparse keyword vector
 */

import type { EmbeddingEngine } from '../embedder.js';
import type { SemanticSignal } from '../../hooks/piggyback-extractor.js';

// ---------------------------------------------------------------------------
// Signal cache -- hook extractor writes, strategy reads
// ---------------------------------------------------------------------------

/**
 * Cache of semantic signals from hook processing.
 *
 * Key: text content (or hash of it) that was processed.
 * Value: signal + timestamp for TTL eviction.
 *
 * The piggyback extractor writes to this cache during PostToolUse hook,
 * and the PiggybackEngine reads from it during embed() calls.
 */
export const signalCache = new Map<string, { signal: SemanticSignal; timestamp: number }>();

/** TTL for cached signals: 30 seconds */
const SIGNAL_TTL_MS = 30_000;

/** Maximum cache entries before forced cleanup */
const MAX_CACHE_SIZE = 100;

/** Default embedding dimensions when no fallback is available */
const DEFAULT_DIMENSIONS = 384;

/** Blending weight: ONNX contribution */
const ONNX_WEIGHT = 0.7;

/** Blending weight: keyword feature contribution */
const KEYWORD_WEIGHT = 0.3;

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Evict stale entries from the signal cache (lazy, on read).
 */
function evictStale(): void {
  const now = Date.now();
  const keys = Array.from(signalCache.keys());
  for (const key of keys) {
    const entry = signalCache.get(key);
    if (entry && now - entry.timestamp > SIGNAL_TTL_MS) {
      signalCache.delete(key);
    }
  }

  // Safety valve: if cache is still too large, drop oldest entries
  if (signalCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(signalCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
    for (const entry of toRemove) {
      signalCache.delete(entry[0]);
    }
  }
}

/**
 * Look up cached signal for the given text.
 * Performs lazy eviction of stale entries.
 */
function getCachedSignal(text: string): SemanticSignal | null {
  evictStale();
  const entry = signalCache.get(text);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > SIGNAL_TTL_MS) {
    signalCache.delete(text);
    return null;
  }

  return entry.signal;
}

// ---------------------------------------------------------------------------
// Keyword feature vector
// ---------------------------------------------------------------------------

/**
 * Build a fixed vocabulary from keywords for sparse vector construction.
 *
 * This creates a deterministic mapping from keyword strings to vector
 * positions using a simple hash function. The result is a sparse vector
 * where keyword positions have non-zero values.
 */
function keywordFeatureVector(keywords: string[], dims: number): Float32Array {
  const vec = new Float32Array(dims);

  if (keywords.length === 0) return vec;

  // Distribute keyword weights across dimensions using hash
  const weight = 1.0 / Math.sqrt(keywords.length);
  for (const keyword of keywords) {
    const hash = simpleHash(keyword);
    const index = Math.abs(hash) % dims;
    vec[index] += weight;
  }

  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Simple deterministic hash for string -> number mapping.
 * FNV-1a inspired, fast and collision-resistant enough for keyword hashing.
 */
function simpleHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) | 0;
  }
  return hash;
}

/**
 * Blend two Float32Array vectors with the given weights.
 * Both must have the same length.
 */
function blendVectors(
  primary: Float32Array,
  secondary: Float32Array,
  primaryWeight: number,
  secondaryWeight: number,
): Float32Array {
  const result = new Float32Array(primary.length);
  for (let i = 0; i < primary.length; i++) {
    result[i] = primary[i] * primaryWeight + secondary[i] * secondaryWeight;
  }

  // Re-normalize to unit length
  let norm = 0;
  for (let i = 0; i < result.length; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < result.length; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// PiggybackEngine -- implements EmbeddingEngine
// ---------------------------------------------------------------------------

/**
 * Configuration for PiggybackEngine.
 */
export interface PiggybackEngineConfig {
  /** Optional fallback engine (typically LocalOnnxEngine) for hybrid mode */
  fallbackEngine?: EmbeddingEngine;
}

/**
 * Embedding engine that leverages semantic signals from Claude's responses.
 *
 * When signals are available in the cache (written by the hook extractor),
 * keyword features are blended with the fallback engine's embedding
 * (70% ONNX + 30% keyword features).
 *
 * When no signals are available, falls back to the fallback engine directly.
 * When no fallback is configured, produces a sparse keyword vector.
 *
 * Implements the EmbeddingEngine interface for plug-in compatibility.
 */
export class PiggybackEngine implements EmbeddingEngine {
  private readonly fallback: EmbeddingEngine | null;
  private ready = false;

  constructor(config?: PiggybackEngineConfig) {
    this.fallback = config?.fallbackEngine ?? null;
  }

  /**
   * Initialize the engine.
   *
   * If a fallback engine is provided, its initialization result determines
   * our readiness. Without a fallback, we're always ready (keyword-only mode).
   */
  async initialize(): Promise<boolean> {
    if (this.fallback) {
      const fallbackReady = this.fallback.isReady() || (await this.fallback.initialize());
      this.ready = fallbackReady;
      return this.ready;
    }

    // No fallback -- keyword-only mode is always ready
    this.ready = true;
    return true;
  }

  /** Whether the engine is initialized and ready. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Embed a single text string.
   *
   * Strategy:
   *   1. Check signal cache for this text
   *   2. If signals found + fallback available: blend ONNX + keyword features
   *   3. If signals found + no fallback: return keyword feature vector
   *   4. If no signals + fallback available: delegate to fallback
   *   5. If no signals + no fallback: return null
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!text || text.trim().length === 0) return null;

    const signal = getCachedSignal(text);
    const dims = this.dimensions();

    if (signal && signal.keywords.length > 0) {
      const kwVec = keywordFeatureVector(signal.keywords, dims);

      if (this.fallback) {
        const onnxVec = await this.fallback.embed(text);
        if (onnxVec) {
          return blendVectors(onnxVec, kwVec, ONNX_WEIGHT, KEYWORD_WEIGHT);
        }
        // Fallback embed failed -- use keyword vector alone
        return kwVec;
      }

      // No fallback -- keyword vector only
      return kwVec;
    }

    // No cached signal -- delegate to fallback if available
    if (this.fallback) {
      return this.fallback.embed(text);
    }

    return null;
  }

  /**
   * Embed multiple texts, preserving order.
   */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const results: (Float32Array | null)[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /**
   * Embedding dimensions.
   *
   * Matches fallback engine dimensions if available, otherwise 384 (standard).
   */
  dimensions(): number {
    if (this.fallback && this.fallback.dimensions() > 0) {
      return this.fallback.dimensions();
    }
    return DEFAULT_DIMENSIONS;
  }

  /** Engine identifier. */
  name(): string {
    if (this.fallback) {
      return `piggyback+${this.fallback.name()}`;
    }
    return 'piggyback-keyword-only';
  }
}
