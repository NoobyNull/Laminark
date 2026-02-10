#!/usr/bin/env node

// Laminark MCP server entry point
// Re-export storage API for library consumers
export * from './storage/index.js';

import path from 'path';
import { fileURLToPath } from 'url';

import { openDatabase } from './storage/database.js';
import { getDatabaseConfig, getProjectHash } from './shared/config.js';
import { debug } from './shared/debug.js';
import { createServer, startServer } from './mcp/server.js';
import { registerRecall } from './mcp/tools/recall.js';
import { registerSaveMemory } from './mcp/tools/save-memory.js';
import { registerTopicContext } from './mcp/tools/topic-context.js';
import { registerQueryGraph } from './mcp/tools/query-graph.js';
import { registerGraphStats } from './mcp/tools/graph-stats.js';
import { registerStatus } from './mcp/tools/status.js';
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
import { initGraphSchema } from './graph/schema.js';
import { extractAndPersist } from './graph/entity-extractor.js';
import { detectAndPersist } from './graph/relationship-detector.js';
import { CurationAgent } from './graph/curation-agent.js';
import { ObservationClassifier } from './curation/observation-classifier.js';
import { broadcast } from './web/routes/sse.js';
import { createWebServer, startWebServer } from './web/server.js';

const db = openDatabase(getDatabaseConfig());
initGraphSchema(db.db);
const projectHash = getProjectHash(process.cwd());

// Register this project in project_metadata (upsert)
try {
  db.db.prepare(`
    INSERT INTO project_metadata (project_hash, project_path, last_seen_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(project_hash) DO UPDATE SET
      project_path = excluded.project_path,
      last_seen_at = excluded.last_seen_at
  `).run(projectHash, process.cwd());
} catch {
  // Table may not exist yet on first run before migrations
}

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

      // Broadcast new observation to SSE clients (minimal payload)
      const truncatedText = obs.content.length > 120
        ? obs.content.substring(0, 120) + '...'
        : obs.content;
      broadcast('new_observation', {
        id,
        text: truncatedText,
        sessionId: obs.sessionId ?? null,
        createdAt: obs.createdAt,
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

            // Broadcast topic shift to SSE clients
            broadcast('topic_shift', {
              id: result.notification.substring(0, 32),
              fromTopic: null,
              toTopic: null,
              timestamp: new Date().toISOString(),
              confidence: null,
            });
          }
        } catch (topicErr) {
          const msg = topicErr instanceof Error ? topicErr.message : String(topicErr);
          debug('embed', 'Topic shift detection error (non-fatal)', { error: msg });
        }
      }

      // Knowledge graph -- extract entities and detect relationships
      try {
        const nodes = extractAndPersist(db.db, text, String(id), { projectHash });
        if (nodes.length > 0) {
          const entityPairs = nodes.map(n => ({
            name: n.name,
            type: n.type,
          }));
          detectAndPersist(db.db, text, entityPairs, { projectHash });
          debug('embed', 'Graph updated', {
            id,
            entities: nodes.length,
          });

          // Broadcast entity updates to SSE clients
          for (const node of nodes) {
            broadcast('entity_updated', {
              id: node.name,
              label: node.name,
              type: node.type,
              observationCount: 1,
              createdAt: new Date().toISOString(),
            });
          }
        }
      } catch (graphErr) {
        const msg = graphErr instanceof Error ? graphErr.message : String(graphErr);
        debug('embed', 'Graph extraction error (non-fatal)', { error: msg });
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
registerSaveMemory(server, db.db, projectHash, notificationStore, worker, embeddingStore);
registerRecall(server, db.db, projectHash, worker, embeddingStore, notificationStore);
registerTopicContext(server, db.db, projectHash, notificationStore);
registerQueryGraph(server, db.db, projectHash, notificationStore);
registerGraphStats(server, db.db, projectHash, notificationStore);
registerStatus(server, db.db, projectHash, process.cwd(), db.hasVectorSupport, () => worker.isReady(), notificationStore);

// ---------------------------------------------------------------------------
// Background observation classifier (LLM-based via MCP sampling)
// ---------------------------------------------------------------------------

const classifier = new ObservationClassifier(db.db, projectHash, server, {
  intervalMs: 45_000,
  contextWindow: 5,
  batchSize: 20,
});

startServer(server).then(() => {
  classifier.start();
}).catch((err) => {
  debug('mcp', 'Fatal: failed to start server', { error: err.message });
  clearInterval(embedTimer);
  db.close();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Web visualization server (runs alongside MCP server)
// ---------------------------------------------------------------------------

const webPort = parseInt(process.env.LAMINARK_WEB_PORT || '37820', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiRoot = path.resolve(__dirname, '..', 'ui');
const webApp = createWebServer(db.db, uiRoot, projectHash);
startWebServer(webApp, webPort);

// ---------------------------------------------------------------------------
// Background curation agent (graph maintenance)
// ---------------------------------------------------------------------------

const curationAgent = new CurationAgent(db.db, {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  onComplete: (report) => {
    debug('db', 'Curation complete', {
      merged: report.observationsMerged,
      deduped: report.entitiesDeduplicated,
      stale: report.stalenessFlagsAdded,
      pruned: report.lowValuePruned,
    });
  },
});
curationAgent.start();

// ---------------------------------------------------------------------------
// Shutdown handlers
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  clearInterval(embedTimer);
  classifier.stop();
  curationAgent.stop();
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearInterval(embedTimer);
  classifier.stop();
  curationAgent.stop();
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  debug('mcp', 'Uncaught exception', { error: err.message });
  clearInterval(embedTimer);
  classifier.stop();
  curationAgent.stop();
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(1);
});
