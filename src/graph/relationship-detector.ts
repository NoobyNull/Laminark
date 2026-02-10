/**
 * Relationship detection between co-occurring entities.
 *
 * Takes observation text and already-extracted entities, then infers typed
 * relationships based on entity type pairs and context signals in the text.
 * Proximity and sentence co-occurrence boost confidence scores.
 *
 * Pipeline:
 *   1. For each unique entity pair, check type-pair inference rules
 *   2. Scan text for context signals to override default relationship type
 *   3. Apply proximity and sentence co-occurrence confidence boosts
 *   4. Filter self-relationships and low-confidence results
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { EntityType, RelationshipType, GraphEdge } from './types.js';
import { getNodeByNameAndType, insertEdge } from './schema.js';
import { enforceMaxDegree } from './constraints.js';

// =============================================================================
// Types
// =============================================================================

export interface RelationshipCandidate {
  sourceEntity: { name: string; type: EntityType };
  targetEntity: { name: string; type: EntityType };
  relationshipType: RelationshipType;
  confidence: number; // 0.0-1.0
  evidence: string; // the text snippet that led to this inference
}

// =============================================================================
// Context Signal Patterns
// =============================================================================

/**
 * Ordered by specificity. First match wins.
 */
const CONTEXT_SIGNALS: Array<{
  pattern: RegExp;
  type: RelationshipType;
}> = [
  // Most specific signals first (multi-word phrases and directional indicators)
  { pattern: /\b(?:decided|chose|selected)\b/i, type: 'decided_by' },
  { pattern: /\b(?:solved\s+by|fixed\s+by|resolved\s+by)\b/i, type: 'solved_by' },
  { pattern: /\b(?:caused\s+by|because\s+of|due\s+to)\b/i, type: 'caused_by' },
  { pattern: /\b(?:depends?\s+on|requires?|imports?)\b/i, type: 'depends_on' },
  { pattern: /\b(?:part\s+of|belongs?\s+to|inside)\b/i, type: 'part_of' },
  // Least specific signals last (common words that could be coincidental)
  { pattern: /\b(?:uses?|using)\b/i, type: 'uses' },
];

// =============================================================================
// Type-Pair Inference Rules
// =============================================================================

/**
 * Default relationship type based on entity type pair.
 * Key format: "SourceType->TargetType"
 */
const TYPE_PAIR_DEFAULTS: Record<string, RelationshipType> = {
  'File->Tool': 'uses',
  'Tool->File': 'uses',
  'File->File': 'related_to', // overridden by context if import/require present
  'Decision->Tool': 'related_to',
  'Tool->Decision': 'related_to',
  'Decision->Person': 'decided_by',
  'Person->Decision': 'decided_by',
  'Problem->File': 'part_of',
  'File->Problem': 'part_of',
  'Problem->Solution': 'solved_by',
  'Solution->Problem': 'solved_by',
  'Solution->Tool': 'uses',
  'Tool->Solution': 'uses',
  'Project->File': 'part_of',
  'File->Project': 'part_of',
};

// =============================================================================
// Core Detection
// =============================================================================

/**
 * Detects typed relationships between co-occurring entities in observation text.
 *
 * For each unique entity pair:
 *   1. Determine base relationship type from type-pair rules
 *   2. Check text context signals to refine relationship type
 *   3. Apply proximity boost (+0.1 for entities within 50 chars)
 *   4. Apply sentence co-occurrence boost (+0.15 for same sentence)
 *   5. Filter out self-relationships
 *
 * @param text - The observation text containing the entities
 * @param entities - Already-extracted entities with name and type
 * @returns Array of relationship candidates with confidence scores
 */
