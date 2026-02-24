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
import { ToolRegistryRepository } from '../storage/tool-registry.js';
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
    classification: 'discovery',
    classifiedAt: '2026-02-09T10:30:00Z',
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

    const result = formatContextIndex(session, { changes: observations, decisions: [], findings: [], references: [] });

    expect(result).toContain('[Laminark - Session Context]');
    expect(result).toContain('## Previous Session');
    expect(result).toContain(session.summary!);
    expect(result).toContain('## Recent Changes');
    expect(result).toContain('Created user authentication module');
    expect(result).toContain('Fixed database connection pooling issue');
    expect(result).toContain('Updated API endpoint tests for auth flow');
  });

  it('shows only observations when session is null', () => {
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: 'Some observation', source: 'hook:Bash' }),
    ];

    const result = formatContextIndex(null, { changes: observations, decisions: [], findings: [], references: [] });

    expect(result).toContain('[Laminark - Session Context]');
    expect(result).not.toContain('## Previous Session');
    expect(result).toContain('## Recent Changes');
    expect(result).toContain('Some observation');
  });

  it('returns welcome message when session is null and observations are empty', () => {
    const result = formatContextIndex(null, { changes: [], decisions: [], findings: [], references: [] });

    expect(result).toContain('[Laminark] First session detected');
    expect(result).toContain('/laminark:remember');
    expect(result).toContain('/laminark:recall');
  });

  it('returns welcome message when session has no summary and no observations', () => {
    const session = makeSession({ summary: null });
    const result = formatContextIndex(session, { changes: [], decisions: [], findings: [], references: [] });

    // Session without a summary and no observations should show welcome
    // (session with null summary does not contribute content)
    expect(result).not.toContain('## Last Session');
  });

  it('truncates observation content at 120 characters', () => {
    const longContent = 'A'.repeat(200);
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: longContent }),
    ];

    const result = formatContextIndex(null, { changes: observations, decisions: [], findings: [], references: [] });

    // Should contain truncated content with "..."
    expect(result).toContain('A'.repeat(120) + '...');
    expect(result).not.toContain('A'.repeat(121));
  });

  it('each observation is a single line', () => {
    const observations = [
      makeObservation({ id: 'aaaa1111bbbb2222', content: 'First observation' }),
      makeObservation({ id: 'cccc3333dddd4444', content: 'Second observation' }),
    ];

    const result = formatContextIndex(null, { changes: observations, decisions: [], findings: [], references: [] });
    const lines = result.split('\n');

    // Find observation lines (starting with "- ")
    const obsLines = lines.filter((l) => l.startsWith('- '));
    expect(obsLines).toHaveLength(2);
    // Each observation is self-contained on one line
    expect(obsLines[0]).toContain('First observation');
    expect(obsLines[1]).toContain('Second observation');
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

    expect(result).toContain('[Laminark - Session Context]');
    expect(result).toContain('Worked on authentication and fixed login bug.');
  });

  it('includes recent observations in output', () => {
    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');
    obsRepo.createClassified({
      content: 'Created the user model with Prisma schema',
      source: 'hook:Write',
    }, 'discovery');

    const result = assembleSessionContext(laminarkDb.db, 'test-project');

    expect(result).toContain('Created the user model with Prisma schema');
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
      obsRepo.createClassified({
        content: `Observation ${i}: ${'detailed content '.repeat(10)}`,
        source: i < 2 ? 'mcp:save_memory' : 'hook:Bash',
      }, 'discovery');
    }

    const result = assembleSessionContext(laminarkDb.db, 'test-project');

    expect(result.length).toBeLessThanOrEqual(6000);
  });

  it('prioritizes mcp:save_memory observations', () => {
    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');

    // Create regular observations first (older)
    obsRepo.createClassified({
      content: 'Regular observation 1',
      source: 'hook:Bash',
    }, 'discovery');
    obsRepo.createClassified({
      content: 'Regular observation 2',
      source: 'hook:Read',
    }, 'discovery');

    // Create an explicit save (could be older but should appear first)
    obsRepo.createClassified({
      content: 'Important memory saved by user',
      source: 'mcp:save_memory',
    }, 'discovery');

    const observations = getHighValueObservations(laminarkDb.db, 'test-project', 5);

    // mcp:save_memory should be first
    expect(observations[0].source).toBe('mcp:save_memory');
    expect(observations[0].content).toBe('Important memory saved by user');
  });

  it('excludes deleted observations from high-value query', () => {
    const obsRepo = new ObservationRepository(laminarkDb.db, 'test-project');

    const obs = obsRepo.createClassified({
      content: 'This will be deleted',
      source: 'hook:Bash',
    }, 'discovery');
    obsRepo.softDelete(obs.id);

    obsRepo.createClassified({
      content: 'This is still active',
      source: 'hook:Bash',
    }, 'discovery');

    const observations = getHighValueObservations(laminarkDb.db, 'test-project', 5);

    expect(observations).toHaveLength(1);
    expect(observations[0].content).toBe('This is still active');
  });

  it('scopes observations to projectHash', () => {
    const obsRepo1 = new ObservationRepository(laminarkDb.db, 'project-a');
    const obsRepo2 = new ObservationRepository(laminarkDb.db, 'project-b');

    obsRepo1.createClassified({ content: 'Project A observation', source: 'hook:Bash' }, 'discovery');
    obsRepo2.createClassified({ content: 'Project B observation', source: 'hook:Bash' }, 'discovery');

    const obsA = getHighValueObservations(laminarkDb.db, 'project-a', 5);
    const obsB = getHighValueObservations(laminarkDb.db, 'project-b', 5);

    expect(obsA).toHaveLength(1);
    expect(obsA[0].content).toBe('Project A observation');
    expect(obsB).toHaveLength(1);
    expect(obsB[0].content).toBe('Project B observation');
  });
});

