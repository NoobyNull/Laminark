/**
 * Shared Haiku client using Claude Agent SDK V2 session.
 *
 * Routes Haiku calls through the user's Claude Code subscription
 * instead of requiring a separate API key. Uses a persistent session
 * to avoid 12s cold-start overhead on sequential calls.
 *
 * Provides the core infrastructure for all Haiku agent modules:
 * - callHaiku() helper for structured prompt/response calls
 * - extractJsonFromResponse() for defensive JSON parsing
 * - Session reuse across batch processing cycles
 */

import {
  unstable_v2_createSession,
  type SDKSession,
} from '@anthropic-ai/claude-agent-sdk';

import { loadHaikuConfig } from '../config/haiku-config.js';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _session: SDKSession | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getOrCreateSession(): SDKSession {
  if (!_session) {
    const config = loadHaikuConfig();
    _session = unstable_v2_createSession({
      model: config.model,
      permissionMode: 'bypassPermissions',
      allowedTools: [], // No tools -- pure text completion only
    });
  }
  return _session;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns whether Haiku enrichment is available.
 * Always true with subscription auth -- no API key check needed.
 */
export function isHaikuEnabled(): boolean {
  return true;
}

/**
 * Calls Haiku with a system prompt and user content.
 * Returns the text content from the response.
 *
 * Uses a persistent V2 session to avoid cold-start overhead on sequential calls.
 * System prompt is embedded in the user message since session-level systemPrompt
 * is set at creation time and we need different prompts per agent.
 *
 * @param systemPrompt - Instructions for the model
 * @param userContent - The content to process
 * @param _maxTokens - Kept for signature compatibility (unused -- Agent SDK constrains output via prompts)
 * @throws Error if the Haiku call fails or session expires
 */
export async function callHaiku(
  systemPrompt: string,
  userContent: string,
  _maxTokens?: number,
): Promise<string> {
  const session = getOrCreateSession();

  // Embed system prompt in user message since the session shares a single
  // system prompt but our three agents each need different instructions
  const fullPrompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userContent}`;

  try {
    await session.send(fullPrompt);
    for await (const msg of session.stream()) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return msg.result;
        }
        const errors = 'errors' in msg ? (msg as { errors?: string[] }).errors : undefined;
        const errorMsg = errors?.join(', ') ?? msg.subtype;
        throw new Error(`Haiku call failed: ${errorMsg}`);
      }
    }
    return ''; // No result message received
  } catch (error) {
    // Session may have expired -- reset and rethrow so next call creates fresh session
    try {
      _session?.close();
    } catch {
      // Ignore close errors
    }
    _session = null;
    throw error;
  }
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
 * Resets the singleton session. Used for testing.
 */
export function resetHaikuClient(): void {
  try {
    _session?.close();
  } catch {
    // Ignore close errors
  }
  _session = null;
}
