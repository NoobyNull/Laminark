/**
 * Background curation agent for knowledge graph maintenance.
 *
 * Runs during quiet periods (session end, long pauses) to keep the
 * knowledge base high-quality as it grows. Performs:
 *   1. Observation merging (near-duplicate consolidation)
 *   2. Entity deduplication (case-insensitive, abbreviation, path)
 *   3. Graph constraint enforcement (approaching degree cap)
 *   4. Staleness sweep (contradiction flagging)
 *   5. Low-value pruning (short + unlinked + old + auto-captured)
 *
 * Each step is isolated -- one failure does not stop others.
 * The agent is idempotent: running twice produces the same result.
 * Curation NEVER crashes the main process.
 */

import type BetterSqlite3 from 'better-sqlite3';

import {
  findMergeableClusters,
  mergeObservationCluster,
  pruneLowValue,
} from './observation-merger.js';
import {
  findDuplicateEntities,
  mergeEntities,
  enforceMaxDegree,
} from './constraints.js';
import { countEdgesForNode } from './schema.js';
import {
  detectStaleness,
  flagStaleObservation,
  initStalenessSchema,
} from './staleness.js';
import { MAX_NODE_DEGREE } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Report of a completed curation cycle.
 */
export interface CurationReport {
  startedAt: string;
  completedAt: string;
  observationsMerged: number;
  entitiesDeduplicated: number;
  stalenessFlagsAdded: number;
  lowValuePruned: number;
  errors: string[];
}

// =============================================================================
// Standalone Curation Function
// =============================================================================

/**
 * Runs a single curation cycle on the knowledge graph.
 *
 * Executes five steps in order:
 *   1. Merge similar observations
 *   2. Deduplicate entities
 *   3. Enforce graph constraints (approaching degree cap)
 *   4. Staleness sweep
 *   5. Low-value pruning
 *
 * Each step is wrapped in try/catch -- if one fails, the rest continue.
 * Returns a CurationReport documenting all actions taken.
 *
 * This function is idempotent: running it twice in a row produces the
 * same result (merged observations do not re-merge, already-flagged
 * stale observations do not get re-flagged, etc.)
 *
 * @param db - better-sqlite3 Database handle
 * @returns CurationReport with counts and any errors
 */
