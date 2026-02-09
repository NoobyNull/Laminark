import type { Observation } from '../shared/types.js';
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
// Heuristic patterns for extracting structured information
// ---------------------------------------------------------------------------

/** Matches file paths like src/foo/bar.ts, ./config.json, /etc/hosts */
const FILE_PATH_RE = /(?:^|[\s"'`(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})(?=[\s"'`),;:]|$)/g;

/** Keywords indicating a decision or choice was made */
const DECISION_KEYWORDS = [
  'decided',
  'chose',
  'will use',
  'going with',
  'selected',
  'opted for',
  'switching to',
  'prefer',
];

/** Keywords indicating a problem was encountered */
const PROBLEM_KEYWORDS = [
  'error',
  'failed',
  'bug',
  'issue',
  'fix',
  'broken',
  'crash',
  'wrong',
  'missing',
  'undefined',
];

/** Keywords indicating a solution was applied */
const SOLUTION_KEYWORDS = [
  'fixed',
  'resolved',
  'solved',
  'working now',
  'corrected',
  'patched',
  'addressed',
];

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts unique file paths from observation content.
 * Filters out common false positives like version numbers (e.g., "v1.0").
 */
function extractFilePaths(observations: Observation[]): string[] {
  const paths = new Set<string>();
  const falsePositiveRe = /^[vV]?\d+\.\d/;

  for (const obs of observations) {
    const text = obs.content;
    let match: RegExpExecArray | null;
    FILE_PATH_RE.lastIndex = 0;
    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      const path = match[1];
      // Skip version-like patterns, single extensions, and very short matches
      if (path.length > 3 && !falsePositiveRe.test(path)) {
        paths.add(path);
      }
    }
  }

  return Array.from(paths).slice(0, 15);
}

/**
 * Extracts observations that contain decision-related keywords.
 * Returns the first sentence or first 120 characters of matching content.
 */
function extractDecisions(observations: Observation[]): string[] {
  const decisions: string[] = [];

  for (const obs of observations) {
    const lower = obs.content.toLowerCase();
    const isDecision = DECISION_KEYWORDS.some((kw) => lower.includes(kw));
    if (isDecision) {
      // Take the first sentence or first 120 chars
      const firstSentence = obs.content.split(/[.!?\n]/)[0].trim();
      const snippet =
        firstSentence.length > 120
          ? firstSentence.slice(0, 117) + '...'
          : firstSentence;
      if (snippet.length > 5) {
        decisions.push(snippet);
      }
    }
  }

  return decisions.slice(0, 8);
}

/**
 * Extracts key activities from observations by summarizing tool usage
 * and notable actions. Prioritizes: explicit saves > problems/solutions > tool actions.
 */
function extractKeyActivities(observations: Observation[]): string[] {
  const activities: string[] = [];
  const seen = new Set<string>();

  for (const obs of observations) {
    const lower = obs.content.toLowerCase();

    // Check for problem/solution pairs
    const isProblem = PROBLEM_KEYWORDS.some((kw) => lower.includes(kw));
    const isSolution = SOLUTION_KEYWORDS.some((kw) => lower.includes(kw));

    let label: string | null = null;
    if (isSolution) {
      label = 'Resolved';
    } else if (isProblem) {
      label = 'Issue';
    } else if (obs.source.startsWith('mcp:')) {
      label = 'Saved';
    } else {
      label = 'Action';
    }

    // Take first meaningful line as the activity summary
    const firstLine = obs.content.split('\n')[0].trim();
    const snippet =
      firstLine.length > 100
        ? firstLine.slice(0, 97) + '...'
        : firstLine;

    if (snippet.length > 5 && !seen.has(snippet)) {
      seen.add(snippet);
      activities.push(`[${label}] ${snippet}`);
    }
  }

  return activities.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compresses an array of session observations into a structured text summary.
 *
 * This is a deterministic heuristic summarizer -- no LLM call. It extracts:
 * - Key activities (significant actions, max 10)
 * - Decisions and insights (keyword-matched, max 8)
 * - File paths mentioned (regex-extracted, max 15)
 *
 * Target output: under 500 tokens (~2000 characters).
 * If the raw extraction exceeds this budget, sections are truncated by priority:
 * decisions > activities > files.
 */
export function compressObservations(observations: Observation[]): string {
  if (observations.length === 0) {
    return '';
  }

  const activities = extractKeyActivities(observations);
  const decisions = extractDecisions(observations);
  const filePaths = extractFilePaths(observations);

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

  if (activities.length > 0) {
    sections.push('');
    sections.push('### Key Activities');
    for (const activity of activities) {
      sections.push(`- ${activity}`);
    }
  }

  if (decisions.length > 0) {
    sections.push('');
    sections.push('### Decisions & Insights');
    for (const decision of decisions) {
      sections.push(`- ${decision}`);
    }
  }

  if (filePaths.length > 0) {
    sections.push('');
    sections.push('### Files Touched');
    for (const fp of filePaths) {
      sections.push(`- ${fp}`);
    }
  }

  let result = sections.join('\n');

  // Enforce ~2000 char budget (approx 500 tokens at ~4 chars/token)
  if (result.length > 2000) {
    // Progressively trim: files first, then activities
    const trimmedFilePaths = filePaths.slice(0, 5);
    const trimmedActivities = activities.slice(0, 5);

    const trimSections: string[] = [];
    trimSections.push('## Session Summary');
    trimSections.push(`**Duration:** ${startedAt} to ${endedAt}`);
    trimSections.push(`**Observations:** ${observations.length}`);

    if (trimmedActivities.length > 0) {
      trimSections.push('');
      trimSections.push('### Key Activities');
      for (const activity of trimmedActivities) {
        trimSections.push(`- ${activity}`);
      }
    }

    if (decisions.length > 0) {
      trimSections.push('');
      trimSections.push('### Decisions & Insights');
      for (const decision of decisions.slice(0, 5)) {
        trimSections.push(`- ${decision}`);
      }
    }

    if (trimmedFilePaths.length > 0) {
      trimSections.push('');
      trimSections.push('### Files Touched');
      for (const fp of trimmedFilePaths) {
        trimSections.push(`- ${fp}`);
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
