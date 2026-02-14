/**
 * Relationship inference agent.
 *
 * Uses Haiku to infer typed relationships between entities extracted from
 * observation text. Replaces the regex-based relationship-detector.ts with
 * LLM-powered contextual inference.
 * Returns relationships validated against the fixed 8-type taxonomy from graph/types.ts.
 */

import { z } from 'zod';

import { RELATIONSHIP_TYPES, type RelationshipType, type EntityType } from '../graph/types.js';
import { callHaiku, extractJsonFromResponse } from './haiku-client.js';

// ---------------------------------------------------------------------------
// Zod validation schemas
// ---------------------------------------------------------------------------

const RelationshipSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(RELATIONSHIP_TYPES),
  confidence: z.number().min(0).max(1),
});

const RelationshipArraySchema = z.array(RelationshipSchema);

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You infer relationships between entities extracted from a developer observation.

Given observation text and a list of entities, determine which entities are related and how.

Relationship types (use ONLY these exact strings):
- modifies: entity A changed/edited/created entity B
- informed_by: entity A was researched/consulted using entity B
- verified_by: entity A was tested/confirmed by entity B
- caused_by: entity A was caused by entity B
- solved_by: entity A was resolved by entity B
- references: entity A references/links to entity B
- preceded_by: entity A came after entity B temporally
- related_to: generic relationship (use sparingly, prefer specific types)

Rules:
- Only infer relationships with clear textual evidence
- Source and target must both be in the provided entity list
- Confidence: 0.8+ for explicit language, 0.5-0.7 for implied
- Return JSON array: [{"source": "entity name", "target": "entity name", "type": "...", "confidence": 0.0-1.0}]
- Return [] if no relationships found
- No markdown, no explanation, ONLY the JSON array`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Infers relationships between entities using Haiku.
 *
 * @param text - The observation content providing context
 * @param entities - Array of entities extracted from the same observation
 * @returns Validated array of inferred relationships with type and confidence
 */
export async function inferRelationshipsWithHaiku(
  text: string,
  entities: Array<{ name: string; type: EntityType }>,
): Promise<Array<{ source: string; target: string; type: RelationshipType; confidence: number }>> {
  const entityList = JSON.stringify(entities.map((e) => ({ name: e.name, type: e.type })));
  const userContent = `Observation:\n${text}\n\nEntities found:\n${entityList}`;

  const response = await callHaiku(SYSTEM_PROMPT, userContent, 512);
  const parsed = extractJsonFromResponse(response);
  return RelationshipArraySchema.parse(parsed);
}
