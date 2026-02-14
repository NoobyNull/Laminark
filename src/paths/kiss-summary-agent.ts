/**
 * KISS summary agent — generates actionable "next time, just do X" summaries.
 *
 * When a debug path resolves, this agent analyzes the waypoints (errors,
 * attempts, failures, resolution) and produces a multi-layer summary:
 *   - kiss_summary: The one-liner takeaway
 *   - root_cause: What actually caused the issue
 *   - what_fixed_it: The specific fix that resolved it
 *   - dimensions: logical, programmatic, development perspectives
 *
 * Uses the shared Haiku client (callHaiku + extractJsonFromResponse) following
 * the same pattern as haiku-classifier-agent.ts.
 */

import { z } from 'zod';

import { callHaiku, extractJsonFromResponse } from '../intelligence/haiku-client.js';
import type { PathWaypoint } from './types.js';

// ---------------------------------------------------------------------------
// Zod validation schema
// ---------------------------------------------------------------------------

const KissSummarySchema = z.object({
  kiss_summary: z.string(),
  root_cause: z.string(),
  what_fixed_it: z.string(),
  dimensions: z.object({
    logical: z.string(),
    programmatic: z.string(),
    development: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type KissSummary = z.infer<typeof KissSummarySchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You analyze completed debug resolution paths and produce actionable summaries.

Given a debug path with its trigger, waypoints (errors, attempts, failures, resolution), and resolution summary, generate:

1. kiss_summary: A "Next time, just do X" one-liner. This is the actionable takeaway a developer should remember.
2. root_cause: What actually caused the issue (1-2 sentences max).
3. what_fixed_it: The specific fix or change that resolved it (1-2 sentences max).
4. dimensions:
   - logical: What mental model was wrong? What assumption led the developer astray? (1-2 sentences)
   - programmatic: What code-level change fixed it? Be specific about files, functions, or patterns. (1-2 sentences)
   - development: What workflow improvement would catch this faster next time? (1-2 sentences)

Keep every field concise. Developers will scan these quickly.
Return ONLY JSON, no markdown, no explanation.`;

// ---------------------------------------------------------------------------
// Key waypoint types worth including in the summary prompt
// ---------------------------------------------------------------------------

const KEY_WAYPOINT_TYPES = new Set([
  'error',
  'failure',
  'success',
  'resolution',
  'discovery',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a KISS summary for a resolved debug path.
 *
 * Pre-filters waypoints to key types (error, failure, success, resolution,
 * discovery) and caps at 10 to keep the prompt small. Returns a structured
 * KissSummary with multi-layer dimensions.
 *
 * @param triggerSummary - What started the debug path
 * @param waypoints - All waypoints from the path
 * @param resolutionSummary - How the path was resolved
 * @returns Structured KISS summary with dimensions
 */
export async function generateKissSummary(
  triggerSummary: string,
  waypoints: PathWaypoint[],
  resolutionSummary: string,
): Promise<KissSummary> {
  // Pre-filter to key waypoint types, skip 'attempt' noise
  const filtered = waypoints
    .filter((w) => KEY_WAYPOINT_TYPES.has(w.waypoint_type))
    .slice(0, 10);

  // Format waypoints for the prompt
  const waypointLines = filtered
    .map((w) => `- [${w.waypoint_type}] ${w.summary}`)
    .join('\n');

  const userContent = `Trigger: ${triggerSummary}

Waypoints:
${waypointLines}

Resolution: ${resolutionSummary}`;

  const response = await callHaiku(SYSTEM_PROMPT, userContent);
  const parsed = extractJsonFromResponse(response);
  return KissSummarySchema.parse(parsed);
}
