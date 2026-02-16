/**
 * Type definitions for thought branches.
 *
 * A thought branch represents a coherent unit of work (investigation, bug fix,
 * feature build, etc.) auto-detected from tool usage patterns and observation
 * sequences. Uses const arrays and derived union types for runtime validation.
 */

// =============================================================================
// Branch Status
// =============================================================================

export const BRANCH_STATUSES = ['active', 'completed', 'abandoned', 'merged'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

// =============================================================================
// Branch Type
// =============================================================================

export const BRANCH_TYPES = [
  'investigation',
  'bug_fix',
  'feature',
  'refactor',
  'research',
  'unknown',
] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

// =============================================================================
// Arc Stage
// =============================================================================

export const ARC_STAGES = [
  'investigation',
  'diagnosis',
  'planning',
  'execution',
  'verification',
  'completed',
] as const;
export type ArcStage = (typeof ARC_STAGES)[number];

// =============================================================================
// Trigger Source
// =============================================================================

export const TRIGGER_SOURCES = [
  'topic_shift',
  'session_start',
  'project_switch',
  'time_gap',
  'manual',
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

// =============================================================================
// Thought Branch Interface
// =============================================================================

export interface ThoughtBranch {
  id: string;
  project_hash: string;
  session_id: string | null;
  status: BranchStatus;
  branch_type: BranchType;
  arc_stage: ArcStage;
  title: string | null;
  summary: string | null;
  parent_branch_id: string | null;
  linked_debug_path_id: string | null;
  trigger_source: TriggerSource | null;
  trigger_observation_id: string | null;
  observation_count: number;
  tool_pattern: Record<string, number>;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

// =============================================================================
// Branch Observation Interface
// =============================================================================

export interface BranchObservation {
  branch_id: string;
  observation_id: string;
  sequence_order: number;
  tool_name: string | null;
  arc_stage_at_add: ArcStage | null;
  created_at: string;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isBranchStatus(s: string): s is BranchStatus {
  return (BRANCH_STATUSES as readonly string[]).includes(s);
}

export function isBranchType(s: string): s is BranchType {
  return (BRANCH_TYPES as readonly string[]).includes(s);
}

export function isArcStage(s: string): s is ArcStage {
  return (ARC_STAGES as readonly string[]).includes(s);
}
