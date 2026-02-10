/**
 * Pre-save gate for duplicate detection.
 *
 * Two operating modes:
 * - Fast (hook path): Jaccard text similarity against recent observations. <5ms.
 * - Full (MCP path): Embedding-based KNN via EmbeddingStore.search() + text fallback. <100ms.
 *
 * Prevents database bloat by rejecting near-duplicate observations
 * before they hit storage, across both the hook auto-capture and MCP save_memory paths.
 *
 * Relevance scoring is handled by the background ObservationClassifier (LLM-based).
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { AnalysisWorker } from '../analysis/worker-bridge.js';
import type { EmbeddingStore } from '../storage/embeddings.js';
import { ObservationRepository } from '../storage/observations.js';
import { jaccardSimilarity } from '../shared/similarity.js';
import { debug } from '../shared/debug.js';

export interface SaveDecision {
  save: boolean;
  reason?: string;
  duplicateOf?: string;
}

export interface SaveGuardOptions {
  worker?: AnalysisWorker | null;
  embeddingStore?: EmbeddingStore | null;
  duplicateThreshold?: number;
  vectorDistanceThreshold?: number;
  recentWindow?: number;
}

export class SaveGuard {
  private readonly obsRepo: ObservationRepository;
  private readonly worker: AnalysisWorker | null;
  private readonly embeddingStore: EmbeddingStore | null;
  private readonly duplicateThreshold: number;
  private readonly vectorDistanceThreshold: number;
  private readonly recentWindow: number;

  /**
   * Construct from db + projectHash (creates internal ObservationRepository),
   * or from an existing ObservationRepository.
   */
  constructor(
    dbOrRepo: BetterSqlite3.Database | ObservationRepository,
    projectHashOrOpts?: string | SaveGuardOptions,
    opts?: SaveGuardOptions,
  ) {
    if (dbOrRepo instanceof ObservationRepository) {
      this.obsRepo = dbOrRepo;
      const resolvedOpts = (projectHashOrOpts as SaveGuardOptions | undefined) ?? {};
      this.worker = resolvedOpts.worker ?? null;
      this.embeddingStore = resolvedOpts.embeddingStore ?? null;
      this.duplicateThreshold = resolvedOpts.duplicateThreshold ?? 0.85;
      this.vectorDistanceThreshold = resolvedOpts.vectorDistanceThreshold ?? 0.08;
      this.recentWindow = resolvedOpts.recentWindow ?? 20;
    } else {
      this.obsRepo = new ObservationRepository(dbOrRepo, projectHashOrOpts as string);
      this.worker = opts?.worker ?? null;
      this.embeddingStore = opts?.embeddingStore ?? null;
      this.duplicateThreshold = opts?.duplicateThreshold ?? 0.85;
      this.vectorDistanceThreshold = opts?.vectorDistanceThreshold ?? 0.08;
      this.recentWindow = opts?.recentWindow ?? 20;
    }
  }

  /**
   * Synchronous evaluation for the hook path (text-only, no embeddings).
   * Only checks for duplicates — relevance is handled by the background classifier.
   */
  evaluateSync(content: string, _source: string): SaveDecision {
    const dupResult = this.checkTextDuplicates(content);
    if (dupResult) return dupResult;
    return { save: true, reason: 'ok' };
  }

  /**
   * Async evaluation for the MCP path (embeddings + text fallback).
   * Only checks for duplicates — relevance is handled by the background classifier.
   */
  async evaluate(content: string, _source: string): Promise<SaveDecision> {
    // 1a. Vector duplicate detection (if worker + embeddingStore available)
    if (this.worker?.isReady() && this.embeddingStore) {
      const embedding = await this.worker.embed(content);
      if (embedding) {
        const results = this.embeddingStore.search(embedding, 5);
        for (const result of results) {
          if (result.distance < this.vectorDistanceThreshold) {
            debug('save-guard', 'Vector duplicate detected', {
              distance: result.distance,
              duplicateOf: result.observationId,
            });
            return {
              save: false,
              reason: 'duplicate',
              duplicateOf: result.observationId,
            };
          }
        }
      }
    }

    // 1b. Text-based fallback
    const dupResult = this.checkTextDuplicates(content);
    if (dupResult) return dupResult;

    return { save: true, reason: 'ok' };
  }

  private checkTextDuplicates(content: string): SaveDecision | null {
    const recent = this.obsRepo.list({ limit: this.recentWindow, includeUnclassified: true });

    for (const obs of recent) {
      const sim = jaccardSimilarity(content, obs.content);
      if (sim >= this.duplicateThreshold) {
        debug('save-guard', 'Text duplicate detected', {
          similarity: sim,
          duplicateOf: obs.id,
        });
        return {
          save: false,
          reason: 'duplicate',
          duplicateOf: obs.id,
        };
      }
    }

    return null;
  }
}
