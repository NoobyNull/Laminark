import { describe, it, expect, beforeEach } from 'vitest';
import { PiggybackEngine, signalCache } from '../engines/piggyback.js';
import type { EmbeddingEngine } from '../embedder.js';
import type { SemanticSignal } from '../../hooks/piggyback-extractor.js';

// ---------------------------------------------------------------------------
// Mock fallback engine for testing
// ---------------------------------------------------------------------------

function createMockFallback(dims: number = 384): EmbeddingEngine {
  const ready = true;
  return {
    async embed(text: string): Promise<Float32Array | null> {
      if (!text || text.trim().length === 0) return null;
      // Generate a deterministic mock vector
      const vec = new Float32Array(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = Math.sin(i + text.length) / Math.sqrt(dims);
      }
      return vec;
    },
    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
      const results: (Float32Array | null)[] = [];
      for (const t of texts) {
        results.push(await this.embed(t));
      }
      return results;
    },
    dimensions: () => dims,
    name: () => 'mock-fallback',
    async initialize() {
      return true;
    },
    isReady: () => ready,
  };
}

// ---------------------------------------------------------------------------
// Helper: populate signal cache
// ---------------------------------------------------------------------------

function cacheSignal(text: string, keywords: string[]): void {
  const signal: SemanticSignal = {
    keywords,
    topics: ['test-topic'],
    sentiment: 'neutral',
    entities_mentioned: [],
    summary_vector: null,
  };
  signalCache.set(text, { signal, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// PiggybackEngine
// ---------------------------------------------------------------------------

describe('PiggybackEngine', () => {
  beforeEach(() => {
    signalCache.clear();
  });

  // Interface compliance
  it('implements all 6 EmbeddingEngine interface methods', () => {
    const engine = new PiggybackEngine();
    const methods: (keyof EmbeddingEngine)[] = [
      'embed', 'embedBatch', 'dimensions', 'name', 'initialize', 'isReady',
    ];
    for (const method of methods) {
      expect(typeof engine[method]).toBe('function');
    }
  });

  // Dimensions
  it('dimensions() returns 384 without fallback', () => {
    const engine = new PiggybackEngine();
    expect(engine.dimensions()).toBe(384);
  });

  it('dimensions() matches fallback engine', () => {
    const fallback = createMockFallback(512);
    const engine = new PiggybackEngine({ fallbackEngine: fallback });
    expect(engine.dimensions()).toBe(512);
  });

  // Name
  it('name() returns piggyback-keyword-only without fallback', () => {
    const engine = new PiggybackEngine();
    expect(engine.name()).toBe('piggyback-keyword-only');
  });

  it('name() includes fallback name in hybrid mode', () => {
    const fallback = createMockFallback();
    const engine = new PiggybackEngine({ fallbackEngine: fallback });
    expect(engine.name()).toBe('piggyback+mock-fallback');
  });

  // Initialize
  it('initialize() succeeds without fallback (keyword-only mode)', async () => {
    const engine = new PiggybackEngine();
    const result = await engine.initialize();
    expect(result).toBe(true);
    expect(engine.isReady()).toBe(true);
  });

  it('initialize() delegates to fallback engine', async () => {
    const fallback = createMockFallback();
    const engine = new PiggybackEngine({ fallbackEngine: fallback });
    const result = await engine.initialize();
    expect(result).toBe(true);
    expect(engine.isReady()).toBe(true);
  });

  // Embed without fallback, with cached signal
  it('embed() returns keyword vector when signal cached and no fallback', async () => {
    const engine = new PiggybackEngine();
    await engine.initialize();

    const text = 'authentication middleware JWT token';
    cacheSignal(text, ['authentication', 'middleware', 'jwt', 'token']);

    const result = await engine.embed(text);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result!.length).toBe(384);

    // Vector should be normalized (unit length)
    let norm = 0;
    for (let i = 0; i < result!.length; i++) {
      norm += result![i] * result![i];
    }
    expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.01);
  });

  // Embed with fallback, with cached signal (hybrid blend)
  it('embed() blends ONNX + keyword features when signal cached and fallback available', async () => {
    const fallback = createMockFallback();
    const engine = new PiggybackEngine({ fallbackEngine: fallback });
    await engine.initialize();

    const text = 'authentication middleware JWT token';
    cacheSignal(text, ['authentication', 'middleware', 'jwt', 'token']);

    const blended = await engine.embed(text);
    const onnxOnly = await fallback.embed(text);

    expect(blended).toBeInstanceOf(Float32Array);
    expect(blended!.length).toBe(384);

    // Blended should differ from pure ONNX (keyword features were mixed in)
    let different = false;
    for (let i = 0; i < blended!.length; i++) {
      if (Math.abs(blended![i] - onnxOnly![i]) > 0.0001) {
        different = true;
        break;
      }
    }
    expect(different).toBe(true);
  });

  // Embed with fallback, no cached signal (falls through to ONNX)
  it('embed() delegates to fallback when no signal cached', async () => {
    const fallback = createMockFallback();
    const engine = new PiggybackEngine({ fallbackEngine: fallback });
    await engine.initialize();

    const text = 'no signal cached for this text';
    const result = await engine.embed(text);
    const fallbackResult = await fallback.embed(text);

    expect(result).toBeInstanceOf(Float32Array);

    // Should match fallback exactly (no blending occurred)
    for (let i = 0; i < result!.length; i++) {
      expect(result![i]).toBeCloseTo(fallbackResult![i], 5);
    }
  });

  // Embed without fallback, no cached signal -> null
  it('embed() returns null when no signal and no fallback', async () => {
    const engine = new PiggybackEngine();
    await engine.initialize();

    const result = await engine.embed('text with no cached signal');
    expect(result).toBeNull();
  });

  // Empty/null input
  it('embed() returns null for empty text', async () => {
    const engine = new PiggybackEngine();
    await engine.initialize();

    expect(await engine.embed('')).toBeNull();
    expect(await engine.embed('   ')).toBeNull();
  });

  // embedBatch
  it('embedBatch() processes multiple texts', async () => {
    const engine = new PiggybackEngine();
    await engine.initialize();

    const text1 = 'first text about tokens';
    const text2 = 'second text about databases';
    cacheSignal(text1, ['first', 'tokens']);
    cacheSignal(text2, ['second', 'databases']);

    const results = await engine.embedBatch([text1, text2, '']);
    expect(results).toHaveLength(3);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(results[1]).toBeInstanceOf(Float32Array);
    expect(results[2]).toBeNull();
  });

  // Consistent dimensions
  it('returns vectors of consistent dimensions regardless of input', async () => {
    const engine = new PiggybackEngine();
    await engine.initialize();

    const inputs = ['short', 'a longer text about something', 'x'.repeat(1000)];
    for (const text of inputs) {
      cacheSignal(text, ['keyword']);
    }

    for (const text of inputs) {
      const result = await engine.embed(text);
      expect(result).toBeInstanceOf(Float32Array);
      expect(result!.length).toBe(384);
    }
  });
});

// ---------------------------------------------------------------------------
// Signal cache TTL
// ---------------------------------------------------------------------------

describe('Signal cache TTL', () => {
  beforeEach(() => {
    signalCache.clear();
  });

  it('evicts entries older than 30 seconds', async () => {
    // Insert a signal with a timestamp 31 seconds ago
    const text = 'stale signal text';
    const signal: SemanticSignal = {
      keywords: ['stale'],
      topics: [],
      sentiment: 'neutral',
      entities_mentioned: [],
      summary_vector: null,
    };
    signalCache.set(text, { signal, timestamp: Date.now() - 31_000 });

    // Create engine and try to embed -- should not find the stale signal
    const engine = new PiggybackEngine();
    await engine.initialize();

    // embed() internally calls getCachedSignal which evicts stale entries
    const result = await engine.embed(text);
    // No fallback and stale signal evicted -> null
    expect(result).toBeNull();
  });

  it('retains fresh entries', async () => {
    const text = 'fresh signal text';
    cacheSignal(text, ['fresh']);

    const engine = new PiggybackEngine();
    await engine.initialize();

    const result = await engine.embed(text);
    expect(result).toBeInstanceOf(Float32Array);
  });
});
