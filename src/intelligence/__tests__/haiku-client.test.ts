import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup -- Agent SDK module
// ---------------------------------------------------------------------------

const { mockSend, mockStream, mockClose, mockCreateSession } = vi.hoisted(() => {
  const mockSend = vi.fn();
  const mockStream = vi.fn();
  const mockClose = vi.fn();
  const mockCreateSession = vi.fn(() => ({
    send: mockSend,
    stream: mockStream,
    close: mockClose,
  }));
  return { mockSend, mockStream, mockClose, mockCreateSession };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: mockCreateSession,
}));

import {
  isHaikuEnabled,
  callHaiku,
  extractJsonFromResponse,
  resetHaikuClient,
} from '../haiku-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStream(
  messages: Array<{ type: string; subtype?: string; result?: string; errors?: string[] }>,
) {
  return (async function* () {
    for (const msg of messages) yield msg;
  })();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetHaikuClient();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isHaikuEnabled
// ---------------------------------------------------------------------------

describe('isHaikuEnabled', () => {
  it('always returns true', () => {
    expect(isHaikuEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// callHaiku
// ---------------------------------------------------------------------------

describe('callHaiku', () => {
  it('sends prompt with embedded system instructions to session', async () => {
    mockStream.mockReturnValue(
      createMockStream([{ type: 'result', subtype: 'success', result: 'ok' }]),
    );

    await callHaiku('You are a classifier.', 'Classify this text.');

    expect(mockSend).toHaveBeenCalledOnce();
    const sentPrompt = mockSend.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('<instructions>');
    expect(sentPrompt).toContain('You are a classifier.');
    expect(sentPrompt).toContain('Classify this text.');
  });

  it('returns result text from successful stream message', async () => {
    mockStream.mockReturnValue(
      createMockStream([{ type: 'result', subtype: 'success', result: 'response text' }]),
    );

    const result = await callHaiku('system', 'user');
    expect(result).toBe('response text');
  });

  it('throws on failed stream message', async () => {
    mockStream.mockReturnValue(
      createMockStream([{ type: 'result', subtype: 'error', errors: ['fail'] }]),
    );

    await expect(callHaiku('system', 'user')).rejects.toThrow('Haiku call failed');
  });

  it('reuses session across multiple calls', async () => {
    mockStream.mockReturnValue(
      createMockStream([{ type: 'result', subtype: 'success', result: 'a' }]),
    );
    await callHaiku('system', 'user1');

    mockStream.mockReturnValue(
      createMockStream([{ type: 'result', subtype: 'success', result: 'b' }]),
    );
    await callHaiku('system', 'user2');

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it('creates new session after error (session expiration recovery)', async () => {
    // First call: send throws (simulating expired session)
    mockSend.mockRejectedValueOnce(new Error('Session expired'));

    await expect(callHaiku('system', 'user')).rejects.toThrow('Session expired');

    // Second call: succeeds with fresh session
    mockStream.mockReturnValue(
      createMockStream([{ type: 'result', subtype: 'success', result: 'recovered' }]),
    );

    const result = await callHaiku('system', 'user');
    expect(result).toBe('recovered');
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it('returns empty string when no result message in stream', async () => {
    mockStream.mockReturnValue(
      createMockStream([{ type: 'progress', subtype: 'text' }]),
    );

    const result = await callHaiku('system', 'user');
    expect(result).toBe('');
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
