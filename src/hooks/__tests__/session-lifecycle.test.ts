import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../storage/database.js';
import { SessionRepository } from '../../storage/sessions.js';
import { createTempDb } from '../../storage/__tests__/test-utils.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

import { handleSessionStart, handleSessionEnd } from '../session-lifecycle.js';

describe('handleSessionStart', () => {
  let laminarkDb: LaminarkDatabase;
  let config: DatabaseConfig;
  let cleanup: () => void;
  let sessionRepo: SessionRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    ({ config, cleanup } = createTempDb());
    laminarkDb = openDatabase(config);
    sessionRepo = new SessionRepository(laminarkDb.db, projectHash);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  it('creates a session record in the database', () => {
    const context = handleSessionStart(
      {
        session_id: 'sess-start-1',
        cwd: '/tmp/project',
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'claude-sonnet-4-5-20250929',
      },
      sessionRepo,
      laminarkDb.db,
      projectHash,
    );

    const session = sessionRepo.getById('sess-start-1');
    expect(session).not.toBeNull();
    expect(session!.id).toBe('sess-start-1');
    expect(session!.startedAt).toBeDefined();
    expect(session!.endedAt).toBeNull();
    // First session should return welcome message
    expect(context).toContain('[Laminark]');
  });

  it('skips when session_id is missing', () => {
    const context = handleSessionStart(
      {
        cwd: '/tmp/project',
        hook_event_name: 'SessionStart',
      },
      sessionRepo,
      laminarkDb.db,
      projectHash,
    );

    const sessions = sessionRepo.getLatest(10);
    expect(sessions).toHaveLength(0);
    expect(context).toBeNull();
  });
});

describe('handleSessionEnd', () => {
  let laminarkDb: LaminarkDatabase;
  let config: DatabaseConfig;
  let cleanup: () => void;
  let sessionRepo: SessionRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    ({ config, cleanup } = createTempDb());
    laminarkDb = openDatabase(config);
    sessionRepo = new SessionRepository(laminarkDb.db, projectHash);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  it('closes a session by setting ended_at', () => {
    // First create a session
    sessionRepo.create('sess-end-1');

    // Now end it via the hook handler
    handleSessionEnd(
      {
        session_id: 'sess-end-1',
        cwd: '/tmp/project',
        hook_event_name: 'SessionEnd',
        reason: 'other',
      },
      sessionRepo,
    );

    const session = sessionRepo.getById('sess-end-1');
    expect(session).not.toBeNull();
    expect(session!.endedAt).not.toBeNull();
  });

  it('skips when session_id is missing', () => {
    handleSessionEnd(
      {
        cwd: '/tmp/project',
        hook_event_name: 'SessionEnd',
      },
      sessionRepo,
    );

    // No crash, no session modified
    const sessions = sessionRepo.getLatest(10);
    expect(sessions).toHaveLength(0);
  });

  it('handles ending a non-existent session gracefully', () => {
    // This should not throw -- sessionRepo.end() returns null for non-existent
    handleSessionEnd(
      {
        session_id: 'non-existent-session',
        cwd: '/tmp/project',
        hook_event_name: 'SessionEnd',
      },
      sessionRepo,
    );

    // No crash expected
    expect(true).toBe(true);
  });
});

describe('session lifecycle integration', () => {
  let laminarkDb: LaminarkDatabase;
  let config: DatabaseConfig;
  let cleanup: () => void;
  let sessionRepo: SessionRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    ({ config, cleanup } = createTempDb());
    laminarkDb = openDatabase(config);
    sessionRepo = new SessionRepository(laminarkDb.db, projectHash);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  it('full lifecycle: start then end a session', () => {
    // Start
    handleSessionStart(
      {
        session_id: 'lifecycle-1',
        cwd: '/tmp/project',
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
      sessionRepo,
      laminarkDb.db,
      projectHash,
    );

    const started = sessionRepo.getById('lifecycle-1');
    expect(started).not.toBeNull();
    expect(started!.endedAt).toBeNull();

    // End
    handleSessionEnd(
      {
        session_id: 'lifecycle-1',
        cwd: '/tmp/project',
        hook_event_name: 'SessionEnd',
        reason: 'other',
      },
      sessionRepo,
    );

    const ended = sessionRepo.getById('lifecycle-1');
    expect(ended).not.toBeNull();
    expect(ended!.endedAt).not.toBeNull();
  });
});
