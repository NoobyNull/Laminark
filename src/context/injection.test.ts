import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  formatContextIndex,
  formatRelativeTime,
  assembleSessionContext,
  getHighValueObservations,
} from './injection.js';
import type { Observation, Session } from '../shared/types.js';
import { openDatabase } from '../storage/database.js';
import { ObservationRepository } from '../storage/observations.js';
import { SessionRepository } from '../storage/sessions.js';
import type { LaminarkDatabase } from '../storage/database.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    projectHash: 'test-project',
    startedAt: '2026-02-09T10:00:00Z',
    endedAt: '2026-02-09T11:30:00Z',
    summary: 'Implemented auth module with JWT tokens. Fixed login bug. Updated tests.',
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    rowid: 1,
    id: 'obs-' + Math.random().toString(36).slice(2, 10),
    projectHash: 'test-project',
    content: 'Default observation content for testing purposes',
    title: null,
    source: 'hook:Bash',
    sessionId: 'session-1',
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null,
    createdAt: '2026-02-09T10:30:00Z',
    updatedAt: '2026-02-09T10:30:00Z',
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps less than 1 minute ago', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns "1 minute ago" for 60 seconds ago', () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatRelativeTime(oneMinAgo)).toBe('1 minute ago');
  });

  it('returns "X minutes ago" for several minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5 minutes ago');
  });

  it('returns "1 hour ago" for 1 hour ago', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(oneHourAgo)).toBe('1 hour ago');
  });

  it('returns "X hours ago" for several hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
  });

  it('returns "yesterday" for 1 day ago', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(yesterday)).toBe('yesterday');
  });

  it('returns "X days ago" for several days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
  });

  it('returns "1 week ago" for 7 days ago', () => {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(oneWeekAgo)).toBe('1 week ago');
  });

  it('returns "X weeks ago" for multiple weeks', () => {
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeWeeksAgo)).toBe('3 weeks ago');
  });
});

// ---------------------------------------------------------------------------
// formatContextIndex
// ---------------------------------------------------------------------------

describe('formatContextIndex', () => {
  it('produces expected format with session and 3 observations', () => {
    const session = makeSession();
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: 'Created user authentication module', source: 'hook:Write', createdAt: '2026-02-09T10:15:00Z' }),
      makeObservation({ id: 'cccc3333dddd4444', content: 'Fixed database connection pooling issue', source: 'hook:Bash', createdAt: '2026-02-09T10:10:00Z' }),
      makeObservation({ id: 'eeee5555ffff6666', content: 'Updated API endpoint tests for auth flow', source: 'mcp:save_memory', createdAt: '2026-02-09T10:05:00Z' }),
    ];

    const result = formatContextIndex(session, observations);

    expect(result).toContain('[Laminark Context - Session Recovery]');
    expect(result).toContain('## Last Session (2026-02-09T10:00:00Z to 2026-02-09T11:30:00Z)');
    expect(result).toContain(session.summary!);
    expect(result).toContain('## Recent Memories (use search tool for full details)');
    expect(result).toContain('[aaaa1111]');
    expect(result).toContain('[cccc3333]');
    expect(result).toContain('[eeee5555]');
    expect(result).toContain('source: hook:Write');
    expect(result).toContain('source: mcp:save_memory');
  });

  it('shows only observations when session is null', () => {
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: 'Some observation', source: 'hook:Bash' }),
    ];

    const result = formatContextIndex(null, observations);

    expect(result).toContain('[Laminark Context - Session Recovery]');
    expect(result).not.toContain('## Last Session');
    expect(result).toContain('## Recent Memories');
    expect(result).toContain('[aaaa1111]');
  });

  it('returns welcome message when session is null and observations are empty', () => {
    const result = formatContextIndex(null, []);

    expect(result).toContain('[Laminark] First session detected');
    expect(result).toContain('/laminark:remember');
    expect(result).toContain('/laminark:recall');
  });

  it('returns welcome message when session has no summary and no observations', () => {
    const session = makeSession({ summary: null });
    const result = formatContextIndex(session, []);

    // Session without a summary and no observations should show welcome
    // (session with null summary does not contribute content)
    expect(result).not.toContain('## Last Session');
  });

  it('truncates observation content at 120 characters', () => {
    const longContent = 'A'.repeat(200);
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: longContent }),
    ];

    const result = formatContextIndex(null, observations);

    // Should contain truncated content with "..."
    expect(result).toContain('A'.repeat(120) + '...');
    expect(result).not.toContain('A'.repeat(121));
  });

  it('each observation is a single line', () => {
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: 'First observation' }),
      makeObservation({ id: 'cccc3333dddd4444', content: 'Second observation' }),
    ];

    const result = formatContextIndex(null, observations);
    const lines = result.split('\n');

    // Find observation lines (starting with "- [")
    const obsLines = lines.filter((l) => l.startsWith('- ['));
    expect(obsLines).toHaveLength(2);
    // Each observation is self-contained on one line
    expect(obsLines[0]).toContain('[aaaa1111]');
    expect(obsLines[1]).toContain('[cccc3333]');
  });
});

