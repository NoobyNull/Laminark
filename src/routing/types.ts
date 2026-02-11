/**
 * A routing suggestion produced by either the heuristic or learned tier.
 * Delivered to the user via NotificationStore as a tool recommendation.
 */
export interface RoutingSuggestion {
  /** The suggested tool name (e.g., "mcp__playwright__browser_screenshot"). */
  toolName: string;
  /** Optional description for display in the notification. */
  toolDescription: string | null;
  /** Confidence score from 0.0 to 1.0. */
  confidence: number;
  /** Which routing tier produced this suggestion. */
  tier: 'heuristic' | 'learned';
  /** Human-readable explanation for why this tool was suggested. */
  reason: string;
}

/**
 * Configuration for the conversation routing system.
 * Controls thresholds, rate limits, and pattern matching parameters.
 */
export interface RoutingConfig {
  /** Minimum confidence score to emit a suggestion (0.0-1.0). */
  confidenceThreshold: number;
  /** Maximum number of suggestions per session (rate limit). */
  maxSuggestionsPerSession: number;
  /** Minimum tool_usage_events before learned patterns activate. */
  minEventsForLearned: number;
  /** Minimum tool calls between suggestions (cooldown). */
  suggestionCooldown: number;
  /** Minimum tool calls before the first suggestion in a session. */
  minCallsBeforeFirstSuggestion: number;
  /** Sliding window size for learned pattern extraction. */
  patternWindowSize: number;
}

/**
 * Per-session routing state persisted in SQLite (mirrors routing_state table).
 * Tracks suggestion counts and cooldown counters across handler invocations.
 */
export interface RoutingState {
  /** The current session identifier. */
  sessionId: string;
  /** Hash of the project directory. */
  projectHash: string;
  /** Number of suggestions emitted this session. */
  suggestionsMade: number;
  /** ISO timestamp of the last suggestion, or null if none yet. */
  lastSuggestionAt: string | null;
  /** Number of tool calls since the last suggestion was emitted. */
  toolCallsSinceSuggestion: number;
}

/**
 * A learned tool usage pattern extracted from historical tool_usage_events.
 * Represents a recurring sequence of tool calls that precedes a target tool.
 */
export interface ToolPattern {
  /** The tool that was eventually used after the preceding sequence. */
  targetTool: string;
  /** Tools used in the N calls before the target tool. */
  precedingTools: string[];
  /** How many times this exact pattern occurred in history. */
  frequency: number;
}

/**
 * Default routing configuration values.
 * Threshold and rate limits tuned to avoid over-suggestion (Clippy problem).
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  confidenceThreshold: 0.6,
  maxSuggestionsPerSession: 2,
  minEventsForLearned: 20,
  suggestionCooldown: 5,
  minCallsBeforeFirstSuggestion: 3,
  patternWindowSize: 5,
};
