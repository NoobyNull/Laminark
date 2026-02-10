import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { DatabaseConfig } from './types.js';

/**
 * Cached debug-enabled flag.
 * Resolved once per process -- debug mode does not change at runtime.
 */
let _debugCached: boolean | null = null;

/**
 * Returns whether debug logging is enabled for this process.
 *
 * Resolution order:
 * 1. `LAMINARK_DEBUG` env var -- `"1"` or `"true"` enables debug mode
 * 2. `~/.laminark/config.json` -- `{ "debug": true }` enables debug mode
 * 3. Default: disabled
 *
 * The result is cached after the first call.
 */
export function isDebugEnabled(): boolean {
  if (_debugCached !== null) {
    return _debugCached;
  }

  // Check environment variable first
  const envVal = process.env.LAMINARK_DEBUG;
  if (envVal === '1' || envVal === 'true') {
    _debugCached = true;
    return true;
  }

  // Check config.json
  try {
    const configPath = join(getConfigDir(), 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config.debug === true) {
      _debugCached = true;
      return true;
    }
  } catch {
    // Config file doesn't exist or is invalid -- that's fine
  }

  _debugCached = false;
  return false;
}

/**
 * Default busy timeout in milliseconds.
 * Must be >= 5000ms to prevent SQLITE_BUSY under concurrent load.
 * Source: SQLite docs + better-sqlite3 performance recommendations.
 */
export const DEFAULT_BUSY_TIMEOUT = 5000;

/**
 * Returns the Laminark data directory.
 * Default: ~/.claude/plugins/cache/laminark/data/
 * Creates the directory recursively if it does not exist.
 *
 * Supports LAMINARK_DATA_DIR env var override for testing --
 * redirects all data storage to a custom directory without
 * affecting the real plugin data.
 */
export function getConfigDir(): string {
  const dir = process.env.LAMINARK_DATA_DIR || join(homedir(), '.claude', 'plugins', 'cache', 'laminark', 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns the path to the single Laminark database file.
 * Single database at ~/.claude/plugins/cache/laminark/data/data.db for ALL projects.
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
