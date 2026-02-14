/**
 * Shared Anthropic client singleton and callHaiku helper.
 *
 * Provides the core infrastructure for all Haiku agent modules:
 * - Singleton Anthropic client initialized with LAMINARK_API_KEY
 * - callHaiku() helper for structured prompt/response calls
 * - extractJsonFromResponse() for defensive JSON parsing
 * - Graceful degradation when no API key is configured
 */

import Anthropic from '@anthropic-ai/sdk';

import { loadHaikuConfig, type HaikuConfig } from '../config/haiku-config.js';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
let _config: HaikuConfig | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the shared Anthropic client instance, or null if no API key is configured.
 * The client is created once and reused for all subsequent calls.
 */
export function getHaikuClient(): Anthropic | null {
  if (_client) return _client;

  _config = loadHaikuConfig();
  if (!_config.apiKey) return null;

  _client = new Anthropic({ apiKey: _config.apiKey });
  return _client;
}

/**
 * Returns whether Haiku enrichment is available (API key configured).
 */
export function isHaikuEnabled(): boolean {
  if (_config) return _config.enabled;
  _config = loadHaikuConfig();
  return _config.enabled;
}

/**
 * Calls Haiku with a system prompt and user content.
 * Returns the text content from the response.
 *
 * @throws Error if Haiku client is not configured
 */
export async function callHaiku(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
): Promise<string> {
  const client = getHaikuClient();
  if (!client || !_config) {
    throw new Error('Haiku not configured -- set LAMINARK_API_KEY or add apiKey to config.json');
  }

  const message = await client.messages.create({
    model: _config.model,
    max_tokens: maxTokens ?? _config.maxTokensPerCall,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const textBlock = message.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

/**
 * Defensive JSON extraction from Haiku response text.
 *
 * Handles common LLM response quirks:
 * - Markdown code fences (```json ... ```)
 * - Explanatory text before/after JSON
 * - Both array and object JSON shapes
 *
 * @throws Error if no JSON structure found in text
 */
export function extractJsonFromResponse(text: string): unknown {
  // Strip markdown code fences
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

  // Try to find JSON array
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) return JSON.parse(arrayMatch[0]);

  // Try to find JSON object
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) return JSON.parse(objMatch[0]);

  throw new Error('No JSON found in Haiku response');
}

/**
 * Resets the singleton client and config. Used for testing.
 */
export function resetHaikuClient(): void {
  _client = null;
  _config = null;
}
