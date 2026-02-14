/**
 * Entity extraction pipeline.
 *
 * Provides both the legacy regex-based extraction path (deprecated) and
 * the new Haiku-powered async path. The HaikuProcessor calls agents directly;
 * these functions provide a higher-level interface.
 *
 * The deprecated sync functions are retained for backward compatibility
 * but return empty results since the regex extraction-rules.ts has been removed.
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { EntityType } from './types.js';
import type { GraphNode } from './types.js';
import { upsertNode } from './schema.js';
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
// Deprecated Sync Path
// =============================================================================

/**
 * @deprecated Regex extraction rules have been removed. Use extractEntitiesAsync()
 * or call extractEntitiesWithHaiku() directly. This function now returns empty results.
 */
export function extractEntities(
  text: string,
  observationId: string,
  _opts?: { minConfidence?: number },
): EntityExtractionResult {
  return {
    entities: [],
    observationId,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * @deprecated Regex extraction rules have been removed. Use HaikuProcessor
 * for entity extraction and persistence. This function now returns empty results.
 */
export function extractAndPersist(
  _db: BetterSqlite3.Database,
  text: string,
  observationId: string,
  _opts?: {
    minConfidence?: number;
    projectHash?: string;
    isChangeObservation?: boolean;
    graphConfig?: GraphExtractionConfig;
  },
): GraphNode[] {
  return [];
}

// =============================================================================
// Async Haiku Path
// =============================================================================

/**
 * Extracts entities from observation text using Haiku agent.
 *
 * This is the replacement for the deprecated regex-based extractEntities().
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
