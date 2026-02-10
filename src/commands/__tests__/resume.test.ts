import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../storage/database.js';
import { StashManager } from '../../storage/stash-manager.js';
import { handleResumeCommand, timeAgo } from '../resume.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';
import type { StashObservation, CreateStashInput } from '../../types/stash.js';

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

describe('handleResumeCommand', () => {
  let tmp: string;
  let config: DatabaseConfig;
  let ldb: LaminarkDatabase;
  let stashManager: StashManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'laminark-resume-test-'));
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

  // =========================================================================
  // List mode
  // =========================================================================

  it('list mode with no stashes returns "no stashed" message', async () => {
    const result = await handleResumeCommand(
      { projectId: 'proj-test' },
      { stashManager },
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('No stashed context threads found.');
    expect(result.context).toBeUndefined();
  });

  it('list mode with stashes returns formatted list with topic labels and time', async () => {
    stashManager.createStash(
      makeStashInput({ topicLabel: 'JWT auth', summary: 'Implementing JWT refresh token rotation' }),
    );
    stashManager.createStash(
      makeStashInput({ topicLabel: 'Database schema', summary: 'Designing the user table with roles' }),
    );

    const result = await handleResumeCommand(
      { projectId: 'proj-test' },
      { stashManager },
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Stashed context threads:');
    expect(result.message).toContain('JWT auth');
    expect(result.message).toContain('Database schema');
    expect(result.message).toContain('Use /laminark:resume {id} to restore a thread.');
  });

  it('list mode excludes resumed stashes', async () => {
    const stash1 = stashManager.createStash(
      makeStashInput({ topicLabel: 'active-topic' }),
    );
    const stash2 = stashManager.createStash(
      makeStashInput({ topicLabel: 'resumed-topic' }),
    );
    stashManager.resumeStash(stash2.id);

    const result = await handleResumeCommand(
      { projectId: 'proj-test' },
      { stashManager },
    );

    expect(result.message).toContain('active-topic');
    expect(result.message).not.toContain('resumed-topic');
  });

  // =========================================================================
  // Resume mode
  // =========================================================================

  it('resume mode with valid ID returns observations and marks as resumed', async () => {
    const obs = [
      makeObservation({ id: 'obs-aaa', content: 'First observation' }),
      makeObservation({ id: 'obs-bbb', content: 'Second observation' }),
    ];
    const stash = stashManager.createStash(
      makeStashInput({ topicLabel: 'JWT auth', observations: obs }),
    );

    const result = await handleResumeCommand(
      { projectId: 'proj-test', stashId: stash.id },
      { stashManager },
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Resumed: "JWT auth"');
    expect(result.message).toContain('2 observations');
    expect(result.context).toHaveLength(2);
    expect(result.context![0].id).toBe('obs-aaa');
    expect(result.context![1].id).toBe('obs-bbb');

    // Verify stash status updated
    const updated = stashManager.getStash(stash.id);
    expect(updated!.status).toBe('resumed');
    expect(updated!.resumedAt).not.toBeNull();
  });

  it('resume mode with invalid ID returns error', async () => {
    const result = await handleResumeCommand(
      { projectId: 'proj-test', stashId: 'nonexistent-id' },
      { stashManager },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Stash not found: nonexistent-id');
    expect(result.context).toBeUndefined();
  });
});

// ===========================================================================
// timeAgo helper
// ===========================================================================

describe('timeAgo', () => {
  const now = new Date('2026-02-09T12:00:00Z');

  it('returns "just now" for very recent dates', () => {
    expect(timeAgo('2026-02-09T11:59:30Z', now)).toBe('just now');
  });

  it('returns minutes ago', () => {
    expect(timeAgo('2026-02-09T11:55:00Z', now)).toBe('5 minutes ago');
  });

  it('returns "1 minute ago" for singular', () => {
    expect(timeAgo('2026-02-09T11:58:50Z', now)).toBe('1 minute ago');
  });

  it('returns hours ago', () => {
    expect(timeAgo('2026-02-09T09:00:00Z', now)).toBe('3 hours ago');
  });

  it('returns "1 hour ago" for singular', () => {
    expect(timeAgo('2026-02-09T10:50:00Z', now)).toBe('1 hour ago');
  });

  it('returns "yesterday" for 1 day ago', () => {
    expect(timeAgo('2026-02-08T12:00:00Z', now)).toBe('yesterday');
  });

  it('returns days ago', () => {
    expect(timeAgo('2026-02-04T12:00:00Z', now)).toBe('5 days ago');
  });

  it('returns months ago', () => {
    expect(timeAgo('2025-11-09T12:00:00Z', now)).toBe('3 months ago');
  });

  it('returns "just now" for future dates', () => {
    expect(timeAgo('2026-02-10T00:00:00Z', now)).toBe('just now');
  });
});
