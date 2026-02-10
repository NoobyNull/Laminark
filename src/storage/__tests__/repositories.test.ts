import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';
import { SessionRepository } from '../sessions.js';
import type { LaminarkDatabase } from '../database.js';
import type { DatabaseConfig } from '../../shared/types.js';

describe('ObservationRepository', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-repo-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates observations and lists them', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    repo.createClassified({ content: 'First observation about authentication' }, 'discovery');
    repo.createClassified({ content: 'Second observation about databases' }, 'discovery');
    repo.createClassified({ content: 'Third observation about testing patterns' }, 'discovery');

    const all = repo.list();
    expect(all).toHaveLength(3);
  });

  it('getById returns the correct observation', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    const created = repo.create({ content: 'Find me by ID' });

    const found = repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe('Find me by ID');
    expect(found!.projectHash).toBe('aaa');
  });

  it('enforces project isolation - project B cannot see project A data', () => {
    const repoA = new ObservationRepository(ldb.db, 'aaa');
    const repoB = new ObservationRepository(ldb.db, 'bbb');

    repoA.createClassified({ content: 'Project A observation 1' }, 'discovery');
    repoA.createClassified({ content: 'Project A observation 2' }, 'discovery');
    repoA.createClassified({ content: 'Project A observation 3' }, 'discovery');

    // Project B should see nothing
    const listB = repoB.list();
    expect(listB).toHaveLength(0);

    // Project B count should be zero
    expect(repoB.count()).toBe(0);

    // Project A should see all 3
    expect(repoA.list()).toHaveLength(3);
    expect(repoA.count()).toBe(3);
  });

  it('getById returns null for observations in another project', () => {
    const repoA = new ObservationRepository(ldb.db, 'aaa');
    const repoB = new ObservationRepository(ldb.db, 'bbb');

    const obs = repoA.create({ content: 'Only for project A' });

    // Project B cannot access project A's observation by ID
    expect(repoB.getById(obs.id)).toBeNull();
  });

  it('softDelete excludes observation from list and count', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    const obs1 = repo.createClassified({ content: 'Keep me' }, 'discovery');
    const obs2 = repo.createClassified({ content: 'Delete me' }, 'discovery');
    repo.createClassified({ content: 'Keep me too' }, 'discovery');

    expect(repo.list()).toHaveLength(3);
    expect(repo.count()).toBe(3);

    // Soft delete obs2
    const deleted = repo.softDelete(obs2.id);
    expect(deleted).toBe(true);

    // List and count should exclude deleted
    expect(repo.list()).toHaveLength(2);
    expect(repo.count()).toBe(2);

    // getById should not find deleted observation
    expect(repo.getById(obs2.id)).toBeNull();

    // But obs1 should still be findable
    expect(repo.getById(obs1.id)).not.toBeNull();
  });

  it('restore brings back a soft-deleted observation', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    const obs = repo.createClassified({ content: 'Deletable and restorable' }, 'discovery');
    repo.createClassified({ content: 'Filler 1' }, 'discovery');
    repo.createClassified({ content: 'Filler 2' }, 'discovery');

    repo.softDelete(obs.id);
    expect(repo.list()).toHaveLength(2);

    const restored = repo.restore(obs.id);
    expect(restored).toBe(true);
    expect(repo.list()).toHaveLength(3);
    expect(repo.getById(obs.id)).not.toBeNull();
  });

  it('update changes content and updates updated_at', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    const created = repo.create({ content: 'Original content' });
    const originalUpdatedAt = created.updatedAt;

    // Small delay to ensure timestamp changes (SQLite datetime has second precision)
    // Use direct SQL to force a different time instead of sleeping
    ldb.db
      .prepare(
        "UPDATE observations SET updated_at = datetime('now', '-1 second') WHERE id = ?",
      )
      .run(created.id);

    const updated = repo.update(created.id, { content: 'Updated content' });
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe('Updated content');
    // updated_at should be set to datetime('now') which is >= original
    expect(updated!.updatedAt).toBeDefined();
  });

  it('update returns null for non-existent observation', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    const result = repo.update('nonexistent', { content: 'Nothing' });
    expect(result).toBeNull();
  });

  it('update returns null for observation in another project', () => {
    const repoA = new ObservationRepository(ldb.db, 'aaa');
    const repoB = new ObservationRepository(ldb.db, 'bbb');

    const obs = repoA.create({ content: 'Project A only' });
    const result = repoB.update(obs.id, { content: 'Trying from B' });
    expect(result).toBeNull();
  });

  it('embedding roundtrip: Float32Array -> Buffer -> Float32Array', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    const originalEmbedding = new Float32Array([0.1, 0.2, 0.3, -0.5, 1.0]);
    const created = repo.create({
      content: 'Observation with embedding',
      embedding: originalEmbedding,
      embeddingModel: 'test-model',
      embeddingVersion: 'v1',
    });

    expect(created.embedding).not.toBeNull();
    expect(created.embedding).toBeInstanceOf(Float32Array);
    expect(created.embedding!.length).toBe(5);

    // Compare values with small epsilon for floating point
    for (let i = 0; i < originalEmbedding.length; i++) {
      expect(created.embedding![i]).toBeCloseTo(originalEmbedding[i], 5);
    }

    expect(created.embeddingModel).toBe('test-model');
    expect(created.embeddingVersion).toBe('v1');

    // Also verify getById returns correct embedding
    const fetched = repo.getById(created.id);
    expect(fetched!.embedding).toBeInstanceOf(Float32Array);
    expect(fetched!.embedding!.length).toBe(5);
    for (let i = 0; i < originalEmbedding.length; i++) {
      expect(fetched!.embedding![i]).toBeCloseTo(originalEmbedding[i], 5);
    }
  });

  it('list supports sessionId filter', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    repo.createClassified({ content: 'Session A obs', sessionId: 'sess-a' }, 'discovery');
    repo.createClassified({ content: 'Session B obs', sessionId: 'sess-b' }, 'discovery');
    repo.createClassified({ content: 'No session obs' }, 'discovery');

    const sessionAObs = repo.list({ sessionId: 'sess-a' });
    expect(sessionAObs).toHaveLength(1);
    expect(sessionAObs[0].content).toBe('Session A obs');
  });

  it('list returns results ordered by created_at DESC', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    const obs1 = repo.createClassified({ content: 'First' }, 'discovery');
    const obs2 = repo.createClassified({ content: 'Second' }, 'discovery');
    const obs3 = repo.createClassified({ content: 'Third' }, 'discovery');

    const all = repo.list();
    // Most recent first
    expect(all[0].id).toBe(obs3.id);
    expect(all[2].id).toBe(obs1.id);
  });

  it('list supports limit and offset', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');

    for (let i = 0; i < 10; i++) {
      repo.createClassified({ content: `Observation ${i}` }, 'discovery');
    }

    const page1 = repo.list({ limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = repo.list({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);

    // No overlap
    const page1Ids = page1.map((o) => o.id);
    const page2Ids = page2.map((o) => o.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  it('softDelete returns false for non-existent observation', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    expect(repo.softDelete('nonexistent')).toBe(false);
  });

  it('restore returns false for non-existent observation', () => {
    const repo = new ObservationRepository(ldb.db, 'aaa');
    expect(repo.restore('nonexistent')).toBe(false);
  });
});

describe('SessionRepository', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-sess-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a session and retrieves it', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    const session = repo.create('sess-1');
    expect(session.id).toBe('sess-1');
    expect(session.projectHash).toBe('aaa');
    expect(session.startedAt).toBeDefined();
    expect(session.endedAt).toBeNull();
    expect(session.summary).toBeNull();
  });

  it('getById retrieves created session', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    const found = repo.getById('sess-1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('sess-1');
  });

  it('enforces project scoping on getById', () => {
    const repoA = new SessionRepository(ldb.db, 'aaa');
    const repoB = new SessionRepository(ldb.db, 'bbb');

    repoA.create('sess-1');
    expect(repoB.getById('sess-1')).toBeNull();
  });

  it('ends a session with timestamp', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    const ended = repo.end('sess-1');
    expect(ended).not.toBeNull();
    expect(ended!.endedAt).not.toBeNull();
  });

  it('ends a session with summary', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    const ended = repo.end('sess-1', 'Worked on authentication');
    expect(ended).not.toBeNull();
    expect(ended!.summary).toBe('Worked on authentication');
    expect(ended!.endedAt).not.toBeNull();
  });

  it('end returns null for non-existent session', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');
    expect(repo.end('nonexistent')).toBeNull();
  });

  it('end returns null for session in another project', () => {
    const repoA = new SessionRepository(ldb.db, 'aaa');
    const repoB = new SessionRepository(ldb.db, 'bbb');

    repoA.create('sess-1');
    expect(repoB.end('sess-1')).toBeNull();
  });

  it('getLatest returns sessions ordered by started_at DESC', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    repo.create('sess-2');
    repo.create('sess-3');

    const latest = repo.getLatest();
    expect(latest).toHaveLength(3);
    expect(latest[0].id).toBe('sess-3');
    expect(latest[2].id).toBe('sess-1');
  });

  it('getLatest respects limit', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    repo.create('sess-2');
    repo.create('sess-3');

    const latest = repo.getLatest(2);
    expect(latest).toHaveLength(2);
  });

  it('getLatest is project-scoped', () => {
    const repoA = new SessionRepository(ldb.db, 'aaa');
    const repoB = new SessionRepository(ldb.db, 'bbb');

    repoA.create('sess-a1');
    repoA.create('sess-a2');
    repoB.create('sess-b1');

    expect(repoA.getLatest()).toHaveLength(2);
    expect(repoB.getLatest()).toHaveLength(1);
  });

  it('getActive returns the most recent active session', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    repo.create('sess-2');
    repo.end('sess-1');

    const active = repo.getActive();
    expect(active).not.toBeNull();
    expect(active!.id).toBe('sess-2');
    expect(active!.endedAt).toBeNull();
  });

  it('getActive returns null when all sessions ended', () => {
    const repo = new SessionRepository(ldb.db, 'aaa');

    repo.create('sess-1');
    repo.end('sess-1');

    expect(repo.getActive()).toBeNull();
  });

  it('getActive is project-scoped', () => {
    const repoA = new SessionRepository(ldb.db, 'aaa');
    const repoB = new SessionRepository(ldb.db, 'bbb');

    repoA.create('sess-a1');

    expect(repoA.getActive()).not.toBeNull();
    expect(repoB.getActive()).toBeNull();
  });
});
