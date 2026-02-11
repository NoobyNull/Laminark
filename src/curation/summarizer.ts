import type { Observation, ObservationKind } from '../shared/types.js';
import { ObservationRepository } from '../storage/observations.js';
import { SessionRepository } from '../storage/sessions.js';
import { debug } from '../shared/debug.js';

/**
 * Summary result returned after generating a session summary.
 */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  observationCount: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Kind-aware extraction helpers
// ---------------------------------------------------------------------------

/**
 * Groups observations by their kind field.
 */
function groupByKind(observations: Observation[]): Record<ObservationKind, Observation[]> {
  const groups: Record<ObservationKind, Observation[]> = {
    change: [],
    reference: [],
    finding: [],
    decision: [],
    verification: [],
  };

  for (const obs of observations) {
    const kind = obs.kind ?? 'finding';
    if (groups[kind]) {
      groups[kind].push(obs);
    } else {
      groups.finding.push(obs);
    }
  }

  return groups;
}

/**
 * Extracts a snippet from observation content (first line, max 120 chars).
 */
function snippet(content: string, maxLen: number = 120): string {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + '...';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compresses an array of session observations into a structured text summary.
 *
 * Kind-aware: groups observations by their `kind` field instead of heuristic
 * keyword matching. Produces structured sections:
 * - Changes (kind='change'): file modifications
 * - Decisions (kind='decision'): choices made
 * - Verifications (kind='verification'): test/build results
 * - References (kind='reference'): external resources consulted
 * - Findings (kind='finding'): manual saves and insights
 *
 * Target output: under 500 tokens (~2000 characters).
 * If the raw extraction exceeds this budget, sections are trimmed by priority:
 * references first, then findings, then verifications, then changes.
 */
export function compressObservations(observations: Observation[]): string {
  if (observations.length === 0) {
    return '';
  }

  const groups = groupByKind(observations);

  // Build the summary with section headers
  const sections: string[] = [];

  sections.push('## Session Summary');

  // Timestamps from first and last observation
  const sorted = [...observations].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt),
  );
  const startedAt = sorted[0].createdAt;
  const endedAt = sorted[sorted.length - 1].createdAt;

  sections.push(`**Duration:** ${startedAt} to ${endedAt}`);
  sections.push(`**Observations:** ${observations.length}`);

  // Changes section (most important)
  if (groups.change.length > 0) {
    sections.push('');
    sections.push('### Changes');
    for (const obs of groups.change.slice(0, 10)) {
      sections.push(`- ${snippet(obs.content)}`);
    }
  }

  // Decisions section
  if (groups.decision.length > 0) {
    sections.push('');
    sections.push('### Decisions');
    for (const obs of groups.decision.slice(0, 5)) {
      sections.push(`- ${snippet(obs.content)}`);
    }
  }

  // Verifications section
  if (groups.verification.length > 0) {
    sections.push('');
    sections.push('### Verifications');
    for (const obs of groups.verification.slice(0, 5)) {
      sections.push(`- ${snippet(obs.content)}`);
    }
  }

  // References section
  if (groups.reference.length > 0) {
    sections.push('');
    sections.push('### References');
    for (const obs of groups.reference.slice(0, 3)) {
      sections.push(`- ${snippet(obs.content)}`);
    }
  }

  // Findings section
  if (groups.finding.length > 0) {
    sections.push('');
    sections.push('### Findings');
    for (const obs of groups.finding.slice(0, 5)) {
      sections.push(`- ${snippet(obs.content)}`);
    }
  }

  let result = sections.join('\n');

  // Enforce ~2000 char budget (approx 500 tokens at ~4 chars/token)
  if (result.length > 2000) {
    // Progressively trim: references first, then findings, then verifications
    const trimSections: string[] = [];
    trimSections.push('## Session Summary');
    trimSections.push(`**Duration:** ${startedAt} to ${endedAt}`);
    trimSections.push(`**Observations:** ${observations.length}`);

    if (groups.change.length > 0) {
      trimSections.push('');
      trimSections.push('### Changes');
      for (const obs of groups.change.slice(0, 5)) {
        trimSections.push(`- ${snippet(obs.content)}`);
      }
    }

    if (groups.decision.length > 0) {
      trimSections.push('');
      trimSections.push('### Decisions');
      for (const obs of groups.decision.slice(0, 3)) {
        trimSections.push(`- ${snippet(obs.content)}`);
      }
    }

    if (groups.verification.length > 0) {
      trimSections.push('');
      trimSections.push('### Verifications');
      for (const obs of groups.verification.slice(0, 3)) {
        trimSections.push(`- ${snippet(obs.content)}`);
      }
    }

    result = trimSections.join('\n');
  }

  return result;
}

/**
 * Generates a session summary by reading all observations for the given session,
 * compressing them into a concise summary, and storing it back on the session row.
 *
 * Returns null if the session has zero observations (graceful no-op).
 *
 * @param sessionId - The session ID to summarize
 * @param obsRepo - Repository for reading observations
 * @param sessionRepo - Repository for updating the session summary
 * @returns SessionSummary or null if no observations
 */
export function generateSessionSummary(
  sessionId: string,
  obsRepo: ObservationRepository,
  sessionRepo: SessionRepository,
): SessionSummary | null {
  debug('curation', 'Generating session summary', { sessionId });

  // Fetch all non-deleted observations for this session, ordered by createdAt
  const observations = obsRepo.list({
    sessionId,
    limit: 1000, // generous limit -- compress handles any count
  });

  if (observations.length === 0) {
    debug('curation', 'No observations for session, skipping summary', {
      sessionId,
    });
    return null;
  }

  const summary = compressObservations(observations);
  const generatedAt = new Date().toISOString();

  // Store the summary on the session row
  sessionRepo.updateSessionSummary(sessionId, summary);

  debug('curation', 'Session summary generated', {
    sessionId,
    observationCount: observations.length,
    summaryLength: summary.length,
  });

  return {
    sessionId,
    summary,
    observationCount: observations.length,
    generatedAt,
  };
}
