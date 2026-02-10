import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openDatabase } from '../../storage/database.js';
import { ObservationRepository } from '../../storage/observations.js';
import { SessionRepository } from '../../storage/sessions.js';
import { getProjectHash } from '../../shared/config.js';
import type { LaminarkDatabase } from '../../storage/database.js';

/**
 * End-to-end integration tests for the hook handler.
 *
 * These tests simulate the actual Claude Code hook invocation:
 * 1. Build a JSON payload matching the hook event format
 * 2. Pipe it to the compiled handler via child_process
 * 3. Verify the expected database state after handler exits
 *
 * Uses LAMINARK_DATA_DIR env var to redirect storage to temp directory.
 */

const HANDLER_PATH = resolve('dist/hooks/handler.js');
const PROJECT_DIR = resolve('/tmp/laminark-test-project');

describe('hook handler end-to-end integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let projectHash: string;

  beforeAll(() => {
    // Ensure the handler is built
    if (!existsSync(HANDLER_PATH)) {
      execSync('npx tsdown', { cwd: resolve('.') });
    }
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'laminark-e2e-'));
    dbPath = join(tmpDir, 'data.db');
    // getProjectHash resolves symlinks, so use a real path
    projectHash = getProjectHash(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: pipe a JSON payload to the hook handler and return exit status.
   * Uses LAMINARK_DATA_DIR to redirect the database to our temp dir.
   */
  function runHandler(payload: Record<string, unknown>): { exitCode: number } {
    const json = JSON.stringify(payload);
    try {
      execFileSync('node', [HANDLER_PATH], {
        input: json,
        env: {
          ...process.env,
          LAMINARK_DATA_DIR: tmpDir,
        },
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { exitCode: 0 };
    } catch (err: unknown) {
      // execFileSync throws if exit code != 0, but handler should always exit 0
      const execErr = err as { status?: number };
      return { exitCode: execErr.status ?? 1 };
    }
  }

  /**
   * Helper: open the database created by the handler for verification.
   */
  function openTestDb(): LaminarkDatabase {
    return openDatabase({
      dbPath,
      busyTimeout: 5000,
    });
  }

  // -------------------------------------------------------------------------
  // E2E: PostToolUse Write -> observation stored
  // -------------------------------------------------------------------------

  it('PostToolUse Write creates a correctly-filtered observation in the database', () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-sess-1',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: {
        file_path: '/src/app.ts',
        content: 'export const greeting = "hello world";',
      },
      tool_response: {},
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });

      expect(observations).toHaveLength(1);
      expect(observations[0].source).toBe('hook:Write');
      expect(observations[0].content).toContain('[Write] Created /src/app.ts');
      expect(observations[0].content).toContain('hello world');
      expect(observations[0].sessionId).toBe('e2e-sess-1');
    } finally {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: PostToolUse Bash with noise -> no observation
  // -------------------------------------------------------------------------

  it('PostToolUse Bash with npm install noise stores no observation', () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-sess-2',
      cwd: tmpDir,
      tool_name: 'Bash',
      tool_input: { command: 'npm install express' },
      tool_response: {
        stdout: 'added 50 packages, and audited 51 packages in 2s\n\nnpm WARN deprecated depd@2.0.0',
      },
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });

      expect(observations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: PostToolUse with API key -> observation stored with redaction
  // -------------------------------------------------------------------------

  it('PostToolUse with API key stores observation with redacted content', () => {
    const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz12345678';
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-sess-3',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: {
        file_path: '/src/config.ts',
        content: `export const OPENAI_KEY = "${apiKey}";`,
      },
      tool_response: {},
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });

      expect(observations).toHaveLength(1);
      expect(observations[0].content).toContain('[REDACTED:api_key]');
      expect(observations[0].content).not.toContain(apiKey);
    } finally {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: Session lifecycle -> session created and closed
  // -------------------------------------------------------------------------

  it('SessionStart then SessionEnd creates and closes a session record', () => {
    const sessionId = 'e2e-lifecycle-1';

    // Start session
    const start = runHandler({
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: tmpDir,
    });
    expect(start.exitCode).toBe(0);

    // Verify session created
    const db1 = openTestDb();
    try {
      const sessionRepo = new SessionRepository(db1.db, projectHash);
      const session = sessionRepo.getById(sessionId);
      expect(session).not.toBeNull();
      expect(session!.startedAt).toBeDefined();
      expect(session!.endedAt).toBeNull();
    } finally {
      db1.close();
    }

    // End session
    const end = runHandler({
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      cwd: tmpDir,
    });
    expect(end.exitCode).toBe(0);

    // Verify session ended
    const db2 = openTestDb();
    try {
      const sessionRepo = new SessionRepository(db2.db, projectHash);
      const session = sessionRepo.getById(sessionId);
      expect(session).not.toBeNull();
      expect(session!.endedAt).not.toBeNull();
    } finally {
      db2.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: Invalid JSON -> exits 0 (no crash)
  // -------------------------------------------------------------------------

  it('invalid JSON input exits 0 without crashing', () => {
    const json = 'not json {{{';
    try {
      execFileSync('node', [HANDLER_PATH], {
        input: json,
        env: {
          ...process.env,
          LAMINARK_DATA_DIR: tmpDir,
        },
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // If we get here, exit code was 0
      expect(true).toBe(true);
    } catch (err: unknown) {
      // Should NOT get here -- handler must always exit 0
      const execErr = err as { status?: number };
      expect(execErr.status).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // E2E: .env file -> no observation stored
  // -------------------------------------------------------------------------

  it('PostToolUse targeting .env file produces no observation', () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-sess-env',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: {
        file_path: '/project/.env',
        content: 'DATABASE_URL=postgres://user:pass@localhost/db',
      },
      tool_response: {},
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });
      expect(observations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: Stop event -> no observation
  // -------------------------------------------------------------------------

  it('Stop event does not create any observations', () => {
    const payload = {
      hook_event_name: 'Stop',
      session_id: 'e2e-sess-stop',
      cwd: tmpDir,
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });
      expect(observations).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: PostToolUseFailure -> captured
  // -------------------------------------------------------------------------

  it('PostToolUseFailure event is captured with observation', () => {
    const payload = {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'e2e-sess-fail',
      cwd: tmpDir,
      tool_name: 'Write',
      tool_input: {
        file_path: '/src/app.ts',
        content: 'valid content here',
      },
      tool_response: { error: 'Permission denied' },
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });

      expect(observations).toHaveLength(1);
      expect(observations[0].source).toBe('hook:Write');
    } finally {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // E2E: Self-referential tool -> no observation
  // -------------------------------------------------------------------------

  it('mcp__laminark__save_memory tool produces no observation', () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 'e2e-sess-self',
      cwd: tmpDir,
      tool_name: 'mcp__laminark__save_memory',
      tool_input: { content: 'test' },
      tool_response: {},
    };

    const { exitCode } = runHandler(payload);
    expect(exitCode).toBe(0);

    const db = openTestDb();
    try {
      const obsRepo = new ObservationRepository(db.db, projectHash);
      const observations = obsRepo.list({ limit: 10 });
      expect(observations).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
