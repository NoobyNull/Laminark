/**
 * Database hygiene analyzer.
 *
 * Scores observations on multiple deletion signals and produces a
 * simulation report of candidates for cleanup. No side effects in
 * analyze mode — purging is handled by the MCP tool layer.
 */

import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import { initStalenessSchema } from './staleness.js';

// =============================================================================
// Types
// =============================================================================

export interface HygieneCandidate {
  id: string;
  shortId: string;
  sessionId: string | null;
  kind: string;
  source: string;
  contentPreview: string;
  createdAt: string;
  signals: {
    orphaned: boolean;
    islandNode: boolean;
    noiseClassified: boolean;
    shortContent: boolean;
    autoCaptured: boolean;
    stale: boolean;
  };
  confidence: number;
  tier: 'high' | 'medium' | 'low';
}

export interface OrphanNode {
  id: string;
  type: string;
  name: string;
  reason: string;
}

export interface HygieneReport {
  analyzedAt: string;
  totalObservations: number;
  candidates: HygieneCandidate[];
  orphanNodes: OrphanNode[];
  summary: {
    high: number;
    medium: number;
    low: number;
    orphanNodeCount: number;
  };
}

// =============================================================================
// Signal Weights
// =============================================================================

const WEIGHTS = {
  orphaned: 0.30,
  islandNode: 0.15,
  noiseClassified: 0.25,
  shortContent: 0.10,
  autoCaptured: 0.10,
  stale: 0.10,
} as const;

const SHORT_CONTENT_THRESHOLD = 50;

// =============================================================================
// Internal Row Types
// =============================================================================

interface ObsRow {
  id: string;
  content: string;
  title: string | null;
  source: string;
  kind: string;
  session_id: string | null;
  classification: string | null;
  created_at: string;
}

interface GraphNodeRow {
  id: string;
  type: string;
  name: string;
  observation_ids: string; // JSON array
}

// =============================================================================
// Analysis
// =============================================================================

export interface AnalyzeOptions {
  sessionId?: string;
  limit?: number;
  minTier?: 'high' | 'medium' | 'low';
}

/**
 * Analyzes all active observations and scores each on deletion signals.
 * Pure read-only — no data is modified.
 */
