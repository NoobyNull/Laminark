import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { compressObservations, generateSessionSummary } from './summarizer.js';
import type { Observation } from '../shared/types.js';
import { openDatabase } from '../storage/database.js';
import { ObservationRepository } from '../storage/observations.js';
import { SessionRepository } from '../storage/sessions.js';
import type { LaminarkDatabase } from '../storage/database.js';

// ---------------------------------------------------------------------------
// Helper: create a mock observation with sensible defaults
// ---------------------------------------------------------------------------
function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    rowid: 1,
    id: 'obs-' + Math.random().toString(36).slice(2, 10),
    projectHash: 'test-project',
    content: 'Default observation content',
    title: null,
    source: 'hook:Bash',
    sessionId: 'session-1',
    embedding: null,
    embeddingModel: null,
    embeddingVersion: null,
    createdAt: '2026-02-09T00:00:00Z',
    updatedAt: '2026-02-09T00:00:00Z',
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// compressObservations unit tests
// ---------------------------------------------------------------------------
describe('compressObservations', () => {
  it('returns empty string for empty observations array', () => {
    const result = compressObservations([]);
    expect(result).toBe('');
  });

  it('produces structured output with 3 observations', () => {
    const observations: Observation[] = [
      makeObservation({
        content: 'Edited src/storage/database.ts to add WAL mode',
        createdAt: '2026-02-09T10:00:00Z',
      }),
      makeObservation({
        content:
          'Decided to use better-sqlite3 instead of sql.js for performance',
        createdAt: '2026-02-09T10:05:00Z',
      }),
      makeObservation({
        content: 'Fixed error in migration script for FTS5 table creation',
        createdAt: '2026-02-09T10:10:00Z',
      }),
    ];

    const result = compressObservations(observations);

    // Should contain structured sections
    expect(result).toContain('## Session Summary');
    expect(result).toContain('**Duration:**');
    expect(result).toContain('**Observations:** 3');
    expect(result).toContain('### Key Activities');
  });

  it('stays under 2000 characters with 50+ observations', () => {
    const observations: Observation[] = [];
    for (let i = 0; i < 60; i++) {
      observations.push(
        makeObservation({
          content: `Observation ${i}: edited file src/module${i}/component${i}.ts with some changes to the implementation of feature ${i} involving database queries and API endpoints for handling user authentication and session management workflows`,
          createdAt: `2026-02-09T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        }),
      );
    }

    const result = compressObservations(observations);
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result).toContain('## Session Summary');
    expect(result).toContain('**Observations:** 60');
  });

  it('extracts file paths from observation content', () => {
    const observations: Observation[] = [
      makeObservation({
        content:
          'Modified src/storage/database.ts and src/shared/types.ts for new schema',
      }),
      makeObservation({
        content: 'Updated package.json with new dependency',
      }),
    ];

    const result = compressObservations(observations);

    expect(result).toContain('### Files Touched');
    expect(result).toContain('src/storage/database.ts');
    expect(result).toContain('src/shared/types.ts');
    expect(result).toContain('package.json');
  });

  it('detects decision keywords in observations', () => {
    const observations: Observation[] = [
      makeObservation({
        content: 'Decided to use WAL mode for concurrent access safety',
      }),
      makeObservation({
        content: 'Going with Zod v4 for runtime validation',
      }),
      makeObservation({
        content: 'Normal tool output without any decisions',
      }),
    ];

    const result = compressObservations(observations);

    expect(result).toContain('### Decisions & Insights');
    // At least the decision observations should appear
    expect(result).toContain('WAL mode');
    expect(result).toContain('Zod v4');
  });

  it('includes problem and solution indicators in activities', () => {
    const observations: Observation[] = [
      makeObservation({
        content: 'Error: SQLITE_BUSY when running concurrent writes',
      }),
      makeObservation({
        content: 'Fixed the busy timeout by increasing to 5000ms',
      }),
    ];

    const result = compressObservations(observations);

    expect(result).toContain('### Key Activities');
    expect(result).toContain('[Issue]');
    expect(result).toContain('[Resolved]');
  });

  it('uses timestamps from first and last observation for duration', () => {
    const observations: Observation[] = [
      makeObservation({ createdAt: '2026-02-09T10:00:00Z' }),
      makeObservation({ createdAt: '2026-02-09T10:30:00Z' }),
      makeObservation({ createdAt: '2026-02-09T11:00:00Z' }),
    ];

    const result = compressObservations(observations);

    expect(result).toContain('2026-02-09T10:00:00Z');
    expect(result).toContain('2026-02-09T11:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// generateSessionSummary integration tests (with real DB)
// ---------------------------------------------------------------------------
describe('generateSessionSummary', () => {
  let tmpDir: string;
  let laminarkDb: LaminarkDatabase;
  let obsRepo: ObservationRepository;
  let sessionRepo: SessionRepository;
  const PROJECT_HASH = 'test-summarizer';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-summarizer-test-'));
    laminarkDb = openDatabase({ dbPath: join(tmpDir, 'test.db'), busyTimeout: 5000 });
    obsRepo = new ObservationRepository(laminarkDb.db, PROJECT_HASH);
    sessionRepo = new SessionRepository(laminarkDb.db, PROJECT_HASH);
  });

  afterEach(() => {
    laminarkDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a session with no observations', () => {
    sessionRepo.create('empty-session');

    const result = generateSessionSummary('empty-session', obsRepo, sessionRepo);

    expect(result).toBeNull();
  });

  it('generates a summary for a session with observations', () => {
    sessionRepo.create('active-session');
    obsRepo.create({
      content: 'Edited src/index.ts to add new MCP tool registration',
      source: 'hook:Write',
      sessionId: 'active-session',
    });
    obsRepo.create({
      content: 'Decided to use registerTool pattern for MCP tools',
      source: 'hook:Bash',
      sessionId: 'active-session',
    });

    const result = generateSessionSummary('active-session', obsRepo, sessionRepo);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('active-session');
    expect(result!.observationCount).toBe(2);
    expect(result!.summary).toContain('## Session Summary');
    expect(result!.generatedAt).toBeTruthy();

    // Verify the summary was persisted on the session row
    const session = sessionRepo.getById('active-session');
    expect(session).not.toBeNull();
    expect(session!.summary).toContain('## Session Summary');
  });

  it('does not include observations from other sessions', () => {
    sessionRepo.create('session-a');
    sessionRepo.create('session-b');

    obsRepo.create({
      content: 'This belongs to session A',
      source: 'hook:Bash',
      sessionId: 'session-a',
    });
    obsRepo.create({
      content: 'This belongs to session B',
      source: 'hook:Bash',
      sessionId: 'session-b',
    });

    const result = generateSessionSummary('session-a', obsRepo, sessionRepo);

    expect(result).not.toBeNull();
    expect(result!.observationCount).toBe(1);
    expect(result!.summary).toContain('**Observations:** 1');
  });
});
