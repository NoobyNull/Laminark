/**
 * Background Haiku processing orchestrator.
 *
 * Runs on a timer, picks up unclassified observations, and processes them
 * through the Haiku agent pipeline:
 *   1. Classify (noise/signal + discovery/problem/solution)
 *   2. Extract entities via Haiku
 *   3. Infer relationships via Haiku
 *
 * Noise observations are soft-deleted after classification (store-then-soft-delete).
 * Replaces the broken MCP sampling ObservationClassifier and the regex-based
 * entity extraction / relationship detection in the embedding loop.
 */

import type BetterSqlite3 from 'better-sqlite3';

import { classifyWithHaiku } from './haiku-classifier-agent.js';
import { extractEntitiesWithHaiku } from './haiku-entity-agent.js';
import { inferRelationshipsWithHaiku } from './haiku-relationship-agent.js';
import { isHaikuEnabled } from './haiku-client.js';
import { ObservationRepository } from '../storage/observations.js';
import { upsertNode, getNodeByNameAndType, insertEdge } from '../graph/schema.js';
import { applyQualityGate } from '../graph/write-quality-gate.js';
import { enforceMaxDegree } from '../graph/constraints.js';
import { broadcast } from '../web/routes/sse.js';
import { debug } from '../shared/debug.js';
import type { EntityType } from '../graph/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HaikuProcessorOptions {
  intervalMs?: number;
  batchSize?: number;
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// HaikuProcessor
// ---------------------------------------------------------------------------

export class HaikuProcessor {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: BetterSqlite3.Database,
    projectHash: string,
    opts?: HaikuProcessorOptions,
  ) {
    this.db = db;
    this.projectHash = projectHash;
    this.intervalMs = opts?.intervalMs ?? 30_000;
    this.batchSize = opts?.batchSize ?? 10;
    this.concurrency = opts?.concurrency ?? 3;
  }

  start(): void {
    if (this.timer) return;
    debug('haiku', 'HaikuProcessor started', {
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      concurrency: this.concurrency,
    });
    this.timer = setInterval(() => {
      this.processOnce().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        debug('haiku', 'HaikuProcessor cycle error', { error: msg });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      debug('haiku', 'HaikuProcessor stopped');
    }
  }

  async processOnce(): Promise<void> {
    if (!isHaikuEnabled()) return;

    const repo = new ObservationRepository(this.db, this.projectHash);
    const unclassified = repo.listUnclassified(this.batchSize);

    if (unclassified.length === 0) return;

    debug('haiku', 'Processing unclassified observations', {
      count: unclassified.length,
    });

    // Process up to `concurrency` observations in parallel
    const chunks: typeof unclassified = [];
    for (let i = 0; i < unclassified.length; i += this.concurrency) {
      const batch = unclassified.slice(i, i + this.concurrency);
      await Promise.all(batch.map((obs) => this.processOne(obs, repo)));
    }
  }

  private async processOne(
    obs: { id: string; content: string; source: string },
    repo: ObservationRepository,
  ): Promise<void> {
    try {
      // Step 1: Classify via Haiku
      let classification: string;
      try {
        const result = await classifyWithHaiku(obs.content, obs.source);

        if (result.signal === 'noise') {
          // Mark as noise and soft-delete
          repo.updateClassification(obs.id, 'noise');
          repo.softDelete(obs.id);
          debug('haiku', 'Observation classified as noise, soft-deleted', { id: obs.id });
          return;
        }

        classification = result.classification ?? 'discovery';
        repo.updateClassification(
          obs.id,
          classification as 'discovery' | 'problem' | 'solution',
        );
        debug('haiku', 'Observation classified', {
          id: obs.id,
          classification,
        });
      } catch (classifyErr) {
        const msg = classifyErr instanceof Error ? classifyErr.message : String(classifyErr);
        debug('haiku', 'Classification failed, will retry next cycle', {
          id: obs.id,
          error: msg,
        });
        // Leave unclassified for retry
        return;
      }

      // Step 2: Extract entities via Haiku
      let entities: Array<{ name: string; type: EntityType; confidence: number }> = [];
      try {
        entities = await extractEntitiesWithHaiku(obs.content);
      } catch (entityErr) {
        const msg = entityErr instanceof Error ? entityErr.message : String(entityErr);
        debug('haiku', 'Entity extraction failed (non-fatal)', {
          id: obs.id,
          error: msg,
        });
        // Classification succeeded, entity extraction failed -- acceptable
        return;
      }

      if (entities.length === 0) return;

      // Apply quality gate and persist entities
      const isChange = obs.source === 'hook:Write' || obs.source === 'hook:Edit';
      const gateResult = applyQualityGate(entities, isChange);

      const persistedNodes: Array<{ id: string; name: string; type: string }> = [];
      for (const entity of gateResult.passed) {
        try {
          const node = upsertNode(this.db, {
            type: entity.type,
            name: entity.name,
            metadata: { confidence: entity.confidence },
            observation_ids: [String(obs.id)],
            project_hash: this.projectHash,
          });
          persistedNodes.push(node);
        } catch {
          // Skip individual entity failures
          continue;
        }
      }

      if (persistedNodes.length > 0) {
        // Broadcast entity updates to SSE clients
        for (const node of persistedNodes) {
          broadcast('entity_updated', {
            id: node.name,
            label: node.name,
            type: node.type,
            observationCount: 1,
            createdAt: new Date().toISOString(),
          });
        }

        debug('haiku', 'Entities persisted', {
          id: obs.id,
          count: persistedNodes.length,
        });
      }

      // Step 3: Infer relationships via Haiku (only if 2+ entities)
      if (persistedNodes.length >= 2) {
        try {
          const entityPairs = persistedNodes.map((n) => ({
            name: n.name,
            type: n.type as EntityType,
          }));
          const relationships = await inferRelationshipsWithHaiku(
            obs.content,
            entityPairs,
          );

          const affectedNodeIds = new Set<string>();
          for (const rel of relationships) {
            const sourceNode = getNodeByNameAndType(this.db, rel.source, entityPairs.find((e) => e.name === rel.source)?.type ?? 'File');
            const targetNode = getNodeByNameAndType(this.db, rel.target, entityPairs.find((e) => e.name === rel.target)?.type ?? 'File');

            if (!sourceNode || !targetNode) continue;

            try {
              insertEdge(this.db, {
                source_id: sourceNode.id,
                target_id: targetNode.id,
                type: rel.type,
                weight: rel.confidence,
                metadata: { source: 'haiku' },
                project_hash: this.projectHash,
              });
              affectedNodeIds.add(sourceNode.id);
              affectedNodeIds.add(targetNode.id);
            } catch {
              // Edge may already exist, skip
            }
          }

          // Enforce max degree on affected nodes
          for (const nodeId of affectedNodeIds) {
            enforceMaxDegree(this.db, nodeId);
          }

          debug('haiku', 'Relationships persisted', {
            id: obs.id,
            count: relationships.length,
          });
        } catch (relErr) {
          const msg = relErr instanceof Error ? relErr.message : String(relErr);
          debug('haiku', 'Relationship inference failed (non-fatal)', {
            id: obs.id,
            error: msg,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug('haiku', 'processOne failed (non-fatal)', {
        id: obs.id,
        error: msg,
      });
    }
  }
}