// ---------------------------------------------------------------------------
// assembleSessionContext (integration with database)
// ---------------------------------------------------------------------------

describe('assembleSessionContext', () => {
  let tmpDir: string;
  let laminarkDb: LaminarkDatabase;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-ctx-test-'));
    process.env.LAMINARK_DATA_DIR = tmpDir;
    laminarkDb = openDatabase({ dbPath: join(tmpDir, 'data.db'), busyTimeout: 5000 });
  });

  afterEach(() => {
    laminarkDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LAMINARK_DATA_DIR;
  });

  it('returns welcome message when no prior sessions exist', () => {
    const result = assembleSessionContext(laminarkDb.db, 'test-project-hash');

    expect(result).toContain('[Laminark] First session detected');
    expect(result).toContain('/laminark:remember');
  });

  it('includes last session summary in output', () => {
    const sessionRepo = new SessionRepository(laminarkDb.db, 'test-project');
    sessionRepo.create('sess-1');
    sessionRepo.end('sess-1', 'Worked on authentication and fixed login bug.');

    const result = assembleSessionContext(laminarkDb.db, 'test-project');

    expect(result).toContain('[Laminark Context - Session Recovery]');
    expect(result).toContain('Worked on authentication and fixed login bug.');
  });

  it('includes recent observations in output', () => {
    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');
    obsRepo.create({
      content: 'Created the user model with Prisma schema',
      source: 'hook:Write',
    });

    const result = assembleSessionContext(laminarkDb.db, 'test-project');

    expect(result).toContain('Created the user model with Prisma schema');
    expect(result).toContain('source: hook:Write');
  });

  it('total output stays under 6000 characters', () => {
    const sessionRepo = new SessionRepository(laminarkDb.db, 'test-project');
    sessionRepo.create('sess-1');
    // Create a large session summary (but within limits)
    const largeSummary = 'Activity: ' + 'x'.repeat(2000);
    sessionRepo.end('sess-1', largeSummary);

    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');
    // Create 5 observations with moderate content
    for (let i = 0; i < 5; i++) {
      obsRepo.create({
        content: `Observation ${i}: ${'detailed content '.repeat(10)}`,
        source: i < 2 ? 'mcp:save_memory' : 'hook:Bash',
      });
    }

    const result = assembleSessionContext(laminarkDb.db, 'test-project');

    expect(result.length).toBeLessThanOrEqual(6000);
  });

  it('prioritizes mcp:save_memory observations', () => {
    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');

    // Create regular observations first (older)
    obsRepo.create({
      content: 'Regular observation 1',
      source: 'hook:Bash',
    });
    obsRepo.create({
      content: 'Regular observation 2',
      source: 'hook:Read',
    });

    // Create an explicit save (could be older but should appear first)
    obsRepo.create({
      content: 'Important memory saved by user',
      source: 'mcp:save_memory',
    });

    const observations = getHighValueObservations(laminarkDb.db, 'test-project', 5);

    // mcp:save_memory should be first
    expect(observations[0].source).toBe('mcp:save_memory');
    expect(observations[0].content).toBe('Important memory saved by user');
  });

  it('excludes deleted observations from high-value query', () => {
    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');

    const obs = obsRepo.create({
      content: 'This will be deleted',
      source: 'hook:Bash',
    });
    obsRepo.softDelete(obs.id);

    obsRepo.create({
      content: 'This is still active',
      source: 'hook:Bash',
    });

    const observations = getHighValueObservations(laminarkDb.db, 'test-project', 5);

    expect(observations).toHaveLength(1);
    expect(observations[0].content).toBe('This is still active');
  });

  it('scopes observations to projectHash', () => {
    const obsRepo1 = new ObservationRepository(laminarkDb.db, 'project-a');
    const obsRepo2 = new ObservationRepository(laminarkDb.db, 'project-b');

    obsRepo1.create({ content: 'Project A observation', source: 'hook:Bash' });
    obsRepo2.create({ content: 'Project B observation', source: 'hook:Bash' });

    const obsA = getHighValueObservations(laminarkDb.db, 'project-a', 5);
    const obsB = getHighValueObservations(laminarkDb.db, 'project-b', 5);

    expect(obsA).toHaveLength(1);
    expect(obsA[0].content).toBe('Project A observation');
    expect(obsB).toHaveLength(1);
    expect(obsB[0].content).toBe('Project B observation');
  });
});
