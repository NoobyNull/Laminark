/**
 * Staleness detection for the knowledge graph.
 *
 * Detects contradictions between observations linked to the same entity
 * using pattern matching (negation, replacement, status change). Stale
 * observations are FLAGGED but NEVER deleted -- the system surfaces both
 * observations and lets the user decide.
 *
 * This module is detection-only on the read path (detectStaleness) and
 * provides advisory flagging on the write path (flagStaleObservation).
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { Observation, ObservationRow } from '../shared/types.js';
import { rowToObservation } from '../shared/types.js';
import type { EntityType } from './types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A staleness report documenting a detected contradiction between
 * two observations about the same entity.
 */
export interface StalenessReport {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  newerObservation: { id: string; text: string; created_at: string };
  olderObservation: { id: string; text: string; created_at: string };
  reason: string;
  detectedAt: string;
}

/**
 * A flagged stale observation with its staleness metadata.
 */
export interface StalenessFlag {
  observation_id: string;
  flagged_at: string;
  reason: string;
  resolved: boolean;
}

// =============================================================================
// Staleness Detection Patterns
// =============================================================================

/**
 * Negation patterns: newer observation negates older one.
 * Matches when newer text contains negation keywords absent in older text
 * and both discuss similar subjects.
 */
const NEGATION_KEYWORDS = [
  'not',
  "don't",
  'no longer',
  'stopped',
  'never',
  "doesn't",
  "won't",
  "isn't",
  "aren't",
  'discontinued',
] as const;

/**
 * Replacement patterns: newer observation explicitly replaces older approach.
 */
const REPLACEMENT_PATTERNS = [
  /switched\s+(?:from\s+\S+\s+)?to\b/i,
  /migrated\s+(?:from\s+\S+\s+)?to\b/i,
  /replaced\s+(?:\S+\s+)?with\b/i,
  /changed\s+from\b/i,
  /moved\s+(?:from\s+\S+\s+)?to\b/i,
  /upgraded\s+(?:from\s+\S+\s+)?to\b/i,
  /swapped\s+(?:\S+\s+)?(?:for|with)\b/i,
] as const;

/**
 * Status change patterns: newer observation marks something as inactive.
 */
const STATUS_CHANGE_KEYWORDS = [
  'removed',
  'deleted',
  'deprecated',
  'archived',
  'dropped',
  'disabled',
  'decommissioned',
  'sunset',
  'abandoned',
] as const;

// =============================================================================
// Schema Initialization
// =============================================================================

/**
 * Creates the staleness_flags table if it doesn't exist.
 * Uses a separate table rather than modifying the observations table,
 * keeping staleness metadata decoupled from core observation storage.
 */
export function initStalenessSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staleness_flags (
      observation_id TEXT PRIMARY KEY,
      flagged_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_staleness_resolved ON staleness_flags(resolved);
  `);
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Detects potential staleness (contradictions) between observations
 * linked to a specific entity.
 *
 * Compares consecutive observation pairs chronologically and checks for:
 * 1. Negation patterns (newer negates older)
 * 2. Replacement patterns (newer replaces older approach)
 * 3. Status change patterns (newer marks something as inactive)
 *
 * This is DETECTION ONLY -- no data is modified.
 *
 * @param db - better-sqlite3 Database handle
 * @param entityId - Graph node ID to check observations for
 * @returns Array of StalenessReport for each detected contradiction
 */
export function detectStaleness(
  db: BetterSqlite3.Database,
  entityId: string,
): StalenessReport[] {
  // Get entity info
  const node = db
    .prepare('SELECT id, name, type, observation_ids FROM graph_nodes WHERE id = ?')
    .get(entityId) as
    | { id: string; name: string; type: string; observation_ids: string }
    | undefined;

  if (!node) return [];

  const obsIds = JSON.parse(node.observation_ids) as string[];
  if (obsIds.length < 2) return [];

  // Fetch observations and sort by created_at
  const placeholders = obsIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at ASC`,
    )
    .all(...obsIds) as ObservationRow[];

  const observations = rows.map(rowToObservation);
  if (observations.length < 2) return [];

  const reports: StalenessReport[] = [];
  const now = new Date().toISOString();

  // Compare consecutive pairs
  for (let i = 0; i < observations.length - 1; i++) {
    const older = observations[i];
    const newer = observations[i + 1];

    const reason = detectContradiction(older.content, newer.content);
    if (reason) {
      reports.push({
        entityId: node.id,
        entityName: node.name,
        entityType: node.type as EntityType,
        newerObservation: {
          id: newer.id,
          text: newer.content,
          created_at: newer.createdAt,
        },
        olderObservation: {
          id: older.id,
          text: older.content,
          created_at: older.createdAt,
        },
        reason,
        detectedAt: now,
      });
    }
  }

  return reports;
}

/**
 * Detects contradiction between two observation texts.
 * Returns a human-readable reason string, or null if no contradiction found.
 */
