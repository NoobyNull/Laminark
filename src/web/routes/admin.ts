/**
 * Admin API routes for database statistics and reset operations.
 *
 * @module web/routes/admin
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';

import { getConfigDir } from '../../shared/config.js';
import { analyzeObservations, executePurge } from '../../graph/hygiene-analyzer.js';
import { loadTopicDetectionConfig } from '../../config/topic-detection-config.js';
import { loadGraphExtractionConfig } from '../../config/graph-extraction-config.js';
import { loadCrossAccessConfig, saveCrossAccessConfig, resetCrossAccessConfig } from '../../config/cross-access.js';
import { loadToolVerbosityConfig, saveToolVerbosityConfig, resetToolVerbosityConfig } from '../../config/tool-verbosity-config.js';

type AppEnv = {
  Variables: {
    db: BetterSqlite3.Database;
    defaultProject: string;
  };
};

function getDb(c: { get: (key: 'db') => BetterSqlite3.Database }): BetterSqlite3.Database {
  return c.get('db');
}

function getProjectHash(c: { get: (key: 'defaultProject') => string; req: { query: (key: string) => string | undefined } }): string | null {
  return c.req.query('project') || c.get('defaultProject') || null;
}

const ALLOWED_TABLES = new Set([
  'observations', 'observations_fts', 'observation_embeddings', 'staleness_flags',
  'graph_nodes', 'graph_edges', 'sessions', 'context_stashes', 'threshold_history',
  'shift_decisions', 'pending_notifications', 'project_metadata', '_migrations',
  'tool_registry', 'tool_usage_events', 'research_buffer',
]);

function tableCount(db: BetterSqlite3.Database, table: string, where?: string, params?: unknown[]): number {
  if (!ALLOWED_TABLES.has(table)) return 0;
  try {
    const sql = where
      ? `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}`
      : `SELECT COUNT(*) AS cnt FROM ${table}`;
    const row = db.prepare(sql).get(...(params || [])) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

export const adminRoutes = new Hono<AppEnv>();

/**
 * GET /api/admin/stats
 *
 * Returns row counts per table group, optionally scoped to a project.
 */
adminRoutes.get('/stats', (c) => {
  const db = getDb(c);
  const project = c.req.query('project') || getProjectHash(c);

  const projectWhere = project ? 'project_hash = ?' : undefined;
  const projectIdWhere = project ? 'project_id = ?' : undefined;
  const projectParams = project ? [project] : undefined;

  const observations = tableCount(db, 'observations', projectWhere, projectParams);
  const observationsFts = tableCount(db, 'observations_fts');
  const observationEmbeddings = tableCount(db, 'observation_embeddings');
  const stalenessFlags = tableCount(db, 'staleness_flags');
  const graphNodes = tableCount(db, 'graph_nodes', projectWhere, projectParams);
  const graphEdges = tableCount(db, 'graph_edges', projectWhere, projectParams);
  const sessions = tableCount(db, 'sessions', projectWhere, projectParams);
  const contextStashes = tableCount(db, 'context_stashes', projectIdWhere, projectParams);
  const thresholdHistory = tableCount(db, 'threshold_history', projectIdWhere, projectParams);
  const shiftDecisions = tableCount(db, 'shift_decisions', projectIdWhere, projectParams);
  const pendingNotifications = tableCount(db, 'pending_notifications', projectIdWhere, projectParams);
  const projects = tableCount(db, 'project_metadata');

  return c.json({
    observations,
    observationsFts,
    observationEmbeddings,
    stalenessFlags,
    graphNodes,
    graphEdges,
    sessions,
    contextStashes,
    thresholdHistory,
    shiftDecisions,
    pendingNotifications,
    projects,
    scopedToProject: project || null,
  });
});

/**
 * POST /api/admin/reset
 *
 * Hard-deletes data by group inside a transaction.
 * Body: { type: 'observations'|'graph'|'sessions'|'all', scope: 'current'|'all', projectHash?: string }
 */
