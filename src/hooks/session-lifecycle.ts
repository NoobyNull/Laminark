import type { ObservationRepository } from '../storage/observations.js';
import type { SessionRepository } from '../storage/sessions.js';
import { generateSessionSummary } from '../curation/summarizer.js';
import { debug } from '../shared/debug.js';

/**
 * Handles a SessionStart hook event.
 *
 * Creates a new session record in the database with the session_id
 * from the hook payload. Must be FAST (under 100ms) -- no context
 * injection (that is Phase 5's responsibility).
 */
export function handleSessionStart(
  input: Record<string, unknown>,
  sessionRepo: SessionRepository,
): void {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'SessionStart missing session_id, skipping');
    return;
  }

  sessionRepo.create(sessionId);

  debug('session', 'Session started', { sessionId });
}

/**
 * Handles a SessionEnd hook event.
 *
 * Closes the session record by setting ended_at timestamp.
 */
export function handleSessionEnd(
  input: Record<string, unknown>,
  sessionRepo: SessionRepository,
): void {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'SessionEnd missing session_id, skipping');
    return;
  }

  sessionRepo.end(sessionId);

  debug('session', 'Session ended', { sessionId });
}

/**
 * Handles a Stop hook event.
 *
 * Triggers session summary generation by compressing all observations
 * from the session into a concise summary stored on the session row.
 *
 * Stop fires after SessionEnd, so the session is already closed.
 * Summary generation is heuristic (no LLM call) and typically completes
 * in under 10ms even with many observations.
 *
 * If the session has zero observations, this is a graceful no-op.
 */
export function handleStop(
  input: Record<string, unknown>,
  obsRepo: ObservationRepository,
  sessionRepo: SessionRepository,
): void {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'Stop missing session_id, skipping');
    return;
  }

  debug('session', 'Stop event received, generating summary', { sessionId });

  const result = generateSessionSummary(sessionId, obsRepo, sessionRepo);

  if (result) {
    debug('session', 'Session summary generated', {
      sessionId,
      observationCount: result.observationCount,
      summaryLength: result.summary.length,
    });
  } else {
    debug('session', 'No observations to summarize', { sessionId });
  }
}