function detectContradiction(
  olderText: string,
  newerText: string,
): string | null {
  const olderLower = olderText.toLowerCase();
  const newerLower = newerText.toLowerCase();

  // Check negation patterns
  const negationResult = detectNegation(olderLower, newerLower);
  if (negationResult) return negationResult;

  // Check replacement patterns
  const replacementResult = detectReplacement(newerLower);
  if (replacementResult) return replacementResult;

  // Check status change patterns
  const statusResult = detectStatusChange(olderLower, newerLower);
  if (statusResult) return statusResult;

  return null;
}

/**
 * Detects negation: newer text contains negation keywords that are absent
 * in the older text, suggesting the newer observation contradicts the older.
 */
function detectNegation(
  olderLower: string,
  newerLower: string,
): string | null {
  for (const keyword of NEGATION_KEYWORDS) {
    if (newerLower.includes(keyword) && !olderLower.includes(keyword)) {
      return `Newer observation contains negation ("${keyword}") not present in older observation`;
    }
  }
  return null;
}

/**
 * Detects replacement: newer text explicitly mentions switching/replacing.
 */
function detectReplacement(newerLower: string): string | null {
  for (const pattern of REPLACEMENT_PATTERNS) {
    const match = newerLower.match(pattern);
    if (match) {
      return `Newer observation indicates replacement ("${match[0].trim()}")`;
    }
  }
  return null;
}

/**
 * Detects status change: newer text marks something as removed/deprecated
 * when the older text described it as active/present.
 */
function detectStatusChange(
  olderLower: string,
  newerLower: string,
): string | null {
  for (const keyword of STATUS_CHANGE_KEYWORDS) {
    if (newerLower.includes(keyword) && !olderLower.includes(keyword)) {
      return `Newer observation indicates status change ("${keyword}")`;
    }
  }
  return null;
}

// =============================================================================
// Flagging
// =============================================================================

/**
 * Flags an observation as stale with an advisory reason.
 *
 * This flag is advisory -- search can use it to deprioritize but never hide
 * the observation. The observation remains fully queryable.
 *
 * Uses INSERT OR REPLACE to allow re-flagging with an updated reason.
 *
 * @param db - better-sqlite3 Database handle
 * @param observationId - ID of the observation to flag
 * @param reason - Human-readable explanation of why it's stale
 */
export function flagStaleObservation(
  db: BetterSqlite3.Database,
  observationId: string,
  reason: string,
): void {
  initStalenessSchema(db);

  db.prepare(
    `INSERT OR REPLACE INTO staleness_flags (observation_id, reason, resolved)
     VALUES (?, ?, 0)`,
  ).run(observationId, reason);
}

// =============================================================================
// Querying Flagged Observations
// =============================================================================

/**
 * Retrieves observations that have been flagged as stale.
 *
 * Optionally filtered by entity (via graph_nodes.observation_ids) or
 * resolution status.
 *
 * @param db - better-sqlite3 Database handle
 * @param opts - Filter options: entityId, resolved status
 * @returns Array of observation + staleness report pairs
 */
export function getStaleObservations(
  db: BetterSqlite3.Database,
  opts?: { entityId?: string; resolved?: boolean },
): Array<{ observation: Observation; flag: StalenessFlag }> {
  initStalenessSchema(db);

  // Get candidate observation IDs (optionally scoped to entity)
  let candidateIds: string[] | null = null;
  if (opts?.entityId) {
    const node = db
      .prepare('SELECT observation_ids FROM graph_nodes WHERE id = ?')
      .get(opts.entityId) as { observation_ids: string } | undefined;

    if (!node) return [];
    candidateIds = JSON.parse(node.observation_ids) as string[];
    if (candidateIds.length === 0) return [];
  }

  // Build query
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (candidateIds) {
    const placeholders = candidateIds.map(() => '?').join(', ');
    conditions.push(`sf.observation_id IN (${placeholders})`);
    params.push(...candidateIds);
  }

  if (opts?.resolved !== undefined) {
    conditions.push('sf.resolved = ?');
    params.push(opts.resolved ? 1 : 0);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT o.*, sf.observation_id AS sf_observation_id, sf.flagged_at AS sf_flagged_at,
           sf.reason AS sf_reason, sf.resolved AS sf_resolved
    FROM staleness_flags sf
    JOIN observations o ON o.id = sf.observation_id
    ${whereClause}
    ORDER BY sf.flagged_at DESC
  `;

  interface StaleRow extends ObservationRow {
    sf_observation_id: string;
    sf_flagged_at: string;
    sf_reason: string;
    sf_resolved: number;
  }

  const rows = db.prepare(sql).all(...params) as StaleRow[];

  return rows.map((row) => ({
    observation: rowToObservation(row),
    flag: {
      observation_id: row.sf_observation_id,
      flagged_at: row.sf_flagged_at,
      reason: row.sf_reason,
      resolved: row.sf_resolved === 1,
    },
  }));
}
