import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseConfig } from '../../shared/types.js';

/**
 * Creates a temporary database directory and returns a DatabaseConfig
 * pointing to it, along with a cleanup function.
 *
 * Each test should use its own temp directory to avoid cross-test interference.
 */
export function createTempDb(): {
  config: DatabaseConfig;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'laminark-acceptance-'));
  const config: DatabaseConfig = {
    dbPath: join(tmp, 'test.db'),
    busyTimeout: 5000,
  };

  const cleanup = () => {
    rmSync(tmp, { recursive: true, force: true });
  };

  return { config, cleanup };
}
