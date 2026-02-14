/**
 * Integration tests for graph wiring (07-08).
 *
 * NOTE: The sync extractAndPersist() function now returns empty results because
 * the regex extraction rules were removed in Phase 17. Entity extraction is now
 * handled by HaikuProcessor via Haiku agents. Tests for the deprecated sync path
 * verify the backward-compatible empty-result behavior. Relationship detection
 * and CurationAgent lifecycle tests remain as-is since those modules are still
 * functional.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { initGraphSchema, upsertNode } from '../schema.js';
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
  describe('extractAndPersist (deprecated -- returns empty since regex rules removed)', () => {
    it('returns empty array (regex extraction rules deleted in Phase 17)', () => {
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

      // Deprecated sync path returns empty -- entity extraction now handled by HaikuProcessor
      expect(nodes).toHaveLength(0);

      // No graph nodes should be created
      const rows = db
        .prepare('SELECT * FROM graph_nodes')
        .all() as Array<{ name: string; type: string }>;
      expect(rows).toHaveLength(0);
    });

    it('returns empty array regardless of input', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      const obsId = 'obs-002';
      const nodes = extractAndPersist(db, 'Editing src/index.ts for the server', obsId, {
        isChangeObservation: true,
      });

      // Deprecated function returns empty
      expect(nodes).toHaveLength(0);
    });
  });

  describe('detectAndPersist creates edges between manually-created entities', () => {
    it('creates edges between co-occurring entities of different types', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Since extractAndPersist is deprecated and returns empty, manually create nodes
      // to test detectAndPersist in isolation.
      const decisionNode = upsertNode(db, {
        type: 'Decision',
        name: 'refactor middleware',
        metadata: {},
        observation_ids: ['obs-003'],
      });
      const fileNode = upsertNode(db, {
        type: 'File',
        name: 'src/auth/middleware.ts',
        metadata: {},
        observation_ids: ['obs-003'],
      });

      const text =
        'Decided to refactor middleware for src/auth/middleware.ts';
      const entityPairs = [
        { name: 'refactor middleware', type: 'Decision' as const },
        { name: 'src/auth/middleware.ts', type: 'File' as const },
      ];

      const edges = detectAndPersist(db, text, entityPairs);

      const edgeRows = db
        .prepare('SELECT * FROM graph_edges')
        .all() as Array<{ source_id: string; target_id: string; type: string }>;
      expect(edgeRows.length).toBeGreaterThan(0);
    });

    it('skips entity pairs with no type-pair default and no context signal', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      upsertNode(db, {
        type: 'File',
        name: 'src/utils/parser.ts',
        metadata: {},
        observation_ids: ['obs-003b'],
      });
      upsertNode(db, {
        type: 'File',
        name: 'src/utils/lexer.ts',
        metadata: {},
        observation_ids: ['obs-003b'],
      });

      // Neutral text -- no context signals for File->File
      const text =
        'Files src/utils/parser.ts and src/utils/lexer.ts exist in the project';
      const entityPairs = [
        { name: 'src/utils/parser.ts', type: 'File' as const },
        { name: 'src/utils/lexer.ts', type: 'File' as const },
      ];

      const edges = detectAndPersist(db, text, entityPairs);
      expect(edges).toHaveLength(0);
    });

    it('handles empty entity list gracefully', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Should not throw with empty entities
      const edges = detectAndPersist(db, 'Edited package.json', []);
      expect(Array.isArray(edges)).toBe(true);
      expect(edges).toHaveLength(0);
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

  describe('End-to-end: deprecated sync extraction returns empty', () => {
    it('deprecated extractAndPersist returns empty -- live pipeline uses HaikuProcessor', () => {
      const { db, tmpDir } = createTempDb();
      cleanups.push(() => {
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
      });

      const text =
        'Decided to update src/graph/schema.ts for the knowledge graph';
      const obsId = 'obs-end-to-end';

      // Deprecated sync path returns empty since regex rules were deleted
      const nodes = extractAndPersist(db, text, obsId, {
        isChangeObservation: true,
      });
      expect(nodes).toHaveLength(0);

      // No graph nodes created via deprecated path
      const nodeCount = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM graph_nodes')
          .get() as { cnt: number }
      ).cnt;
      expect(nodeCount).toBe(0);
    });
  });
});
