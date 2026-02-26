/**
 * Database hygiene analyzer.
 *
 * Scores observations on multiple deletion signals and produces a
 * simulation report of candidates for cleanup. No side effects in
 * analyze mode — purging is handled by the MCP tool layer.
 */

import type BetterSqlite3 from 'better-sqlite3';

import type { HygieneConfig, AutoCleanupConfig } from '../config/hygiene-config.js';
import { loadHygieneConfig } from '../config/hygiene-config.js';
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

export interface FindAnalysisReport {
  total: number;
  bySignal: {
    orphaned: number;
    islandNode: number;
    noiseClassified: number;
    shortContent: number;
    autoCaptured: number;
    stale: number;
  };
  distribution: { range: string; count: number }[];
  islandNodes: {
    total: number;
    minConfidence: number;
    maxConfidence: number;
    medianConfidence: number;
    capturedAtCurrentThresholds: { high: number; medium: number; all: number };
  };
}

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
// Shared: build signal lookups
// =============================================================================

interface SignalLookups {
  linkedObsIds: Set<string>;
  islandObsIds: Set<string>;
  staleIds: Set<string>;
  allNodes: GraphNodeRow[];
  edgeCounts: Map<string, number>;
}

function buildSignalLookups(db: BetterSqlite3.Database, projectHash: string | null): SignalLookups {
  const linkedObsIds = new Set<string>();
  const islandObsIds = new Set<string>();

  const allNodes = projectHash
    ? db.prepare(
        'SELECT id, type, name, observation_ids FROM graph_nodes WHERE project_hash = ?',
      ).all(projectHash) as GraphNodeRow[]
    : db.prepare(
        'SELECT id, type, name, observation_ids FROM graph_nodes',
      ).all() as GraphNodeRow[];

  const edgeCounts = new Map<string, number>();
  const edgeRows = projectHash
    ? db.prepare(
        `SELECT source_id AS nid, COUNT(*) AS cnt FROM graph_edges WHERE project_hash = ? GROUP BY source_id
         UNION ALL
         SELECT target_id AS nid, COUNT(*) AS cnt FROM graph_edges WHERE project_hash = ? GROUP BY target_id`,
      ).all(projectHash, projectHash) as { nid: string; cnt: number }[]
    : db.prepare(
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

  return { linkedObsIds, islandObsIds, staleIds, allNodes, edgeCounts };
}

function scoreObservation(
  obs: ObsRow,
  lookups: SignalLookups,
  config: HygieneConfig,
): { signals: HygieneCandidate['signals']; confidence: number; tier: 'high' | 'medium' | 'low' } {
  const weights = config.signalWeights;
  const thresholds = config.tierThresholds;

  const signals = {
    orphaned: !lookups.linkedObsIds.has(obs.id),
    islandNode: lookups.islandObsIds.has(obs.id),
    noiseClassified: obs.classification === 'noise',
    shortContent: obs.content.length < config.shortContentThreshold,
    autoCaptured: obs.source.startsWith('hook:'),
    stale: lookups.staleIds.has(obs.id),
  };

  const confidence =
    (signals.orphaned ? weights.orphaned : 0) +
    (signals.islandNode ? weights.islandNode : 0) +
    (signals.noiseClassified ? weights.noiseClassified : 0) +
    (signals.shortContent ? weights.shortContent : 0) +
    (signals.autoCaptured ? weights.autoCaptured : 0) +
    (signals.stale ? weights.stale : 0);

  const tier: 'high' | 'medium' | 'low' =
    confidence >= thresholds.high ? 'high' : confidence >= thresholds.medium ? 'medium' : 'low';

  return { signals, confidence: Math.round(confidence * 100) / 100, tier };
}

// =============================================================================
// Analysis
// =============================================================================

export interface AnalyzeOptions {
  sessionId?: string;
  limit?: number;
  minTier?: 'high' | 'medium' | 'low';
  config?: HygieneConfig;
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
  const config = opts?.config ?? loadHygieneConfig();

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
  const lookups = buildSignalLookups(db, projectHash);

  // 3. Score each observation
  const allCandidates: HygieneCandidate[] = [];

  for (const obs of observations) {
    const { signals, confidence, tier } = scoreObservation(obs, lookups, config);

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
      confidence,
      tier,
    });
  }

  // Sort by confidence descending
  allCandidates.sort((a, b) => b.confidence - a.confidence);

  // 4. Find orphan graph nodes (zero edges AND all observation refs dead/missing)
  const activeObsIds = new Set(observations.map(o => o.id));
  const orphanNodes: OrphanNode[] = [];

  for (const node of lookups.allNodes) {
    const degree = lookups.edgeCounts.get(node.id) ?? 0;
    if (degree > 0) continue;

    let obsIds: string[];
    try {
      obsIds = JSON.parse(node.observation_ids) as string[];
    } catch {
      continue;
    }

    // Zero-edge nodes are island nodes — they add no graph connectivity.
    // Flag them all as orphans regardless of whether observation refs are alive.
    const allDead = obsIds.length === 0 || obsIds.every(oid => !activeObsIds.has(oid));
    orphanNodes.push({
      id: node.id,
      type: node.type,
      name: node.name,
      reason: allDead ? 'zero edges, dead observation refs' : 'zero edges (island node)',
    });
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
// Find Analysis
// =============================================================================

/**
 * Produces a score distribution report across all observations.
 * Shows signal counts, confidence histogram, and island node summary
 * so users can tune thresholds to catch the right candidates.
 */
export function findAnalysis(
  db: BetterSqlite3.Database,
  projectHash: string,
  config?: HygieneConfig,
): FindAnalysisReport {
  const cfg = config ?? loadHygieneConfig();

  const observations = db.prepare(`
    SELECT id, content, title, source, kind, session_id, classification, created_at
    FROM observations
    WHERE project_hash = ? AND deleted_at IS NULL
    ORDER BY created_at DESC
  `).all(projectHash) as ObsRow[];

  const lookups = buildSignalLookups(db, projectHash);

  const bySignal = {
    orphaned: 0,
    islandNode: 0,
    noiseClassified: 0,
    shortContent: 0,
    autoCaptured: 0,
    stale: 0,
  };

  // 10 histogram buckets: 0.0-0.1, 0.1-0.2, ... 0.9-1.0
  const buckets = new Array(10).fill(0) as number[];

  // Track island-linked observation confidences
  const islandConfidences: number[] = [];

  for (const obs of observations) {
    const { signals, confidence } = scoreObservation(obs, lookups, cfg);

    if (signals.orphaned) bySignal.orphaned++;
    if (signals.islandNode) bySignal.islandNode++;
    if (signals.noiseClassified) bySignal.noiseClassified++;
    if (signals.shortContent) bySignal.shortContent++;
    if (signals.autoCaptured) bySignal.autoCaptured++;
    if (signals.stale) bySignal.stale++;

    const bucketIdx = Math.min(Math.floor(confidence * 10), 9);
    buckets[bucketIdx]++;

    if (signals.islandNode) {
      islandConfidences.push(confidence);
    }
  }

  const distribution = buckets.map((count, i) => ({
    range: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
    count,
  }));

  // Island node summary
  islandConfidences.sort((a, b) => a - b);
  const islandTotal = islandConfidences.length;
  const minConf = islandTotal > 0 ? islandConfidences[0] : 0;
  const maxConf = islandTotal > 0 ? islandConfidences[islandTotal - 1] : 0;
  const medianConf = islandTotal > 0
    ? islandConfidences[Math.floor(islandTotal / 2)]
    : 0;

  const capturedHigh = islandConfidences.filter(c => c >= cfg.tierThresholds.high).length;
  const capturedMedium = islandConfidences.filter(c => c >= cfg.tierThresholds.medium).length;

  return {
    total: observations.length,
    bySignal,
    distribution,
    islandNodes: {
      total: islandTotal,
      minConfidence: Math.round(minConf * 100) / 100,
      maxConfidence: Math.round(maxConf * 100) / 100,
      medianConfidence: Math.round(medianConf * 100) / 100,
      capturedAtCurrentThresholds: {
        high: capturedHigh,
        medium: capturedMedium,
        all: islandTotal,
      },
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
export interface AutoCleanupResult {
  skipped: boolean;
  reason?: string;
  observationsPurged: number;
  orphanNodesRemoved: number;
}

/**
 * Runs automatic hygiene cleanup at session end.
 *
 * Analyzes observations and purges candidates matching the configured tier.
 * Orphan graph node removal is capped by autoCleanup.maxOrphanNodes.
 * Safe to call on every session end — skips quickly if disabled.
 */
export function runAutoCleanup(
  db: BetterSqlite3.Database,
  projectHash: string,
  config?: HygieneConfig,
): AutoCleanupResult {
  const cfg = config ?? loadHygieneConfig();
  const auto = cfg.autoCleanup;

  if (!auto.enabled) {
    return { skipped: true, reason: 'disabled', observationsPurged: 0, orphanNodesRemoved: 0 };
  }

  debug('hygiene', 'Auto-cleanup starting', { tier: auto.tier, maxOrphanNodes: auto.maxOrphanNodes });

  const minTier = auto.tier === 'all' ? 'low' as const : auto.tier;
  const report = analyzeObservations(db, projectHash, {
    limit: 200,
    minTier,
    config: cfg,
  });

  // Cap orphan node removal
  if (report.orphanNodes.length > auto.maxOrphanNodes) {
    report.orphanNodes = report.orphanNodes.slice(0, auto.maxOrphanNodes);
  }

  const totalWork = report.candidates.length + report.orphanNodes.length;
  if (totalWork === 0) {
    debug('hygiene', 'Auto-cleanup: nothing to clean');
    return { skipped: false, observationsPurged: 0, orphanNodesRemoved: 0 };
  }

  const result = executePurge(db, projectHash, report, auto.tier);

  debug('hygiene', 'Auto-cleanup complete', {
    observationsPurged: result.observationsPurged,
    orphanNodesRemoved: result.orphanNodesRemoved,
  });

  return { skipped: false, ...result };
}

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
