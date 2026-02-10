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

// Path to the concurrent writer script (use tsx to run TS directly)
const WRITER_SCRIPT = join(__dirname, 'concurrent-writer.ts');

/**
 * Forks a child process that writes `count` observations to the given database.
 * Returns a promise that resolves with the exit code.
 */
function forkWriter(
  dbPath: string,
  projectHash: string,
  count: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Use tsx to run TypeScript directly (vitest uses it)
    const child = fork(WRITER_SCRIPT, [dbPath, projectHash, String(count)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code !== 0 && stderr) {
        console.error(`Writer exited with code ${code}: ${stderr}`);
      }
      resolve(code ?? 1);
    });
  });
}

describe('Concurrency: Multi-process write safety', { timeout: 30000 }, () => {
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

  it('3 concurrent processes write 300 observations without data loss', async () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    // Initialize the database (run migrations) before forking writers
    ldb = openDatabase(config);
    ldb.close();
    ldb = null;

    const PROJECT_HASH = 'concurrent-test';
    const OBS_PER_PROCESS = 100;

    // Fork 3 writer processes
    const exitCodes = await Promise.all([
      forkWriter(config.dbPath, PROJECT_HASH, OBS_PER_PROCESS),
      forkWriter(config.dbPath, PROJECT_HASH, OBS_PER_PROCESS),
      forkWriter(config.dbPath, PROJECT_HASH, OBS_PER_PROCESS),
    ]);

    // All writers should exit with code 0 (no SQLITE_BUSY errors)
    expect(exitCodes).toEqual([0, 0, 0]);

    // Open database and verify total count
    ldb = openDatabase(config);
    const repo = new ObservationRepository(ldb.db, PROJECT_HASH);

    const count = repo.count();
    expect(count).toBe(300);

    // Verify no duplicate IDs
    const allObs = repo.list({ limit: 300 });
    const ids = allObs.map((o) => o.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(300);
  });

  it('concurrent reader sees consistent data during writes', async () => {
    const { config, cleanup: c } = createTempDb();
    cleanup = c;

    // Initialize the database
    ldb = openDatabase(config);
    ldb.close();
    ldb = null;

    const PROJECT_HASH = 'read-write-test';

    // Fork a writer that writes 200 observations
    const writerPromise = forkWriter(config.dbPath, PROJECT_HASH, 200);

    // Open a reader connection concurrently
    ldb = openDatabase(config);
    const readerRepo = new ObservationRepository(ldb.db, PROJECT_HASH);

    // Repeatedly read during writes -- all returned observations must be valid
    let readCount = 0;
    const maxReads = 20;

    for (let i = 0; i < maxReads; i++) {
      const observations = readerRepo.list({ limit: 300 });
      for (const obs of observations) {
        // Every observation must have valid content (no partial/corrupted data)
        expect(obs.content).toBeTruthy();
        expect(typeof obs.content).toBe('string');
        expect(obs.id).toBeTruthy();
        expect(obs.projectHash).toBe(PROJECT_HASH);
      }
      readCount += observations.length;

      // Small delay to spread reads across the write window
      await new Promise((r) => setTimeout(r, 10));
    }

    // Wait for writer to finish
    const exitCode = await writerPromise;
    expect(exitCode).toBe(0);

    // Verify final count
    const finalCount = readerRepo.count();
    expect(finalCount).toBe(200);
  });
});
