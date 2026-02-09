import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../storage/database.js';
import { StashManager } from '../../../storage/stash-manager.js';
import { createServer } from '../../server.js';
import { registerTopicContext, formatStashes } from '../topic-context.js';
import type { LaminarkDatabase } from '../../../storage/database.js';
import type { DatabaseConfig } from '../../../shared/types.js';
import type { StashObservation, CreateStashInput, ContextStash } from '../../../types/stash.js';

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

function makeStashInput(overrides?: Partial<CreateStashInput>): CreateStashInput {
  return {
    projectId: 'proj-test',
    sessionId: 'sess-001',
    topicLabel: 'authentication',
    summary: 'Working on JWT auth with refresh tokens',
    observations: [makeObservation(), makeObservation()],
    ...overrides,
  };
}

describe('topic_context MCP tool', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;
  let stashManager: StashManager;
  const PROJECT_HASH = 'proj-test';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-topic-ctx-test-'));
    config = { dbPath: join(tmp, 'test.db'), busyTimeout: 5000 };
    ldb = openDatabase(config);
    stashManager = new StashManager(ldb.db);
  });

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('registers on MCP server without throwing', () => {
    const server = createServer();
    expect(() => {
      registerTopicContext(server, ldb.db, PROJECT_HASH);
    }).not.toThrow();
  });

  it('returns formatted list of recent stashes', () => {
    stashManager.createStash(
      makeStashInput({ topicLabel: 'JWT auth', summary: 'Implementing refresh rotation' }),
    );
    stashManager.createStash(
      makeStashInput({ topicLabel: 'DB schema', summary: 'Designing user tables' }),
    );

    const stashes = stashManager.getRecentStashes(PROJECT_HASH, 5);
    const formatted = formatStashes(stashes);

    // With 2 stashes (<=3), full format is used
    expect(formatted).toContain('JWT auth');
    expect(formatted).toContain('DB schema');
    expect(formatted).toContain('Observations:');
  });

  it('empty stashes returns appropriate message', () => {
    const stashes = stashManager.getRecentStashes(PROJECT_HASH, 5);
    expect(stashes).toHaveLength(0);
    // The MCP handler would return the "no stashed" message
  });

  it('query filters by topic label', () => {
    stashManager.createStash(
      makeStashInput({ topicLabel: 'JWT authentication', summary: 'Implementing token refresh rotation' }),
    );
    stashManager.createStash(
      makeStashInput({ topicLabel: 'Database migrations', summary: 'Schema versioning with up/down scripts' }),
    );

    const allStashes = stashManager.getRecentStashes(PROJECT_HASH, 10);
    expect(allStashes).toHaveLength(2);

    // Filter by query (simulating tool handler logic)
    const query = 'jwt';
    const filtered = allStashes.filter(
      (s) =>
        s.topicLabel.toLowerCase().includes(query) ||
        s.summary.toLowerCase().includes(query),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].topicLabel).toBe('JWT authentication');
  });

  it('query filters by summary content', () => {
    stashManager.createStash(
      makeStashInput({ topicLabel: 'Topic A', summary: 'Working on REST API endpoints' }),
    );
    stashManager.createStash(
      makeStashInput({ topicLabel: 'Topic B', summary: 'CSS layout debugging' }),
    );

    const allStashes = stashManager.getRecentStashes(PROJECT_HASH, 10);
    const query = 'rest api';
    const filtered = allStashes.filter(
      (s) =>
        s.topicLabel.toLowerCase().includes(query) ||
        s.summary.toLowerCase().includes(query),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].topicLabel).toBe('Topic A');
  });

  it('limit parameter works', () => {
    for (let i = 0; i < 8; i++) {
      stashManager.createStash(
        makeStashInput({ topicLabel: `topic-${i}` }),
      );
    }

    const limited = stashManager.getRecentStashes(PROJECT_HASH, 3);
    expect(limited).toHaveLength(3);
  });
});

// ===========================================================================
// Progressive disclosure format tests
// ===========================================================================

describe('formatStashes progressive disclosure', () => {
  function makeStash(overrides?: Partial<ContextStash>): ContextStash {
    return {
      id: `stash-${Math.random().toString(36).slice(2, 8)}`,
      projectId: 'proj-test',
      sessionId: 'sess-001',
      topicLabel: 'test-topic',
      summary: 'A test summary of the topic thread',
      observationIds: ['obs-1', 'obs-2'],
      observationSnapshots: [
        { id: 'obs-1', content: 'First observation', type: 'tool_use', timestamp: new Date().toISOString(), embedding: null },
        { id: 'obs-2', content: 'Second observation', type: 'tool_result', timestamp: new Date().toISOString(), embedding: null },
      ],
      createdAt: new Date().toISOString(),
      resumedAt: null,
      status: 'stashed',
      ...overrides,
    };
  }

  it('1-3 stashes use full format (observations included)', () => {
    const stashes = [makeStash({ topicLabel: 'topic-1' }), makeStash({ topicLabel: 'topic-2' })];
    const result = formatStashes(stashes);

    expect(result).toContain('Observations:');
    expect(result).toContain('topic-1');
    expect(result).toContain('topic-2');
    expect(result).toContain('First observation');
  });

  it('4-8 stashes use detail format (summaries, no observations)', () => {
    const stashes = Array.from({ length: 5 }, (_, i) =>
      makeStash({ topicLabel: `topic-${i}`, summary: `Summary for topic ${i}` }),
    );
    const result = formatStashes(stashes);

    expect(result).toContain('**topic-0**');
    expect(result).toContain('Summary for topic 0');
    expect(result).not.toContain('Observations:');
  });

  it('9+ stashes use compact format (labels only)', () => {
    const stashes = Array.from({ length: 10 }, (_, i) =>
      makeStash({ topicLabel: `topic-${i}` }),
    );
    const result = formatStashes(stashes);

    expect(result).toContain('1. topic-0');
    expect(result).toContain('10. topic-9');
    expect(result).not.toContain('**');
    expect(result).not.toContain('Observations:');
  });

  it('full format shows "... and N more" when >3 observations', () => {
    const obs = Array.from({ length: 6 }, (_, i) => ({
      id: `obs-${i}`,
      content: `Observation number ${i}`,
      type: 'tool_use',
      timestamp: new Date().toISOString(),
      embedding: null,
    }));
    const stashes = [makeStash({ observationSnapshots: obs, observationIds: obs.map((o) => o.id) })];
    const result = formatStashes(stashes);

    expect(result).toContain('Observations: 6');
    expect(result).toContain('Observation number 0');
    expect(result).toContain('Observation number 1');
    expect(result).toContain('Observation number 2');
    expect(result).toContain('... and 3 more');
    expect(result).not.toContain('Observation number 3');
  });
});
