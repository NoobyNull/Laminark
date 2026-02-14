/**
 * Type definitions for debug resolution paths.
 *
 * Defines waypoint types, path status, and interfaces for debug paths
 * and their ordered waypoints. Uses const arrays and derived union types
 * (same pattern as graph/types.ts) for runtime validation and type safety.
 */

// =============================================================================
// Waypoint Type Taxonomy
// =============================================================================

export const WAYPOINT_TYPES = [
  'error',        // Error encountered
  'attempt',      // Fix attempted
  'failure',      // Attempted fix didn't work (dead end - PATH-05)
  'success',      // Something worked
  'pivot',        // Changed approach
  'revert',       // Reverted a change
  'discovery',    // Learned something useful
  'resolution',   // Final fix that resolved the issue
] as const;

export type WaypointType = (typeof WAYPOINT_TYPES)[number];

// =============================================================================
// Path Status
// =============================================================================

export type PathStatus = 'active' | 'resolved' | 'abandoned';

// =============================================================================
// Debug Path Interface
// =============================================================================

/**
 * A debug resolution path tracking the journey from error to resolution.
 *
 * - id: UUID (hex-encoded randomBytes)
 * - status: lifecycle state (active -> resolved | abandoned)
 * - trigger_summary: what started this debug path
 * - resolution_summary: how it was resolved (null while active)
 * - kiss_summary: simplified summary for Phase 20
 * - started_at / resolved_at: ISO 8601 timestamps
 * - project_hash: project scope identifier
 */
export interface DebugPath {
  id: string;
  status: PathStatus;
  trigger_summary: string;
  resolution_summary: string | null;
  kiss_summary: string | null;
  started_at: string;
  resolved_at: string | null;
  project_hash: string;
}

// =============================================================================
// Path Waypoint Interface
// =============================================================================

/**
 * An ordered waypoint within a debug path.
 *
 * - id: UUID (hex-encoded randomBytes)
 * - path_id: references DebugPath.id
 * - observation_id: optional link to observations table
 * - waypoint_type: one of the 8 waypoint types
 * - sequence_order: position within the path (1-based)
 * - summary: description of what happened at this waypoint
 * - created_at: ISO 8601 timestamp
 */
export interface PathWaypoint {
  id: string;
  path_id: string;
  observation_id: string | null;
  waypoint_type: WaypointType;
  sequence_order: number;
  summary: string;
  created_at: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Runtime type guard for WaypointType.
 */
export function isWaypointType(s: string): s is WaypointType {
  return (WAYPOINT_TYPES as readonly string[]).includes(s);
}
