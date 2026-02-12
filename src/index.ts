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
import { StatusCache } from './mcp/status-cache.js';
import { registerDiscoverTools } from './mcp/tools/discover-tools.js';
import { registerReportTools } from './mcp/tools/report-tools.js';
import { AnalysisWorker } from './analysis/worker-bridge.js';
import { EmbeddingStore } from './storage/embeddings.js';
import { ObservationRepository } from './storage/observations.js';
import { ResearchBufferRepository } from './storage/research-buffer.js';
import { TopicShiftHandler } from './hooks/topic-shift-handler.js';
import { TopicShiftDetector } from './intelligence/topic-detector.js';
import { AdaptiveThresholdManager } from './intelligence/adaptive-threshold.js';
import { TopicShiftDecisionLogger } from './intelligence/decision-logger.js';
import { loadTopicDetectionConfig, applyConfig } from './config/topic-detection-config.js';
import { loadGraphExtractionConfig } from './config/graph-extraction-config.js';
import { classifySignal } from './graph/signal-classifier.js';
import { StashManager } from './storage/stash-manager.js';
import { ThresholdStore } from './storage/threshold-store.js';
import { NotificationStore } from './storage/notifications.js';
import { initGraphSchema } from './graph/schema.js';
import { extractAndPersist } from './graph/entity-extractor.js';
import { detectAndPersist } from './graph/relationship-detector.js';
import { upsertNode, getNodeByNameAndType, insertEdge } from './graph/schema.js';
import { CurationAgent } from './graph/curation-agent.js';
import { ObservationClassifier } from './curation/observation-classifier.js';
import { broadcast } from './web/routes/sse.js';
import { createWebServer, startWebServer } from './web/server.js';
import { ToolRegistryRepository } from './storage/tool-registry.js';

const noGui = process.argv.includes('--no_gui');

const db = openDatabase(getDatabaseConfig());
initGraphSchema(db.db);
const projectHash = getProjectHash(process.cwd());

// NOTE: project_metadata is populated by the SessionStart hook handler,
// which receives the real project directory via input.cwd.
// The MCP server's process.cwd() returns the plugin install path, not the project dir.

