/**
 * Observation merging for knowledge graph curation.
 *
 * Detects near-duplicate observations linked to the same entity using:
 *   - Cosine similarity on embeddings (threshold 0.95)
 *   - Jaccard similarity on tokenized words (threshold 0.85) as fallback
 *
 * Merging creates consolidated summaries, preserves audit trails via
 * soft-deletion, and computes mean embeddings for consolidated observations.
 *
 * Low-value pruning removes very short, unlinked, old, auto-captured
 * observations using conservative AND-logic (all criteria must match).
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import { jaccardSimilarity } from '../shared/similarity.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A cluster of observations that are similar enough to merge.
 */
export interface MergeCluster {
  entityId: string;
  observations: Array<{
    id: string;
    text: string;
    embedding: number[] | null;
    created_at: string;
  }>;
  similarity: number;
  suggestedSummary: string;
}

interface ObsRow {
  id: string;
  content: string;
  embedding: Buffer | null;
  created_at: string;
  source: string;
  deleted_at: string | null;
}

interface NodeRow {
  id: string;
  observation_ids: string;
}

// =============================================================================
// Similarity Functions
// =============================================================================

/**
 * Computes cosine similarity between two number arrays.
 * Returns 0 for zero-length or zero-norm vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// jaccardSimilarity imported from ../shared/similarity.js

/**
 * Converts a Buffer of Float32 values to a number array.
 */
function bufferToNumbers(buf: Buffer): number[] {
  const floats = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  return Array.from(floats);
}

// =============================================================================
// Clustering
// =============================================================================

/**
 * Generates a consolidated summary from a cluster of observations.
 *
 * Strategy:
 *   1. Take the longest observation as the base
 *   2. Find unique keywords in shorter observations
 *   3. Append unique info in parentheses
 *   4. Prepend "[Consolidated from N observations]"
 */
function generateSummary(
  observations: Array<{ text: string }>,
): string {
  if (observations.length === 0) return '';
  if (observations.length === 1) return observations[0].text;

  // Find longest observation as base
  const sorted = [...observations].sort(
    (a, b) => b.text.length - a.text.length,
  );
  const base = sorted[0];
  const baseWords = new Set(
    base.text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  // Collect unique keywords from shorter observations
  const uniqueKeywords: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const words = sorted[i].text
      .split(/\s+/)
      .filter((w) => w.length > 2);
    for (const word of words) {
      if (
        !baseWords.has(word.toLowerCase()) &&
        !uniqueKeywords.includes(word.toLowerCase())
      ) {
        uniqueKeywords.push(word.toLowerCase());
      }
    }
  }

  let summary = base.text;
  if (uniqueKeywords.length > 0) {
    const extras = uniqueKeywords.slice(0, 10).join(', ');
    summary += ` (also: ${extras})`;
  }

  return `[Consolidated from ${observations.length} observations] ${summary}`;
}

/**
 * Finds clusters of similar observations for the same entity.
 *
 * For each entity with 3+ observations:
 *   1. Compute pairwise similarities (cosine on embeddings, Jaccard on text)
 *   2. Cluster observations where ALL pairwise similarities exceed threshold
 *   3. Generate suggested summaries for each cluster
 *
 * Only clusters with 2+ observations are returned, sorted by size DESC.
 *
 * @param db - better-sqlite3 Database handle
 * @param opts - threshold (default 0.95 cosine / 0.85 Jaccard), entityId filter
 * @returns Mergeable observation clusters sorted by size descending
 */