adminRoutes.post('/reset', async (c) => {
  const db = getDb(c);
  const body = await c.req.json<{ type: string; scope: string; projectHash?: string }>();
  const { type, scope } = body;
  const project = body.projectHash || getProjectHash(c);

  const validTypes = ['observations', 'graph', 'sessions', 'all'];
  if (!validTypes.includes(type)) {
    return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);
  }

  const scoped = scope === 'current' && project;
  const deleted: string[] = [];

  const exec = (sql: string) => {
    try { db.exec(sql); } catch { /* table/trigger may not exist */ }
  };

  const run = (sql: string, params?: unknown[]) => {
    try {
      db.prepare(sql).run(...(params || []));
    } catch {
      // Table may not exist — skip silently
    }
  };

  db.transaction(() => {
    if (type === 'observations' || type === 'all') {
      // Drop FTS sync triggers FIRST — they fire on every DELETE and will
      // abort the delete if the FTS index is out of sync with observations.
      exec('DROP TRIGGER IF EXISTS observations_ai');
      exec('DROP TRIGGER IF EXISTS observations_au');
      exec('DROP TRIGGER IF EXISTS observations_ad');

      if (scoped) {
        run('DELETE FROM observation_embeddings WHERE observation_id IN (SELECT id FROM observations WHERE project_hash = ?)', [project]);
        run('DELETE FROM staleness_flags WHERE observation_id IN (SELECT id FROM observations WHERE project_hash = ?)', [project]);
        run('DELETE FROM observations WHERE project_hash = ?', [project]);
      } else {
        run('DELETE FROM observation_embeddings');
        run('DELETE FROM staleness_flags');
        run('DELETE FROM observations');
      }

      // Rebuild FTS (will be empty or contain only remaining rows)
      exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");

      // Recreate FTS sync triggers
      exec(`
        CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, content)
            VALUES (new.rowid, new.title, new.content);
        END
      `);
      exec(`
        CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, old.content);
          INSERT INTO observations_fts(rowid, title, content)
            VALUES (new.rowid, new.title, new.content);
        END
      `);
      exec(`
        CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, content)
            VALUES('delete', old.rowid, old.title, old.content);
        END
      `);

      deleted.push('observations', 'observations_fts', 'observation_embeddings', 'staleness_flags');
    }

    if (type === 'graph' || type === 'all') {
      if (scoped) {
        run('DELETE FROM graph_edges WHERE project_hash = ?', [project]);
        run('DELETE FROM graph_nodes WHERE project_hash = ?', [project]);
      } else {
        run('DELETE FROM graph_edges');
        run('DELETE FROM graph_nodes');
      }
      deleted.push('graph_nodes', 'graph_edges');
    }

    if (type === 'sessions' || type === 'all') {
      if (scoped) {
        run('DELETE FROM shift_decisions WHERE project_id = ?', [project]);
        run('DELETE FROM threshold_history WHERE project_id = ?', [project]);
        run('DELETE FROM context_stashes WHERE project_id = ?', [project]);
        run('DELETE FROM pending_notifications WHERE project_id = ?', [project]);
        run('DELETE FROM sessions WHERE project_hash = ?', [project]);
      } else {
        run('DELETE FROM shift_decisions');
        run('DELETE FROM threshold_history');
        run('DELETE FROM context_stashes');
        run('DELETE FROM pending_notifications');
        run('DELETE FROM sessions');
      }
      deleted.push('sessions', 'context_stashes', 'threshold_history', 'shift_decisions', 'pending_notifications');
    }

    if (type === 'all' && !scoped) {
      run('DELETE FROM project_metadata');
      run('DELETE FROM _migrations');
      deleted.push('project_metadata', '_migrations');
    }
  })();

  return c.json({ ok: true, deleted, scope: scoped ? 'project' : 'all' });
});

// =========================================================================
// Hygiene analysis
// =========================================================================

