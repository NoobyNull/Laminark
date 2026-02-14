/**
 * Entity extraction agent.
 *
 * Uses Haiku to extract typed entities from observation text.
 * Replaces the regex-based extraction-rules.ts with LLM-powered analysis.
 * Returns entities validated against the fixed 6-type taxonomy from graph/types.ts.
 */

import { z } from 'zod';

import { ENTITY_TYPES, type EntityType } from '../graph/types.js';
import { callHaiku, extractJsonFromResponse } from './haiku-client.js';

// ---------------------------------------------------------------------------
// Zod validation schemas
// ---------------------------------------------------------------------------

const EntitySchema = z.object({
  name: z.string().min(1),
  type: z.enum(ENTITY_TYPES),
  confidence: z.number().min(0).max(1),
});

const EntityArraySchema = z.array(EntitySchema);

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You extract structured entities from developer observations.

Entity types (use ONLY these exact strings):
- File: file paths (src/foo/bar.ts, package.json, ./config.yml)
- Project: repository names (org/repo), npm packages (@scope/pkg)
- Reference: URLs (https://...)
- Decision: explicit choices made ("decided to use X", "chose Y over Z")
- Problem: bugs, errors, failures, obstacles encountered
- Solution: fixes, resolutions, workarounds applied

Rules:
- Extract ALL entities present in the text
- For Decision/Problem/Solution, extract the descriptive phrase (not just the keyword)
- Confidence: 0.9+ for unambiguous (file paths, URLs), 0.7-0.8 for clear context, 0.5-0.6 for inferred
- Return a JSON array: [{"name": "...", "type": "...", "confidence": 0.0-1.0}]
- Return [] if no entities found
- No markdown, no explanation, ONLY the JSON array`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts entities from observation text using Haiku.
 *
 * @param text - The observation content to analyze
 * @returns Validated array of extracted entities with type and confidence
 */
export async function extractEntitiesWithHaiku(
  text: string,
): Promise<Array<{ name: string; type: EntityType; confidence: number }>> {
  const response = await callHaiku(SYSTEM_PROMPT, text, 512);
  const parsed = extractJsonFromResponse(response);
  return EntityArraySchema.parse(parsed);
}
