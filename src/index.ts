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
import { AnalysisWorker } from './analysis/worker-bridge.js';
import { EmbeddingStore } from './storage/embeddings.js';
import { ObservationRepository } from './storage/observations.js';

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
registerSaveMemory(server, db.db, projectHash);
registerRecall(server, db.db, projectHash, worker, embeddingStore);
registerTopicContext(server, db.db, projectHash);

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
