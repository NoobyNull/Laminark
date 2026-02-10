/**
 * Temporal query utilities for the knowledge graph.
 *
 * Provides time-aware observation queries, recency scoring with exponential
 * decay, age formatting, entity timelines, and recently-active entity lookups.
 *
 * All timestamps are ISO 8601 strings in UTC. Functions accept a better-sqlite3
 * Database handle directly (no project scoping -- graph tables are global).
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { Observation, ObservationRow } from '../shared/types.js';
import { rowToObservation } from '../shared/types.js';
import type { EntityType, GraphNode } from './types.js';

// =============================================================================
// Row types for internal use
// =============================================================================

interface NodeRow {
  id: string;
  type: string;
  name: string;
  metadata: string; // JSON string
  observation_ids: string; // JSON string
  created_at: string;
  updated_at: string;
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    observation_ids: JSON.parse(row.observation_ids) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// =============================================================================
// Constants
// =============================================================================

/** Half-life for exponential decay recency scoring, in days. */
const HALF_LIFE_DAYS = 7;

/** Decay constant: ln(2) / half-life */
const DECAY_CONSTANT = 0.693 / HALF_LIFE_DAYS;

// =============================================================================
// Time Range Queries
// =============================================================================

/**
 * Queries observations within a time range, optionally filtered by entity.
 *
 * When entityId is provided, only returns observations that are linked to
 * the specified graph node via its observation_ids JSON array.
 *
 * Results are sorted by created_at DESC (newest first).
 *
 * @param db - better-sqlite3 Database handle
 * @param opts - Query options: since/until (ISO 8601), entityId, limit
 * @returns Observations matching the time range and entity filter
 */
export function getObservationsByTimeRange(
  db: BetterSqlite3.Database,
  opts: {
    since?: string;
    until?: string;
    entityId?: string;
    limit?: number;
  } = {},
): Observation[] {
  const limit = opts.limit ?? 100;

  // If entityId is provided, first get the observation IDs linked to that entity
  if (opts.entityId) {
    const node = db
      .prepare('SELECT observation_ids FROM graph_nodes WHERE id = ?')
      .get(opts.entityId) as { observation_ids: string } | undefined;

    if (!node) return [];

    const obsIds = JSON.parse(node.observation_ids) as string[];
    if (obsIds.length === 0) return [];

    // Build query with time range filters
    const conditions: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];

    // IN clause for observation IDs
    const placeholders = obsIds.map(() => '?').join(', ');
    conditions.push(`id IN (${placeholders})`);
    params.push(...obsIds);

    if (opts.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      conditions.push('created_at <= ?');
      params.push(opts.until);
    }

    params.push(limit);

    const sql = `SELECT * FROM observations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  // No entityId -- query all observations in time range
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  if (opts.since) {
    conditions.push('created_at >= ?');
    params.push(opts.since);
  }
  if (opts.until) {
    conditions.push('created_at <= ?');
    params.push(opts.until);
  }

  params.push(limit);

  const sql = `SELECT * FROM observations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params) as ObservationRow[];
  return rows.map(rowToObservation);
}

// =============================================================================
// Recency Scoring
// =============================================================================

/**
 * Calculates a recency score between 0.0 and 1.0 using exponential decay.
 *
 * Formula: score = exp(-0.693 * ageDays / 7)
 *
 * - 0 days old = 1.0
 * - 7 days old = ~0.5
 * - 14 days old = ~0.25
 * - 28 days old = ~0.0625
 *
 * @param createdAt - ISO 8601 timestamp string
 * @param now - Reference time (defaults to current time)
 * @returns Score between 0.0 and 1.0
 */
export function calculateRecencyScore(
  createdAt: string,
  now: Date = new Date(),
): number {
  const createdDate = new Date(createdAt);
  const ageDays =
    (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24);

  if (ageDays <= 0) return 1.0;

  return Math.exp(-DECAY_CONSTANT * ageDays);
}

// =============================================================================
// Observation Age
// =============================================================================

export interface ObservationAge {
  days: number;
  hours: number;
  label: string;
}

/**
 * Returns structured age information for an observation.
 *
 * Label formatting:
 * - < 1 hour: "just now"
 * - < 24 hours: "N hours ago"
 * - < 30 days: "N days ago"
 * - >= 30 days: "N months ago"
 *
 * @param createdAt - ISO 8601 timestamp string
 * @param now - Reference time (defaults to current time)
 * @returns Structured age with days, hours, and human-readable label
 */
export function getObservationAge(
  createdAt: string,
  now: Date = new Date(),
): ObservationAge {
  const createdDate = new Date(createdAt);
  const diffMs = now.getTime() - createdDate.getTime();

  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  let label: string;

  if (totalHours < 1) {
    label = 'just now';
  } else if (totalHours < 24) {
    label = `${totalHours} hour${totalHours === 1 ? '' : 's'} ago`;
  } else if (totalDays < 30) {
    label = `${totalDays} day${totalDays === 1 ? '' : 's'} ago`;
  } else {
    const months = Math.floor(totalDays / 30);
    label = `${months} month${months === 1 ? '' : 's'} ago`;
  }

  return { days: totalDays, hours: totalHours, label };
}

// =============================================================================
// Entity Timeline
// =============================================================================

export interface TimelineEntry {
  observation: Observation;
  recencyScore: number;
  age: ObservationAge;
}

/**
 * Returns all observations linked to an entity, annotated with recency scores
 * and age information. Sorted chronologically (oldest first) for timeline view.
 *
 * @param db - better-sqlite3 Database handle
 * @param entityId - Graph node ID to get timeline for
 * @returns Array of timeline entries sorted oldest-first
 */
export function getEntityTimeline(
  db: BetterSqlite3.Database,
  entityId: string,
): TimelineEntry[] {
  const node = db
    .prepare('SELECT observation_ids FROM graph_nodes WHERE id = ?')
    .get(entityId) as { observation_ids: string } | undefined;

  if (!node) return [];

  const obsIds = JSON.parse(node.observation_ids) as string[];
  if (obsIds.length === 0) return [];

  const placeholders = obsIds.map(() => '?').join(', ');
  const sql = `SELECT * FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at ASC`;
  const rows = db.prepare(sql).all(...obsIds) as ObservationRow[];

  const now = new Date();
  return rows.map((row) => {
    const obs = rowToObservation(row);
    return {
      observation: obs,
      recencyScore: calculateRecencyScore(obs.createdAt, now),
      age: getObservationAge(obs.createdAt, now),
    };
  });
}

// =============================================================================
// Recent Entities
// =============================================================================

/**
 * Returns entities (graph nodes) that were created or had observations added
 * within the specified time window.
 *
 * Determines "recent" by checking the node's updated_at timestamp, which
 * gets set whenever observation_ids are merged via upsertNode.
 *
 * @param db - better-sqlite3 Database handle
 * @param opts - Optional time window (default: 24 hours) and entity type filter
 * @returns Graph nodes active within the time window
 */
export function getRecentEntities(
  db: BetterSqlite3.Database,
  opts?: { hours?: number; type?: EntityType },
): GraphNode[] {
  const hours = opts?.hours ?? 24;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Time window filter using SQLite datetime arithmetic
  conditions.push(`updated_at >= datetime('now', '-${hours} hours')`);

  if (opts?.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM graph_nodes ${whereClause} ORDER BY updated_at DESC`;

  const rows = db.prepare(sql).all(...params) as NodeRow[];
  return rows.map(rowToNode);
}
