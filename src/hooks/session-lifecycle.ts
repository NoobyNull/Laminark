import type BetterSqlite3 from 'better-sqlite3';

import type { ObservationRepository } from '../storage/observations.js';
import type { SessionRepository } from '../storage/sessions.js';
import { generateSessionSummary } from '../curation/summarizer.js';
import { assembleSessionContext } from '../context/injection.js';
import { debug } from '../shared/debug.js';

/**
 * Handles a SessionStart hook event.
 *
 * Creates a new session record in the database, then assembles context
 * from prior sessions and observations for injection into Claude's
 * context window.
 *
 * This hook is SYNCHRONOUS -- stdout is injected into Claude's context.
 * Must complete within 2 seconds (performance budget for sync hooks).
 * Expected execution: <100ms (session create + 2-3 SELECT queries).
 *
 * @returns Context string to write to stdout, or null if no context available
 */
export function handleSessionStart(
  input: Record<string, unknown>,
  sessionRepo: SessionRepository,
  db: BetterSqlite3.Database,
  projectHash: string,
): string | null {
  const sessionId = input.session_id as string | undefined;

  if (!sessionId) {
    debug('session', 'SessionStart missing session_id, skipping');
    return null;
  }

  sessionRepo.create(sessionId);
  debug('session', 'Session started', { sessionId });

  // Assemble context from prior sessions and observations
  const startTime = Date.now();
  const context = assembleSessionContext(db, projectHash);
  const elapsed = Date.now() - startTime;

  if (elapsed > 500) {
    debug('session', 'Context assembly slow', { elapsed, sessionId });
  }

  debug('session', 'Context assembled for injection', {
    sessionId,
    contextLength: context.length,
    elapsed,
  });

  return context;
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
