import type { ToolRegistryRow } from '../shared/tool-types.js';
import type { RoutingSuggestion } from './types.js';

/**
 * Stop words filtered from keyword extraction.
 * Common English function words that carry no discriminative signal for tool matching.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'and', 'but', 'or', 'nor', 'not',
  'so', 'yet', 'this', 'that', 'these', 'those', 'it', 'its',
]);

/**
 * Tokenizes text into lowercase keywords for matching.
 *
 * Replaces non-alphanumeric characters (except hyphens and underscores) with spaces,
 * splits on whitespace, filters words shorter than 3 characters and stop words,
 * and returns unique keywords.
 */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  return [...new Set(words)];
}

/**
 * Extracts keywords from a tool's description, server name, and parsed name.
 *
 * - Description text is tokenized via extractKeywords
 * - Server name is added as a keyword (lowercase)
 * - Slash commands are parsed by splitting on `:`, `-`, `_`
 * - Skills are parsed by splitting on `-` and `_`
 *
 * Returns a deduplicated array of keywords.
 */
export function extractToolKeywords(tool: ToolRegistryRow): string[] {
  const sources: string[] = [];

  // Description keywords (highest value)
  if (tool.description) {
    sources.push(...extractKeywords(tool.description));
  }

  // Server name as keyword (e.g., "playwright", "github")
  if (tool.server_name) {
    sources.push(tool.server_name.toLowerCase());
  }

  // Parse slash command path (e.g., "/gsd:plan-phase" -> ["gsd", "plan", "phase"])
  if (tool.tool_type === 'slash_command') {
    const parts = tool.name
      .replace(/^\//, '')
      .split(/[:\-_]/)
      .filter(p => p.length > 0);
    sources.push(...parts.map(p => p.toLowerCase()));
  }

  // Skill name keywords (e.g., "debug-memory" -> ["debug", "memory"])
  if (tool.tool_type === 'skill') {
    const parts = tool.name
      .split(/[\-_]/)
      .filter(p => p.length > 0);
    sources.push(...parts.map(p => p.toLowerCase()));
  }

  return [...new Set(sources)];
}

/**
 * Evaluates heuristic keyword matching between recent observations and available tools.
 *
 * This is the cold-start routing tier (ROUT-04). It works with zero accumulated usage
 * history by matching keywords from recent session observations against tool descriptions
 * and names.
 *
 * Returns the highest-confidence match above the threshold, or null if no match qualifies.
 *
 * @param recentObservations - Recent observation content strings from the current session
 * @param suggestableTools - Scope-filtered, non-builtin, non-Laminark tools
 * @param confidenceThreshold - Minimum score to return a suggestion (0.0-1.0)
 */
export function evaluateHeuristic(
  recentObservations: string[],
  suggestableTools: ToolRegistryRow[],
  confidenceThreshold: number,
): RoutingSuggestion | null {
  // Too early to judge intent from fewer than 2 observations
  if (recentObservations.length < 2) return null;

  // Build context keyword set from all recent observations
  const contextKeywords = new Set(
    recentObservations.flatMap(obs => extractKeywords(obs)),
  );

  if (contextKeywords.size === 0) return null;

  let bestMatch: { tool: ToolRegistryRow; score: number } | null = null;

  for (const tool of suggestableTools) {
    const toolKeywords = extractToolKeywords(tool);
    if (toolKeywords.length === 0) continue;

    const matchCount = toolKeywords.filter(kw => contextKeywords.has(kw)).length;
    const score = matchCount / toolKeywords.length;

    if (score > (bestMatch?.score ?? 0)) {
      bestMatch = { tool, score };
    }
  }

  if (!bestMatch || bestMatch.score < confidenceThreshold) return null;

  return {
    toolName: bestMatch.tool.name,
    toolDescription: bestMatch.tool.description,
    confidence: bestMatch.score,
    tier: 'heuristic',
    reason: 'Keywords match between current work and tool description',
  };
}