export function findMergeableClusters(
  db: BetterSqlite3.Database,
  opts?: { threshold?: number; entityId?: string },
): MergeCluster[] {
  const embeddingThreshold = opts?.threshold ?? 0.95;
  const textThreshold = 0.85;

  // Get entity nodes with 3+ observations
  let nodes: NodeRow[];
  if (opts?.entityId) {
    const row = db
      .prepare('SELECT id, observation_ids FROM graph_nodes WHERE id = ?')
      .get(opts.entityId) as NodeRow | undefined;
    nodes = row ? [row] : [];
  } else {
    nodes = db
      .prepare('SELECT id, observation_ids FROM graph_nodes')
      .all() as NodeRow[];
  }

  const clusters: MergeCluster[] = [];

  for (const node of nodes) {
    const obsIds = JSON.parse(node.observation_ids) as string[];
    if (obsIds.length < 3) continue;

    // Fetch observations (only non-deleted, non-merged)
    const placeholders = obsIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id, content, embedding, created_at, source, deleted_at
         FROM observations
         WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      )
      .all(...obsIds) as ObsRow[];

    if (rows.length < 2) continue;

    // Build observation objects with parsed embeddings
    const observations = rows.map((r) => ({
      id: r.id,
      text: r.content,
      embedding: r.embedding ? bufferToNumbers(r.embedding) : null,
      created_at: r.created_at,
    }));

    // Find clusters using greedy algorithm
    const used = new Set<string>();

    for (let i = 0; i < observations.length; i++) {
      if (used.has(observations[i].id)) continue;

      const cluster = [observations[i]];
      let totalSim = 0;
      let pairCount = 0;

      for (let j = i + 1; j < observations.length; j++) {
        if (used.has(observations[j].id)) continue;

        // Check if candidate is similar to ALL members of the current cluster
        let allSimilar = true;
        let candidateSim = 0;
        let candidatePairs = 0;

        for (const member of cluster) {
          const sim = computeSimilarity(
            member,
            observations[j],
            embeddingThreshold,
            textThreshold,
          );

          if (sim === null) {
            allSimilar = false;
            break;
          }

          candidateSim += sim;
          candidatePairs++;
        }

        if (allSimilar && candidatePairs > 0) {
          cluster.push(observations[j]);
          totalSim += candidateSim;
          pairCount += candidatePairs;
        }
      }

      if (cluster.length >= 2) {
        // Mark all observations in this cluster as used
        for (const obs of cluster) {
          used.add(obs.id);
        }

        const avgSim = pairCount > 0 ? totalSim / pairCount : 0;

        clusters.push({
          entityId: node.id,
          observations: cluster,
          similarity: avgSim,
          suggestedSummary: generateSummary(cluster),
        });
      }
    }
  }

  // Sort by cluster size DESC (largest first)
  clusters.sort((a, b) => b.observations.length - a.observations.length);

  return clusters;
}

/**
 * Computes similarity between two observations.
 * Returns the similarity score if it exceeds the threshold, or null if not.
 */
function computeSimilarity(
  a: { text: string; embedding: number[] | null },
  b: { text: string; embedding: number[] | null },
  embeddingThreshold: number,
  textThreshold: number,
): number | null {
  // Prefer cosine similarity on embeddings
  if (a.embedding && b.embedding) {
    const sim = cosineSimilarity(a.embedding, b.embedding);
    return sim >= embeddingThreshold ? sim : null;
  }

  // Fallback to Jaccard similarity on text
  const sim = jaccardSimilarity(a.text, b.text);
  return sim >= textThreshold ? sim : null;
}

// =============================================================================
// Merging
// =============================================================================

/**
 * Merges a cluster of similar observations into a consolidated observation.
 *
 * Steps:
 *   1. Create new consolidated observation with suggestedSummary text
 *   2. Store merge metadata (merged_from, merged_at, original_count)
 *   3. Update entity's observation_ids: remove old, add new merged ID
 *   4. Soft-delete originals (set deleted_at, do NOT hard delete)
 *   5. Compute mean embedding if originals have embeddings
 *
 * Runs in a transaction for atomicity.
 *
 * @param db - better-sqlite3 Database handle
 * @param cluster - The cluster to merge
 * @returns The new merged observation ID and removed IDs
 */
