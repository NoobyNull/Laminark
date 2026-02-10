import { describe, it, expect } from 'vitest';
import { KeywordOnlyEngine } from '../engines/keyword-only.js';
import { LocalOnnxEngine } from '../engines/local-onnx.js';
import { createEmbeddingEngine } from '../embedder.js';
import type { EmbeddingEngine } from '../embedder.js';

// ---------------------------------------------------------------------------
// SC-4: Graceful degradation -- KeywordOnlyEngine returns null/false/0
// ---------------------------------------------------------------------------

describe('SC-4: Graceful degradation', () => {
  it('KeywordOnlyEngine.embed() returns null', async () => {
    const engine = new KeywordOnlyEngine();
    const result = await engine.embed('some text');
    expect(result).toBeNull();
  });

  it('KeywordOnlyEngine.embedBatch() returns array of nulls matching input length', async () => {
    const engine = new KeywordOnlyEngine();
    const results = await engine.embedBatch(['one', 'two', 'three']);
    expect(results).toHaveLength(3);
    expect(results).toEqual([null, null, null]);
  });

  it('KeywordOnlyEngine.isReady() returns false', () => {
    const engine = new KeywordOnlyEngine();
    expect(engine.isReady()).toBe(false);
  });

  it('KeywordOnlyEngine.initialize() returns false', async () => {
    const engine = new KeywordOnlyEngine();
    const result = await engine.initialize();
    expect(result).toBe(false);
  });

  it('KeywordOnlyEngine.dimensions() returns 0', () => {
    const engine = new KeywordOnlyEngine();
    expect(engine.dimensions()).toBe(0);
  });

  it("KeywordOnlyEngine.name() returns 'keyword-only'", () => {
    const engine = new KeywordOnlyEngine();
    expect(engine.name()).toBe('keyword-only');
  });
});

// ---------------------------------------------------------------------------
// EmbeddingEngine interface contract -- LocalOnnxEngine
// ---------------------------------------------------------------------------

describe('EmbeddingEngine interface contract', () => {
  const interfaceMethods: (keyof EmbeddingEngine)[] = [
    'embed',
    'embedBatch',
    'dimensions',
    'name',
    'initialize',
    'isReady',
  ];

  it('LocalOnnxEngine implements all 6 interface methods', () => {
    const engine = new LocalOnnxEngine();
    for (const method of interfaceMethods) {
      expect(typeof engine[method]).toBe('function');
    }
  });

  it('LocalOnnxEngine.dimensions() returns 384', () => {
    const engine = new LocalOnnxEngine();
    expect(engine.dimensions()).toBe(384);
  });

  it("LocalOnnxEngine.name() returns 'bge-small-en-v1.5-q8'", () => {
    const engine = new LocalOnnxEngine();
    expect(engine.name()).toBe('bge-small-en-v1.5-q8');
  });

  it('LocalOnnxEngine.isReady() returns false before initialize()', () => {
    const engine = new LocalOnnxEngine();
    expect(engine.isReady()).toBe(false);
  });

  it('LocalOnnxEngine.embed() returns null when not initialized', async () => {
    const engine = new LocalOnnxEngine();
    // Do NOT call initialize() -- model not available in test env
    const result = await engine.embed('test text');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createEmbeddingEngine factory
// ---------------------------------------------------------------------------

describe('createEmbeddingEngine factory', () => {
  it('createEmbeddingEngine() returns an engine without throwing', async () => {
    // In test env without ONNX model, this should return KeywordOnlyEngine
    const engine = await createEmbeddingEngine();
    expect(engine).toBeDefined();
  });

  it('Returned engine has all 6 interface methods', async () => {
    const engine = await createEmbeddingEngine();
    const interfaceMethods: (keyof EmbeddingEngine)[] = [
      'embed',
      'embedBatch',
      'dimensions',
      'name',
      'initialize',
      'isReady',
    ];

    for (const method of interfaceMethods) {
      expect(typeof engine[method]).toBe('function');
    }
  });
});
