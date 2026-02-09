import { describe, it, expect } from 'vitest';
import { extractSemanticSignals } from '../piggyback-extractor.js';
import type { SemanticSignal } from '../piggyback-extractor.js';

// ---------------------------------------------------------------------------
// extractSemanticSignals -- core extraction
// ---------------------------------------------------------------------------

describe('extractSemanticSignals', () => {
  it('extracts keywords from Claude response text', () => {
    const text = `
      I've updated the authentication middleware to handle JWT refresh tokens.
      The implementation uses the jose library for token verification and
      rotation. The refresh token endpoint validates the existing token,
      generates a new access token, and rotates the refresh token to prevent
      replay attacks. Error handling covers expired tokens, invalid signatures,
      and malformed payloads.
    `;

    const signal = extractSemanticSignals(text);

    expect(signal.keywords.length).toBeGreaterThan(0);
    expect(signal.keywords.some((kw) => kw === 'token' || kw === 'tokens')).toBe(true);
  });

  it('detects file paths as entity mentions', () => {
    const text = `
      I modified src/hooks/handler.ts and src/analysis/embedder.ts to add
      the new piggyback embedding strategy. The changes in /data/Laminark/src/shared/config.ts
      update the configuration loading.
    `;

    const signal = extractSemanticSignals(text);
    const filePaths = signal.entities_mentioned.filter((e) => e.probable_type === 'file_path');

    expect(filePaths.length).toBeGreaterThanOrEqual(2);
    expect(filePaths.some((e) => e.name.includes('handler.ts'))).toBe(true);
  });

  it('detects decision language', () => {
    const text = `
      I decided to use a Map-based cache for signal storage instead of a
      plain object. I chose the TTL approach because it automatically
      handles cleanup without a separate timer. I went with 30 seconds
      as the default TTL.
    `;

    const signal = extractSemanticSignals(text);
    const decisions = signal.entities_mentioned.filter((e) => e.probable_type === 'decision');

    expect(decisions.length).toBeGreaterThanOrEqual(1);
  });

  it('detects tool names', () => {
    const text = `
      Using the bash command to run tests, then read the output file
      and edit the configuration. The grep search found matching patterns.
    `;

    const signal = extractSemanticSignals(text);
    const tools = signal.entities_mentioned.filter((e) => e.probable_type === 'tool');

    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.some((e) => e.name === 'bash')).toBe(true);
  });

  it('detects person references from @mentions', () => {
    const text = 'Code reviewed by @matthew and approved by @sarah.';

    const signal = extractSemanticSignals(text);
    const persons = signal.entities_mentioned.filter((e) => e.probable_type === 'person');

    expect(persons.length).toBe(2);
    expect(persons.some((e) => e.name === 'matthew')).toBe(true);
    expect(persons.some((e) => e.name === 'sarah')).toBe(true);
  });

  it('detects technical sentiment for code-heavy responses', () => {
    const text = `
      The function accepts an interface parameter and returns a Promise.
      The async implementation uses await for the database query.
      Import the module and export the class for TypeScript compilation.
      The schema migration adds a new table with a foreign key constraint.
    `;

    const signal = extractSemanticSignals(text);
    expect(signal.sentiment).toBe('technical');
  });

  it('detects negative sentiment for error responses', () => {
    const text = `
      The build failed with multiple errors. There are several bugs
      causing crashes. The missing dependency issue prevents the
      application from starting. The invalid configuration is a problem.
    `;

    const signal = extractSemanticSignals(text);
    expect(signal.sentiment).toBe('negative');
  });

  it('detects positive sentiment for success responses', () => {
    const text = `
      All tests passed and the build succeeded. The fix resolved the
      issue completely. Everything works correctly and the deployment
      is complete and ready.
    `;

    const signal = extractSemanticSignals(text);
    expect(signal.sentiment).toBe('positive');
  });

  it('generates topic labels from keyword clusters', () => {
    const text = `
      The authentication system uses JWT tokens with refresh rotation.
      The database migration adds user session tracking tables.
      The API endpoint handles login and token verification.
    `;

    const signal = extractSemanticSignals(text);
    expect(signal.topics.length).toBeGreaterThan(0);
  });

  it('returns empty signal for empty text', () => {
    const signal = extractSemanticSignals('');
    expect(signal.keywords).toEqual([]);
    expect(signal.topics).toEqual([]);
    expect(signal.sentiment).toBe('neutral');
    expect(signal.entities_mentioned).toEqual([]);
    expect(signal.summary_vector).toBeNull();
  });

  it('returns empty signal for whitespace-only text', () => {
    const signal = extractSemanticSignals('   \n\t  ');
    expect(signal.keywords).toEqual([]);
  });

  it('never throws, even with malformed input', () => {
    // These should all return valid (possibly empty) signals
    expect(() => extractSemanticSignals('')).not.toThrow();
    expect(() => extractSemanticSignals(null as unknown as string)).not.toThrow();
    expect(() => extractSemanticSignals(undefined as unknown as string)).not.toThrow();
    expect(() => extractSemanticSignals(123 as unknown as string)).not.toThrow();
  });

  it('processes a 500-word response in under 10ms', () => {
    // Generate a ~500-word response
    const words = [];
    for (let i = 0; i < 500; i++) {
      words.push(['authentication', 'database', 'function', 'the', 'is', 'a'][i % 6]);
    }
    const text = words.join(' ');

    const start = performance.now();
    extractSemanticSignals(text);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('produces a well-formed SemanticSignal structure', () => {
    const text = 'The authentication middleware handles JWT token verification and refresh.';
    const signal: SemanticSignal = extractSemanticSignals(text);

    expect(Array.isArray(signal.keywords)).toBe(true);
    expect(Array.isArray(signal.topics)).toBe(true);
    expect(['positive', 'negative', 'neutral', 'technical']).toContain(signal.sentiment);
    expect(Array.isArray(signal.entities_mentioned)).toBe(true);
    expect(signal.summary_vector).toBeNull();

    // Each entity has name and probable_type
    for (const entity of signal.entities_mentioned) {
      expect(typeof entity.name).toBe('string');
      expect(typeof entity.probable_type).toBe('string');
    }
  });
});
