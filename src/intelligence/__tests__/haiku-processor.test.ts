import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mock all agent modules and haiku-client
// ---------------------------------------------------------------------------

vi.mock('../haiku-classifier-agent.js', () => ({
  classifyWithHaiku: vi.fn(),
}));

vi.mock('../haiku-entity-agent.js', () => ({
  extractEntitiesWithHaiku: vi.fn(),
}));

vi.mock('../haiku-relationship-agent.js', () => ({
  inferRelationshipsWithHaiku: vi.fn(),
}));

vi.mock('../haiku-client.js', () => ({
  isHaikuEnabled: vi.fn(),
}));

// Mock SSE broadcast to prevent test side effects
vi.mock('../../web/routes/sse.js', () => ({
  broadcast: vi.fn(),
}));

import { classifyWithHaiku } from '../haiku-classifier-agent.js';
import { extractEntitiesWithHaiku } from '../haiku-entity-agent.js';
import { inferRelationshipsWithHaiku } from '../haiku-relationship-agent.js';
import { isHaikuEnabled } from '../haiku-client.js';
import { HaikuProcessor } from '../haiku-processor.js';
import { initGraphSchema } from '../../graph/schema.js';

const mockClassify = vi.mocked(classifyWithHaiku);
const mockExtract = vi.mocked(extractEntitiesWithHaiku);
const mockRelationships = vi.mocked(inferRelationshipsWithHaiku);
const mockIsEnabled = vi.mocked(isHaikuEnabled);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_HASH = 'test-project-hash';

function createTestDb(): { db: Database.Database; tmpDir: string } {
  const tmpDir = join(
    tmpdir(),
    `laminark-proc-test-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  const db = new Database(join(tmpDir, 'test.db'));
  db.pragma('foreign_keys = ON');

  // Create observations table matching the application schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      project_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      title TEXT,
      source TEXT NOT NULL,
      session_id TEXT,
      kind TEXT DEFAULT 'finding',
      classification TEXT,
      classified_at TEXT,
      embedding BLOB,
      embedding_model TEXT,
      embedding_version TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    )
  `);

  // Init graph schema for entity/edge persistence
  initGraphSchema(db);

  return { db, tmpDir };
}