export async function runCuration(
  db: BetterSqlite3.Database,
): Promise<CurationReport> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  let observationsMerged = 0;
  let entitiesDeduplicated = 0;
  let stalenessFlagsAdded = 0;
  let lowValuePruned = 0;

  // Ensure staleness schema exists
  try {
    initStalenessSchema(db);
  } catch (err) {
    errors.push(`Schema init: ${err instanceof Error ? err.message : String(err)}`);
  }

  // -----------------------------------------------------------------------
  // Step 1: Merge similar observations
  // -----------------------------------------------------------------------
  try {
    const clusters = findMergeableClusters(db);
    for (const cluster of clusters) {
      try {
        const result = mergeObservationCluster(db, cluster);
        observationsMerged += result.removedIds.length;
      } catch (err) {
        errors.push(
          `Merge cluster (entity ${cluster.entityId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    errors.push(
      `Step 1 (merge): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 2: Deduplicate entities
  // -----------------------------------------------------------------------
  try {
    const duplicates = findDuplicateEntities(db);
    for (const group of duplicates) {
      if (group.entities.length < 2) continue;

      // Keep the entity with more observation_ids
      const sorted = [...group.entities].sort(
        (a, b) => b.observation_ids.length - a.observation_ids.length,
      );
      const keepId = sorted[0].id;

      for (let i = 1; i < sorted.length; i++) {
        try {
          mergeEntities(db, keepId, sorted[i].id);
          entitiesDeduplicated++;
        } catch (err) {
          errors.push(
            `Dedup (${sorted[0].name} <- ${sorted[i].name}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    errors.push(
      `Step 2 (dedup): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: Enforce graph constraints (nodes approaching degree cap)
  // -----------------------------------------------------------------------
  try {
    const threshold = Math.floor(MAX_NODE_DEGREE * 0.9);
    const nodeRows = db
      .prepare('SELECT id FROM graph_nodes')
      .all() as Array<{ id: string }>;

    for (const row of nodeRows) {
      try {
        const degree = countEdgesForNode(db, row.id);
        if (degree > threshold) {
          enforceMaxDegree(db, row.id);
        }
      } catch (err) {
        errors.push(
          `Constraint (node ${row.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    errors.push(
      `Step 3 (constraints): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 4: Staleness sweep
  // -----------------------------------------------------------------------
  try {
    // Check recently updated entities for contradictions
    const recentNodes = db
      .prepare(
        `SELECT id FROM graph_nodes WHERE updated_at >= datetime('now', '-24 hours')`,
      )
      .all() as Array<{ id: string }>;

    // Get already-flagged observation IDs to avoid re-flagging
    const existingFlags = new Set<string>();
    try {
      const flagRows = db
        .prepare('SELECT observation_id FROM staleness_flags WHERE resolved = 0')
        .all() as Array<{ observation_id: string }>;
      for (const row of flagRows) {
        existingFlags.add(row.observation_id);
      }
    } catch {
      // Table might not exist yet -- that's fine
    }

    for (const node of recentNodes) {
      try {
        const reports = detectStaleness(db, node.id);
        for (const report of reports) {
          // Only flag if not already flagged (idempotency)
          if (!existingFlags.has(report.olderObservation.id)) {
            flagStaleObservation(db, report.olderObservation.id, report.reason);
            existingFlags.add(report.olderObservation.id);
            stalenessFlagsAdded++;
          }
        }
      } catch (err) {
        errors.push(
          `Staleness (node ${node.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    errors.push(
      `Step 4 (staleness): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Step 5: Low-value pruning
  // -----------------------------------------------------------------------
  try {
    const result = pruneLowValue(db);
    lowValuePruned = result.pruned;
  } catch (err) {
    errors.push(
      `Step 5 (prune): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const completedAt = new Date().toISOString();

  const report: CurationReport = {
    startedAt,
    completedAt,
    observationsMerged,
    entitiesDeduplicated,
    stalenessFlagsAdded,
    lowValuePruned,
    errors,
  };

  process.stderr.write(
    `[laminark:curation] Cycle complete: ${observationsMerged} merged, ${entitiesDeduplicated} deduped, ${stalenessFlagsAdded} flagged stale, ${lowValuePruned} pruned\n`,
  );

  return report;
}

// =============================================================================
// CurationAgent Class
// =============================================================================

/**
 * Background curation agent that runs periodically or on-demand.
 *
 * Manages scheduling, lifecycle, and reporting. Uses the standalone
 * runCuration() function for the actual curation logic.
 */
export class CurationAgent {
  private db: BetterSqlite3.Database;
  private intervalMs: number;
  private onComplete?: (report: CurationReport) => void;
  private running: boolean = false;
  private lastRun: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: BetterSqlite3.Database,
    opts?: {
      intervalMs?: number;
      onComplete?: (report: CurationReport) => void;
    },
  ) {
    this.db = db;
    this.intervalMs = opts?.intervalMs ?? 300_000; // 5 minutes default
    this.onComplete = opts?.onComplete;
  }

  /**
   * Start periodic curation on setInterval.
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);

    process.stderr.write(
      `[laminark:curation] Agent started, interval: ${this.intervalMs}ms\n`,
    );
  }

  /**
   * Stop the periodic curation timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;

    process.stderr.write('[laminark:curation] Agent stopped\n');
  }

  /**
   * Execute one curation cycle. This is the main entry point.
   */
  async runOnce(): Promise<CurationReport> {
    const report = await runCuration(this.db);
    this.lastRun = report.completedAt;

    if (this.onComplete) {
      this.onComplete(report);
    }

    return report;
  }

  /**
   * Whether the agent is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Timestamp of the last completed curation run.
   */
  getLastRun(): string | null {
    return this.lastRun;
  }
}

// =============================================================================
// Integration Trigger Functions
// =============================================================================

/**
 * Triggered at session end. Runs a targeted curation cycle
 * focusing on the current session's observations only (faster
 * than a full sweep).
 *
 * Note: Currently runs the full cycle since targeted per-session
 * filtering would require session_id awareness in all curation steps.
 * The full cycle is fast enough for session-end triggers.
 */
export async function onSessionEnd(
  db: BetterSqlite3.Database,
): Promise<CurationReport> {
  return runCuration(db);
}

/**
 * Triggered when no activity detected for 5+ minutes.
 * Runs the full curation cycle.
 */
export async function onQuietPeriod(
  db: BetterSqlite3.Database,
): Promise<CurationReport> {
  return runCuration(db);
}
