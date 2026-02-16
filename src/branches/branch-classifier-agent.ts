/**
 * Haiku agent for classifying thought branch type and generating title/summary.
 *
 * Uses a single Haiku call to determine:
 * 1. Branch type (investigation, bug_fix, feature, refactor, research)
 * 2. A concise title for the branch
 * 3. An optional summary (for completed branches)
 *
 * Follows the same pattern as haiku-classifier-agent.ts.
 */

import { z } from 'zod';

import { callHaiku, extractJsonFromResponse } from '../intelligence/haiku-client.js';
import type { BranchType } from './types.js';

// ---------------------------------------------------------------------------
// Zod validation schemas
// ---------------------------------------------------------------------------

const ClassifyBranchSchema = z.object({
  branch_type: z.enum(['investigation', 'bug_fix', 'feature', 'refactor', 'research']),
  title: z.string().max(100),
});

const SummarizeBranchSchema = z.object({
  summary: z.string().max(500),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type BranchClassification = {
  branch_type: BranchType;
  title: string;
};

export type BranchSummaryResult = {
  summary: string;
};

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = `You classify developer work branches for a knowledge management system.

Given a sequence of observations from a work session, determine:
1. branch_type: What kind of work is this?
   - "investigation": Exploring code, reading docs, understanding behavior
   - "bug_fix": Fixing an error, test failure, or unexpected behavior
   - "feature": Building new functionality
   - "refactor": Restructuring existing code without changing behavior
   - "research": Looking up external resources, comparing approaches

2. title: A concise title (3-8 words) describing the work unit. Use imperative form.
   Examples: "Fix auth token refresh", "Add branch detection system", "Investigate memory leak"

Return JSON: {"branch_type": "...", "title": "..."}
No markdown, no explanation, ONLY the JSON object.`;

const SUMMARIZE_PROMPT = `You summarize completed developer work branches for a knowledge management system.

Given a sequence of observations from a completed work branch, write a concise summary (1-3 sentences) that captures:
- What was the goal
- What was done
- What was the outcome

Return JSON: {"summary": "..."}
No markdown, no explanation, ONLY the JSON object.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies a branch type and generates a title from observation content.
 */
export async function classifyBranchWithHaiku(
  observationTexts: string[],
  toolPattern: Record<string, number>,
): Promise<BranchClassification> {
  const toolSummary = Object.entries(toolPattern)
    .sort(([, a], [, b]) => b - a)
    .map(([tool, count]) => `${tool}: ${count}`)
    .join(', ');

  const userContent = [
    `Tool usage: ${toolSummary}`,
    '',
    'Observations:',
    ...observationTexts.slice(0, 10).map((t, i) => `${i + 1}. ${t.slice(0, 200)}`),
  ].join('\n');

  const response = await callHaiku(CLASSIFY_PROMPT, userContent, 256);
  const parsed = extractJsonFromResponse(response);
  return ClassifyBranchSchema.parse(parsed);
}

/**
 * Generates a completion summary for a finished branch.
 */
export async function summarizeBranchWithHaiku(
  title: string,
  branchType: string,
  observationTexts: string[],
): Promise<BranchSummaryResult> {
  const userContent = [
    `Branch: ${title} (${branchType})`,
    '',
    'Observations:',
    ...observationTexts.slice(0, 15).map((t, i) => `${i + 1}. ${t.slice(0, 200)}`),
  ].join('\n');

  const response = await callHaiku(SUMMARIZE_PROMPT, userContent, 256);
  const parsed = extractJsonFromResponse(response);
  return SummarizeBranchSchema.parse(parsed);
}
