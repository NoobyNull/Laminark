/**
 * REST API routes for the Laminark visualization.
 *
 * Provides endpoints for graph data, timeline data, and individual node
 * details. All endpoints read from the better-sqlite3 database instance
 * set on the Hono context by the server middleware.
 *
 * @module web/routes/api
 */

import { Hono } from 'hono';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Raw row interfaces for SQL results
// ---------------------------------------------------------------------------

interface GraphNodeRow {
  id: string;
  name: string;
  type: string;
  observation_ids: string; // JSON array
  created_at: string;
}

interface GraphEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  name?: string; // joined from graph_nodes for label
  weight: number;
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

interface ObservationRow {
  id: string;
  content: string;
  title: string | null;
  source: string;
  created_at: string;
  session_id: string | null;
}

interface ShiftDecisionRow {
  id: string;
  session_id: string;
  distance: number;
  threshold: number;
  confidence: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helper: get db from Hono context
// ---------------------------------------------------------------------------

function getDb(c: { get: (key: string) => unknown }): BetterSqlite3.Database {
  return c.get('db') as BetterSqlite3.Database;
}

// ---------------------------------------------------------------------------
// Route group
// ---------------------------------------------------------------------------

export const apiRoutes = new Hono();

/**
 * GET /api/graph
 *
 * Returns the knowledge graph as JSON with nodes and edges arrays.
 * Accepts optional query params:
 *   ?type=File,Decision  - comma-separated entity types to include
 *   ?since=ISO8601       - only entities created after this timestamp
 */
apiRoutes.get('/graph', (c) => {
  const db = getDb(c);
  const typeFilter = c.req.query('type');
  const sinceFilter = c.req.query('since');

  // Build nodes query
  let nodesSql = 'SELECT id, name, type, observation_ids, created_at FROM graph_nodes';
  const nodeParams: unknown[] = [];
  const nodeConditions: string[] = [];

  if (typeFilter) {
    const types = typeFilter.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length > 0) {
      nodeConditions.push(`type IN (${types.map(() => '?').join(', ')})`);
      nodeParams.push(...types);
    }
  }

  if (sinceFilter) {
    nodeConditions.push('created_at >= ?');
    nodeParams.push(sinceFilter);
  }

  if (nodeConditions.length > 0) {
    nodesSql += ' WHERE ' + nodeConditions.join(' AND ');
  }

  nodesSql += ' ORDER BY created_at DESC';

  let nodeRows: GraphNodeRow[];
  try {
    nodeRows = db.prepare(nodesSql).all(...nodeParams) as GraphNodeRow[];
  } catch {
    nodeRows = [];
  }

  const nodes = nodeRows.map(row => ({
    id: row.id,
    label: row.name,
    type: row.type,
    observationCount: safeParseJsonArray(row.observation_ids).length,
    createdAt: row.created_at,
  }));

  // Build edges query -- only include edges where both nodes are in the result set
  let edgeRows: GraphEdgeRow[];
  try {
    const edgesSql = `
      SELECT e.id, e.source_id, e.target_id, e.type, e.weight,
             tn.name AS name
      FROM graph_edges e
      LEFT JOIN graph_nodes tn ON tn.id = e.target_id
      ORDER BY e.created_at DESC
    `;
    edgeRows = db.prepare(edgesSql).all() as GraphEdgeRow[];
  } catch {
    edgeRows = [];
  }

  // If type filtering is active, only include edges between included nodes
  const nodeIdSet = new Set(nodes.map(n => n.id));
  const filteredEdges = typeFilter
    ? edgeRows.filter(e => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id))
    : edgeRows;

  const edges = filteredEdges.map(row => ({
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    type: row.type,
    label: row.name ?? row.type,
  }));

  return c.json({ nodes, edges });
});

/**
 * GET /api/timeline
 *
 * Returns timeline data: sessions, observations, and topic shifts.
 * Accepts optional query params:
 *   ?from=ISO8601  - start of time range
 *   ?to=ISO8601    - end of time range
 *   ?limit=N       - max observations (default 500)
 */