export function detectRelationships(
  text: string,
  entities: Array<{ name: string; type: EntityType }>,
): RelationshipCandidate[] {
  if (entities.length < 2) return [];

  const candidates: RelationshipCandidate[] = [];

  // For each unique pair of entities
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const source = entities[i];
      const target = entities[j];

      // Filter self-relationships (same name AND same type)
      if (source.name === target.name && source.type === target.type) {
        continue;
      }

      // Find entity positions in text for proximity analysis
      const sourcePos = text.toLowerCase().indexOf(source.name.toLowerCase());
      const targetPos = text.toLowerCase().indexOf(target.name.toLowerCase());

      // Both entities must appear in the text
      if (sourcePos === -1 || targetPos === -1) continue;

      // Get the context text surrounding both entities for signal analysis.
      // Expand window by up to 50 chars before first entity and after last entity
      // to capture context signals like "Decided by @matt to use Tailwind CSS"
      // where "Decided" precedes both entities.
      const minPos = Math.min(sourcePos, targetPos);
      const maxPos = Math.max(
        sourcePos + source.name.length,
        targetPos + target.name.length,
      );
      const contextStart = Math.max(0, minPos - 50);
      const contextEnd = Math.min(text.length, maxPos + 50);
      const contextText = text.slice(contextStart, contextEnd);

      // Determine relationship type
      const pairKey = `${source.type}->${target.type}`;
      let relationshipType = TYPE_PAIR_DEFAULTS[pairKey] ?? 'related_to';

      // Check context signals in the text between entities
      for (const signal of CONTEXT_SIGNALS) {
        if (signal.pattern.test(contextText)) {
          relationshipType = signal.type;
          break;
        }
      }

      // Special case: File->File with import/require language
      if (source.type === 'File' && target.type === 'File') {
        if (/\b(?:imports?|requires?|from)\b/i.test(contextText)) {
          relationshipType = 'depends_on';
        }
      }

      // Calculate base confidence
      let confidence: number;
      if (relationshipType === 'related_to' && !TYPE_PAIR_DEFAULTS[pairKey]) {
        // Default fallback for unknown type pairs
        confidence = 0.3;
      } else {
        confidence = 0.5;
      }

      // Proximity boost: entities within 50 characters of each other
      const distance = Math.abs(sourcePos - targetPos);
      if (distance <= 50) {
        confidence += 0.1;
      }

      // Sentence co-occurrence boost: entities in the same sentence
      if (areInSameSentence(text, sourcePos, targetPos)) {
        confidence += 0.15;
      }

      // Cap at 1.0
      confidence = Math.min(confidence, 1.0);

      candidates.push({
        sourceEntity: { name: source.name, type: source.type },
        targetEntity: { name: target.name, type: target.type },
        relationshipType,
        confidence,
        evidence: contextText.slice(0, 200), // Truncate evidence to 200 chars
      });
    }
  }

  return candidates;
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Detects relationships, resolves entity names to node IDs, and persists edges.
 *
 * - Calls detectRelationships to find candidates
 * - Resolves each entity to a graph node via getNodeByNameAndType
 * - Inserts edges for candidates with confidence > 0.3
 * - Enforces max degree on affected nodes after insertion
 *
 * @returns Array of persisted GraphEdge objects
 */
export function detectAndPersist(
  db: BetterSqlite3.Database,
  text: string,
  entities: Array<{ name: string; type: EntityType }>,
  opts?: { projectHash?: string },
): GraphEdge[] {
  const candidates = detectRelationships(text, entities);
  const persisted: GraphEdge[] = [];
  const affectedNodeIds = new Set<string>();

  const persist = db.transaction(() => {
    for (const candidate of candidates) {
      // Filter low-confidence candidates
      if (candidate.confidence <= 0.3) continue;

      // Resolve entity names to node IDs
      const sourceNode = getNodeByNameAndType(
        db,
        candidate.sourceEntity.name,
        candidate.sourceEntity.type,
      );
      const targetNode = getNodeByNameAndType(
        db,
        candidate.targetEntity.name,
        candidate.targetEntity.type,
      );

      // Both nodes must exist in the graph
      if (!sourceNode || !targetNode) continue;

      try {
        const edge = insertEdge(db, {
          source_id: sourceNode.id,
          target_id: targetNode.id,
          type: candidate.relationshipType,
          weight: candidate.confidence,
          metadata: { evidence: candidate.evidence },
          project_hash: opts?.projectHash,
        });
        persisted.push(edge);
        affectedNodeIds.add(sourceNode.id);
        affectedNodeIds.add(targetNode.id);
      } catch {
        // Skip individual edge failures, continue with remaining
        continue;
      }
    }

    // Enforce max degree on all affected nodes
    for (const nodeId of affectedNodeIds) {
      enforceMaxDegree(db, nodeId);
    }
  });

  persist();
  return persisted;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Checks if two positions in the text are within the same sentence.
 * A sentence boundary is defined by '.', '!', '?', or newline followed by
 * optional whitespace.
 */
function areInSameSentence(
  text: string,
  pos1: number,
  pos2: number,
): boolean {
  const start = Math.min(pos1, pos2);
  const end = Math.max(pos1, pos2);
  const between = text.slice(start, end);

  // If there's a sentence boundary between the two positions, they're in different sentences
  return !/[.!?\n]/.test(between);
}
