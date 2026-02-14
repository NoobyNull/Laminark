/**
 * Combined noise/signal and observation classification agent.
 *
 * Uses a single Haiku call to determine:
 * 1. Whether an observation is noise or signal
 * 2. If signal, what kind of observation it is (discovery/problem/solution)
 * 3. Whether the observation contains debug signals (error/resolution detection)
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

const DebugSignalSchema = z.object({
  is_error: z.boolean(),
  is_resolution: z.boolean(),
  waypoint_hint: z.enum([
    'error', 'attempt', 'failure', 'success',
    'pivot', 'revert', 'discovery', 'resolution',
  ]).nullable(),
  confidence: z.number(),
}).nullable();

const ClassificationSchema = z.object({
  signal: z.enum(['noise', 'signal']),
  classification: z.enum(['discovery', 'problem', 'solution']).nullable(),
  reason: z.string(),
  debug_signal: DebugSignalSchema.default(null),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type DebugSignal = {
  is_error: boolean;
  is_resolution: boolean;
  waypoint_hint: 'error' | 'attempt' | 'failure' | 'success' | 'pivot' | 'revert' | 'discovery' | 'resolution' | null;
  confidence: number;
};

export type ClassificationResult = {
  signal: 'noise' | 'signal';
  classification: ObservationClassification | null;
  reason: string;
  debug_signal: DebugSignal | null;
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

3. debug_signal (always, even for noise): Is this related to debugging?
   - is_error: Does this contain an error message, test failure, build failure, or exception?
   - is_resolution: Does this indicate a successful fix, passing test, or resolved error?
   - waypoint_hint: If debug-related, what type? "error" (hit an error), "attempt" (trying a fix), "failure" (fix didn't work), "success" (something passed), "pivot" (changing approach), "revert" (undoing a change), "discovery" (learned something), "resolution" (final fix). null if not debug-related.
   - confidence: 0.0-1.0 how confident this is debug activity

Return JSON: {"signal": "noise"|"signal", "classification": "discovery"|"problem"|"solution"|null, "reason": "brief", "debug_signal": {"is_error": bool, "is_resolution": bool, "waypoint_hint": "type"|null, "confidence": 0.0-1.0}|null}
If noise, classification must be null. debug_signal can be non-null even for noise (e.g., build failure output is noise but debug-relevant).
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

  const response = await callHaiku(SYSTEM_PROMPT, userContent, 512);
  const parsed = extractJsonFromResponse(response);
  return ClassificationSchema.parse(parsed) as ClassificationResult;
}