function insertObservation(
  db: Database.Database,
  id: string,
  content: string,
  source: string = 'hook:Bash',
): void {
  db.prepare(`
    INSERT INTO observations (id, project_hash, content, source, kind)
    VALUES (?, ?, ?, ?, 'finding')
  `).run(id, PROJECT_HASH, content, source);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HaikuProcessor', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const setup = createTestDb();
    db = setup.db;
    tmpDir = setup.tmpDir;
    mockIsEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('processOnce', () => {
    it('skips when Haiku is not enabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      insertObservation(db, 'obs-1', 'test content');

      const processor = new HaikuProcessor(db, PROJECT_HASH);
      await processor.processOnce();

      expect(mockClassify).not.toHaveBeenCalled();
    });

    it('skips when no unclassified observations exist', async () => {
      const processor = new HaikuProcessor(db, PROJECT_HASH);
      await processor.processOnce();

      expect(mockClassify).not.toHaveBeenCalled();
    });

    it('classifies noise observation and soft-deletes it', async () => {
      insertObservation(db, 'obs-noise', 'npm WARN deprecated glob@7.2.3');

      mockClassify.mockResolvedValue({
        signal: 'noise',
        classification: null,
        reason: 'build output',
      });

      const processor = new HaikuProcessor(db, PROJECT_HASH);
      await processor.processOnce();

      expect(mockClassify).toHaveBeenCalledOnce();
      // Entity extraction should NOT be called for noise
      expect(mockExtract).not.toHaveBeenCalled();

      // Observation should be soft-deleted
      const row = db
        .prepare('SELECT deleted_at, classification FROM observations WHERE id = ?')
        .get('obs-noise') as { deleted_at: string | null; classification: string | null };
      expect(row.deleted_at).not.toBeNull();
      expect(row.classification).toBe('noise');
    });

    it('classifies signal observation and extracts entities', async () => {
      // Use hook:Write so isChange=true and File entities pass the quality gate
      insertObservation(db, 'obs-signal', 'Modified src/auth.ts for JWT tokens', 'hook:Write');

      mockClassify.mockResolvedValue({
        signal: 'signal',
        classification: 'discovery',
        reason: 'new finding',
      });
      mockExtract.mockResolvedValue([
        { name: 'src/auth.ts', type: 'File', confidence: 0.95 },
      ]);

      const processor = new HaikuProcessor(db, PROJECT_HASH);
      await processor.processOnce();

      expect(mockClassify).toHaveBeenCalledOnce();
      expect(mockExtract).toHaveBeenCalledOnce();

      // Observation should be classified but NOT soft-deleted
      const row = db
        .prepare('SELECT deleted_at, classification FROM observations WHERE id = ?')
        .get('obs-signal') as { deleted_at: string | null; classification: string | null };
      expect(row.deleted_at).toBeNull();
      expect(row.classification).toBe('discovery');

      // Graph node should exist
      const node = db
        .prepare('SELECT * FROM graph_nodes WHERE name = ?')
        .get('src/auth.ts') as { name: string; type: string } | undefined;
      expect(node).toBeDefined();
      expect(node!.type).toBe('File');
    });

    it('infers relationships when 2+ entities found', async () => {
      // Use hook:Write so File entities pass the quality gate at 0.95 threshold
      insertObservation(db, 'obs-multi', 'src/auth.ts references the React docs', 'hook:Write');

      mockClassify.mockResolvedValue({
        signal: 'signal',
        classification: 'discovery',
        reason: 'meaningful',
      });
      mockExtract.mockResolvedValue([
        { name: 'src/auth.ts', type: 'File', confidence: 0.95 },
        { name: 'React docs', type: 'Reference', confidence: 0.9 },
      ]);
      mockRelationships.mockResolvedValue([
        { source: 'src/auth.ts', target: 'React docs', type: 'references', confidence: 0.8 },
      ]);

      const processor = new HaikuProcessor(db, PROJECT_HASH);
      await processor.processOnce();

      expect(mockRelationships).toHaveBeenCalledOnce();

      // Graph edge should exist
      const edges = db
        .prepare('SELECT * FROM graph_edges')
        .all() as Array<{ type: string }>;
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].type).toBe('references');
    });

    it('handles classification failure gracefully', async () => {
      insertObservation(db, 'obs-fail', 'some content');

      mockClassify.mockRejectedValue(new Error('API timeout'));

      const processor = new HaikuProcessor(db, PROJECT_HASH);
      // Should not throw
      await processor.processOnce();

      // Observation should remain unclassified for retry
      const row = db
        .prepare('SELECT classification FROM observations WHERE id = ?')
        .get('obs-fail') as { classification: string | null };
      expect(row.classification).toBeNull();
    });

    it('handles entity extraction failure gracefully', async () => {
      insertObservation(db, 'obs-ent-fail', 'some content');

      mockClassify.mockResolvedValue({
        signal: 'signal',
        classification: 'discovery',
        reason: 'finding',
      });
      mockExtract.mockRejectedValue(new Error('Extraction failed'));

      const processor = new HaikuProcessor(db, PROJECT_HASH);
      // Should not throw
      await processor.processOnce();

      // Classification should still succeed
      const row = db
        .prepare('SELECT classification FROM observations WHERE id = ?')
        .get('obs-ent-fail') as { classification: string | null };
      expect(row.classification).toBe('discovery');
    });
  });

  describe('start/stop', () => {
    it('starts and stops timer cleanly', () => {
      vi.useFakeTimers();
      try {
        const processor = new HaikuProcessor(db, PROJECT_HASH, {
          intervalMs: 1000,
        });

        processor.start();
        // Starting again should be a no-op (no duplicate timers)
        processor.start();

        processor.stop();
        // Stopping again should be safe
        processor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires processOnce on interval tick', async () => {
      vi.useFakeTimers();
      try {
        const processor = new HaikuProcessor(db, PROJECT_HASH, {
          intervalMs: 500,
        });

        processor.start();

        // Advance past one interval
        await vi.advanceTimersByTimeAsync(600);

        // isHaikuEnabled is called during processOnce
        expect(mockIsEnabled).toHaveBeenCalled();

        processor.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
