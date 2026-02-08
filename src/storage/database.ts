import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DatabaseConfig } from '../shared/types.js';
import { runMigrations } from './migrations.js';

/**
 * Wrapper around a configured better-sqlite3 database instance.
 * Provides lifecycle methods (close, checkpoint) and tracks whether
 * the sqlite-vec extension loaded successfully.
 */
export interface LaminarkDatabase {
  db: Database.Database;
  hasVectorSupport: boolean;
  close(): void;
  checkpoint(): void;
}

/**
 * Opens a SQLite database with WAL mode, correct PRAGMA order,
 * optional sqlite-vec extension loading, and schema migrations.
 *
 * Single connection per process by design -- better-sqlite3 is synchronous,
 * so connection pooling adds zero benefit.
 *
 * @param config - Database path and busy timeout configuration
 * @returns A configured LaminarkDatabase instance
 */
export function openDatabase(config: DatabaseConfig): LaminarkDatabase {
  // 1. Ensure directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  // 2. Create connection
  const db = new Database(config.dbPath);

  // 3. Set PRAGMAs in correct order (order matters per research)
  //    WAL mode MUST be first -- synchronous = NORMAL is only safe with WAL
  const journalMode = db.pragma('journal_mode = WAL', {
    simple: true,
  }) as string;
  if (journalMode !== 'wal') {
    console.warn(
      `WARNING: WAL mode not active (got '${journalMode}'). ` +
        'Database may be on a read-only filesystem or otherwise restricted.',
    );
  }

  // busy_timeout -- per-connection, must set every time
  db.pragma(`busy_timeout = ${config.busyTimeout}`);

  // synchronous NORMAL -- safe ONLY with WAL, faster than FULL
  db.pragma('synchronous = NORMAL');

  // cache_size -- negative = KiB (64MB)
  db.pragma('cache_size = -64000');

  // foreign_keys -- per-connection, not persistent
  db.pragma('foreign_keys = ON');

  // temp_store -- temp tables in memory
  db.pragma('temp_store = MEMORY');

  // wal_autocheckpoint -- explicit default, prevents WAL growth
  db.pragma('wal_autocheckpoint = 1000');

  // 4. Load sqlite-vec with graceful degradation
  let hasVectorSupport = false;
  try {
    sqliteVec.load(db);
    hasVectorSupport = true;
  } catch {
    // Vector search unavailable -- keyword-only mode
  }

  // 5. Run migrations
  runMigrations(db, hasVectorSupport);

  // 6. Return LaminarkDatabase
  return {
    db,
    hasVectorSupport,

    close(): void {
      try {
        // Flush WAL before shutdown
        db.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        // If checkpoint fails (e.g., locked), still close
      }
      db.close();
    },

    checkpoint(): void {
      db.pragma('wal_checkpoint(PASSIVE)');
    },
  };
}
