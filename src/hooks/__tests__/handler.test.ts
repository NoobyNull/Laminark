import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { SessionRepository } from '../../storage/sessions.js';
import { createTempDb } from '../../storage/__tests__/test-utils.js';
import type { LaminarkDatabase } from '../../storage/database.js';
import type { DatabaseConfig } from '../../shared/types.js';

import { processPostToolUseFiltered } from '../handler.js';
import { handleSessionStart, handleSessionEnd } from '../session-lifecycle.js';

// ---------------------------------------------------------------------------
// processPostToolUseFiltered() -- handler pipeline with filter integration
// ---------------------------------------------------------------------------

describe('processPostToolUseFiltered', () => {
  let laminarkDb: LaminarkDatabase;
  let config: DatabaseConfig;
  let cleanup: () => void;
  let obsRepo: ObservationRepository;
  const projectHash = 'testhash12345678';

  beforeEach(() => {
    ({ config, cleanup } = createTempDb());
    laminarkDb = openDatabase(config);
    obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
  });

  afterEach(() => {
    laminarkDb.close();
    cleanup();
  });

  it('stores observation for Write tool with clean content', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-1',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/src/app.ts', content: 'const x = 1;' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('hook:Write');
    expect(observations[0].content).toContain('[Write] Created /src/app.ts');
    expect(observations[0].content).toContain('const x = 1;');
  });

  it('rejects PostToolUse with noise Bash output (npm WARN)', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-2',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm install express' },
        tool_response: { stdout: 'npm WARN deprecated package@1.0.0' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('stores observation with API key redacted', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-3',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/src/config.ts',
          content: 'const key = "sk-abcdefghijklmnopqrstuvwxyz12345678";',
        },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].content).toContain('[REDACTED:api_key]');
    expect(observations[0].content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12345678');
  });

  it('produces no observation for .env file', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-4',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/project/.env',
          content: 'DATABASE_URL=postgres://localhost/db',
        },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('produces no observation for .env.local file', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-4b',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/project/.env.local',
          content: 'SECRET=abc',
        },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('captures PostToolUseFailure events', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-5',
        cwd: '/tmp',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Write',
        tool_input: { file_path: '/src/bad.ts', content: 'syntax error' },
        tool_response: { error: 'Permission denied' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].source).toBe('hook:Write');
  });

  it('skips mcp__laminark__save_memory tool', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-6',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__laminark__save_memory',
        tool_input: { content: 'some observation' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('skips mcp__laminark__recall tool', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-6b',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__laminark__recall',
        tool_input: { query: 'test' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('skips input without tool_name', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-7',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('rejects Bash package install output', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-8',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
        tool_response: { stdout: 'added 150 packages in 5s' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(0);
  });

  it('admits Bash with meaningful output', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-9',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git log --oneline -5' },
        tool_response: { stdout: 'abc1234 feat: add new feature\ndef5678 fix: resolve bug' },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].content).toContain('[Bash]');
  });

  it('redacts JWT tokens in stored content', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    processPostToolUseFiltered(
      {
        session_id: 'sess-10',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/src/auth.ts',
          content: `const token = "${jwt}";`,
        },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].content).toContain('[REDACTED:jwt]');
    expect(observations[0].content).not.toContain(jwt);
  });

  it('redacts connection strings in stored content', () => {
    processPostToolUseFiltered(
      {
        session_id: 'sess-11',
        cwd: '/tmp',
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: '/src/db.ts',
          content: 'const url = "postgresql://user:pass@host:5432/db";',
        },
      },
      obsRepo,
    );

    const observations = obsRepo.list({ limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0].content).toContain('[REDACTED:connection_string]');
    expect(observations[0].content).not.toContain('user:pass');
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle through handler dispatch
// ---------------------------------------------------------------------------

describe('handler session lifecycle', () => {
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

  it('SessionStart creates a session and SessionEnd closes it', () => {
    handleSessionStart(
      {
        session_id: 'handler-sess-1',
        cwd: '/tmp/project',
        hook_event_name: 'SessionStart',
      },
      sessionRepo,
      laminarkDb.db,
      projectHash,
    );

    const started = sessionRepo.getById('handler-sess-1');
    expect(started).not.toBeNull();
    expect(started!.startedAt).toBeDefined();
    expect(started!.endedAt).toBeNull();

    handleSessionEnd(
      {
        session_id: 'handler-sess-1',
        cwd: '/tmp/project',
        hook_event_name: 'SessionEnd',
      },
      sessionRepo,
    );

    const ended = sessionRepo.getById('handler-sess-1');
    expect(ended).not.toBeNull();
    expect(ended!.endedAt).not.toBeNull();
  });
});
