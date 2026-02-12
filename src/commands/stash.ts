// ---------------------------------------------------------------------------
// /laminark:stash -- Manual Context Stash Command
// ---------------------------------------------------------------------------
// Allows users to manually stash their current session's observations
// as a context thread snapshot. Complements automatic topic-shift stashing
// by giving users explicit control.
// ---------------------------------------------------------------------------

import { debug } from '../shared/debug.js';
import type { StashManager } from '../storage/stash-manager.js';
import type { ObservationRepository } from '../storage/observations.js';
import type { StashObservation } from '../types/stash.js';

/**
 * Dependencies injected into the stash command handler.
 */
export interface StashCommandDeps {
  stashManager: StashManager;
  observationStore: ObservationRepository;
}

/**
 * Result of the /laminark:stash command.
 */
export interface StashCommandResult {
  success: boolean;
  message: string;
}

/**
 * Handles the /laminark:stash slash command.
 *
 * Gathers recent observations from the current session and creates
 * a stash snapshot. The user can optionally provide a label; otherwise
 * one is extracted from the first observation content.
 *
 * @param args.projectId - Current project identifier
 * @param args.sessionId - Current session identifier
 * @param args.label - Optional user-provided topic label
 * @param deps - Injected dependencies (stashManager, observationStore)
 */
export async function handleStashCommand(
  args: { projectId: string; sessionId: string; label?: string },
  deps: StashCommandDeps,
): Promise<StashCommandResult> {
  const { stashManager, observationStore } = deps;

  debug('cmd', 'handleStashCommand', {
    projectId: args.projectId,
    sessionId: args.sessionId,
    hasLabel: !!args.label,
  });

  // 1. Gather recent observations from current session
  const observations = observationStore.list({
    sessionId: args.sessionId,
    limit: 20,
  });

  // 2. No observations -> early return
  if (observations.length === 0) {
    return {
      success: false,
      message: 'No observations in current session to stash.',
    };
  }

  // 3. Generate topic label
  const topicLabel = args.label ?? generateLabel(observations);

  // 4. Generate summary from first 3 observations
  const summary = generateSummary(observations);

  // 5. Create observation snapshots
  const snapshots: StashObservation[] = observations.map((obs) => ({
    id: obs.id,
    content: obs.content,
    type: obs.source,
    timestamp: obs.createdAt,
    embedding: obs.embedding ? Array.from(obs.embedding) : null,
  }));

  // 6. Create the stash
  stashManager.createStash({
    projectId: args.projectId,
    sessionId: args.sessionId,
    topicLabel,
    summary,
    observations: snapshots,
  });

  debug('cmd', 'Stash created', { topicLabel, observationCount: snapshots.length });

  // 7. Return confirmation
  return {
    success: true,
    message: `Context stashed: "${topicLabel}". Use /laminark:resume to return to it.`,
  };
}

/**
 * Extract a semantic topic label from observations.
 * Prefers titled observations; falls back to oldest content.
 * List is DESC-ordered, so oldest is at the end.
 */
function generateLabel(observations: { content: string; title?: string | null }[]): string {
  if (observations.length === 0) return 'Unknown topic';

  // Prefer titled observations
  for (const obs of observations) {
    if (obs.title) {
      const cleaned = obs.title.replace(/\n/g, ' ').trim();
      if (cleaned.length > 0) return cleaned.slice(0, 80);
    }
  }

  const oldest = observations[observations.length - 1];
  const raw = oldest.content.replace(/\n/g, ' ').trim();
  return raw.slice(0, 80) || 'Unknown topic';
}

/**
 * Generate a brief summary from the first 3 (oldest) observations,
 * truncated to 200 characters total.
 */
function generateSummary(observations: { content: string }[]): string {
  if (observations.length === 0) return '';
  const oldest = observations.slice(-3).reverse();
  const joined = oldest
    .map((obs) => obs.content.replace(/\n/g, ' ').trim())
    .join(' | ');
  return joined.slice(0, 200);
}
