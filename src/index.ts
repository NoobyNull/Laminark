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

const db = openDatabase(getDatabaseConfig());
const projectHash = getProjectHash(process.cwd());

const server = createServer();
registerSaveMemory(server, db.db, projectHash);
registerRecall(server, db.db, projectHash);

startServer(server).catch((err) => {
  debug('mcp', 'Fatal: failed to start server', { error: err.message });
  db.close();
  process.exit(1);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  debug('mcp', 'Uncaught exception', { error: err.message });
  db.close();
  process.exit(1);
});
