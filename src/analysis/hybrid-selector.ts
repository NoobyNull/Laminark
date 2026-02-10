/**
 * Hybrid embedding strategy selector.
 *
 * Factory function that creates the appropriate EmbeddingEngine based on
 * startup configuration. Three modes:
 *
 *   - 'local':     Local ONNX engine only (no piggyback augmentation)
 *   - 'piggyback': Piggyback engine only (keyword-based, no ONNX)
 *   - 'hybrid':    Piggyback engine with ONNX fallback (recommended)
 *
 * Mode is selected via:
 *   1. Explicit parameter to createEmbeddingStrategy()
 *   2. LAMINARK_EMBEDDING_MODE environment variable
 *   3. Default: 'hybrid'
 *
 * This is a factory function, NOT a singleton. The caller manages the
 * instance lifecycle.
 */

import type { EmbeddingEngine } from './embedder.js';
import { LocalOnnxEngine } from './engines/local-onnx.js';
import { PiggybackEngine } from './engines/piggyback.js';
import { debug } from '../shared/debug.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Embedding mode selection.
 *
 * - 'local': Pure ONNX embeddings (fast, good quality)
 * - 'piggyback': Pure keyword-derived embeddings from Claude's responses
 * - 'hybrid': ONNX augmented with Claude's semantic signals (recommended)
 */
export type EmbeddingMode = 'local' | 'piggyback' | 'hybrid';

/**
 * Configuration options for createEmbeddingStrategy.
 */
export interface EmbeddingStrategyConfig {
  /** Path to ONNX model (optional, uses default if not specified) */
  onnxModelPath?: string;
}

// ---------------------------------------------------------------------------
// Env var name
// ---------------------------------------------------------------------------

const ENV_EMBEDDING_MODE = 'LAMINARK_EMBEDDING_MODE';

// ---------------------------------------------------------------------------
// Valid modes
// ---------------------------------------------------------------------------

const VALID_MODES: ReadonlySet<string> = new Set(['local', 'piggyback', 'hybrid']);

// ---------------------------------------------------------------------------
// Module-level active mode tracking (for diagnostics)
// ---------------------------------------------------------------------------

let activeMode: EmbeddingMode = 'hybrid';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve the embedding mode from explicit parameter or environment variable.
 *
 * Priority:
 *   1. Explicit `mode` parameter
 *   2. LAMINARK_EMBEDDING_MODE environment variable
 *   3. Default: 'hybrid'
 *
 * Invalid mode values log a warning and default to 'local'.
 */
function resolveMode(mode?: EmbeddingMode): EmbeddingMode {
  // 1. Explicit parameter takes priority
  if (mode !== undefined) {
    if (VALID_MODES.has(mode)) {
      return mode;
    }
    debug('embeddings', `Invalid embedding mode "${mode}", defaulting to "local"`);
    return 'local';
  }

  // 2. Environment variable
  const envMode = process.env[ENV_EMBEDDING_MODE];
  if (envMode !== undefined && envMode !== '') {
    if (VALID_MODES.has(envMode)) {
      return envMode as EmbeddingMode;
    }
    debug('embeddings', `Invalid LAMINARK_EMBEDDING_MODE="${envMode}", defaulting to "local"`);
    return 'local';
  }

  // 3. Default
  return 'hybrid';
}

/**
 * Create an embedding engine based on the selected mode.
 *
 * This is a factory function -- each call creates a new instance.
 * The caller is responsible for calling initialize() on the returned engine.
 *
 * @param mode - Embedding mode ('local', 'piggyback', 'hybrid'). If not
 *   specified, reads from LAMINARK_EMBEDDING_MODE env var, defaulting to 'hybrid'.
 * @param config - Optional configuration (e.g., ONNX model path).
 * @returns An EmbeddingEngine instance (not yet initialized).
 */
export function createEmbeddingStrategy(
  mode?: EmbeddingMode,
  config?: EmbeddingStrategyConfig,
): EmbeddingEngine {
  const resolved = resolveMode(mode);
  activeMode = resolved;

  debug('embeddings', `Creating embedding strategy`, { mode: resolved });

  switch (resolved) {
    case 'local': {
      const engine = new LocalOnnxEngine();
      debug('embeddings', `Selected local ONNX engine`);
      return engine;
    }

    case 'piggyback': {
      const engine = new PiggybackEngine();
      debug('embeddings', `Selected piggyback engine (keyword-only, no ONNX fallback)`);
      return engine;
    }

    case 'hybrid': {
      const onnx = new LocalOnnxEngine();
      const engine = new PiggybackEngine({ fallbackEngine: onnx });
      debug('embeddings', `Selected hybrid engine (piggyback + ONNX fallback)`);
      return engine;
    }
  }
}

/**
 * Returns the currently configured embedding mode.
 *
 * Useful for diagnostics and status reporting. Returns the mode
 * from the last call to createEmbeddingStrategy().
 */
export function getActiveMode(): EmbeddingMode {
  return activeMode;
}
