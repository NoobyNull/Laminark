/**
 * Type definitions for context stashing.
 *
 * Context stashing is the persistence mechanism for topic detection (Phase 6).
 * When a topic shift is detected, the current thread's observations and summary
 * are snapshotted into a stash record so the user can resume later.
 */

/**
 * A snapshot of a single observation stored within a stash.
 * Captures the observation's content at the time of stashing so the stash
 * remains self-contained even if the original observation is later modified.
 */
export interface StashObservation {
  id: string;
  content: string;
  type: string;
  timestamp: string;
  embedding: number[] | null;
}

/**
 * A stashed context thread -- a frozen snapshot of observations and their
 * summary at the moment a topic shift was detected.
 */
export interface ContextStash {
  id: string;
  projectId: string;
  sessionId: string;
  topicLabel: string;
  summary: string;
  observationIds: string[];
  observationSnapshots: StashObservation[];
  createdAt: string;
  resumedAt: string | null;
  status: 'stashed' | 'resumed' | 'expired';
}

/**
 * Input for creating a new stash record.
 * Omits generated fields (id, createdAt, resumedAt, status, observationIds)
 * since those are derived during creation.
 */
export interface CreateStashInput {
  projectId: string;
  sessionId: string;
  topicLabel: string;
  summary: string;
  observations: StashObservation[];
}
