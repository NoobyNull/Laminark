/**
 * Temporal decay for graph edge weights.
 *
 * Edge weights decay over time using exponential function inspired by
 * memento-mcp and agent-memory servers. Edges that aren't reinforced
 * (re-detected) gradually lose weight and eventually get deleted.
 *
 * Formula: weight * e^(-ln(2)/halfLife * ageDays)
 *
 * This maintains a living graph where recent knowledge is prominent
 * and old, unreinforced knowledge fades naturally.
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { GraphExtractionConfig } from '../config/graph-extraction-config.js';

// =============================================================================
// Types
// =============================================================================

export interface TemporalDecayConfig {
  /** Half-life in days. After this many days, unreinforced edges are at 50% weight. */
  halfLifeDays: number;
  /** Minimum floor weight. Edges never decay below this value (until deletion). */
  minFloor: number;
  /** Edges below this weight are deleted during curation. */
  deletionThreshold: number;
  /** Maximum age in days. Edges older than this are always deleted. */
  maxAgeDays: number;
}

export interface DecayResult {
  updated: number;
  deleted: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULTS: TemporalDecayConfig = {
  halfLifeDays: 30,
  minFloor: 0.05,
  deletionThreshold: 0.08,
  maxAgeDays: 180,
};

// =============================================================================
// Core Decay Functions
// =============================================================================

/**
 * Calculates the decayed weight for an edge based on its age.
 *
 * Uses exponential decay: weight * e^(-ln(2)/halfLife * ageDays)
 * Result is clamped to the minimum floor.
 *
 * @param originalWeight - The edge's current stored weight
 * @param ageDays - Age of the edge in days
 * @param config - Decay parameters
 * @returns The decayed weight value
 */
export function calculateDecayedWeight(
  originalWeight: number,
  ageDays: number,
  config?: Partial<TemporalDecayConfig>,
): number {
  const halfLife = config?.halfLifeDays ?? DEFAULTS.halfLifeDays;
  const minFloor = config?.minFloor ?? DEFAULTS.minFloor;

  if (ageDays <= 0) return originalWeight;

  const decayRate = Math.LN2 / halfLife;
  const decayed = originalWeight * Math.exp(-decayRate * ageDays);

  return Math.max(decayed, minFloor);
}

/**
 * Applies temporal decay to all edges in the graph.
 *
 * For each edge:
 *   1. Calculate age from created_at timestamp
 *   2. Apply exponential decay formula
 *   3. Delete edges below deletion threshold or older than max age
 *   4. Update remaining edges with new decayed weights
 *
 * Runs in a transaction for atomicity.
 *
 * @param db - Database handle
 * @param graphConfig - Optional configuration from graph-extraction-config
 * @returns Count of updated and deleted edges
 */
export function applyTemporalDecay(
  db: BetterSqlite3.Database,
  graphConfig?: GraphExtractionConfig,
): DecayResult {
  const halfLife = graphConfig?.temporalDecay?.halfLifeDays ?? DEFAULTS.halfLifeDays;
  const minFloor = graphConfig?.temporalDecay?.minFloor ?? DEFAULTS.minFloor;
  const deletionThreshold = graphConfig?.temporalDecay?.deletionThreshold ?? DEFAULTS.deletionThreshold;
  const maxAgeDays = graphConfig?.temporalDecay?.maxAgeDays ?? DEFAULTS.maxAgeDays;

  let updated = 0;
  let deleted = 0;

  const run = db.transaction(() => {
    // Get all edges with their age in days
    const edges = db.prepare(`
      SELECT id, weight,
        julianday('now') - julianday(created_at) as age_days
      FROM graph_edges
    `).all() as Array<{ id: string; weight: number; age_days: number }>;

    const deleteStmt = db.prepare('DELETE FROM graph_edges WHERE id = ?');
    const updateStmt = db.prepare('UPDATE graph_edges SET weight = ? WHERE id = ?');

    for (const edge of edges) {
      // Delete edges older than max age
      if (edge.age_days > maxAgeDays) {
        deleteStmt.run(edge.id);
        deleted++;
        continue;
      }

      // Calculate decayed weight
      const decayed = calculateDecayedWeight(edge.weight, edge.age_days, {
        halfLifeDays: halfLife,
        minFloor,
      });

      // Delete edges below deletion threshold
      if (decayed < deletionThreshold) {
        deleteStmt.run(edge.id);
        deleted++;
        continue;
      }

      // Update weight if it changed meaningfully (avoid unnecessary writes)
      if (Math.abs(decayed - edge.weight) > 0.001) {
        updateStmt.run(decayed, edge.id);
        updated++;
      }
    }
  });

  run();
  return { updated, deleted };
}
