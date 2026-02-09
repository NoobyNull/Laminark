import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.js';
import { StashManager } from '../stash-manager.js';
import type { LaminarkDatabase } from '../database.js';
import type { DatabaseConfig } from '../../shared/types.js';
import type { CreateStashInput, StashObservation } from '../../types/stash.js';

/**
 * Creates a test StashObservation with optional overrides.
 */
function makeObservation(overrides?: Partial<StashObservation>): StashObservation {
  return {
    id: `obs-${Math.random().toString(36).slice(2, 8)}`,
    content: 'Test observation content',
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    embedding: null,
    ...overrides,
  };
}

/**
 * Creates a test CreateStashInput with optional overrides.
 */
function makeStashInput(overrides?: Partial<CreateStashInput>): CreateStashInput {
  return {
    projectId: 'proj-aaa',
    sessionId: 'sess-001',
    topicLabel: 'authentication',
    summary: 'Working on JWT auth with refresh tokens',
    observations: [makeObservation(), makeObservation()],
    ...overrides,
  };
}

describe('StashManager', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;
  let manager: StashManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-stash-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
    manager = new StashManager(ldb.db);
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a stash and verifies all fields persisted including JSON round-trip of observations', () => {
    const observations: StashObservation[] = [
      {
        id: 'obs-1',
        content: 'User asked about JWT tokens',
        type: 'tool_use',
        timestamp: '2026-02-09T00:00:00Z',
        embedding: [0.1, 0.2, 0.3],
      },
      {
        id: 'obs-2',
        content: 'Implemented refresh token rotation',
        type: 'tool_result',
        timestamp: '2026-02-09T00:01:00Z',
        embedding: null,
      },
    ];

    const input = makeStashInput({
      topicLabel: 'jwt-auth',
      summary: 'JWT authentication with refresh rotation',
      observations,
    });

    const stash = manager.createStash(input);

    expect(stash.id).toBeDefined();
    expect(stash.id).toHaveLength(32); // randomBytes(16).toString('hex')
    expect(stash.projectId).toBe('proj-aaa');
    expect(stash.sessionId).toBe('sess-001');
    expect(stash.topicLabel).toBe('jwt-auth');
    expect(stash.summary).toBe('JWT authentication with refresh rotation');
    expect(stash.status).toBe('stashed');
    expect(stash.createdAt).toBeDefined();
    expect(stash.resumedAt).toBeNull();

    // Observation IDs round-trip
    expect(stash.observationIds).toEqual(['obs-1', 'obs-2']);

    // Observation snapshots round-trip (full JSON fidelity)
    expect(stash.observationSnapshots).toHaveLength(2);
    expect(stash.observationSnapshots[0].id).toBe('obs-1');
    expect(stash.observationSnapshots[0].content).toBe('User asked about JWT tokens');
    expect(stash.observationSnapshots[0].type).toBe('tool_use');
    expect(stash.observationSnapshots[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(stash.observationSnapshots[1].id).toBe('obs-2');
    expect(stash.observationSnapshots[1].embedding).toBeNull();
  });

  it('lists stashes in correct order (most recent first)', () => {
    // Create stashes with slight timestamp differences via direct SQL manipulation
    const stash1 = manager.createStash(makeStashInput({ topicLabel: 'topic-1' }));
    // Force stash1 to have an older created_at
    ldb.db
      .prepare("UPDATE context_stashes SET created_at = datetime('now', '-10 seconds') WHERE id = ?")
      .run(stash1.id);

    const stash2 = manager.createStash(makeStashInput({ topicLabel: 'topic-2' }));

    const stashes = manager.listStashes('proj-aaa');
    expect(stashes).toHaveLength(2);
    expect(stashes[0].topicLabel).toBe('topic-2'); // Most recent first
    expect(stashes[1].topicLabel).toBe('topic-1');
  });

  it('filters by session_id', () => {
    manager.createStash(makeStashInput({ sessionId: 'sess-A' }));
    manager.createStash(makeStashInput({ sessionId: 'sess-B' }));
    manager.createStash(makeStashInput({ sessionId: 'sess-A' }));

    const sessAStashes = manager.listStashes('proj-aaa', { sessionId: 'sess-A' });
    expect(sessAStashes).toHaveLength(2);

    const sessBStashes = manager.listStashes('proj-aaa', { sessionId: 'sess-B' });
    expect(sessBStashes).toHaveLength(1);
  });

  it('resumeStash updates status and resumed_at', () => {
    const stash = manager.createStash(makeStashInput());
    expect(stash.status).toBe('stashed');
    expect(stash.resumedAt).toBeNull();

    const resumed = manager.resumeStash(stash.id);
    expect(resumed.status).toBe('resumed');
    expect(resumed.resumedAt).not.toBeNull();
    expect(resumed.id).toBe(stash.id);
  });

  it('getRecentStashes excludes resumed stashes', () => {
    const stash1 = manager.createStash(makeStashInput({ topicLabel: 'active-1' }));
    manager.createStash(makeStashInput({ topicLabel: 'active-2' }));
    const stash3 = manager.createStash(makeStashInput({ topicLabel: 'resumed-1' }));

    // Resume stash3
    manager.resumeStash(stash3.id);

    const recent = manager.getRecentStashes('proj-aaa');
    expect(recent).toHaveLength(2);
    expect(recent.map((s) => s.topicLabel)).toContain('active-1');
    expect(recent.map((s) => s.topicLabel)).toContain('active-2');
    expect(recent.map((s) => s.topicLabel)).not.toContain('resumed-1');
  });

  it('getStash returns null for nonexistent ID', () => {
    const result = manager.getStash('nonexistent-id');
    expect(result).toBeNull();
  });

  it('deleteStash removes the stash record', () => {
    const stash = manager.createStash(makeStashInput());
    expect(manager.getStash(stash.id)).not.toBeNull();

    manager.deleteStash(stash.id);
    expect(manager.getStash(stash.id)).toBeNull();
  });

  it('listStashes respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      manager.createStash(makeStashInput({ topicLabel: `topic-${i}` }));
    }

    const limited = manager.listStashes('proj-aaa', { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('listStashes scopes to project_id', () => {
    manager.createStash(makeStashInput({ projectId: 'proj-aaa' }));
    manager.createStash(makeStashInput({ projectId: 'proj-bbb' }));

    const projA = manager.listStashes('proj-aaa');
    expect(projA).toHaveLength(1);

    const projB = manager.listStashes('proj-bbb');
    expect(projB).toHaveLength(1);
  });

  it('resumeStash throws for nonexistent ID', () => {
    expect(() => manager.resumeStash('nonexistent')).toThrow('Stash not found');
  });
});
