import { describe, it, expect, afterEach } from 'vitest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';
import { createTempDb } from './test-utils.js';
import type { LaminarkDatabase } from '../database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the crash simulation script
const CRASH_SCRIPT = join(__dirname, 'crash-writer.ts');

/**
 * Forks a child process that simulates a crash mid-transaction.
 * The child:
 * 1. Opens the database
 * 2. Inserts `committedCount` observations normally (committed)
 * 3. Starts a manual BEGIN transaction
 * 4. Inserts `uncommittedCount` observations
 * 5. Calls process.exit(1) WITHOUT committing (simulates hard crash)
 */
function forkCrashWriter(
  dbPath: string,
  projectHash: string,
  committedCount: number,
  uncommittedCount: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = fork(
      CRASH_SCRIPT,
      [dbPath, projectHash, String(committedCount), String(uncommittedCount)],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      },
    );

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

describe('Crash Recovery: WAL transaction atomicity', { timeout: 15000 }, () => {
  let ldb: LaminarkDatabase | null = null;
  let cleanup: () => void;

  afterEach(() => {
    try {
      ldb?.close();
    } catch {
      // already closed
    }
    ldb = null;
    cleanup?.();
  });

  it('committed observations survive process crash, uncommitted are rolled back', async () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    // Initialize the database first
    ldb = openDatabase(config);
    ldb.close();
    ldb = null;

    const PROJECT_HASH = 'crash-test';
    const COMMITTED = 5;
    const UNCOMMITTED = 3;

    // Fork a child that will crash mid-transaction
    const exitCode = await forkCrashWriter(
      config.dbPath,
      PROJECT_HASH,
      COMMITTED,
      UNCOMMITTED,
    );

    // Child should have exited with code 1 (simulated crash)
    expect(exitCode).toBe(1);

    // Reopen the database -- WAL recovery should happen automatically
    ldb = openDatabase(config);
    const repo = new ObservationRepository(ldb.db, PROJECT_HASH);

    // Only committed observations should be present
    const count = repo.count();
    expect(count).toBe(COMMITTED);

    // Verify none of the uncommitted content exists
    const allObs = repo.list({ limit: 100, includeUnclassified: true });
    for (const obs of allObs) {
      expect(obs.content).not.toContain('uncommitted');
    }

    // Verify all committed observations have expected content
    const committedObs = allObs.filter((o) =>
      o.content.startsWith('committed-'),
    );
    expect(committedObs.length).toBe(COMMITTED);

    // Verify WAL mode is still active after recovery
    const journalMode = ldb.db.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');
  });
});
