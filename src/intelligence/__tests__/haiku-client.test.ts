import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  getHaikuClient,
  isHaikuEnabled,
  extractJsonFromResponse,
  resetHaikuClient,
} from '../haiku-client.js';

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

let savedApiKey: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.LAMINARK_API_KEY;
  delete process.env.LAMINARK_API_KEY;
  resetHaikuClient();
});

afterEach(() => {
  if (savedApiKey !== undefined) {
    process.env.LAMINARK_API_KEY = savedApiKey;
  } else {
    delete process.env.LAMINARK_API_KEY;
  }
  resetHaikuClient();
});

// ---------------------------------------------------------------------------
// isHaikuEnabled
// ---------------------------------------------------------------------------

describe('isHaikuEnabled', () => {
  it('returns false when no API key is configured', () => {
    expect(isHaikuEnabled()).toBe(false);
  });

  it('returns true when LAMINARK_API_KEY is set', () => {
    process.env.LAMINARK_API_KEY = 'sk-test-key';
    expect(isHaikuEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getHaikuClient
// ---------------------------------------------------------------------------

describe('getHaikuClient', () => {
  it('returns null when no API key is configured', () => {
    const client = getHaikuClient();
    expect(client).toBeNull();
  });

  it('returns an Anthropic instance when API key is set', () => {
    process.env.LAMINARK_API_KEY = 'sk-test-key';
    const client = getHaikuClient();
    expect(client).not.toBeNull();
    expect(client).toHaveProperty('messages');
  });

  it('returns the same singleton instance on subsequent calls', () => {
    process.env.LAMINARK_API_KEY = 'sk-test-key';
    const client1 = getHaikuClient();
    const client2 = getHaikuClient();
    expect(client1).toBe(client2);
  });
});

// ---------------------------------------------------------------------------
// extractJsonFromResponse
// ---------------------------------------------------------------------------

describe('extractJsonFromResponse', () => {
  it('parses bare JSON array', () => {
    const result = extractJsonFromResponse('[{"name":"foo"}]');
    expect(result).toEqual([{ name: 'foo' }]);
  });

  it('parses markdown-fenced JSON', () => {
    const result = extractJsonFromResponse('```json\n[{"name":"foo"}]\n```');
    expect(result).toEqual([{ name: 'foo' }]);
  });

  it('parses JSON with surrounding text', () => {
    const result = extractJsonFromResponse(
      'Here are the entities:\n[{"name":"foo"}]\nDone.',
    );
    expect(result).toEqual([{ name: 'foo' }]);
  });

  it('parses JSON object', () => {
    const result = extractJsonFromResponse('{"signal":"noise"}');
    expect(result).toEqual({ signal: 'noise' });
  });

  it('throws on no JSON found', () => {
    expect(() => extractJsonFromResponse('No entities found in this text')).toThrow(
      'No JSON found',
    );
  });

  it('parses JSON array with multiple objects', () => {
    const result = extractJsonFromResponse(
      '[{"name":"a","type":"File"},{"name":"b","type":"Project"}]',
    );
    expect(result).toEqual([
      { name: 'a', type: 'File' },
      { name: 'b', type: 'Project' },
    ]);
  });
});
