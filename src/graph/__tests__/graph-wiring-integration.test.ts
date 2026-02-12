/**
 * Integration tests for graph wiring (07-08).
 *
 * Proves that entity extraction populates graph_nodes, relationship detection
 * creates graph_edges, and the CurationAgent lifecycle (start/stop) works
 * without errors.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { initGraphSchema } from '../schema.js';
import { extractAndPersist } from '../entity-extractor.js';
import { detectAndPersist } from '../relationship-detector.js';
import { CurationAgent } from '../curation-agent.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = join(
    tmpdir(),
    `laminark-graph-wiring-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const db = new Database(join(tmpDir, 'test.db'));
  initGraphSchema(db);
  return { db, tmpDir };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
  cleanups.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Graph Wiring Integration', () => {
  describe('extractAndPersist creates graph nodes from observation text', () => {
    it('extracts file paths into graph_nodes', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      const text =
        'Modified src/components/Header.tsx to fix responsive layout';
      const obsId = 'obs-001';

      const nodes = extractAndPersist(db, text, obsId, {
        isChangeObservation: true,
      });

      expect(nodes.length).toBeGreaterThan(0);

      // Verify graph_nodes table has entries
      const rows = db
        .prepare('SELECT * FROM graph_nodes')
        .all() as Array<{ name: string; type: string }>;
      expect(rows.length).toBeGreaterThan(0);

      // Verify at least one File entity was extracted
      const fileNodes = rows.filter((r) => r.type === 'File');
      expect(fileNodes.length).toBeGreaterThan(0);
      expect(fileNodes.some((n) => n.name.includes('Header.tsx'))).toBe(true);
    });

    it('associates observation ID with extracted nodes', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      const obsId = 'obs-002';
      extractAndPersist(db, 'Editing src/index.ts for the server', obsId, {
        isChangeObservation: true,
      });

      const rows = db
        .prepare('SELECT observation_ids FROM graph_nodes')
        .all() as Array<{ observation_ids: string }>;
      expect(rows.length).toBeGreaterThan(0);

      // At least one node should contain our observation ID
      const hasObsId = rows.some((r) => {
        const ids = JSON.parse(r.observation_ids) as string[];
        return ids.includes(obsId);
      });
      expect(hasObsId).toBe(true);
    });
  });

  describe('detectAndPersist creates edges between extracted entities', () => {
    it('creates edges between co-occurring entities of different types', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Text with a Decision and a File that co-occur -- Decision->File has
      // a type-pair default of 'modifies' so an edge will be created.
      // Decision rule triggers on "decided to" and File rule on the path.
      const text =
        'Decided to refactor src/auth/middleware.ts for better error handling';
      const obsId = 'obs-003';

      // First extract entities (creates nodes)
      const nodes = extractAndPersist(db, text, obsId, {
        isChangeObservation: true,
      });
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      // Build entity pairs from extracted nodes
      const entityPairs = nodes.map((n) => ({
        name: n.name,
        type: n.type,
      }));

      // Detect and persist relationships
      const edges = detectAndPersist(db, text, entityPairs);

      // Verify graph_edges table has entries
      const edgeRows = db
        .prepare('SELECT * FROM graph_edges')
        .all() as Array<{ source_id: string; target_id: string; type: string }>;
      expect(edgeRows.length).toBeGreaterThan(0);

      // Edges should reference existing nodes
      const nodeIds = new Set(nodes.map((n) => n.id));
      for (const edge of edgeRows) {
        expect(nodeIds.has(edge.source_id) || nodeIds.has(edge.target_id)).toBe(
          true,
        );
      }
    });

    it('skips entity pairs with no type-pair default and no context signal', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Two File entities with neutral context -- File->File has no type-pair
      // default and words like "and" don't match any context signal, so no
      // edges should be created. Avoid verbs like "looked at", "read",
      // "modified" etc. that match CONTEXT_SIGNALS.
      const text =
        'Files src/utils/parser.ts and src/utils/lexer.ts exist in the project';
      const obsId = 'obs-003b';

      const nodes = extractAndPersist(db, text, obsId, {
        isChangeObservation: true,
      });
      // Should have at least 2 File nodes
      const fileNodes = nodes.filter((n) => n.type === 'File');
      expect(fileNodes.length).toBeGreaterThanOrEqual(2);

      const entityPairs = nodes.map((n) => ({
        name: n.name,
        type: n.type,
      }));

      const edges = detectAndPersist(db, text, entityPairs);

      // File->File with no import/require signal should produce no edges
      const edgeRows = db
        .prepare('SELECT * FROM graph_edges')
        .all() as Array<{ source_id: string; target_id: string; type: string }>;
      expect(edgeRows.length).toBe(0);
      expect(edges.length).toBe(0);
    });

    it('handles text with no relationships gracefully', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Single entity -- no pair to relate
      const nodes = extractAndPersist(db, 'Edited package.json', 'obs-004', {
        isChangeObservation: true,
      });
      const entityPairs = nodes.map((n) => ({
        name: n.name,
        type: n.type,
      }));

      // Should not throw even with 0 or 1 entities
      const edges = detectAndPersist(db, 'Edited package.json', entityPairs);
      // No crash is the assertion -- edges may be empty
      expect(Array.isArray(edges)).toBe(true);
    });
  });

  describe('CurationAgent start/stop lifecycle', () => {
    it('starts and stops without errors', async () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      const agent = new CurationAgent(db, {
        intervalMs: 100, // Short interval for testing
      });

      agent.start();
      expect(agent.isRunning()).toBe(true);

      // Wait briefly to allow at least one potential tick
      await new Promise((resolve) => setTimeout(resolve, 50));

      agent.stop();
      expect(agent.isRunning()).toBe(false);
    });

    it('runOnce completes without errors on empty graph', async () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      const agent = new CurationAgent(db);
      const report = await agent.runOnce();

      expect(report.startedAt).toBeDefined();
      expect(report.completedAt).toBeDefined();
      expect(report.observationsMerged).toBe(0);
      expect(report.entitiesDeduplicated).toBe(0);
    });

    it('calls onComplete callback after a cycle', async () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      let callbackCalled = false;
      const agent = new CurationAgent(db, {
        onComplete: () => {
          callbackCalled = true;
        },
      });

      await agent.runOnce();
      expect(callbackCalled).toBe(true);
    });
  });

  describe('End-to-end: extraction to relationship flow', () => {
    it('full pipeline from text to graph nodes and edges', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Simulate what processUnembedded does.
      // Use text with a Decision + File -- Decision->File has a type-pair
      // default of 'modifies' so edges will be created between them.
      const text =
        'Decided to update src/graph/schema.ts for the knowledge graph';
      const obsId = 'obs-end-to-end';

      // Step 1: Extract entities (mirrors processUnembedded logic)
      const nodes = extractAndPersist(db, text, obsId, {
        isChangeObservation: true,
      });

      if (nodes.length > 0) {
        // Step 2: Detect relationships (mirrors processUnembedded logic)
        const entityPairs = nodes.map((n) => ({
          name: n.name,
          type: n.type,
        }));
        detectAndPersist(db, text, entityPairs);
      }

      // Verify graph was populated
      const nodeCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM graph_nodes')
          .get() as { cnt: number }
      ).cnt;
      expect(nodeCount).toBeGreaterThan(0);

      // Should have Decision + File nodes, so edges should exist
      // Decision->File has 'modifies' type-pair default
      if (nodes.length >= 2) {
        const edgeCount = (
          db
            .prepare('SELECT COUNT(*) as cnt FROM graph_edges')
            .get() as { cnt: number }
        ).cnt;
        expect(edgeCount).toBeGreaterThan(0);
      }
    });
  });
});
