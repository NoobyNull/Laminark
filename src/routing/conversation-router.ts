import type BetterSqlite3 from 'better-sqlite3';

import type { RoutingConfig, RoutingSuggestion } from './types.js';
import { DEFAULT_ROUTING_CONFIG } from './types.js';
import { evaluateLearnedPatterns } from './intent-patterns.js';
import { evaluateHeuristic } from './heuristic-fallback.js';
import { inferToolType } from '../hooks/tool-name-parser.js';
import { isLaminarksOwnTool } from '../hooks/self-referential.js';
import { NotificationStore } from '../storage/notifications.js';
import type { ToolRegistryRepository } from '../storage/tool-registry.js';
import type { ToolRegistryRow } from '../shared/tool-types.js';
import { debug } from '../shared/debug.js';

/**
 * ConversationRouter orchestrates tool suggestion routing.
 *
 * Combines two tiers of suggestion:
 * - Learned patterns: historical tool sequence matching (ROUT-01)
 * - Heuristic fallback: keyword-based cold-start matching (ROUT-04)
 *
 * Suggestions are gated by confidence threshold (ROUT-03) and rate limits,
 * then delivered via NotificationStore (ROUT-02).
 *
 * Instantiated per-evaluation in the PostToolUse handler. No long-lived state --
 * state persists across invocations via the routing_state SQLite table.
 */
export class ConversationRouter {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;
  private readonly config: RoutingConfig;

