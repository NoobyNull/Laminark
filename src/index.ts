#!/usr/bin/env node

// Laminark MCP server entry point
// Re-export storage API for library consumers
export * from './storage/index.js';

import { openDatabase } from './storage/database.js';
import { getDatabaseConfig, getProjectHash } from './shared/config.js';
import { debug } from './shared/debug.js';
import { createServer, startServer } from './mcp/server.js';
import { registerRecall } from './mcp/tools/recall.js';
import { registerSaveMemory } from './mcp/tools/save-memory.js';
import { registerTopicContext } from './mcp/tools/topic-context.js';
import { registerQueryGraph } from './mcp/tools/query-graph.js';
import { registerGraphStats } from './mcp/tools/graph-stats.js';
import { AnalysisWorker } from './analysis/worker-bridge.js';
import { EmbeddingStore } from './storage/embeddings.js';
import { ObservationRepository } from './storage/observations.js';
import { TopicShiftHandler } from './hooks/topic-shift-handler.js';
import { TopicShiftDetector } from './intelligence/topic-detector.js';
import { AdaptiveThresholdManager } from './intelligence/adaptive-threshold.js';
import { TopicShiftDecisionLogger } from './intelligence/decision-logger.js';
import { loadTopicDetectionConfig, applyConfig } from './config/topic-detection-config.js';
import { StashManager } from './storage/stash-manager.js';
import { ThresholdStore } from './storage/threshold-store.js';
import { NotificationStore } from './storage/notifications.js';

const db = openDatabase(getDatabaseConfig());
const projectHash = getProjectHash(process.cwd());

// ---------------------------------------------------------------------------
// Worker thread and embedding store (graceful degradation)
// ---------------------------------------------------------------------------

const embeddingStore = db.hasVectorSupport
  ? new EmbeddingStore(db.db, projectHash)
  : null;

const worker = new AnalysisWorker();

// Start worker in background -- do NOT await during server startup (DQ-04)
const workerReady = worker.start().catch(() => {
  debug('mcp', 'Worker failed to start, keyword-only mode');
});

// Suppress unhandled rejection from workerReady (already handled above)
void workerReady;

// ---------------------------------------------------------------------------
// Topic shift detection (runs in background embedding loop)
// ---------------------------------------------------------------------------

const topicConfig = loadTopicDetectionConfig();
const detector = new TopicShiftDetector();
const adaptiveManager = new AdaptiveThresholdManager({
  sensitivityMultiplier: topicConfig.sensitivityMultiplier,
  alpha: topicConfig.ewmaAlpha,
});
applyConfig(topicConfig, detector, adaptiveManager);

// Seed adaptive threshold from history (cold start handling)
const thresholdStore = new ThresholdStore(db.db);
const historicalSeed = thresholdStore.loadHistoricalSeed(projectHash);
if (historicalSeed) {
  adaptiveManager.seedFromHistory(historicalSeed.averageDistance, historicalSeed.averageVariance);
  applyConfig(topicConfig, detector, adaptiveManager);
}

const stashManager = new StashManager(db.db);
const decisionLogger = new TopicShiftDecisionLogger(db.db);
const notificationStore = new NotificationStore(db.db);
const obsRepoForTopicDetection = new ObservationRepository(db.db, projectHash);

const topicShiftHandler = new TopicShiftHandler({
  detector,
  stashManager,
  observationStore: obsRepoForTopicDetection,
  config: topicConfig,
  decisionLogger,
  adaptiveManager,
});

// ---------------------------------------------------------------------------
// Background embedding loop
// ---------------------------------------------------------------------------

async function processUnembedded(): Promise<void> {
  if (!embeddingStore || !worker.isReady()) return;

  const ids = embeddingStore.findUnembedded(10);
  if (ids.length === 0) return;

  const obsRepo = new ObservationRepository(db.db, projectHash);

  for (const id of ids) {
    const obs = obsRepo.getById(id);
    if (!obs) continue;

    const text = obs.title ? `${obs.title}\n${obs.content}` : obs.content;
    const embedding = await worker.embed(text);

    if (embedding) {
      embeddingStore.store(id, embedding);
      obsRepo.update(id, {
        embeddingModel: worker.getEngineName(),
        embeddingVersion: '1',
      });

      // Topic shift detection -- evaluate the newly embedded observation
      if (topicConfig.enabled) {
        try {
          // Build the observation with its newly generated embedding
          const obsWithEmbedding = { ...obs, embedding };
          const result = await topicShiftHandler.handleObservation(
            obsWithEmbedding,
            obs.sessionId ?? 'unknown',
            projectHash,
          );
          if (result.stashed && result.notification) {
            notificationStore.add(projectHash, result.notification);
            debug('embed', 'Topic shift detected, notification queued', { id });
          }
        } catch (topicErr) {
          const msg = topicErr instanceof Error ? topicErr.message : String(topicErr);
          debug('embed', 'Topic shift detection error (non-fatal)', { error: msg });
        }
      }
    }
  }
}

// Process unembedded observations every 5 seconds
const embedTimer = setInterval(() => {
  processUnembedded().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    debug('embed', 'Background embedding error', { error: message });
  });
}, 5000);

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = createServer();
registerSaveMemory(server, db.db, projectHash, notificationStore);
registerRecall(server, db.db, projectHash, worker, embeddingStore, notificationStore);
registerTopicContext(server, db.db, projectHash, notificationStore);
registerQueryGraph(server, db.db, projectHash, notificationStore);
registerGraphStats(server, db.db, projectHash, notificationStore);

startServer(server).catch((err) => {
  debug('mcp', 'Fatal: failed to start server', { error: err.message });
  clearInterval(embedTimer);
  db.close();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Shutdown handlers
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  clearInterval(embedTimer);
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearInterval(embedTimer);
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  debug('mcp', 'Uncaught exception', { error: err.message });
  clearInterval(embedTimer);
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(1);
});
