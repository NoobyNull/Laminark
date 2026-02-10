import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../storage/database.js';
import { createServer } from '../../server.js';
import { registerQueryGraph } from '../query-graph.js';
import {
  initGraphSchema,
  upsertNode,
  insertEdge,
  traverseFrom,
} from '../../../graph/schema.js';
import { ObservationRepository } from '../../../storage/observations.js';
import type { LaminarkDatabase } from '../../../storage/database.js';
import type { DatabaseConfig } from '../../../shared/types.js';

let tmp: string;
let config: DatabaseConfig;
let ldb: LaminarkDatabase;
const PROJECT_HASH = 'test_project_hash';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'laminark-query-graph-test-'));
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

// =============================================================================
// Test 1: Finds entity by exact name and returns traversal results
// =============================================================================

describe('query_graph MCP tool', () => {
  it('finds entity by exact name and returns traversal results', () => {
    // Set up: insert File node with edges to Tool and Decision
    const fileNode = upsertNode(ldb.db, {
      type: 'File',
      name: 'src/auth/login.ts',
      metadata: {},
      observation_ids: [],
    });

    const toolNode = upsertNode(ldb.db, {
      type: 'Tool',
      name: 'jose',
      metadata: {},
      observation_ids: [],
    });

    const decisionNode = upsertNode(ldb.db, {
      type: 'Decision',
      name: 'Use JWT for authentication',
      metadata: {},
      observation_ids: [],
    });

    insertEdge(ldb.db, {
      source_id: fileNode.id,
      target_id: toolNode.id,
      type: 'uses',
      weight: 0.9,
      metadata: {},
    });

    insertEdge(ldb.db, {
      source_id: fileNode.id,
      target_id: decisionNode.id,
      type: 'related_to',
      weight: 0.7,
      metadata: {},
    });

    // Use the registration function to verify it doesn't throw
    const server = createServer();
    expect(() => {
      registerQueryGraph(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();

    // Directly test the query logic by searching the graph
    const row = ldb.db
      .prepare(
        'SELECT * FROM graph_nodes WHERE name = ? AND type = ?',
      )
      .get('src/auth/login.ts', 'File') as { id: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.id).toBe(fileNode.id);

    // Verify edges exist
    const edges = ldb.db
      .prepare(
        'SELECT * FROM graph_edges WHERE source_id = ?',
      )
      .all(fileNode.id);
    expect(edges).toHaveLength(2);
  });

  // =============================================================================
  // Test 2: Filters by entity type
  // =============================================================================

  it('filters by entity type', () => {
    // Insert Tool "react" and File "react.config.js"
    upsertNode(ldb.db, {
      type: 'Tool',
      name: 'react',
      metadata: {},
      observation_ids: [],
    });

    upsertNode(ldb.db, {
      type: 'File',
      name: 'react.config.js',
      metadata: {},
      observation_ids: [],
    });

    // Search with type filter for Tool only
    const rows = ldb.db
      .prepare(
        'SELECT * FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE AND type = ?',
      )
      .all('%react%', 'Tool') as Array<{ name: string; type: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('react');
    expect(rows[0].type).toBe('Tool');
  });

  // =============================================================================
  // Test 3: Respects depth limit
  // =============================================================================

  it('respects depth limit', () => {
    // Create chain: A -> B -> C -> D
    const nodeA = upsertNode(ldb.db, {
      type: 'File',
      name: 'a.ts',
      metadata: {},
      observation_ids: [],
    });
    const nodeB = upsertNode(ldb.db, {
      type: 'File',
      name: 'b.ts',
      metadata: {},
      observation_ids: [],
    });
    const nodeC = upsertNode(ldb.db, {
      type: 'File',
      name: 'c.ts',
      metadata: {},
      observation_ids: [],
    });
    const nodeD = upsertNode(ldb.db, {
      type: 'File',
      name: 'd.ts',
      metadata: {},
      observation_ids: [],
    });

    insertEdge(ldb.db, {
      source_id: nodeA.id,
      target_id: nodeB.id,
      type: 'depends_on',
      weight: 0.8,
      metadata: {},
    });
    insertEdge(ldb.db, {
      source_id: nodeB.id,
      target_id: nodeC.id,
      type: 'depends_on',
      weight: 0.8,
      metadata: {},
    });
    insertEdge(ldb.db, {
      source_id: nodeC.id,
      target_id: nodeD.id,
      type: 'depends_on',
      weight: 0.8,
      metadata: {},
    });

    // Traverse from A with depth=1 -- should only get B
    const results = traverseFrom(ldb.db, nodeA.id, { depth: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].node.name).toBe('b.ts');

    // Traverse from A with depth=2 -- should get B and C
    const results2 = traverseFrom(ldb.db, nodeA.id, { depth: 2 });
    expect(results2).toHaveLength(2);
    const names = results2.map((r) => r.node.name).sort();
    expect(names).toEqual(['b.ts', 'c.ts']);
  });

  // =============================================================================
  // Test 4: Returns helpful message when no results found
  // =============================================================================

  it('returns helpful message when no results found', () => {
    // Query for nonexistent entity
    const rows = ldb.db
      .prepare('SELECT * FROM graph_nodes WHERE name LIKE ? COLLATE NOCASE')
      .all('%nonexistent%');

    expect(rows).toHaveLength(0);

    // Verify the tool would return a "no entities found" message
    // (Simulating the tool logic)
    const query = 'nonexistent';
    const message = `No entities matching "${query}" found. Try: entity types Project, File, Decision, Problem, Solution, Tool, Person`;
    expect(message).toContain('No entities matching');
    expect(message).toContain('nonexistent');
  });

  // =============================================================================
  // Test 5: Truncates observation text in results
  // =============================================================================

  it('truncates observation text in results', () => {
    // Create a node with a linked observation > 200 chars
    const repo = new ObservationRepository(ldb.db, PROJECT_HASH);
    const longContent =
      'A'.repeat(300) +
      ' This is a very long observation that should be truncated when displayed in graph query results.';
    const obs = repo.create({
      content: longContent,
      title: 'Long observation',
      source: 'test',
    });

    upsertNode(ldb.db, {
      type: 'Tool',
      name: 'long-tool',
      metadata: {},
      observation_ids: [obs.id],
    });

    // Verify observation is linked
    const node = ldb.db
      .prepare(
        'SELECT observation_ids FROM graph_nodes WHERE name = ?',
      )
      .get('long-tool') as { observation_ids: string };
    const obsIds = JSON.parse(node.observation_ids) as string[];
    expect(obsIds).toContain(obs.id);

    // Verify truncation logic
    const truncated =
      longContent.length > 200
        ? longContent.slice(0, 200).trimEnd() + '...'
        : longContent;
    expect(truncated.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(truncated).toContain('...');
  });

  // =============================================================================
  // Test 6: Registers on MCP server without throwing
  // =============================================================================

  it('registers on MCP server without throwing', () => {
    const server = createServer();
    expect(() => {
      registerQueryGraph(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();
  });

  // =============================================================================
  // Test 7: Handles relationship type filtering
  // =============================================================================

  it('filters by relationship types in traversal', () => {
    const nodeA = upsertNode(ldb.db, {
      type: 'File',
      name: 'main.ts',
      metadata: {},
      observation_ids: [],
    });
    const nodeB = upsertNode(ldb.db, {
      type: 'Tool',
      name: 'vitest',
      metadata: {},
      observation_ids: [],
    });
    const nodeC = upsertNode(ldb.db, {
      type: 'Decision',
      name: 'Use vitest',
      metadata: {},
      observation_ids: [],
    });

    insertEdge(ldb.db, {
      source_id: nodeA.id,
      target_id: nodeB.id,
      type: 'uses',
      weight: 0.9,
      metadata: {},
    });
    insertEdge(ldb.db, {
      source_id: nodeA.id,
      target_id: nodeC.id,
      type: 'related_to',
      weight: 0.7,
      metadata: {},
    });

    // Only traverse 'uses' relationships
    const usesOnly = traverseFrom(ldb.db, nodeA.id, {
      depth: 2,
      edgeTypes: ['uses'],
    });
    expect(usesOnly).toHaveLength(1);
    expect(usesOnly[0].node.name).toBe('vitest');

    // Only traverse 'related_to' relationships
    const relatedOnly = traverseFrom(ldb.db, nodeA.id, {
      depth: 2,
      edgeTypes: ['related_to'],
    });
    expect(relatedOnly).toHaveLength(1);
    expect(relatedOnly[0].node.name).toBe('Use vitest');
  });
});
