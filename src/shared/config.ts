import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { DatabaseConfig } from './types.js';

/**
 * Default busy timeout in milliseconds.
 * Must be >= 5000ms to prevent SQLITE_BUSY under concurrent load.
 * Source: SQLite docs + better-sqlite3 performance recommendations.
 */
export const DEFAULT_BUSY_TIMEOUT = 5000;

/**
 * Returns the Laminark configuration directory (~/.laminark/).
 * Creates the directory recursively if it does not exist.
 */
export function getConfigDir(): string {
  const dir = join(homedir(), '.laminark');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns the path to the single Laminark database file.
 * User decision: single database at ~/.laminark/data.db for ALL projects.
 */
export function getDbPath(): string {
  return join(getConfigDir(), 'data.db');
}

/**
 * Creates a deterministic SHA-256 hash of a project directory path.
 * Uses realpathSync to canonicalize (resolves symlinks) to prevent
 * multiple hashes for the same directory via different paths.
 *
 * @param projectDir - The project directory path to hash
 * @returns First 16 hex characters of the SHA-256 hash
 */
export function getProjectHash(projectDir: string): string {
  const canonical = realpathSync(resolve(projectDir));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Returns the default database configuration.
 */
export function getDatabaseConfig(): DatabaseConfig {
  return {
    dbPath: getDbPath(),
    busyTimeout: DEFAULT_BUSY_TIMEOUT,
  };
}
