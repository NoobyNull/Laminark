import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../storage/database.js';
import { createServer } from '../../server.js';
import { registerGraphStats } from '../graph-stats.js';
import {
  initGraphSchema,
  upsertNode,
  insertEdge,
} from '../../../graph/schema.js';
import type { LaminarkDatabase } from '../../../storage/database.js';
import type { DatabaseConfig } from '../../../shared/types.js';

let tmp: string;
let config: DatabaseConfig;
let ldb: LaminarkDatabase;
const PROJECT_HASH = 'test_project_hash';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'laminark-graph-stats-test-'));
  config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
  ldb = openDatabase(config);
  initGraphSchema(ldb.db);
});

afterEach(() => {
  try {
    ldb?.close();
  } catch {
    // already closed
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('graph_stats MCP tool', () => {
  it('registers on MCP server without throwing', () => {
    const server = createServer();
    expect(() => {
      registerGraphStats(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();
  });

  it('handles empty graph gracefully (all zeros, no errors)', () => {
    // Verify empty graph queries return zero counts
    const totalNodes = (
      ldb.db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as {
        cnt: number;
      }
    ).cnt;
    const totalEdges = (
      ldb.db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as {
        cnt: number;
      }
    ).cnt;

    expect(totalNodes).toBe(0);
    expect(totalEdges).toBe(0);

    // Registration should not throw even with empty graph
    const server = createServer();
    expect(() => {
      registerGraphStats(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();
  });

  it('returns correct counts matching actual graph state', () => {
    // Insert some nodes and edges
    const fileNode = upsertNode(ldb.db, {
      type: 'File',
      name: 'src/app.ts',
      metadata: {},
      observation_ids: [],
    });

    const toolNode1 = upsertNode(ldb.db, {
      type: 'Tool',
      name: 'typescript',
      metadata: {},
      observation_ids: [],
    });

    const toolNode2 = upsertNode(ldb.db, {
      type: 'Tool',
      name: 'vitest',
      metadata: {},
      observation_ids: [],
    });

    const decisionNode = upsertNode(ldb.db, {
      type: 'Decision',
      name: 'Use TypeScript',
      metadata: {},
      observation_ids: [],
    });

    insertEdge(ldb.db, {
      source_id: fileNode.id,
      target_id: toolNode1.id,
      type: 'uses',
      weight: 0.9,
      metadata: {},
    });

    insertEdge(ldb.db, {
      source_id: fileNode.id,
      target_id: toolNode2.id,
      type: 'uses',
      weight: 0.8,
      metadata: {},
    });

    insertEdge(ldb.db, {
      source_id: fileNode.id,
      target_id: decisionNode.id,
      type: 'related_to',
      weight: 0.7,
      metadata: {},
    });

    // Verify counts
    const totalNodes = (
      ldb.db.prepare('SELECT COUNT(*) as cnt FROM graph_nodes').get() as {
        cnt: number;
      }
    ).cnt;
    expect(totalNodes).toBe(4);

    const totalEdges = (
      ldb.db.prepare('SELECT COUNT(*) as cnt FROM graph_edges').get() as {
        cnt: number;
      }
    ).cnt;
    expect(totalEdges).toBe(3);

    // Verify type distribution
    const entityCounts = ldb.db
      .prepare('SELECT type, COUNT(*) as cnt FROM graph_nodes GROUP BY type')
      .all() as Array<{ type: string; cnt: number }>;

    const typeMap = new Map(entityCounts.map((r) => [r.type, r.cnt]));
    expect(typeMap.get('File')).toBe(1);
    expect(typeMap.get('Tool')).toBe(2);
    expect(typeMap.get('Decision')).toBe(1);

    // Verify relationship distribution
    const relCounts = ldb.db
      .prepare('SELECT type, COUNT(*) as cnt FROM graph_edges GROUP BY type')
      .all() as Array<{ type: string; cnt: number }>;

    const relMap = new Map(relCounts.map((r) => [r.type, r.cnt]));
    expect(relMap.get('uses')).toBe(2);
    expect(relMap.get('related_to')).toBe(1);
  });

  it('detects duplicate candidates (same name, different type)', () => {
    // Create two nodes with the same name but different types
    upsertNode(ldb.db, {
      type: 'Tool',
      name: 'react',
      metadata: {},
      observation_ids: [],
    });

    upsertNode(ldb.db, {
      type: 'Project',
      name: 'react',
      metadata: {},
      observation_ids: [],
    });

    // Count duplicates
    const dupCount = (
      ldb.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM (
            SELECT name FROM graph_nodes GROUP BY name HAVING COUNT(DISTINCT type) > 1
          )`,
        )
        .get() as { cnt: number }
    ).cnt;

    expect(dupCount).toBe(1);
  });

  it('identifies degree for max-degree node', () => {
    // Create a hub node with many edges
    const hub = upsertNode(ldb.db, {
      type: 'File',
      name: 'src/index.ts',
      metadata: {},
      observation_ids: [],
    });

    for (let i = 0; i < 5; i++) {
      const target = upsertNode(ldb.db, {
        type: 'Tool',
        name: `tool-${i}`,
        metadata: {},
        observation_ids: [],
      });
      insertEdge(ldb.db, {
        source_id: hub.id,
        target_id: target.id,
        type: 'uses',
        weight: 0.8,
        metadata: {},
      });
    }

    // Verify hub has degree 5
    const degreeRow = ldb.db
      .prepare(
        `SELECT n.name,
                (SELECT COUNT(*) FROM graph_edges WHERE source_id = n.id OR target_id = n.id) as degree
         FROM graph_nodes n
         WHERE n.id = ?`,
      )
      .get(hub.id) as { name: string; degree: number };

    expect(degreeRow.name).toBe('src/index.ts');
    expect(degreeRow.degree).toBe(5);
  });
});
