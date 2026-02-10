/**
 * Hybrid search combining FTS5 keyword results and vec0 vector results
 * using reciprocal rank fusion (RRF).
 *
 * When both keyword and vector results are available, RRF merges the two
 * ranked lists into a single score-sorted list. When only keyword results
 * are available (worker not ready, no embeddings), falls back transparently.
 */

import { debug, debugTimed } from '../shared/debug.js';
import type { SearchResult } from '../shared/types.js';
import type { SearchEngine } from '../storage/search.js';
import type { EmbeddingStore, EmbeddingSearchResult } from '../storage/embeddings.js';
import type { AnalysisWorker } from '../analysis/worker-bridge.js';
import { ObservationRepository } from '../storage/observations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RankedItem {
  id: string;
  [key: string]: unknown;
}

interface FusedResult {
  id: string;
  fusedScore: number;
}

export interface HybridSearchParams {
  searchEngine: SearchEngine;
  embeddingStore: EmbeddingStore;
  worker: AnalysisWorker | null;
  query: string;
  db: import('better-sqlite3').Database;
  projectHash: string;
  options?: { limit?: number; sessionId?: string };
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * Merges multiple ranked lists into a single fused ranking using RRF.
 *
 * For each document across all lists, computes:
 *   fusedScore = sum(1 / (k + rank + 1))
 * where rank is the 0-based position in each list.
 *
 * @param rankedLists - Arrays of ranked items, each with an `id` field
 * @param k - Smoothing constant (default 60, standard RRF value)
 * @returns Fused results sorted by fusedScore descending
 */
export function reciprocalRankFusion(
  rankedLists: Array<Array<RankedItem>>,
  k = 60,
): FusedResult[] {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const current = scores.get(item.id) ?? 0;
      scores.set(item.id, current + 1 / (k + rank + 1));
    }
  }

  const results: FusedResult[] = [];
  for (const [id, fusedScore] of scores) {
    results.push({ id, fusedScore });
  }

  results.sort((a, b) => b.fusedScore - a.fusedScore);
  return results;
}

// ---------------------------------------------------------------------------
// Hybrid Search
// ---------------------------------------------------------------------------

/**
 * Combines FTS5 keyword search and vec0 vector search using RRF.
 *
 * Falls back to keyword-only when:
 * - Worker is null or not ready
 * - Query embedding fails
 * - No vector results returned
 *
 * @returns SearchResult[] with matchType indicating source(s)
 */
export async function hybridSearch(
  params: HybridSearchParams,
): Promise<SearchResult[]> {
  const { searchEngine, embeddingStore, worker, query, db, projectHash, options } = params;
  const limit = options?.limit ?? 20;

  return debugTimed('search', 'Hybrid search', async () => {
    // Step 1: Always run keyword search
    const keywordResults = searchEngine.searchKeyword(query, {
      limit,
      sessionId: options?.sessionId,
    });

    debug('search', 'Keyword results', { count: keywordResults.length });

    // Step 2: Attempt vector search if worker is available
    let vectorResults: EmbeddingSearchResult[] = [];

    if (worker && worker.isReady()) {
      const queryEmbedding = await worker.embed(query);

      if (queryEmbedding) {
        // Fetch more vector results than limit to improve fusion quality
        vectorResults = embeddingStore.search(queryEmbedding, limit * 2);
        debug('search', 'Vector results', { count: vectorResults.length });
      } else {
        debug('search', 'Query embedding failed, keyword-only');
      }
    } else {
      debug('search', 'Worker not ready, keyword-only');
    }

    // Step 3: Keyword-only fallback
    if (vectorResults.length === 0) {
      debug('search', 'Returning keyword-only results', { count: keywordResults.length });
      return keywordResults;
    }

    // Step 4: Fuse keyword + vector results with RRF
    const keywordRanked: RankedItem[] = keywordResults.map((r) => ({
      id: r.observation.id,
    }));

    const vectorRanked: RankedItem[] = vectorResults.map((r) => ({
      id: r.observationId,
    }));

    const fused = reciprocalRankFusion([keywordRanked, vectorRanked]);

    // Build lookup maps
    const keywordMap = new Map<string, SearchResult>();
    for (const r of keywordResults) {
      keywordMap.set(r.observation.id, r);
    }

    const vectorIdSet = new Set(vectorResults.map((r) => r.observationId));

    // We need an ObservationRepository to look up vector-only observations
    const obsRepo = new ObservationRepository(db, projectHash);

    // Merge results
    const merged: SearchResult[] = [];

    for (const item of fused) {
      if (merged.length >= limit) break;

      const fromKeyword = keywordMap.get(item.id);
      const fromVector = vectorIdSet.has(item.id);

      if (fromKeyword && fromVector) {
        // In both: hybrid match, use keyword snippet
        merged.push({
          observation: fromKeyword.observation,
          score: item.fusedScore,
          matchType: 'hybrid',
          snippet: fromKeyword.snippet,
        });
      } else if (fromKeyword) {
        // Keyword only
        merged.push({
          observation: fromKeyword.observation,
          score: item.fusedScore,
          matchType: 'fts',
          snippet: fromKeyword.snippet,
        });
      } else if (fromVector) {
        // Vector only -- need to load observation
        const obs = obsRepo.getById(item.id);
        if (obs) {
          const snippet = (obs.content ?? '').replace(/\n/g, ' ').slice(0, 100);
          merged.push({
            observation: obs,
            score: item.fusedScore,
            matchType: 'vector',
            snippet,
          });
        }
      }
    }

    debug('search', 'Hybrid search complete', {
      keyword: keywordResults.length,
      vector: vectorResults.length,
      fused: merged.length,
      hybrid: merged.filter((r) => r.matchType === 'hybrid').length,
    });

    return merged;
  });
}
