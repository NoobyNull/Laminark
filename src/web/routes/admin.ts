/**
 * Admin API routes for database statistics and reset operations.
 *
 * @module web/routes/admin
 */

import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';

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

function tableCount(db: BetterSqlite3.Database, table: string, where?: string, params?: unknown[]): number {
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
  const graphNodes = tableCount(db, 'graph_nodes', projectWhere, projectParams);
  const graphEdges = tableCount(db, 'graph_edges', projectWhere, projectParams);
  const sessions = tableCount(db, 'sessions', projectWhere, projectParams);
  const contextStashes = tableCount(db, 'context_stashes', projectIdWhere, projectParams);
  const thresholdHistory = tableCount(db, 'threshold_history', projectIdWhere, projectParams);
  const shiftDecisions = tableCount(db, 'shift_decisions', projectIdWhere, projectParams);
  const projects = tableCount(db, 'project_metadata');

  return c.json({
    observations,
    observationsFts,
    observationEmbeddings,
    graphNodes,
    graphEdges,
    sessions,
    contextStashes,
    thresholdHistory,
    shiftDecisions,
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

  const run = (sql: string, params?: unknown[]) => {
    try {
      db.prepare(sql).run(...(params || []));
    } catch {
      // Table may not exist — skip silently
    }
  };

  db.transaction(() => {
    if (type === 'observations' || type === 'all') {
      if (scoped) {
        // Delete FTS rows for matching observations
        run(
          `DELETE FROM observations_fts WHERE rowid IN (SELECT rowid FROM observations WHERE project_hash = ?)`,
          [project],
        );
        run('DELETE FROM observation_embeddings WHERE observation_id IN (SELECT id FROM observations WHERE project_hash = ?)', [project]);
        run('DELETE FROM observations WHERE project_hash = ?', [project]);
      } else {
        run('DELETE FROM observations_fts');
        run('DELETE FROM observation_embeddings');
        run('DELETE FROM observations');
      }
      deleted.push('observations', 'observations_fts', 'observation_embeddings');
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
        run('DELETE FROM sessions WHERE project_hash = ?', [project]);
      } else {
        run('DELETE FROM shift_decisions');
        run('DELETE FROM threshold_history');
        run('DELETE FROM context_stashes');
        run('DELETE FROM sessions');
      }
      deleted.push('sessions', 'context_stashes', 'threshold_history', 'shift_decisions');
    }

    if (type === 'all' && !scoped) {
      run('DELETE FROM project_metadata');
      deleted.push('project_metadata');
    }
  })();

  return c.json({ ok: true, deleted, scope: scoped ? 'project' : 'all' });
});