  constructor(
    db: BetterSqlite3.Database,
    projectHash: string,
    config?: Partial<RoutingConfig>,
  ) {
    this.db = db;
    this.projectHash = projectHash;
    this.config = { ...DEFAULT_ROUTING_CONFIG, ...config };

    // Create routing_state table inline (transient, no migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_state (
        session_id TEXT NOT NULL,
        project_hash TEXT NOT NULL,
        suggestions_made INTEGER NOT NULL DEFAULT 0,
        last_suggestion_at TEXT,
        tool_calls_since_suggestion INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, project_hash)
      )
    `);
  }

  /**
   * Evaluates whether a tool suggestion should be surfaced for the current context.
   *
   * Called from PostToolUse handler after observation storage.
   * Runs AFTER the self-referential filter -- never evaluates Laminark's own tools.
   *
   * The entire method is wrapped in try/catch -- routing is supplementary
   * and must NEVER block or fail the core handler pipeline.
   *
   * @param sessionId - Current session identifier
   * @param toolName - The tool just used
   * @param toolRegistry - Tool registry for availability checking
   */
  evaluate(sessionId: string, toolName: string, toolRegistry: ToolRegistryRepository): void {
    try {
      this._evaluate(sessionId, toolName, toolRegistry);
    } catch (err) {
      // Routing is supplementary -- never block core pipeline
      debug('routing', 'Routing evaluation failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _evaluate(sessionId: string, toolName: string, toolRegistry: ToolRegistryRepository): void {
    // 1. Skip built-in tools
    if (inferToolType(toolName) === 'builtin') return;

    // 2. Skip Laminark's own tools
    if (isLaminarksOwnTool(toolName)) return;

    // 3. Load or create routing state for this session
    const state = this.getOrCreateState(sessionId);

    // 4. Increment tool_calls_since_suggestion and update state
    state.toolCallsSinceSuggestion++;
    this.updateState(sessionId, state);

    // 5. Check rate limits
    if (state.suggestionsMade >= this.config.maxSuggestionsPerSession) {
      debug('routing', 'Rate limited: max suggestions reached', { sessionId, made: state.suggestionsMade });
      return;
    }
    if (state.toolCallsSinceSuggestion < this.config.suggestionCooldown) {
      debug('routing', 'Rate limited: cooldown active', {
        sessionId, callsSince: state.toolCallsSinceSuggestion, cooldown: this.config.suggestionCooldown,
      });
      return;
    }

    // Check total tool calls this session (must have enough before first suggestion)
    const totalCalls = this.getTotalCallsForSession(sessionId);
    if (totalCalls < this.config.minCallsBeforeFirstSuggestion) {
      debug('routing', 'Too early: not enough tool calls', { sessionId, totalCalls });
      return;
    }

    // 6. Get available tools (scope-filtered)
    const availableTools = toolRegistry.getAvailableForSession(this.projectHash);

    // 7. Filter to suggestable: exclude built-in, Laminark, and stale/demoted tools
    const suggestableTools = availableTools.filter(
      (t: ToolRegistryRow) =>
        t.tool_type !== 'builtin' &&
        !isLaminarksOwnTool(t.name) &&
        t.status === 'active',  // STAL: Only suggest tools in good standing
    );

    // 8. If no suggestable tools: return
    if (suggestableTools.length === 0) return;

    const suggestableNames = new Set(suggestableTools.map((t: ToolRegistryRow) => t.name));

    // 9. Try learned patterns first (if enough historical data)
    let suggestion: RoutingSuggestion | null = null;

    const eventCount = this.countRecentEvents();
    if (eventCount >= this.config.minEventsForLearned) {
      suggestion = evaluateLearnedPatterns(
        this.db,
        sessionId,
        this.projectHash,
        suggestableNames,
        this.config.confidenceThreshold,
      );
    }

    // 10. Fall back to heuristic if no learned suggestion
    if (!suggestion) {
      const recentObservations = this.getRecentObservations(sessionId);
      suggestion = evaluateHeuristic(recentObservations, suggestableTools, this.config.confidenceThreshold);
    }

    // 11. If no suggestion from either tier: return
    if (!suggestion) return;

    // 12. Confidence gate (belt-and-suspenders -- tiers already check, but guard here too)
    if (suggestion.confidence < this.config.confidenceThreshold) return;

    // 13. Deliver via NotificationStore
    const notifStore = new NotificationStore(this.db);
    const description = suggestion.toolDescription ? ` -- ${suggestion.toolDescription}` : '';
    const usageHint = suggestion.tier === 'learned' ? ` (${suggestion.reason})` : '';
    const message = `Tool suggestion: ${suggestion.toolName}${description}${usageHint}`;
    notifStore.add(this.projectHash, message);

    debug('routing', 'Suggestion delivered', {
      tool: suggestion.toolName,
      tier: suggestion.tier,
      confidence: suggestion.confidence,
    });

    // 14. Update routing state: increment suggestions_made, reset cooldown
    state.suggestionsMade++;
    state.lastSuggestionAt = new Date().toISOString();
    state.toolCallsSinceSuggestion = 0;
    this.updateState(sessionId, state);
  }

  /**
   * Gets or creates routing state for a session.
   */
  private getOrCreateState(sessionId: string): {
    suggestionsMade: number;
    lastSuggestionAt: string | null;
    toolCallsSinceSuggestion: number;
  } {
    const row = this.db.prepare(`
      SELECT suggestions_made, last_suggestion_at, tool_calls_since_suggestion
      FROM routing_state
      WHERE session_id = ? AND project_hash = ?
    `).get(sessionId, this.projectHash) as {
      suggestions_made: number;
      last_suggestion_at: string | null;
      tool_calls_since_suggestion: number;
    } | undefined;

    if (row) {
      return {
        suggestionsMade: row.suggestions_made,
        lastSuggestionAt: row.last_suggestion_at,
        toolCallsSinceSuggestion: row.tool_calls_since_suggestion,
      };
    }

    // Create new state row
    this.db.prepare(`
      INSERT INTO routing_state (session_id, project_hash, suggestions_made, tool_calls_since_suggestion)
      VALUES (?, ?, 0, 0)
    `).run(sessionId, this.projectHash);

    return {
      suggestionsMade: 0,
      lastSuggestionAt: null,
      toolCallsSinceSuggestion: 0,
    };
  }

  /**
   * Updates routing state in the database.
   */
  private updateState(
    sessionId: string,
    state: {
      suggestionsMade: number;
      lastSuggestionAt: string | null;
      toolCallsSinceSuggestion: number;
    },
  ): void {
    this.db.prepare(`
      UPDATE routing_state
      SET suggestions_made = ?, last_suggestion_at = ?, tool_calls_since_suggestion = ?
      WHERE session_id = ? AND project_hash = ?
    `).run(
      state.suggestionsMade,
      state.lastSuggestionAt,
      state.toolCallsSinceSuggestion,
      sessionId,
      this.projectHash,
    );
  }

  /**
   * Returns total tool calls for the current session (from routing_state).
   */
  private getTotalCallsForSession(sessionId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM tool_usage_events
      WHERE session_id = ? AND project_hash = ?
    `).get(sessionId, this.projectHash) as { count: number };
    return row.count;
  }

  /**
   * Counts total tool_usage_events for this project (for learned pattern threshold).
   */
  private countRecentEvents(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM tool_usage_events WHERE project_hash = ?
    `).get(this.projectHash) as { count: number };
    return row.count;
  }

  /**
   * Gets recent observation content strings for heuristic matching.
   */
  private getRecentObservations(sessionId: string): string[] {
    const rows = this.db.prepare(`
      SELECT content FROM observations
      WHERE project_hash = ? AND session_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 5
    `).all(this.projectHash, sessionId) as Array<{ content: string }>;
    return rows.map(r => r.content);
  }
}
