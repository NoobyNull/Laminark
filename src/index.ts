#!/usr/bin/env node

// Laminark MCP server entry point
// Re-export storage API for library consumers
export * from './storage/index.js';

import path from 'path';
import { fileURLToPath } from 'url';

import { openDatabase } from './storage/database.js';
import { getDatabaseConfig, getProjectHash } from './shared/config.js';
import { debug } from './shared/debug.js';
import type { ProjectHashRef } from './shared/types.js';
import { createServer, startServer } from './mcp/server.js';
import { registerRecall } from './mcp/tools/recall.js';
import { registerSaveMemory } from './mcp/tools/save-memory.js';
import { registerIngestKnowledge } from './mcp/tools/ingest-knowledge.js';
import { registerTopicContext } from './mcp/tools/topic-context.js';
import { registerQueryGraph } from './mcp/tools/query-graph.js';
import { registerGraphStats } from './mcp/tools/graph-stats.js';
import { registerHygiene } from './mcp/tools/hygiene.js';
import { registerStatus } from './mcp/tools/status.js';
import { StatusCache } from './mcp/status-cache.js';
import { registerDiscoverTools } from './mcp/tools/discover-tools.js';
import { registerReportTools } from './mcp/tools/report-tools.js';
import { registerDebugPathTools } from './mcp/tools/debug-paths.js';
import { registerThoughtBranchTools } from './mcp/tools/thought-branches.js';
import { BranchRepository } from './branches/branch-repository.js';
import { BranchTracker } from './branches/branch-tracker.js';
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
import { StashManager } from './storage/stash-manager.js';
import { ThresholdStore } from './storage/threshold-store.js';
import { NotificationStore } from './storage/notifications.js';
import { initGraphSchema } from './graph/schema.js';
import { CurationAgent } from './graph/curation-agent.js';
import { HaikuProcessor } from './intelligence/haiku-processor.js';
import { initPathSchema } from './paths/schema.js';
import { PathRepository } from './paths/path-repository.js';
import { PathTracker } from './paths/path-tracker.js';
import { broadcast } from './web/routes/sse.js';
import { createWebServer, startWebServer } from './web/server.js';
import { ToolRegistryRepository } from './storage/tool-registry.js';

const noGui = process.argv.includes('--no_gui');

const db = openDatabase(getDatabaseConfig());
initGraphSchema(db.db);
initPathSchema(db.db);

// ---------------------------------------------------------------------------
// Live project hash ref — auto-refreshes from project_metadata on access.
//
// The MCP server's process.cwd() is the plugin install path, NOT the user's
// project directory.  The correct hash is written to project_metadata by the
// SessionStart hook (which receives input.cwd from Claude Code).  This ref
// re-queries the database at most once per CHECK_INTERVAL_MS so tool handlers
// always use the correct, current project hash.
// ---------------------------------------------------------------------------

class LiveProjectHashRef implements ProjectHashRef {
  private _current: string;
  private _lastChecked = 0;
  private _db: import('better-sqlite3').Database;
  private static readonly CHECK_INTERVAL_MS = 2000;

  constructor(sqliteDb: import('better-sqlite3').Database) {
    this._db = sqliteDb;
    // Best-effort initial value (may be stale from a previous session).
    // First tool-call access will re-query after CHECK_INTERVAL_MS (0ms elapsed
    // since _lastChecked starts at 0, so the very first .current triggers a refresh).
    this._current = this.resolve();
  }

  get current(): string {
    const now = Date.now();
    if (now - this._lastChecked >= LiveProjectHashRef.CHECK_INTERVAL_MS) {
      this._lastChecked = now;
      const fresh = this.resolve();
      if (fresh !== this._current) {
        debug('mcp', 'Project hash refreshed from database', { old: this._current, new: fresh });
        this._current = fresh;
      }
    }
    return this._current;
  }

  private resolve(): string {
    try {
      const row = this._db.prepare(
        'SELECT project_hash FROM project_metadata ORDER BY last_seen_at DESC LIMIT 1',
      ).get() as { project_hash: string } | undefined;
      if (row?.project_hash) return row.project_hash;
    } catch {
      // Table may not exist yet on first run
    }
    return getProjectHash(process.cwd());
  }
}