export function analyzeObservations(
  db: BetterSqlite3.Database,
  projectHash: string,
  opts?: AnalyzeOptions,
): HygieneReport {
  const limit = opts?.limit ?? 50;
  const minTier = opts?.minTier ?? 'medium';

  debug('hygiene', 'Starting analysis', { projectHash, sessionId: opts?.sessionId });

  // 1. Fetch all active observations for this project
  let obsSql = `
    SELECT id, content, title, source, kind, session_id, classification, created_at
    FROM observations
    WHERE project_hash = ? AND deleted_at IS NULL
  `;
  const obsParams: unknown[] = [projectHash];

  if (opts?.sessionId) {
    obsSql += ' AND session_id = ?';
    obsParams.push(opts.sessionId);
  }

  obsSql += ' ORDER BY created_at DESC';
  const observations = db.prepare(obsSql).all(...obsParams) as ObsRow[];

  // 2. Build lookup sets for signal detection

  // Set of observation IDs linked to at least one graph node
  const linkedObsIds = new Set<string>();
  // Set of observation IDs linked to island nodes (nodes with zero edges)
  const islandObsIds = new Set<string>();

  const allNodes = db.prepare(
    'SELECT id, type, name, observation_ids FROM graph_nodes',
  ).all() as GraphNodeRow[];

  // Precompute edge counts per node
  const edgeCounts = new Map<string, number>();
  const edgeRows = db.prepare(
    `SELECT source_id AS nid, COUNT(*) AS cnt FROM graph_edges GROUP BY source_id
     UNION ALL
     SELECT target_id AS nid, COUNT(*) AS cnt FROM graph_edges GROUP BY target_id`,
  ).all() as { nid: string; cnt: number }[];
  for (const row of edgeRows) {
    edgeCounts.set(row.nid, (edgeCounts.get(row.nid) ?? 0) + row.cnt);
  }

  for (const node of allNodes) {
    let obsIds: string[];
    try {
      obsIds = JSON.parse(node.observation_ids) as string[];
    } catch {
      continue;
    }

    const degree = edgeCounts.get(node.id) ?? 0;

    for (const oid of obsIds) {
      linkedObsIds.add(oid);
      if (degree === 0) {
        islandObsIds.add(oid);
      }
    }
  }

  // Staleness flags set
  const staleIds = new Set<string>();
  try {
    initStalenessSchema(db);
    const staleRows = db.prepare(
      'SELECT observation_id FROM staleness_flags WHERE resolved = 0',
    ).all() as { observation_id: string }[];
    for (const row of staleRows) {
      staleIds.add(row.observation_id);
    }
  } catch {
    // staleness_flags may not exist
  }

  // 3. Score each observation
  const allCandidates: HygieneCandidate[] = [];

  for (const obs of observations) {
    const signals = {
      orphaned: !linkedObsIds.has(obs.id),
      islandNode: islandObsIds.has(obs.id),
      noiseClassified: obs.classification === 'noise',
      shortContent: obs.content.length < SHORT_CONTENT_THRESHOLD,
      autoCaptured: obs.source.startsWith('hook:'),
      stale: staleIds.has(obs.id),
    };

    const confidence =
      (signals.orphaned ? WEIGHTS.orphaned : 0) +
      (signals.islandNode ? WEIGHTS.islandNode : 0) +
      (signals.noiseClassified ? WEIGHTS.noiseClassified : 0) +
      (signals.shortContent ? WEIGHTS.shortContent : 0) +
      (signals.autoCaptured ? WEIGHTS.autoCaptured : 0) +
      (signals.stale ? WEIGHTS.stale : 0);

    const tier: 'high' | 'medium' | 'low' =
      confidence >= 0.7 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';

    // Filter by minimum tier
    if (minTier === 'high' && tier !== 'high') continue;
    if (minTier === 'medium' && tier === 'low') continue;

    const preview = obs.content.length > 80
      ? obs.content.substring(0, 80) + '...'
      : obs.content;

    allCandidates.push({
      id: obs.id,
      shortId: obs.id.substring(0, 8),
      sessionId: obs.session_id,
      kind: obs.kind,
      source: obs.source,
      contentPreview: preview,
      createdAt: obs.created_at,
      signals,
      confidence: Math.round(confidence * 100) / 100,
      tier,
    });
  }

  // Sort by confidence descending
  allCandidates.sort((a, b) => b.confidence - a.confidence);

  // 4. Find orphan graph nodes (zero edges AND all observation refs dead/missing)
  const activeObsIds = new Set(observations.map(o => o.id));
  const orphanNodes: OrphanNode[] = [];

  for (const node of allNodes) {
    const degree = edgeCounts.get(node.id) ?? 0;
    if (degree > 0) continue;

    let obsIds: string[];
    try {
      obsIds = JSON.parse(node.observation_ids) as string[];
    } catch {
      continue;
    }

    // Check if all observation refs are dead (deleted or missing)
    const allDead = obsIds.length === 0 || obsIds.every(oid => !activeObsIds.has(oid));
    if (allDead) {
      orphanNodes.push({
        id: node.id,
        type: node.type,
        name: node.name,
        reason: 'zero edges, dead observation refs',
      });
    }
  }

  // 5. Build summary
  const limited = allCandidates.slice(0, limit);
  const highCount = allCandidates.filter(c => c.tier === 'high').length;
  const mediumCount = allCandidates.filter(c => c.tier === 'medium').length;
  const lowCount = allCandidates.filter(c => c.tier === 'low').length;

  debug('hygiene', 'Analysis complete', {
    total: observations.length,
    high: highCount,
    medium: mediumCount,
    orphanNodes: orphanNodes.length,
  });

  return {
    analyzedAt: new Date().toISOString(),
    totalObservations: observations.length,
    candidates: limited,
    orphanNodes: orphanNodes.slice(0, limit),
    summary: {
      high: highCount,
      medium: mediumCount,
      low: lowCount,
      orphanNodeCount: orphanNodes.length,
    },
  };
}

// =============================================================================
// Purge Execution
// =============================================================================

export interface PurgeResult {
  observationsPurged: number;
  orphanNodesRemoved: number;
}

/**
 * Soft-deletes observations matching the given tier threshold and removes
 * dead orphan graph nodes. Returns counts of affected records.
 */
export function executePurge(
  db: BetterSqlite3.Database,
  projectHash: string,
  report: HygieneReport,
  tier: 'high' | 'medium' | 'all',
): PurgeResult {
  const candidateIds = report.candidates
    .filter(c => {
      if (tier === 'high') return c.tier === 'high';
      if (tier === 'medium') return c.tier === 'high' || c.tier === 'medium';
      return true; // 'all'
    })
    .map(c => c.id);

  debug('hygiene', 'Executing purge', { tier, candidates: candidateIds.length });

  let observationsPurged = 0;

  // Soft-delete observations in batches
  const softDeleteStmt = db.prepare(`
    UPDATE observations
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
  `);

  const purgeTransaction = db.transaction(() => {
    for (const id of candidateIds) {
      const result = softDeleteStmt.run(id, projectHash);
      observationsPurged += result.changes;
    }

    // Remove dead orphan graph nodes
    let orphanNodesRemoved = 0;
    const deleteNodeStmt = db.prepare('DELETE FROM graph_nodes WHERE id = ?');
    for (const node of report.orphanNodes) {
      const result = deleteNodeStmt.run(node.id);
      orphanNodesRemoved += result.changes;
    }

    return { observationsPurged, orphanNodesRemoved };
  });

  return purgeTransaction();
}
