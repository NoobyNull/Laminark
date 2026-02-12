/**
 * Write-quality gate for entity extraction filtering.
 *
 * Filters individual entities before they enter the knowledge graph
 * to prevent low-quality nodes from accumulating. Applies:
 *   - Name length bounds (min 3, max 200 chars)
 *   - Vague/filler name rejection
 *   - Per-type minimum confidence thresholds
 *   - File node cap per observation
 *   - Context-aware confidence adjustment (File paths from non-change
 *     observations get confidence reduced)
 */

import type { EntityType } from './types.js';
import type { GraphExtractionConfig } from '../config/graph-extraction-config.js';

// =============================================================================
// Types
// =============================================================================

export interface QualityGateEntity {
  name: string;
  type: EntityType;
  confidence: number;
}

export interface QualityGateResult {
  passed: QualityGateEntity[];
  rejected: Array<{ entity: QualityGateEntity; reason: string }>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MIN_NAME_LENGTH = 3;
const DEFAULT_MAX_NAME_LENGTH = 200;
const DEFAULT_MAX_FILES_PER_OBSERVATION = 5;

/**
 * Vague name prefixes that indicate low-quality entity names.
 * Case-insensitive match against the start of the entity name.
 */
const VAGUE_PREFIXES = [
  'the ', 'this ', 'that ', 'it ', 'some ', 'a ', 'an ',
  'here ', 'there ', 'now ', 'just ',
  'ok ', 'yes ', 'no ', 'maybe ', 'done ', 'tmp ',
];

/**
 * Per-type minimum confidence thresholds.
 * High-signal types (Decision, Problem, Solution) have lower thresholds
 * to capture more of the valuable knowledge. File has the highest
 * threshold to reduce noise.
 */
const DEFAULT_TYPE_CONFIDENCE: Record<EntityType, number> = {
  File: 0.95,
  Project: 0.8,
  Reference: 0.85,
  Decision: 0.65,
  Problem: 0.6,
  Solution: 0.6,
};

/**
 * Context-aware confidence multiplier for File paths from non-change
 * observations. Reduces 0.95 -> ~0.70, below the 0.95 File threshold.
 */
const DEFAULT_FILE_NON_CHANGE_MULTIPLIER = 0.74;

// =============================================================================
// Core Quality Gate
// =============================================================================

/**
 * Applies quality gate filters to a list of extracted entities.
 *
 * Steps:
 *   1. Apply context-aware confidence adjustment (File paths in non-change obs)
 *   2. Reject entities with names outside length bounds
 *   3. Reject entities with vague/filler name prefixes
 *   4. Apply per-type confidence thresholds
 *   5. Cap File nodes to max per observation (keep highest confidence)
 *
 * @param entities - Extracted entities to filter
 * @param isChangeObservation - Whether the source observation is a change/write
 * @param config - Optional configuration overrides
 * @returns Entities that passed the gate, plus rejected entities with reasons
 */
export function applyQualityGate(
  entities: QualityGateEntity[],
  isChangeObservation: boolean,
  config?: GraphExtractionConfig,
): QualityGateResult {
  const minNameLen = config?.qualityGate?.minNameLength ?? DEFAULT_MIN_NAME_LENGTH;
  const maxNameLen = config?.qualityGate?.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;
  const maxFiles = config?.qualityGate?.maxFilesPerObservation ?? DEFAULT_MAX_FILES_PER_OBSERVATION;
  const typeConfidence = config?.qualityGate?.typeConfidenceThresholds ?? DEFAULT_TYPE_CONFIDENCE;
  const fileMultiplier = config?.qualityGate?.fileNonChangeMultiplier ?? DEFAULT_FILE_NON_CHANGE_MULTIPLIER;

  const passed: QualityGateEntity[] = [];
  const rejected: Array<{ entity: QualityGateEntity; reason: string }> = [];

  for (const entity of entities) {
    // Step 1: Context-aware confidence adjustment
    let adjustedConfidence = entity.confidence;
    if (entity.type === 'File' && !isChangeObservation) {
      adjustedConfidence = entity.confidence * fileMultiplier;
    }

    const adjusted = { ...entity, confidence: adjustedConfidence };

    // Step 2: Name length bounds
    if (adjusted.name.length < minNameLen) {
      rejected.push({ entity: adjusted, reason: `Name too short (${adjusted.name.length} < ${minNameLen})` });
      continue;
    }
    if (adjusted.name.length > maxNameLen) {
      rejected.push({ entity: adjusted, reason: `Name too long (${adjusted.name.length} > ${maxNameLen})` });
      continue;
    }

    // Step 3: Vague name rejection
    const lowerName = adjusted.name.toLowerCase();
    const isVague = VAGUE_PREFIXES.some(prefix => lowerName.startsWith(prefix));
    if (isVague) {
      rejected.push({ entity: adjusted, reason: `Vague name prefix: "${adjusted.name}"` });
      continue;
    }

    // Step 4: Per-type confidence threshold
    const threshold = typeConfidence[adjusted.type] ?? DEFAULT_TYPE_CONFIDENCE[adjusted.type] ?? 0.5;
    if (adjusted.confidence < threshold) {
      rejected.push({
        entity: adjusted,
        reason: `Below ${adjusted.type} confidence threshold (${adjusted.confidence.toFixed(2)} < ${threshold})`,
      });
      continue;
    }

    passed.push(adjusted);
  }

  // Step 5: Cap File nodes per observation
  const fileEntities = passed.filter(e => e.type === 'File');
  if (fileEntities.length > maxFiles) {
    // Sort by confidence descending, keep top N
    fileEntities.sort((a, b) => b.confidence - a.confidence);
    const toRemove = new Set(
      fileEntities.slice(maxFiles).map(e => e.name),
    );
    const finalPassed: QualityGateEntity[] = [];
    for (const e of passed) {
      if (e.type === 'File' && toRemove.has(e.name)) {
        rejected.push({ entity: e, reason: `File cap exceeded (max ${maxFiles} per observation)` });
      } else {
        finalPassed.push(e);
      }
    }
    return { passed: finalPassed, rejected };
  }

  return { passed, rejected };
}