// ---------------------------------------------------------------------------
// Tool ranking and sub-budget (Phase 13)
// ---------------------------------------------------------------------------

describe('tool ranking and sub-budget', () => {
  let tmpDir: string;
  let laminarkDb: LaminarkDatabase;
  const PROJECT_HASH = 'test-project-13';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-tool-rank-'));
    process.env.LAMINARK_DATA_DIR = tmpDir;
    laminarkDb = openDatabase({ dbPath: join(tmpDir, 'data.db'), busyTimeout: 5000 });
  });

  afterEach(() => {
    laminarkDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LAMINARK_DATA_DIR;
  });

  it('tool section fits within 500-character sub-budget', () => {
    const toolRegistry = new ToolRegistryRepository(laminarkDb.db);

    // Register 25 tools to exceed the budget limit
    for (let i = 0; i < 25; i++) {
      toolRegistry.upsert({
        name: `mcp__server${i}__tool_with_longer_name`,
        toolType: 'mcp_server',
        scope: 'global',
        source: 'config:test',
        projectHash: null,
        description: null,
        serverName: `server${i}`,
        triggerHints: null,
      });
    }

    const result = assembleSessionContext(laminarkDb.db, PROJECT_HASH, toolRegistry);

    // Extract tool section
    const toolIdx = result.indexOf('## Available Tools');
    if (toolIdx >= 0) {
      // Tool section goes to end or next ## section
      const afterTools = result.indexOf('\n\n##', toolIdx + 1);
      const toolSection = afterTools >= 0
        ? result.slice(toolIdx, afterTools)
        : result.slice(toolIdx);
      expect(toolSection.length).toBeLessThanOrEqual(500);
    }
  });

  it('recently-used tools appear before unused tools', () => {
    const toolRegistry = new ToolRegistryRepository(laminarkDb.db);

    // Register 3 tools
    toolRegistry.upsert({
      name: 'tool-A-unused',
      toolType: 'slash_command',
      scope: 'project',
      source: 'config:test',
      projectHash: PROJECT_HASH,
      description: null,
      serverName: null,
    });
    toolRegistry.upsert({
      name: 'tool-B-heavy',
      toolType: 'slash_command',
      scope: 'project',
      source: 'config:test',
      projectHash: PROJECT_HASH,
      description: null,
      serverName: null,
    });
    toolRegistry.upsert({
      name: 'tool-C-moderate',
      toolType: 'slash_command',
      scope: 'project',
      source: 'config:test',
      projectHash: PROJECT_HASH,
      description: null,
      serverName: null,
    });

    // Create usage events for tool-B (5 uses) and tool-C (2 uses)
    for (let i = 0; i < 5; i++) {
      toolRegistry.recordOrCreate('tool-B-heavy', {
        toolType: 'slash_command',
        scope: 'project',
        source: 'config:test',
        projectHash: PROJECT_HASH,
        description: null,
        serverName: null,
      }, 'session-rank-test', true);
    }
    for (let i = 0; i < 2; i++) {
      toolRegistry.recordOrCreate('tool-C-moderate', {
        toolType: 'slash_command',
        scope: 'project',
        source: 'config:test',
        projectHash: PROJECT_HASH,
        description: null,
        serverName: null,
      }, 'session-rank-test', true);
    }

    const result = assembleSessionContext(laminarkDb.db, PROJECT_HASH, toolRegistry);

    const idxB = result.indexOf('tool-B-heavy');
    const idxC = result.indexOf('tool-C-moderate');
    const idxA = result.indexOf('tool-A-unused');

    // All should be present
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);

    // tool-B (5 uses) before tool-C (2 uses) before tool-A (0 uses)
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
  });

  it('tool section is empty string when no non-builtin tools exist', () => {
    const toolRegistry = new ToolRegistryRepository(laminarkDb.db);

    // Register only built-in tools
    toolRegistry.upsert({
      name: 'Read',
      toolType: 'builtin',
      scope: 'global',
      source: 'builtin',
      projectHash: null,
      description: null,
      serverName: null,
    });
    toolRegistry.upsert({
      name: 'Write',
      toolType: 'builtin',
      scope: 'global',
      source: 'builtin',
      projectHash: null,
      description: null,
      serverName: null,
    });

    const result = assembleSessionContext(laminarkDb.db, PROJECT_HASH, toolRegistry);

    expect(result).not.toContain('## Available Tools');
  });

  it('overall context stays under 6000 characters with tools', () => {
    const toolRegistry = new ToolRegistryRepository(laminarkDb.db);

    // Register 20 tools and create usage events
    for (let i = 0; i < 20; i++) {
      const name = `tool-load-${i}`;
      toolRegistry.upsert({
        name,
        toolType: 'slash_command',
        scope: 'project',
        source: 'config:test',
        projectHash: PROJECT_HASH,
        description: null,
        serverName: null,
        triggerHints: null,
      });
      toolRegistry.recordOrCreate(name, {
        toolType: 'slash_command',
        scope: 'project',
        source: 'config:test',
        projectHash: PROJECT_HASH,
        description: null,
        serverName: null,
      }, 'session-budget-test', true);
    }

    // Create a session with a large summary
    const sessionRepo = new SessionRepository(laminarkDb.db, PROJECT_HASH);
    sessionRepo.create('sess-budget');
    sessionRepo.end('sess-budget', 'Activity: ' + 'x'.repeat(2000));

    // Create observations
    const obsRepo = new ObservationRepository(laminarkDb.db, PROJECT_HASH);
    for (let i = 0; i < 5; i++) {
      obsRepo.createClassified({
        content: `Observation ${i}: ${'detailed content '.repeat(10)}`,
        source: 'hook:Bash',
        kind: 'change',
      }, 'discovery');
    }

    const result = assembleSessionContext(laminarkDb.db, PROJECT_HASH, toolRegistry);

    expect(result.length).toBeLessThanOrEqual(6000);
  });
});
