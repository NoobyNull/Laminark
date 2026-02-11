/**
 * Type definitions for the knowledge graph.
 *
 * Defines a fixed entity/relationship taxonomy using const arrays and
 * derived union types (NOT enums) for better type inference and runtime
 * validation. Every Phase 7 module imports from this file.
 */

// =============================================================================
// Entity Type Taxonomy (FIXED -- no other types allowed)
// =============================================================================

export const ENTITY_TYPES = [
  'Project',
  'File',
  'Decision',
  'Problem',
  'Solution',
  'Reference',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

// =============================================================================
// Relationship Type Taxonomy (FIXED -- no other types allowed)
// =============================================================================

export const RELATIONSHIP_TYPES = [
  'related_to',
  'solved_by',
  'caused_by',
  'modifies',
  'informed_by',
  'references',
  'verified_by',
  'preceded_by',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

// =============================================================================
// Graph Node Interface
// =============================================================================

/**
 * A node in the knowledge graph representing a named entity.
 *
 * - id: UUID (hex-encoded randomBytes)
 * - type: one of the 6 entity types
 * - name: canonical name (e.g., "src/auth/login.ts" for File, "Use JWT" for Decision)
 * - metadata: flexible JSON for type-specific data
 * - observation_ids: source observations this entity was extracted from
 * - created_at / updated_at: ISO 8601 timestamps
 */
export interface GraphNode {
  id: string;
  type: EntityType;
  name: string;
  metadata: Record<string, unknown>;
  observation_ids: string[];
  created_at: string;
  updated_at: string;
}

// =============================================================================
// Graph Edge Interface
// =============================================================================

/**
 * A directed edge in the knowledge graph connecting two nodes.
 *
 * - id: UUID (hex-encoded randomBytes)
 * - source_id / target_id: references to GraphNode.id
 * - type: one of the 8 relationship types
 * - weight: confidence/strength score between 0.0 and 1.0
 * - metadata: flexible JSON for relationship-specific data
 * - created_at: ISO 8601 timestamp
 */
export interface GraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: RelationshipType;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Runtime type guard for EntityType.
 * Uses the ENTITY_TYPES const array for O(n) lookup (n=6, negligible).
 */
export function isEntityType(s: string): s is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(s);
}

/**
 * Runtime type guard for RelationshipType.
 * Uses the RELATIONSHIP_TYPES const array for O(n) lookup (n=8, negligible).
 */
export function isRelationshipType(s: string): s is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(s);
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of edges a single node can have.
 * Used by constraint enforcement in Plan 05 to prevent
 * hub nodes from dominating the graph.
 */
export const MAX_NODE_DEGREE = 50;