apiRoutes.get('/timeline', (c) => {
  const db = getDb(c);
  const from = c.req.query('from');
  const to = c.req.query('to');
  const limitStr = c.req.query('limit');
  const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 500, 2000) : 500;
  const offsetStr = c.req.query('offset');
  const offset = offsetStr ? Math.max(parseInt(offsetStr, 10) || 0, 0) : 0;

  // Sessions
  let sessions: Array<{ id: string; startedAt: string; endedAt: string | null; observationCount: number; summary: string | null }> = [];
  try {
    let sessionsSql = 'SELECT id, started_at, ended_at, summary FROM sessions';
    const sessionParams: unknown[] = [];
    const sessionConds: string[] = [];

    if (from) {
      sessionConds.push('started_at >= ?');
      sessionParams.push(from);
    }
    if (to) {
      sessionConds.push('(ended_at IS NULL OR ended_at <= ?)');
      sessionParams.push(to);
    }

    if (sessionConds.length > 0) {
      sessionsSql += ' WHERE ' + sessionConds.join(' AND ');
    }
    sessionsSql += ' ORDER BY started_at DESC LIMIT 50 OFFSET ?';
    sessionParams.push(offset);

    const sessionRows = db.prepare(sessionsSql).all(...sessionParams) as SessionRow[];

    // Count observations per session
    const countStmt = db.prepare(
      'SELECT COUNT(*) AS cnt FROM observations WHERE session_id = ? AND deleted_at IS NULL'
    );

    sessions = sessionRows.map(row => {
      let obsCount = 0;
      try {
        const countRow = countStmt.get(row.id) as { cnt: number } | undefined;
        obsCount = countRow?.cnt ?? 0;
      } catch { /* empty */ }

      return {
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        observationCount: obsCount,
        summary: row.summary,
      };
    });
  } catch { /* tables may not exist yet */ }

  // Observations
  let observations: Array<{ id: string; text: string; createdAt: string; sessionId: string | null; type: string }> = [];
  try {
    let obsSql = 'SELECT id, content, title, source, created_at, session_id FROM observations WHERE deleted_at IS NULL';
    const obsParams: unknown[] = [];

    if (from) {
      obsSql += ' AND created_at >= ?';
      obsParams.push(from);
    }
    if (to) {
      obsSql += ' AND created_at <= ?';
      obsParams.push(to);
    }

    obsSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    obsParams.push(limit);
    obsParams.push(offset);

    const obsRows = db.prepare(obsSql).all(...obsParams) as ObservationRow[];

    observations = obsRows.map(row => ({
      id: row.id,
      text: row.title ? `${row.title}: ${row.content}` : row.content,
      createdAt: row.created_at,
      sessionId: row.session_id,
      type: row.source,
    }));
  } catch { /* table may not exist yet */ }

  // Topic shifts
  let topicShifts: Array<{ id: string; fromTopic: string | null; toTopic: string | null; timestamp: string; confidence: number | null }> = [];
  try {
    let shiftSql = 'SELECT id, session_id, distance, threshold, confidence, created_at FROM shift_decisions WHERE shifted = 1';
    const shiftParams: unknown[] = [];

    if (from) {
      shiftSql += ' AND created_at >= ?';
      shiftParams.push(from);
    }
    if (to) {
      shiftSql += ' AND created_at <= ?';
      shiftParams.push(to);
    }

    shiftSql += ' ORDER BY created_at DESC LIMIT 100';

    const shiftRows = db.prepare(shiftSql).all(...shiftParams) as ShiftDecisionRow[];

    topicShifts = shiftRows.map(row => ({
      id: row.id,
      fromTopic: null, // shift_decisions doesn't store topic labels directly
      toTopic: null,
      timestamp: row.created_at,
      confidence: row.confidence,
    }));
  } catch { /* table may not exist yet */ }

  return c.json({ sessions, observations, topicShifts });
});

/**
 * GET /api/node/:id
 *
 * Returns details for a single entity node including its observations
 * and relationships. Powers the detail panel.
 */
apiRoutes.get('/node/:id', (c) => {
  const db = getDb(c);
  const nodeId = c.req.param('id');

  // Get the entity node
  interface FullNodeRow {
    id: string;
    name: string;
    type: string;
    observation_ids: string;
    metadata: string;
    created_at: string;
    updated_at: string;
  }

  let nodeRow: FullNodeRow | undefined;
  try {
    nodeRow = db.prepare(
      'SELECT id, name, type, observation_ids, metadata, created_at, updated_at FROM graph_nodes WHERE id = ?'
    ).get(nodeId) as FullNodeRow | undefined;
  } catch { /* table may not exist */ }

  if (!nodeRow) {
    return c.json({ error: 'Node not found' }, 404);
  }

  const entity = {
    id: nodeRow.id,
    label: nodeRow.name,
    type: nodeRow.type,
    createdAt: nodeRow.created_at,
    updatedAt: nodeRow.updated_at,
    metadata: safeParseJson(nodeRow.metadata),
  };

  // Get observations for this entity
  const observationIds = safeParseJsonArray(nodeRow.observation_ids);
  let nodeObservations: Array<{ id: string; text: string; createdAt: string }> = [];

  if (observationIds.length > 0) {
    try {
      const placeholders = observationIds.map(() => '?').join(', ');
      const obsRows = db.prepare(
        `SELECT id, content, title, created_at FROM observations WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at DESC`
      ).all(...observationIds) as Array<{ id: string; content: string; title: string | null; created_at: string }>;

      nodeObservations = obsRows.map(row => ({
        id: row.id,
        text: row.title ? `${row.title}: ${row.content}` : row.content,
        createdAt: row.created_at,
      }));
    } catch { /* table may not exist */ }
  }

  // Get relationships
  interface RelRow {
    id: string;
    source_id: string;
    target_id: string;
    type: string;
    weight: number;
    target_name: string | null;
    target_type: string | null;
    source_name: string | null;
    source_type: string | null;
  }

  let relationships: Array<{ id: string; targetId: string; targetLabel: string; type: string; direction: string }> = [];
  try {
    const relRows = db.prepare(`
      SELECT
        e.id, e.source_id, e.target_id, e.type, e.weight,
        tn.name AS target_name, tn.type AS target_type,
        sn.name AS source_name, sn.type AS source_type
      FROM graph_edges e
      LEFT JOIN graph_nodes tn ON tn.id = e.target_id
      LEFT JOIN graph_nodes sn ON sn.id = e.source_id
      WHERE e.source_id = ? OR e.target_id = ?
      ORDER BY e.weight DESC
    `).all(nodeId, nodeId) as RelRow[];

    relationships = relRows.map(row => {
      const isSource = row.source_id === nodeId;
      return {
        id: row.id,
        targetId: isSource ? row.target_id : row.source_id,
        targetLabel: isSource ? (row.target_name ?? row.target_id) : (row.source_name ?? row.source_id),
        type: row.type,
        direction: isSource ? 'outgoing' : 'incoming',
      };
    });
  } catch { /* table may not exist */ }

  return c.json({ entity, observations: nodeObservations, relationships });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