// Tool registry (cross-project, scope-aware)
let toolRegistry: ToolRegistryRepository | null = null;
try {
  toolRegistry = new ToolRegistryRepository(db.db);
} catch {
  debug('mcp', 'Tool registry not available (pre-migration-16)');
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
const graphConfig = loadGraphExtractionConfig();
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

// Sources that reflect user-directed work (for topic shift detection).
// Exploration tools (Read/Glob/Grep/Task) are excluded to avoid false shifts.
const TOPIC_SHIFT_SOURCES = new Set(['hook:Write', 'hook:Edit', 'hook:Bash', 'manual']);

async function processUnembedded(): Promise<void> {
  if (!embeddingStore || !worker.isReady()) return;

  const ids = embeddingStore.findUnembedded(10);
  if (ids.length === 0) return;

  const obsRepo = new ObservationRepository(db.db, projectHash);

  // At most one topic shift notification per processing cycle
  let shiftDetectedThisCycle = false;

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

      // Topic shift detection -- only evaluate user-directed observations
      // (Write/Edit/Bash reflect user intent; Read/Glob/Grep are exploration noise)
      // Only one shift notification per processing cycle to avoid spam.
      if (topicConfig.enabled && !shiftDetectedThisCycle && TOPIC_SHIFT_SOURCES.has(obs.source)) {
        try {
          // Build the observation with its newly generated embedding
          const obsWithEmbedding = { ...obs, embedding };
          const result = await topicShiftHandler.handleObservation(
            obsWithEmbedding,
            obs.sessionId ?? 'unknown',
            projectHash,
          );
          if (result.stashed && result.notification) {
            shiftDetectedThisCycle = true;
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
      // Signal classification gates which observations trigger graph extraction
      const signal = graphConfig.enabled
        ? classifySignal(obs.source, text, graphConfig)
        : { level: 'skip' as const, reason: 'Graph extraction disabled' };

      if (signal.level !== 'skip') try {
        const isChangeObs = obs.kind === 'change' || obs.source === 'hook:Write' || obs.source === 'hook:Edit';
        const nodes = extractAndPersist(db.db, text, String(id), {
          projectHash,
          isChangeObservation: isChangeObs,
          graphConfig,
        });
        if (nodes.length > 0) {
          const entityPairs = nodes.map(n => ({
            name: n.name,
            type: n.type,
          }));
          // Medium signal: entities only, skip relationship detection
          if (signal.level === 'high') {
            detectAndPersist(db.db, text, entityPairs, {
              projectHash,
              minConfidence: graphConfig.relationshipDetector.minEdgeConfidence,
            });
          }

          // Provenance edges: link research context files to changed files
          if (obs.kind === 'change' && obs.content.includes('Research context:')) {
            try {
              const researchSection = obs.content.split('Research context:\n')[1];
              if (researchSection) {
                const researchPaths = researchSection
                  .split('\n')
                  .map(line => {
                    const match = line.match(/\[(?:Read|Glob|Grep)\]\s+(.+)/);
                    return match ? match[1].trim() : null;
                  })
                  .filter((p): p is string => p !== null);

                // Find the File node for the changed file
                const changeFileNodes = nodes.filter(n => n.type === 'File');
                for (const changeNode of changeFileNodes) {
                  for (const researchPath of researchPaths) {
                    // Ensure the research file exists as a node
                    const researchNode = upsertNode(db.db, {
                      type: 'File',
                      name: researchPath,
                      metadata: {},
                      observation_ids: [String(id)],
                      project_hash: projectHash,
                    });
                    // Create informed_by edge
                    try {
                      insertEdge(db.db, {
                        source_id: changeNode.id,
                        target_id: researchNode.id,
                        type: 'informed_by',
                        weight: 0.7,
                        metadata: { source: 'research_buffer' },
                        project_hash: projectHash,
                      });
                    } catch {
                      // Edge may already exist
                    }
                  }
                }
              }
            } catch (provErr) {
              const msg = provErr instanceof Error ? provErr.message : String(provErr);
              debug('embed', 'Provenance edge error (non-fatal)', { error: msg });
            }
          }

          // Temporal ordering: preceded_by edges between consecutive changes
          if (obs.kind === 'change' && obs.sessionId) {
            try {
              const priorChange = db.db.prepare(`
                SELECT id, content FROM observations
                WHERE project_hash = ? AND session_id = ? AND kind = 'change'
                  AND deleted_at IS NULL AND id != ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1
              `).get(projectHash, obs.sessionId, obs.id) as { id: string; content: string } | undefined;

              if (priorChange) {
                const changeFileNodes = nodes.filter(n => n.type === 'File');
                // Extract file path from prior change content
                const priorFileMatch = priorChange.content.match(/\[(?:Write|Edit)\]\s+(?:Created|Modified)\s+(\S+)/);
                if (priorFileMatch && changeFileNodes.length > 0) {
                  const priorNode = getNodeByNameAndType(db.db, priorFileMatch[1], 'File');
                  if (priorNode) {
                    try {
                      insertEdge(db.db, {
                        source_id: changeFileNodes[0].id,
                        target_id: priorNode.id,
                        type: 'preceded_by',
                        weight: 0.6,
                        metadata: { source: 'temporal' },
                        project_hash: projectHash,
                      });
                    } catch {
                      // Edge may already exist
                    }
                  }
                }
              }
            } catch (tempErr) {
              const msg = tempErr instanceof Error ? tempErr.message : String(tempErr);
              debug('embed', 'Temporal ordering error (non-fatal)', { error: msg });
            }
          }

          debug('embed', 'Graph updated', {
            id,
            entities: nodes.length,
          });
          statusCache.markDirty();

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

// Research buffer instance for periodic flush
let researchBufferForFlush: ResearchBufferRepository | null = null;
try {
  researchBufferForFlush = new ResearchBufferRepository(db.db, projectHash);
} catch {
  // Table may not exist yet
}

// Background tool description embedding (enables semantic tool search)
async function processUnembeddedTools(): Promise<void> {
  if (!toolRegistry || !worker.isReady() || !db.hasVectorSupport) return;

  try {
    const unembedded = toolRegistry.findUnembeddedTools(5);
    for (const tool of unembedded) {
      const text = `${tool.name} ${tool.description}`;
      const embedding = await worker.embed(text);
      if (embedding) {
        toolRegistry.storeEmbedding(tool.id, embedding);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debug('embed', 'Tool embedding error (non-fatal)', { error: msg });
  }
}

// Process unembedded observations every 5 seconds
const embedTimer = setInterval(() => {
  processUnembedded().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    debug('embed', 'Background embedding error', { error: message });
  });
  processUnembeddedTools().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    debug('embed', 'Tool embedding background error', { error: message });
  });
  // Flush old research buffer entries (older than 30 minutes)
  try {
    researchBufferForFlush?.flush(30);
  } catch {
    // Non-fatal
  }
  // Refresh status cache if data changed since last build
  statusCache.refreshIfDirty();
}, 5000);

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const statusCache = new StatusCache(
  db.db, projectHash, process.cwd(), db.hasVectorSupport, () => worker.isReady(),
);

const server = createServer();
registerSaveMemory(server, db.db, projectHash, notificationStore, worker, embeddingStore, statusCache);
registerRecall(server, db.db, projectHash, worker, embeddingStore, notificationStore, statusCache);
registerTopicContext(server, db.db, projectHash, notificationStore);
registerQueryGraph(server, db.db, projectHash, notificationStore);
registerGraphStats(server, db.db, projectHash, notificationStore);
registerStatus(server, statusCache, projectHash, notificationStore);
if (toolRegistry) {
  registerDiscoverTools(server, toolRegistry, worker, db.hasVectorSupport, notificationStore, projectHash);
  registerReportTools(server, toolRegistry, projectHash);
}

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

if (!noGui) {
  const webPort = parseInt(process.env.LAMINARK_WEB_PORT || '37820', 10);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uiRoot = path.resolve(__dirname, '..', 'ui');
  const webApp = createWebServer(db.db, uiRoot, projectHash);
  startWebServer(webApp, webPort);
} else {
  debug('mcp', 'Web UI disabled (--no_gui)');
}

// ---------------------------------------------------------------------------
// Background curation agent (graph maintenance)
// ---------------------------------------------------------------------------

const curationAgent = new CurationAgent(db.db, {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  graphConfig,
  onComplete: (report) => {
    debug('db', 'Curation complete', {
      merged: report.observationsMerged,
      deduped: report.entitiesDeduplicated,
      stale: report.stalenessFlagsAdded,
      pruned: report.lowValuePruned,
      decayed: report.temporalDecayUpdated,
      decayDeleted: report.temporalDecayDeleted,
    });
    statusCache.markDirty();
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
