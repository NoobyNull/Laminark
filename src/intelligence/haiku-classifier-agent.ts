/**
 * Combined noise/signal and observation classification agent.
 *
 * Uses a single Haiku call to determine:
 * 1. Whether an observation is noise or signal
 * 2. If signal, what kind of observation it is (discovery/problem/solution)
 *
 * Replaces both the regex-based noise-patterns.ts/signal-classifier.ts and the
 * broken MCP sampling observation-classifier.ts with a single focused LLM call.
 */

import { z } from 'zod';

import type { ObservationClassification } from '../shared/types.js';
import { callHaiku, extractJsonFromResponse } from './haiku-client.js';

// ---------------------------------------------------------------------------
// Zod validation schema
// ---------------------------------------------------------------------------

const ClassificationSchema = z.object({
  signal: z.enum(['noise', 'signal']),
  classification: z.enum(['discovery', 'problem', 'solution']).nullable(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ClassificationResult = {
  signal: 'noise' | 'signal';
  classification: ObservationClassification | null;
  reason: string;
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You classify developer observations for a knowledge management system.

For each observation, determine:
1. signal: Is this noise or signal?
   - "noise": build output, linter spam, package install logs, empty/trivial content, routine navigation, repeated boilerplate, test runner output with no failures
   - "signal": meaningful findings, decisions, problems, solutions, reference material, architectural insights

2. classification (only if signal): What kind of observation is this?
   - "discovery": new understanding, finding, insight, or reference material
   - "problem": error, bug, failure, or obstacle encountered
   - "solution": fix, resolution, workaround, or decision that resolved something

Return JSON: {"signal": "noise"|"signal", "classification": "discovery"|"problem"|"solution"|null, "reason": "brief explanation"}
If noise, classification must be null.
No markdown, no explanation, ONLY the JSON object.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies an observation as noise/signal and determines its kind using Haiku.
 *
 * @param text - The observation content to classify
 * @param source - Optional source context (e.g., "PostToolUse:Read", "UserMessage")
 * @returns Classification result with signal/noise determination and observation kind
 */
export async function classifyWithHaiku(
  text: string,
  source?: string,
): Promise<ClassificationResult> {
  let userContent = text;
  if (source) {
    userContent = `Source: ${source}\n\nObservation:\n${text}`;
  }

  const response = await callHaiku(SYSTEM_PROMPT, userContent, 256);
  const parsed = extractJsonFromResponse(response);
  return ClassificationSchema.parse(parsed) as ClassificationResult;
}