const projectHashRef: ProjectHashRef = new LiveProjectHashRef(db.db);

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
  ? new EmbeddingStore(db.db, projectHashRef.current)
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
const historicalSeed = thresholdStore.loadHistoricalSeed(projectHashRef.current);
if (historicalSeed) {
  adaptiveManager.seedFromHistory(historicalSeed.averageDistance, historicalSeed.averageVariance);
  applyConfig(topicConfig, detector, adaptiveManager);
}

const stashManager = new StashManager(db.db);
const decisionLogger = new TopicShiftDecisionLogger(db.db);
const notificationStore = new NotificationStore(db.db);
const obsRepoForTopicDetection = new ObservationRepository(db.db, projectHashRef.current);

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

  const currentHash = projectHashRef.current;
  const obsRepo = new ObservationRepository(db.db, currentHash);

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
        projectHash: currentHash,
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
            currentHash,
          );
          if (result.stashed && result.notification) {
            shiftDetectedThisCycle = true;
            notificationStore.add(currentHash, result.notification);
            debug('embed', 'Topic shift detected, notification queued', { id });

            // Broadcast topic shift to SSE clients
            broadcast('topic_shift', {
              id: result.notification.substring(0, 32),
              fromTopic: null,
              toTopic: null,
              timestamp: new Date().toISOString(),
              confidence: null,
              projectHash: currentHash,
            });
          }
        } catch (topicErr) {
          const msg = topicErr instanceof Error ? topicErr.message : String(topicErr);
          debug('embed', 'Topic shift detection error (non-fatal)', { error: msg });
        }
      }

      // Knowledge graph extraction is now handled by HaikuProcessor in the background.
      // The embedding loop only handles: embeddings, SSE broadcast, topic shift detection.
    }
  }
}

// Research buffer instance for periodic flush
let researchBufferForFlush: ResearchBufferRepository | null = null;
try {
  researchBufferForFlush = new ResearchBufferRepository(db.db, projectHashRef.current);
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
  db.db, projectHashRef, process.cwd(), db.hasVectorSupport, () => worker.isReady(),
);

const server = createServer();
registerSaveMemory(server, db.db, projectHashRef, notificationStore, worker, embeddingStore, statusCache);
registerIngestKnowledge(server, db.db, projectHashRef, statusCache);
registerRecall(server, db.db, projectHashRef, worker, embeddingStore, notificationStore, statusCache);
registerTopicContext(server, db.db, projectHashRef, notificationStore);
registerQueryGraph(server, db.db, projectHashRef, notificationStore);
registerGraphStats(server, db.db, projectHashRef, notificationStore);
registerHygiene(server, db.db, projectHashRef, notificationStore);
registerStatus(server, statusCache, projectHashRef, notificationStore);
if (toolRegistry) {
  registerDiscoverTools(server, toolRegistry, worker, db.hasVectorSupport, notificationStore, projectHashRef);
  registerReportTools(server, toolRegistry, projectHashRef);
}

// ---------------------------------------------------------------------------
// Background Haiku processor (classification + entity extraction + relationships)
// ---------------------------------------------------------------------------

const pathRepo = new PathRepository(db.db, projectHashRef.current);
const pathTracker = new PathTracker(pathRepo);
registerDebugPathTools(server, pathRepo, pathTracker, notificationStore, projectHashRef);

// Branch tracking (thought branch auto-detection)
let branchRepo: BranchRepository | null = null;
let branchTracker: BranchTracker | null = null;
try {
  branchRepo = new BranchRepository(db.db, projectHashRef.current);
  branchTracker = new BranchTracker(branchRepo, db.db, projectHashRef.current);
  const obsRepoForBranches = new ObservationRepository(db.db, projectHashRef.current);
  registerThoughtBranchTools(server, branchRepo, obsRepoForBranches, notificationStore, projectHashRef);
} catch {
  debug('mcp', 'Branch tracking not available (pre-migration-21)');
}

const haikuProcessor = new HaikuProcessor(db.db, projectHashRef.current, {
  intervalMs: 30_000,
  batchSize: 10,
  concurrency: 3,
  pathTracker,
  branchTracker,
});

startServer(server).then(() => {
  haikuProcessor.start();
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
  const webApp = createWebServer(db.db, uiRoot, projectHashRef.current);
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

function shutdown(code: number): void {
  clearInterval(embedTimer);
  haikuProcessor.stop();
  curationAgent.stop();
  worker.shutdown().catch(() => {});
  db.close();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  debug('mcp', 'Uncaught exception', { error: err.message });
  shutdown(1);
});
