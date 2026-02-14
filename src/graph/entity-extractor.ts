/**
 * Entity extraction pipeline.
 *
 * Transforms observation text into typed GraphNode entities by running
 * rule-based pattern matchers and persisting results to the knowledge graph.
 *
 * Pipeline:
 *   1. Run ALL_RULES against text
 *   2. Deduplicate by name (keep highest confidence)
 *   3. Resolve overlapping spans (higher confidence wins)
 *   4. Filter by minimum confidence threshold
 *   5. Return sorted by confidence descending
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { EntityType } from './types.js';
import type { GraphNode } from './types.js';
import { upsertNode } from './schema.js';
import { ALL_RULES, type ExtractionMatch } from './extraction-rules.js';
import { applyQualityGate } from './write-quality-gate.js';
import type { GraphExtractionConfig } from '../config/graph-extraction-config.js';
import { extractEntitiesWithHaiku } from '../intelligence/haiku-entity-agent.js';

// =============================================================================
// Types
// =============================================================================

export interface EntityExtractionResult {
  entities: Array<{ name: string; type: EntityType; confidence: number }>;
  observationId: string;
  extractedAt: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MIN_CONFIDENCE = 0.5;

// =============================================================================
// Core Extraction
// =============================================================================

/**
 * @deprecated Use extractEntitiesAsync() or call extractEntitiesWithHaiku() directly.
 * Retained as a non-Haiku fallback. The HaikuProcessor calls agents directly.
 *
 * Extracts entities from observation text using all registered rules.
 *
 * - Runs every rule against the text
 * - Deduplicates: same name from multiple rules keeps highest confidence
 * - Resolves overlapping spans: higher confidence wins
 * - Filters by minimum confidence threshold
 * - Returns sorted by confidence descending
 */
export function extractEntities(
  text: string,
  observationId: string,
  opts?: { minConfidence?: number },
): EntityExtractionResult {
  const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // Step 1: Run all rules and collect matches
  const allMatches: ExtractionMatch[] = [];
  for (const rule of ALL_RULES) {
    try {
      const results = rule(text);
      allMatches.push(...results);
    } catch {
      // Never fail the whole extraction because one rule had issues
      continue;
    }
  }

  // Step 2: Resolve overlapping spans (higher confidence wins)
  const nonOverlapping = resolveOverlaps(allMatches);

  // Step 3: Deduplicate by name+type (keep highest confidence)
  const deduped = deduplicateByName(nonOverlapping);

  // Step 4: Filter by minimum confidence threshold
  const filtered = deduped.filter((m) => m.confidence >= minConfidence);

  // Step 5: Sort by confidence descending
  filtered.sort((a, b) => b.confidence - a.confidence);

  return {
    entities: filtered.map((m) => ({
      name: m.name,
      type: m.type,
      confidence: m.confidence,
    })),
    observationId,
    extractedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Extracts entities from text and persists them as graph nodes.
 *
 * For each extracted entity:
 *   - Calls upsertNode (creates or merges with existing node)
 *   - Appends observationId to the node's observation_ids array
 *
 * Wrapped in a transaction for atomicity. Individual entity failures
 * are logged and skipped (never fail the whole batch).
 *
 * @returns Array of persisted GraphNode objects
 */
export function extractAndPersist(
  db: BetterSqlite3.Database,
  text: string,
  observationId: string,
  opts?: {
    minConfidence?: number;
    projectHash?: string;
    isChangeObservation?: boolean;
    graphConfig?: GraphExtractionConfig;
  },
): GraphNode[] {
  const result = extractEntities(text, observationId, opts);
  const persisted: GraphNode[] = [];

  // Apply write-quality gate filter
  const isChange = opts?.isChangeObservation ?? false;
  const gateResult = applyQualityGate(result.entities, isChange, opts?.graphConfig);

  const persist = db.transaction(() => {
    for (const entity of gateResult.passed) {
      try {
        const node = upsertNode(db, {
          type: entity.type,
          name: entity.name,
          metadata: { confidence: entity.confidence },
          observation_ids: [observationId],
          project_hash: opts?.projectHash,
        });
        persisted.push(node);
      } catch {
        // Log warning and continue with remaining entities
        // Never fail the whole extraction because one entity had issues
        continue;
      }
    }
  });

  persist();
  return persisted;
}

// =============================================================================
// Async Haiku Path
// =============================================================================

/**
 * Extracts entities from observation text using Haiku agent.
 *
 * This is the async alternative to the deprecated regex-based extractEntities().
 * Delegates to the Haiku entity agent for LLM-powered extraction.
 *
 * @param text - The observation content to analyze
 * @param observationId - The observation ID for result metadata
 * @returns Validated extraction result with entities from Haiku
 */
export async function extractEntitiesAsync(
  text: string,
  observationId: string,
): Promise<EntityExtractionResult> {
  const entities = await extractEntitiesWithHaiku(text);
  return {
    entities,
    observationId,
    extractedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Resolves overlapping spans between same-type entities.
 *
 * Only removes overlapping matches when they share the same entity type
 * (e.g., two Tool entities on overlapping text). Different types are
 * allowed to overlap since they represent different semantic information
 * (e.g., a Decision span can contain a Tool name within it).
 *
 * When same-type spans overlap, the one with higher confidence wins.
 */
function resolveOverlaps(matches: ExtractionMatch[]): ExtractionMatch[] {
  if (matches.length <= 1) return [...matches];

  // Sort by confidence descending so higher-confidence matches are added first
  const sorted = [...matches].sort((a, b) => b.confidence - a.confidence);

  const result: ExtractionMatch[] = [];

  for (const match of sorted) {
    // Only check for overlap with same-type entities
    const sameTypeOverlap = result.findIndex(
      (kept) =>
        kept.type === match.type &&
        match.span[0] < kept.span[1] &&
        match.span[1] > kept.span[0],
    );

    if (sameTypeOverlap === -1) {
      // No same-type overlap -- keep it
      result.push(match);
    }
    // Otherwise skip (same-type overlap, existing has higher or equal confidence)
  }

  return result;
}

/**
 * Deduplicates matches by name+type. When the same entity name appears
 * multiple times (possibly from different rules), keeps the one with
 * the highest confidence score.
 */
function deduplicateByName(matches: ExtractionMatch[]): ExtractionMatch[] {
  const byKey = new Map<string, ExtractionMatch>();

  for (const match of matches) {
    const key = `${match.type}:${match.name.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || match.confidence > existing.confidence) {
      byKey.set(key, match);
    }
  }

  return [...byKey.values()];
}
