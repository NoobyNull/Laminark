import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmbeddingStrategy, getActiveMode } from '../hybrid-selector.js';
import type { EmbeddingMode } from '../hybrid-selector.js';
import { PiggybackEngine } from '../engines/piggyback.js';
import { LocalOnnxEngine } from '../engines/local-onnx.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEY = 'LAMINARK_EMBEDDING_MODE';
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env[ENV_KEY] = originalEnv;
  } else {
    delete process.env[ENV_KEY];
  }
});

// ---------------------------------------------------------------------------
// createEmbeddingStrategy -- mode selection
// ---------------------------------------------------------------------------

describe('createEmbeddingStrategy', () => {
  it('returns LocalOnnxEngine for mode "local"', () => {
    const engine = createEmbeddingStrategy('local');
    expect(engine).toBeInstanceOf(LocalOnnxEngine);
  });

  it('returns PiggybackEngine for mode "piggyback"', () => {
    const engine = createEmbeddingStrategy('piggyback');
    expect(engine).toBeInstanceOf(PiggybackEngine);
  });

  it('returns PiggybackEngine for mode "hybrid"', () => {
    const engine = createEmbeddingStrategy('hybrid');
    // Hybrid mode wraps ONNX inside PiggybackEngine
    expect(engine).toBeInstanceOf(PiggybackEngine);
    expect(engine.name()).toContain('piggyback');
    expect(engine.name()).toContain('bge-small-en-v1.5-q8');
  });

  it('defaults to "hybrid" when no mode specified', () => {
    const engine = createEmbeddingStrategy();
    expect(engine).toBeInstanceOf(PiggybackEngine);
    expect(getActiveMode()).toBe('hybrid');
  });

  it('hybrid engine has correct dimensions (384 from ONNX)', () => {
    const engine = createEmbeddingStrategy('hybrid');
    expect(engine.dimensions()).toBe(384);
  });

  it('local engine has correct dimensions (384)', () => {
    const engine = createEmbeddingStrategy('local');
    expect(engine.dimensions()).toBe(384);
  });

  it('piggyback engine has correct dimensions (384 default)', () => {
    const engine = createEmbeddingStrategy('piggyback');
    expect(engine.dimensions()).toBe(384);
  });
});

// ---------------------------------------------------------------------------
// Environment variable override
// ---------------------------------------------------------------------------

describe('LAMINARK_EMBEDDING_MODE env var', () => {
  it('reads "local" from env var', () => {
    process.env[ENV_KEY] = 'local';
    const engine = createEmbeddingStrategy();
    expect(engine).toBeInstanceOf(LocalOnnxEngine);
    expect(getActiveMode()).toBe('local');
  });

  it('reads "piggyback" from env var', () => {
    process.env[ENV_KEY] = 'piggyback';
    const engine = createEmbeddingStrategy();
    expect(engine).toBeInstanceOf(PiggybackEngine);
    expect(getActiveMode()).toBe('piggyback');
  });

  it('reads "hybrid" from env var', () => {
    process.env[ENV_KEY] = 'hybrid';
    const engine = createEmbeddingStrategy();
    expect(engine).toBeInstanceOf(PiggybackEngine);
    expect(getActiveMode()).toBe('hybrid');
  });

  it('explicit mode overrides env var', () => {
    process.env[ENV_KEY] = 'piggyback';
    const engine = createEmbeddingStrategy('local');
    expect(engine).toBeInstanceOf(LocalOnnxEngine);
    expect(getActiveMode()).toBe('local');
  });

  it('defaults to "local" for invalid env var value', () => {
    process.env[ENV_KEY] = 'invalid-mode';
    const engine = createEmbeddingStrategy();
    expect(engine).toBeInstanceOf(LocalOnnxEngine);
    expect(getActiveMode()).toBe('local');
  });

  it('defaults to "local" for invalid explicit mode', () => {
    const engine = createEmbeddingStrategy('bad-mode' as EmbeddingMode);
    expect(engine).toBeInstanceOf(LocalOnnxEngine);
    expect(getActiveMode()).toBe('local');
  });

  it('ignores empty env var', () => {
    process.env[ENV_KEY] = '';
    const engine = createEmbeddingStrategy();
    expect(engine).toBeInstanceOf(PiggybackEngine);
    expect(getActiveMode()).toBe('hybrid');
  });
});

// ---------------------------------------------------------------------------
// getActiveMode
// ---------------------------------------------------------------------------

describe('getActiveMode', () => {
  it('returns the mode from the last createEmbeddingStrategy call', () => {
    createEmbeddingStrategy('local');
    expect(getActiveMode()).toBe('local');

    createEmbeddingStrategy('piggyback');
    expect(getActiveMode()).toBe('piggyback');

    createEmbeddingStrategy('hybrid');
    expect(getActiveMode()).toBe('hybrid');
  });
});

// ---------------------------------------------------------------------------
// Factory pattern (no singleton)
// ---------------------------------------------------------------------------

describe('Factory pattern', () => {
  it('creates new instances on each call', () => {
    const engine1 = createEmbeddingStrategy('local');
    const engine2 = createEmbeddingStrategy('local');
    expect(engine1).not.toBe(engine2);
  });

  it('creates different engine types per call', () => {
    const local = createEmbeddingStrategy('local');
    const piggyback = createEmbeddingStrategy('piggyback');
    expect(local.constructor).not.toBe(piggyback.constructor);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingEngine interface compliance
// ---------------------------------------------------------------------------

describe('Interface compliance', () => {
  const modes: EmbeddingMode[] = ['local', 'piggyback', 'hybrid'];

  for (const mode of modes) {
    it(`${mode} engine implements all 6 EmbeddingEngine methods`, () => {
      const engine = createEmbeddingStrategy(mode);
      expect(typeof engine.embed).toBe('function');
      expect(typeof engine.embedBatch).toBe('function');
      expect(typeof engine.dimensions).toBe('function');
      expect(typeof engine.name).toBe('function');
      expect(typeof engine.initialize).toBe('function');
      expect(typeof engine.isReady).toBe('function');
    });
  }
});