export function mergeObservationCluster(
  db: BetterSqlite3.Database,
  cluster: MergeCluster,
): { mergedId: string; removedIds: string[] } {
  const merge = db.transaction(() => {
    const mergedId = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    const removedIds = cluster.observations.map((o) => o.id);

    // Step 1 & 2: Create consolidated observation with merge metadata
    const metadata = JSON.stringify({
      merged_from: removedIds,
      merged_at: now,
      original_count: cluster.observations.length,
    });

    // Compute mean embedding if available
    let meanEmbedding: Buffer | null = null;
    const embeddingsWithValues = cluster.observations.filter(
      (o) => o.embedding !== null,
    );

    if (embeddingsWithValues.length > 0) {
      const dim = embeddingsWithValues[0].embedding!.length;
      const mean = new Float32Array(dim);

      for (const obs of embeddingsWithValues) {
        const emb = obs.embedding!;
        for (let i = 0; i < dim; i++) {
          mean[i] += emb[i];
        }
      }

      for (let i = 0; i < dim; i++) {
        mean[i] /= embeddingsWithValues.length;
      }

      meanEmbedding = Buffer.from(mean.buffer);
    }

    // Get project_hash from the first original observation
    const firstObs = db
      .prepare('SELECT project_hash, source FROM observations WHERE id = ?')
      .get(cluster.observations[0].id) as
      | { project_hash: string; source: string }
      | undefined;

    const projectHash = firstObs?.project_hash ?? 'unknown';

    db.prepare(
      `INSERT INTO observations (id, project_hash, content, title, source, session_id, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mergedId,
      projectHash,
      cluster.suggestedSummary,
      `[Merged] ${metadata}`,
      'curation:merge',
      null,
      meanEmbedding,
      now,
      now,
    );

    // Step 3: Update entity's observation_ids
    const nodeRow = db
      .prepare('SELECT observation_ids FROM graph_nodes WHERE id = ?')
      .get(cluster.entityId) as { observation_ids: string } | undefined;

    if (nodeRow) {
      const currentIds = JSON.parse(nodeRow.observation_ids) as string[];
      const removedSet = new Set(removedIds);
      const updatedIds = currentIds.filter((id) => !removedSet.has(id));
      updatedIds.push(mergedId);

      db.prepare(
        `UPDATE graph_nodes SET observation_ids = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(JSON.stringify(updatedIds), cluster.entityId);
    }

    // Step 4: Soft-delete original observations
    const softDeleteStmt = db.prepare(
      `UPDATE observations SET deleted_at = ? WHERE id = ?`,
    );
    for (const obsId of removedIds) {
      softDeleteStmt.run(now, obsId);
    }

    return { mergedId, removedIds };
  });

  return merge();
}

// =============================================================================
// Low-Value Pruning
// =============================================================================

/**
 * Prunes low-value observations using conservative AND-logic.
 *
 * An observation is pruned ONLY if ALL of:
 *   a. Very short (< minTextLength characters, default 20)
 *   b. No linked entities (not in any graph_node's observation_ids)
 *   c. Older than maxAge days (default 90)
 *   d. Auto-captured (source is NOT 'mcp:save_memory' or 'slash:remember')
 *   e. Not already deleted
 *
 * Pruning is soft-delete only -- sets deleted_at, never hard deletes.
 *
 * @param db - better-sqlite3 Database handle
 * @param opts - Configurable thresholds
 * @returns Count of pruned observations
 */
export function pruneLowValue(
  db: BetterSqlite3.Database,
  opts?: { minTextLength?: number; maxAge?: number },
): { pruned: number } {
  const minTextLength = opts?.minTextLength ?? 20;
  const maxAgeDays = opts?.maxAge ?? 90;

  const now = new Date();
  const cutoffDate = new Date(
    now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
  );
  const cutoffISO = cutoffDate.toISOString();

  // Find candidate observations: short, old, auto-captured, not deleted
  const candidates = db
    .prepare(
      `SELECT id, content, source, created_at
       FROM observations
       WHERE deleted_at IS NULL
         AND LENGTH(content) < ?
         AND created_at < ?
         AND source NOT IN ('mcp:save_memory', 'slash:remember')`,
    )
    .all(minTextLength, cutoffISO) as Array<{
    id: string;
    content: string;
    source: string;
    created_at: string;
  }>;

  if (candidates.length === 0) return { pruned: 0 };

  // Check which candidates have NO linked entities
  // Build a set of all observation IDs referenced by any graph node
  const allNodeObsIds = new Set<string>();
  const nodes = db
    .prepare('SELECT observation_ids FROM graph_nodes')
    .all() as Array<{ observation_ids: string }>;

  for (const node of nodes) {
    const ids = JSON.parse(node.observation_ids) as string[];
    for (const id of ids) {
      allNodeObsIds.add(id);
    }
  }

  // Filter: only prune candidates that are NOT linked to any entity
  const toPrune = candidates.filter((c) => !allNodeObsIds.has(c.id));

  if (toPrune.length === 0) return { pruned: 0 };

  // Soft-delete
  const nowISO = now.toISOString();
  const softDeleteStmt = db.prepare(
    'UPDATE observations SET deleted_at = ? WHERE id = ?',
  );

  const prune = db.transaction(() => {
    for (const obs of toPrune) {
      softDeleteStmt.run(nowISO, obs.id);
    }
    return toPrune.length;
  });

  const pruned = prune();

  return { pruned };
}
