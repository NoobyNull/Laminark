import type { SessionRepository } from '../storage/sessions.js';
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