adminRoutes.get('/hygiene', (c) => {
  const db = getDb(c);
  const project = getProjectHash(c);
  if (!project) return c.json({ error: 'No project context available' }, 400);

  const tier = (c.req.query('tier') || 'high') as 'high' | 'medium' | 'all';
  const sessionId = c.req.query('session_id');
  const limit = parseInt(c.req.query('limit') || '50', 10);

  const minTier = tier === 'all' ? 'low' as const : tier;
  const report = analyzeObservations(db, project, { sessionId, limit, minTier });

  return c.json(report);
});

adminRoutes.post('/hygiene/purge', async (c) => {
  const db = getDb(c);
  const project = getProjectHash(c);
  if (!project) return c.json({ error: 'No project context available' }, 400);

  const body = await c.req.json<{ tier?: string }>();
  const tier = (body.tier || 'high') as 'high' | 'medium' | 'all';

  const minTier = tier === 'all' ? 'low' as const : tier;
  const report = analyzeObservations(db, project, { minTier, limit: 500 });
  const result = executePurge(db, project, report, tier);

  return c.json({
    ok: true,
    observationsPurged: result.observationsPurged,
    orphanNodesRemoved: result.orphanNodesRemoved,
    tier,
  });
});

// =========================================================================
// Configuration endpoints
// =========================================================================

adminRoutes.get('/config/topic-detection', (c) => {
  return c.json(loadTopicDetectionConfig());
});

adminRoutes.put('/config/topic-detection', async (c) => {
  const body = await c.req.json();
  const configPath = join(getConfigDir(), 'topic-detection.json');

  if (body && body.__reset === true) {
    try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* ignore */ }
    return c.json(loadTopicDetectionConfig());
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }

  const { __reset: _, ...data } = body;
  // Write raw input, then re-load (validates all fields), then overwrite with validated config
  writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
  const validated = loadTopicDetectionConfig();
  writeFileSync(configPath, JSON.stringify(validated, null, 2), 'utf-8');
  return c.json(validated);
});

adminRoutes.get('/config/graph-extraction', (c) => {
  return c.json(loadGraphExtractionConfig());
});

adminRoutes.put('/config/graph-extraction', async (c) => {
  const body = await c.req.json();
  const configPath = join(getConfigDir(), 'graph-extraction.json');

  if (body && body.__reset === true) {
    try { if (existsSync(configPath)) unlinkSync(configPath); } catch { /* ignore */ }
    return c.json(loadGraphExtractionConfig());
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }

  const { __reset: _, ...data } = body;
  // Write raw input, then re-load (validates all fields), then overwrite with validated config
  writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
  const validated = loadGraphExtractionConfig();
  writeFileSync(configPath, JSON.stringify(validated, null, 2), 'utf-8');
  return c.json(validated);
});

// =========================================================================
// Cross-Project Access Config
// =========================================================================

adminRoutes.get('/config/cross-access', (c) => {
  const project = c.req.query('project');
  if (!project) return c.json({ error: 'project query parameter is required' }, 400);
  return c.json(loadCrossAccessConfig(project));
});

adminRoutes.put('/config/cross-access', async (c) => {
  const project = c.req.query('project');
  if (!project) return c.json({ error: 'project query parameter is required' }, 400);

  const body = await c.req.json();

  if (body && body.__reset === true) {
    resetCrossAccessConfig(project);
    return c.json(loadCrossAccessConfig(project));
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }

  saveCrossAccessConfig(project, { readableProjects: body.readableProjects || [] });
  return c.json(loadCrossAccessConfig(project));
});

// =========================================================================
// Tool Response Verbosity Config
// =========================================================================

adminRoutes.get('/config/tool-verbosity', (c) => {
  return c.json(loadToolVerbosityConfig());
});

adminRoutes.put('/config/tool-verbosity', async (c) => {
  const body = await c.req.json();

  if (body && body.__reset === true) {
    const config = resetToolVerbosityConfig();
    saveToolVerbosityConfig(config);
    return c.json(config);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }

  const level = body.level;
  if (level !== 1 && level !== 2 && level !== 3) {
    return c.json({ error: 'level must be 1, 2, or 3' }, 400);
  }

  saveToolVerbosityConfig({ level });
  return c.json(loadToolVerbosityConfig());
});
