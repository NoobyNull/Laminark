import { isNoise } from './noise-patterns.js';
import { debug } from '../shared/debug.js';

/**
 * Tools that are always admitted regardless of content.
 *
 * Write and Edit observations are high-signal by definition --
 * they represent intentional code changes. Content pattern matching
 * must NEVER reject these tools (see research pitfall #3).
 */
const HIGH_SIGNAL_TOOLS = new Set(['Write', 'Edit']);

/**
 * Prefix for Laminark's own MCP tools.
 * Self-referential observations are noise -- Laminark should not
 * observe its own operations.
 */
const LAMINARK_MCP_PREFIX = 'mcp__laminark__';

/**
 * Maximum content length before requiring decision/error indicators.
 * Content over this threshold with no meaningful indicators is likely
 * a raw file dump or verbose command output.
 */
const MAX_CONTENT_LENGTH = 5000;

/**
 * Patterns that indicate meaningful content even in long output.
 * If content exceeds MAX_CONTENT_LENGTH, it must contain at least
 * one of these to be admitted.
 */
const DECISION_OR_ERROR_INDICATORS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\bbug\b/i,
  /\bdecided\b/i,
  /\bchose\b/i,
  /\bbecause\b/i,
  /\binstead of\b/i,
];

/**
 * Decides whether an observation is worth storing in the database.
 *
 * This is the primary quality gate for the observation pipeline.
 * It prevents the database from filling with noise (build output,
 * linter spam, package install logs).
 *
 * Critical rule: Write and Edit tools are NEVER rejected based on
 * content patterns alone. Tool type is the primary signal.
 *
 * @param toolName - The name of the tool that produced the observation
 * @param content - The observation content to evaluate
 * @returns true if the observation should be stored, false to reject
 */
export function shouldAdmit(toolName: string, content: string): boolean {
  // Reject Laminark self-referential MCP tools
  if (toolName.startsWith(LAMINARK_MCP_PREFIX)) {
    debug('hook', 'Observation rejected', { tool: toolName, reason: 'self-referential' });
    return false;
  }

  // Empty/whitespace content is always rejected, even for high-signal tools
  if (!content || content.trim().length === 0) {
    debug('hook', 'Observation rejected', { tool: toolName, reason: 'empty' });
    return false;
  }

  // High-signal tools are always admitted (Write, Edit)
  if (HIGH_SIGNAL_TOOLS.has(toolName)) {
    return true;
  }

  // Check content against noise patterns
  const noiseResult = isNoise(content);
  if (noiseResult.isNoise) {
    debug('hook', 'Observation rejected', {
      tool: toolName,
      reason: 'noise',
      category: noiseResult.category,
    });
    return false;
  }

  // Long content without decision/error indicators is likely noise
  if (content.length > MAX_CONTENT_LENGTH) {
    const hasIndicator = DECISION_OR_ERROR_INDICATORS.some((pattern) =>
      pattern.test(content),
    );
    if (!hasIndicator) {
      debug('hook', 'Observation rejected', {
        tool: toolName,
        reason: 'long_content_no_indicators',
        length: content.length,
      });
      return false;
    }
  }

  return true;
}
