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
import { PathRepository } from '../../paths/path-repository.js';
import type { PathWaypoint } from '../../paths/types.js';

type AppEnv = {
  Variables: {
    db: BetterSqlite3.Database;
    defaultProject: string;
  };
};

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

function getDb(c: { get: (key: 'db') => BetterSqlite3.Database }): BetterSqlite3.Database {
  return c.get('db');
}

function getProjectHash(c: { get: (key: 'defaultProject') => string; req: { query: (key: string) => string | undefined } }): string | null {
  return c.req.query('project') || c.get('defaultProject') || null;
}

// ---------------------------------------------------------------------------
// Route group
// ---------------------------------------------------------------------------

export const apiRoutes = new Hono<AppEnv>();

/**
 * GET /api/projects
 *
 * Returns list of known projects from project_metadata table.
 */
apiRoutes.get('/projects', (c) => {
  const db = getDb(c);
  const defaultProject = c.get('defaultProject') || null;

  interface ProjectRow {
    project_hash: string;
    project_path: string;
    display_name: string | null;
    last_seen_at: string;
  }

  let projects: ProjectRow[] = [];
  try {
    projects = db.prepare(
      'SELECT project_hash, project_path, display_name, last_seen_at FROM project_metadata ORDER BY last_seen_at DESC'
    ).all() as ProjectRow[];
  } catch { /* table may not exist yet */ }

  // Prefer the most recently active project as default (first in list, sorted by last_seen_at DESC)
  const resolvedDefault = (projects.length > 0 ? projects[0].project_hash : null) || defaultProject;

  return c.json({
    projects: projects.map(p => ({
      hash: p.project_hash,
      path: p.project_path,
      displayName: p.display_name || p.project_path.split('/').pop() || p.project_hash.substring(0, 8),
      lastSeenAt: p.last_seen_at,
    })),
    defaultProject: resolvedDefault,
  });
});

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
  const untilFilter = c.req.query('until');
  const projectFilter = getProjectHash(c);

  // Build nodes query
  let nodesSql = 'SELECT id, name, type, observation_ids, created_at FROM graph_nodes';
  const nodeParams: unknown[] = [];
  const nodeConditions: string[] = [];

  if (projectFilter) {
    nodeConditions.push('project_hash = ?');
    nodeParams.push(projectFilter);
  }

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

  if (untilFilter) {
    nodeConditions.push('created_at <= ?');
    nodeParams.push(untilFilter);
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
    let edgesSql = `
      SELECT e.id, e.source_id, e.target_id, e.type, e.weight,
             tn.name AS name
      FROM graph_edges e
      LEFT JOIN graph_nodes tn ON tn.id = e.target_id`;
    const edgeParams: unknown[] = [];
    if (projectFilter) {
      edgesSql += ' WHERE e.project_hash = ?';
      edgeParams.push(projectFilter);
    }
    edgesSql += ' ORDER BY e.created_at DESC';
    edgeRows = db.prepare(edgesSql).all(...edgeParams) as GraphEdgeRow[];
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
  const projectFilter = getProjectHash(c);

  // Sessions
  let sessions: Array<{ id: string; startedAt: string; endedAt: string | null; observationCount: number; summary: string | null }> = [];
  try {
    let sessionsSql = 'SELECT id, started_at, ended_at, summary FROM sessions';
    const sessionParams: unknown[] = [];
    const sessionConds: string[] = [];

    if (projectFilter) {
      sessionConds.push('project_hash = ?');
      sessionParams.push(projectFilter);
    }

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

    if (projectFilter) {
      obsSql += ' AND project_hash = ?';
      obsParams.push(projectFilter);
    }

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

    if (projectFilter) {
      shiftSql += ' AND project_id = ?';
      shiftParams.push(projectFilter);
    }

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

/**
 * GET /api/node/:id/neighborhood
 *
 * Returns the N-hop subgraph around a node. Powers the focus/drill-down view.
 * Query params:
 *   ?depth=1  - hop count (1 or 2, default 1)
 */
apiRoutes.get('/node/:id/neighborhood', (c) => {
  const db = getDb(c);
  const centerId = c.req.param('id');
  const depthParam = c.req.query('depth');
  const depth = Math.min(Math.max(parseInt(depthParam || '1', 10) || 1, 1), 2);

  // Verify the center node exists
  let centerRow: GraphNodeRow | undefined;
  try {
    centerRow = db.prepare(
      'SELECT id, name, type, observation_ids, created_at FROM graph_nodes WHERE id = ?'
    ).get(centerId) as GraphNodeRow | undefined;
  } catch { /* table may not exist */ }

  if (!centerRow) {
    return c.json({ error: 'Node not found' }, 404);
  }

  // Collect node IDs at each depth level
  const visitedNodeIds = new Set<string>([centerId]);
  let frontier = new Set<string>([centerId]);

  interface EdgeRow {
    id: string;
    source_id: string;
    target_id: string;
    type: string;
    weight: number;
  }

  const allEdgeRows: EdgeRow[] = [];
  const seenEdgeIds = new Set<string>();

  for (let d = 0; d < depth; d++) {
    if (frontier.size === 0) break;

    const frontierIds = Array.from(frontier);
    const placeholders = frontierIds.map(() => '?').join(', ');
    const nextFrontier = new Set<string>();

    try {
      const edgeRows = db.prepare(
        `SELECT id, source_id, target_id, type, weight FROM graph_edges
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
      ).all(...frontierIds, ...frontierIds) as EdgeRow[];

      for (const edge of edgeRows) {
        if (!seenEdgeIds.has(edge.id)) {
          seenEdgeIds.add(edge.id);
          allEdgeRows.push(edge);
        }

        if (!visitedNodeIds.has(edge.source_id)) {
          visitedNodeIds.add(edge.source_id);
          nextFrontier.add(edge.source_id);
        }
        if (!visitedNodeIds.has(edge.target_id)) {
          visitedNodeIds.add(edge.target_id);
          nextFrontier.add(edge.target_id);
        }
      }
    } catch { /* table may not exist */ }

    frontier = nextFrontier;
  }

  // Fetch full node data for all collected node IDs
  const nodeIds = Array.from(visitedNodeIds);
  let nodeRows: GraphNodeRow[] = [];
  if (nodeIds.length > 0) {
    try {
      const placeholders = nodeIds.map(() => '?').join(', ');
      nodeRows = db.prepare(
        `SELECT id, name, type, observation_ids, created_at FROM graph_nodes WHERE id IN (${placeholders})`
      ).all(...nodeIds) as GraphNodeRow[];
    } catch { /* table may not exist */ }
  }

  const nodes = nodeRows.map(row => ({
    id: row.id,
    label: row.name,
    type: row.type,
    observationCount: safeParseJsonArray(row.observation_ids).length,
    createdAt: row.created_at,
  }));

  // Only include edges where both endpoints are in our node set
  const nodeIdSet = new Set(nodeIds);
  const edges = allEdgeRows
    .filter(e => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id))
    .map(row => ({
      id: row.id,
      source: row.source_id,
      target: row.target_id,
      type: row.type,
    }));

  return c.json({ center: centerId, nodes, edges });
});

/**
 * GET /api/graph/search
 *
 * Two-tier search: name-based LIKE matching on graph_nodes, then FTS fallback
 * on observations_fts for richer content matching.
 * Query params:
 *   ?q=       - search query (required)
 *   ?type=    - entity type filter
 *   ?limit=20 - max results
 *   ?project= - project hash filter
 */
apiRoutes.get('/graph/search', (c) => {
  const db = getDb(c);
  const query = (c.req.query('q') || '').trim();
  const typeFilter = c.req.query('type') || null;
  const limitStr = c.req.query('limit');
  const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 20, 50) : 20;
  const projectFilter = getProjectHash(c);

  if (!query) {
    return c.json({ results: [] });
  }

  interface SearchResult {
    id: string;
    label: string;
    type: string;
    observationCount: number;
    matchSource: 'exact' | 'prefix' | 'contains' | 'fts';
    snippet: string | null;
  }

  const results: SearchResult[] = [];
  const seenIds = new Set<string>();

  // Pass 1: Name-based matching ranked by exact > prefix > contains
  try {
    let nameSql = `SELECT id, name, type, observation_ids FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE`;
    const nameParams: unknown[] = [`%${query}%`];

    if (projectFilter) {
      nameSql += ' AND project_hash = ?';
      nameParams.push(projectFilter);
    }
    if (typeFilter) {
      nameSql += ' AND type = ?';
      nameParams.push(typeFilter);
    }

    nameSql += ' LIMIT 100';

    const rows = db.prepare(nameSql).all(...nameParams) as GraphNodeRow[];

    // Rank results: exact > prefix > contains
    const lowerQuery = query.toLowerCase();
    const ranked = rows.map(row => {
      const lowerName = row.name.toLowerCase();
      let rank: 'exact' | 'prefix' | 'contains';
      if (lowerName === lowerQuery) {
        rank = 'exact';
      } else if (lowerName.startsWith(lowerQuery)) {
        rank = 'prefix';
      } else {
        rank = 'contains';
      }
      return { row, rank };
    });

    const rankOrder = { exact: 0, prefix: 1, contains: 2 };
    ranked.sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank]);

    for (const { row, rank } of ranked) {
      if (results.length >= limit) break;
      seenIds.add(row.id);
      results.push({
        id: row.id,
        label: row.name,
        type: row.type,
        observationCount: safeParseJsonArray(row.observation_ids).length,
        matchSource: rank,
        snippet: null,
      });
    }
  } catch { /* graph_nodes may not exist */ }

  // Pass 2: FTS fallback if name matching returned sparse results
  if (results.length < limit) {
    try {
      // Check if observations_fts table exists
      const ftsCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
      ).get();

      if (ftsCheck) {
        let ftsSql = `
          SELECT o.id AS obs_id, o.content, o.title,
                 gn.id AS node_id, gn.name, gn.type, gn.observation_ids
          FROM observations_fts fts
          JOIN observations o ON o.id = fts.rowid
          JOIN graph_nodes gn ON EXISTS (
            SELECT 1 FROM json_each(gn.observation_ids) je WHERE je.value = o.id
          )
          WHERE observations_fts MATCH ?
            AND o.deleted_at IS NULL`;
        const ftsParams: unknown[] = [query + '*'];

        if (projectFilter) {
          ftsSql += ' AND gn.project_hash = ?';
          ftsParams.push(projectFilter);
        }
        if (typeFilter) {
          ftsSql += ' AND gn.type = ?';
          ftsParams.push(typeFilter);
        }

        ftsSql += ' LIMIT 50';

        interface FtsRow {
          obs_id: string;
          content: string;
          title: string | null;
          node_id: string;
          name: string;
          type: string;
          observation_ids: string;
        }

        const ftsRows = db.prepare(ftsSql).all(...ftsParams) as FtsRow[];

        for (const row of ftsRows) {
          if (results.length >= limit) break;
          if (seenIds.has(row.node_id)) continue;
          seenIds.add(row.node_id);

          // Build snippet from matching observation content
          const text = row.title ? `${row.title}: ${row.content}` : row.content;
          const snippet = text.length > 120 ? text.substring(0, 120) + '...' : text;

          results.push({
            id: row.node_id,
            label: row.name,
            type: row.type,
            observationCount: safeParseJsonArray(row.observation_ids).length,
            matchSource: 'fts',
            snippet,
          });
        }
      }
    } catch { /* FTS table may not exist */ }
  }

  return c.json({ results });
});

/**
 * GET /api/graph/analysis
 *
 * Returns graph analysis insights: type distributions, top entities by degree,
 * connected components, and recent activity stats.
 * 30-second in-memory cache to avoid recomputation.
 */

let analysisCache: { key: string; data: unknown; expiry: number } | null = null;

apiRoutes.get('/graph/analysis', (c) => {
  const db = getDb(c);
  const projectFilter = getProjectHash(c);
  const cacheKey = `analysis:${projectFilter || 'all'}`;
  const now = Date.now();

  // Check cache
  if (analysisCache && analysisCache.key === cacheKey && analysisCache.expiry > now) {
    return c.json(analysisCache.data as Record<string, unknown>);
  }

  // Entity type distribution
  let entityTypes: Array<{ type: string; count: number }> = [];
  try {
    let sql = 'SELECT type, COUNT(*) as count FROM graph_nodes';
    const params: unknown[] = [];
    if (projectFilter) {
      sql += ' WHERE project_hash = ?';
      params.push(projectFilter);
    }
    sql += ' GROUP BY type ORDER BY count DESC';
    entityTypes = db.prepare(sql).all(...params) as Array<{ type: string; count: number }>;
  } catch { /* table may not exist */ }

  // Relationship type distribution
  let relationshipTypes: Array<{ type: string; count: number }> = [];
  try {
    let sql = 'SELECT type, COUNT(*) as count FROM graph_edges';
    const params: unknown[] = [];
    if (projectFilter) {
      sql += ' WHERE project_hash = ?';
      params.push(projectFilter);
    }
    sql += ' GROUP BY type ORDER BY count DESC';
    relationshipTypes = db.prepare(sql).all(...params) as Array<{ type: string; count: number }>;
  } catch { /* table may not exist */ }

  // Top 10 entities by degree (most connected)
  let topEntities: Array<{ id: string; label: string; type: string; degree: number }> = [];
  try {
    let sql = `
      SELECT gn.id, gn.name AS label, gn.type,
        (SELECT COUNT(*) FROM graph_edges e WHERE e.source_id = gn.id${projectFilter ? ' AND e.project_hash = ?' : ''})
        + (SELECT COUNT(*) FROM graph_edges e WHERE e.target_id = gn.id${projectFilter ? ' AND e.project_hash = ?' : ''})
        AS degree
      FROM graph_nodes gn`;
    const params: unknown[] = [];
    if (projectFilter) {
      sql += ' WHERE gn.project_hash = ?';
      params.push(projectFilter);
      // Two extra params for the subqueries
      params.unshift(projectFilter, projectFilter);
    }
    sql += ' ORDER BY degree DESC LIMIT 10';
    topEntities = db.prepare(sql).all(...params) as Array<{ id: string; label: string; type: string; degree: number }>;
  } catch { /* table may not exist */ }

  // Connected components via shared BFS helper
  let components: Array<{ id: number; label: string; nodeIds: string[]; nodeCount: number; edgeCount: number }> = [];
  try {
    const bfs = findConnectedComponents(db, projectFilter);
    components = bfs.components.map((comp, i) => ({
      id: i,
      label: comp.label,
      nodeIds: comp.nodeIds,
      nodeCount: comp.nodeIds.length,
      edgeCount: comp.edgeCount,
    }));
  } catch { /* tables may not exist */ }

  // Recent activity stats
  let recentActivity = { lastDay: 0, lastWeek: 0 };
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let daySql = 'SELECT COUNT(*) as count FROM graph_nodes WHERE created_at >= ?';
    let weekSql = 'SELECT COUNT(*) as count FROM graph_nodes WHERE created_at >= ?';
    const dayParams: unknown[] = [dayAgo];
    const weekParams: unknown[] = [weekAgo];

    if (projectFilter) {
      daySql += ' AND project_hash = ?';
      weekSql += ' AND project_hash = ?';
      dayParams.push(projectFilter);
      weekParams.push(projectFilter);
    }

    const dayRow = db.prepare(daySql).get(...dayParams) as { count: number } | undefined;
    const weekRow = db.prepare(weekSql).get(...weekParams) as { count: number } | undefined;
    recentActivity = {
      lastDay: dayRow?.count ?? 0,
      lastWeek: weekRow?.count ?? 0,
    };
  } catch { /* table may not exist */ }

  const result = {
    entityTypes,
    relationshipTypes,
    topEntities,
    components,
    recentActivity,
  };

  // Cache for 30 seconds
  analysisCache = { key: cacheKey, data: result, expiry: now + 30_000 };

  return c.json(result);
});

/**
 * GET /api/graph/communities
 *
 * Returns community assignments with colors from a 10-color palette.
 * Builds on the same BFS component detection as analysis.
 */
apiRoutes.get('/graph/communities', (c) => {
  const db = getDb(c);
  const projectFilter = getProjectHash(c);

  const COMMUNITY_COLORS = [
    '#58a6ff', '#3fb950', '#d2a8ff', '#f0883e', '#f85149',
    '#79c0ff', '#d29922', '#7ee787', '#f778ba', '#a5d6ff',
  ];

  interface Community {
    id: number;
    label: string;
    color: string;
    nodeIds: string[];
  }

  const communities: Community[] = [];
  let isolatedNodes: string[] = [];

  try {
    const bfs = findConnectedComponents(db, projectFilter);
    isolatedNodes = bfs.isolatedNodes;
    for (let i = 0; i < bfs.components.length; i++) {
      const comp = bfs.components[i];
      communities.push({
        id: i,
        label: comp.label,
        color: COMMUNITY_COLORS[i % COMMUNITY_COLORS.length],
        nodeIds: comp.nodeIds,
      });
    }
  } catch { /* tables may not exist */ }

  return c.json({ communities, isolatedNodes });
});

// ---------------------------------------------------------------------------
// Debug Path endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/paths
 *
 * Returns a list of recent debug paths for the current project.
 * Query params:
 *   ?limit=20  - max results (default 20, max 50)
 */
apiRoutes.get('/paths', (c) => {
  const db = getDb(c);
  const projectHash = getProjectHash(c);

  if (!projectHash) {
    return c.json({ paths: [] });
  }

  const limitStr = c.req.query('limit');
  const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 50) : 20;

  try {
    const repo = new PathRepository(db, projectHash);
    const paths = repo.listPaths(limit);
    return c.json({ paths });
  } catch (err) {
    console.error('[laminark] Failed to list paths:', err);
    return c.json({ paths: [] });
  }
});

/**
 * GET /api/paths/active
 *
 * Returns the currently active debug path for the current project.
 */
apiRoutes.get('/paths/active', (c) => {
  const db = getDb(c);
  const projectHash = getProjectHash(c);

  if (!projectHash) {
    return c.json({ path: null });
  }

  try {
    const repo = new PathRepository(db, projectHash);
    const path = repo.getActivePath();
    return c.json({ path });
  } catch (err) {
    console.error('[laminark] Failed to get active path:', err);
    return c.json({ path: null });
  }
});

/**
 * GET /api/paths/:id
 *
 * Returns a single debug path with its waypoints.
 */
apiRoutes.get('/paths/:id', (c) => {
  const db = getDb(c);
  const projectHash = getProjectHash(c);
  const pathId = c.req.param('id');

  if (!projectHash) {
    return c.json({ error: 'Path not found' }, 404);
  }

  try {
    const repo = new PathRepository(db, projectHash);
    const path = repo.getPath(pathId);

    if (!path) {
      return c.json({ error: 'Path not found' }, 404);
    }

    const waypoints: PathWaypoint[] = repo.getWaypoints(pathId);

    // Parse kiss_summary from JSON string back to object if present
    let kissSummary: unknown = null;
    if (path.kiss_summary) {
      try {
        kissSummary = JSON.parse(path.kiss_summary);
      } catch {
        kissSummary = path.kiss_summary;
      }
    }

    return c.json({
      path: { ...path, kiss_summary: kissSummary },
      waypoints,
    });
  } catch (err) {
    console.error('[laminark] Failed to get path:', err);
    return c.json({ error: 'Path not found' }, 404);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BfsComponent {
  nodeIds: string[];
  label: string;
  edgeCount: number;
}

/**
 * Finds connected components in the graph via BFS.
 * Shared by /api/graph/analysis and /api/graph/communities.
 */
function findConnectedComponents(
  db: BetterSqlite3.Database,
  projectFilter: string | null,
): { components: BfsComponent[]; isolatedNodes: string[]; adj: Map<string, Set<string>> } {
  // Fetch all nodes
  let nodesSql = 'SELECT id, name FROM graph_nodes';
  const nodesParams: unknown[] = [];
  if (projectFilter) {
    nodesSql += ' WHERE project_hash = ?';
    nodesParams.push(projectFilter);
  }
  const allNodes = db.prepare(nodesSql).all(...nodesParams) as Array<{ id: string; name: string }>;
  const nodeNameMap = new Map(allNodes.map(n => [n.id, n.name]));

  // Fetch all edges
  let edgesSql = 'SELECT source_id, target_id FROM graph_edges';
  const edgesParams: unknown[] = [];
  if (projectFilter) {
    edgesSql += ' WHERE project_hash = ?';
    edgesParams.push(projectFilter);
  }
  const allEdges = db.prepare(edgesSql).all(...edgesParams) as Array<{ source_id: string; target_id: string }>;

  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const node of allNodes) {
    adj.set(node.id, new Set());
  }
  for (const edge of allEdges) {
    if (adj.has(edge.source_id)) adj.get(edge.source_id)!.add(edge.target_id);
    if (adj.has(edge.target_id)) adj.get(edge.target_id)!.add(edge.source_id);
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const components: BfsComponent[] = [];
  const isolatedNodes: string[] = [];

  for (const nodeId of adj.keys()) {
    if (visited.has(nodeId)) continue;

    const queue = [nodeId];
    visited.add(nodeId);
    const compNodes: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      compNodes.push(current);
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Detect isolated nodes (single node, no edges)
    if (compNodes.length === 1 && (adj.get(compNodes[0])?.size ?? 0) === 0) {
      isolatedNodes.push(compNodes[0]);
      continue;
    }

    // Count edges within this component
    const compSet = new Set(compNodes);
    let edgeCount = 0;
    for (const edge of allEdges) {
      if (compSet.has(edge.source_id) && compSet.has(edge.target_id)) {
        edgeCount++;
      }
    }

    // Label by highest-degree node
    let maxDeg = -1;
    let labelNodeId = compNodes[0];
    for (const nid of compNodes) {
      const deg = (adj.get(nid) || new Set()).size;
      if (deg > maxDeg) {
        maxDeg = deg;
        labelNodeId = nid;
      }
    }

    components.push({
      nodeIds: compNodes,
      label: nodeNameMap.get(labelNodeId) || labelNodeId,
      edgeCount,
    });
  }

  // Sort by size descending
  components.sort((a, b) => b.nodeIds.length - a.nodeIds.length);

  return { components, isolatedNodes, adj };
}

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
