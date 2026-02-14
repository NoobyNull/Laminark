/**
 * DEPRECATED: Signal classification is now handled by the HaikuProcessor
 * which classifies observations directly via Haiku. This file is retained
 * for backward compatibility but is no longer called from the embedding loop.
 *
 * Previously: Signal classifier for observation-to-graph extraction gating.
 * Gates which observations trigger entity extraction and relationship
 * detection based on source quality and content analysis.
 *
 * Signal levels:
 *   - HIGH: full extraction (entities + relationships)
 *   - MEDIUM: entities only (no relationship edges)
 *   - SKIP: no graph work at all
 */

import type { GraphExtractionConfig } from '../config/graph-extraction-config.js';

// =============================================================================
// Types
// =============================================================================

export type SignalLevel = 'high' | 'medium' | 'skip';

export interface ClassificationResult {
  level: SignalLevel;
  reason: string;
}

// =============================================================================
// Default Source Classifications
// =============================================================================

const DEFAULT_HIGH_SIGNAL_SOURCES = new Set([
  'manual',
  'hook:Write',
  'hook:Edit',
  'hook:WebFetch',
  'hook:WebSearch',
]);

const DEFAULT_MEDIUM_SIGNAL_SOURCES = new Set([
  'hook:Bash',
  'curation:merge',
]);

const DEFAULT_SKIP_SOURCES = new Set([
  'hook:TaskUpdate',
  'hook:TaskCreate',
  'hook:EnterPlanMode',
  'hook:ExitPlanMode',
  'hook:Read',
  'hook:Glob',
  'hook:Grep',
]);

// =============================================================================
// Content Boost Detection
// =============================================================================

/**
 * Patterns that indicate high-value content regardless of source.
 * Observations containing decision/problem/solution language get
 * promoted to high signal.
 */
const CONTENT_BOOST_PATTERNS = [
  /\b(?:decided\s+to|chose\s+to|went\s+with|selected|opted\s+for|decision:)\b/i,
  /\b(?:bug\s+in|issue\s+with|problem:|error:|broken|doesn't\s+work|can't)\b/i,
  /\b(?:fixed\s+by|solved\s+by|solution:|resolved\s+by|workaround:)\b/i,
];

/**
 * Checks if observation content contains high-value language
 * (decisions, problems, solutions) that warrants full extraction.
 */
export function hasContentBoost(text: string): boolean {
  return CONTENT_BOOST_PATTERNS.some(pattern => pattern.test(text));
}

// =============================================================================
// Minimum Content Length
// =============================================================================

const DEFAULT_MIN_CONTENT_LENGTH = 30;

// =============================================================================
// Core Classification
// =============================================================================

/**
 * Classifies an observation's signal level for graph extraction.
 *
 * Classification logic:
 *   1. If content is below minimum length, SKIP
 *   2. If source is in skip list, check for content boost -> HIGH or SKIP
 *   3. If source is in high list, HIGH
 *   4. If source is in medium list, check for content boost -> HIGH or MEDIUM
 *   5. Unknown sources default to MEDIUM (with content boost -> HIGH)
 */
export function classifySignal(
  source: string,
  content: string,
  config?: GraphExtractionConfig,
): ClassificationResult {
  const minLength = config?.signalClassifier?.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH;
  const highSources = config?.signalClassifier?.highSignalSources
    ? new Set(config.signalClassifier.highSignalSources)
    : DEFAULT_HIGH_SIGNAL_SOURCES;
  const mediumSources = config?.signalClassifier?.mediumSignalSources
    ? new Set(config.signalClassifier.mediumSignalSources)
    : DEFAULT_MEDIUM_SIGNAL_SOURCES;
  const skipSources = config?.signalClassifier?.skipSources
    ? new Set(config.signalClassifier.skipSources)
    : DEFAULT_SKIP_SOURCES;

  // Below minimum content length -> skip
  if (content.length < minLength) {
    return { level: 'skip', reason: `Content too short (${content.length} < ${minLength})` };
  }

  // Check for content boost (decision/problem/solution language)
  const boosted = hasContentBoost(content);

  // Skip sources: only proceed if content has high-value language
  if (skipSources.has(source)) {
    if (boosted) {
      return { level: 'high', reason: `Skip source "${source}" boosted by decision/problem/solution content` };
    }
    return { level: 'skip', reason: `Low-signal source: ${source}` };
  }

  // High signal sources: always full extraction
  if (highSources.has(source)) {
    return { level: 'high', reason: `High-signal source: ${source}` };
  }

  // Medium signal sources: entities only, unless content boost
  if (mediumSources.has(source)) {
    if (boosted) {
      return { level: 'high', reason: `Medium source "${source}" boosted by decision/problem/solution content` };
    }
    return { level: 'medium', reason: `Medium-signal source: ${source}` };
  }

  // Unknown source: default to medium, with possible boost
  if (boosted) {
    return { level: 'high', reason: `Unknown source "${source}" boosted by decision/problem/solution content` };
  }
  return { level: 'medium', reason: `Unknown source "${source}" defaults to medium` };
}
