/**
 * Standalone script forked by crash-recovery tests.
 *
 * Simulates a process crash mid-transaction:
 * 1. Opens the database
 * 2. Inserts `committedCount` observations normally (auto-committed)
 * 3. Starts a manual BEGIN transaction
 * 4. Inserts `uncommittedCount` observations via raw SQL
 * 5. Calls process.exit(1) WITHOUT committing (simulates hard crash)
 *
 * This file is NOT a test -- it is forked by crash-recovery.test.ts.
 */

import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';

const args = process.argv.slice(2);
const dbPath = args[0];
const projectHash = args[1];
const committedCount = parseInt(args[2], 10);
const uncommittedCount = parseInt(args[3], 10);

if (
  !dbPath ||
  !projectHash ||
  isNaN(committedCount) ||
  isNaN(uncommittedCount)
) {
  console.error(
    'Usage: crash-writer.ts <dbPath> <projectHash> <committedCount> <uncommittedCount>',
  );
  process.exit(1);
}

try {
  const ldb = openDatabase({ dbPath, busyTimeout: 5000 });

  // Step 1: Insert committed observations normally
  const repo = new ObservationRepository(ldb.db, projectHash);
  for (let i = 0; i < committedCount; i++) {
    repo.create({
      content: `committed-${i}`,
      source: 'crash-test',
    });
  }

  // Step 2: Start a manual transaction and insert without committing
  ldb.db.exec('BEGIN');
  for (let i = 0; i < uncommittedCount; i++) {
    ldb.db
      .prepare(
        'INSERT INTO observations (project_hash, content, source) VALUES (?, ?, ?)',
      )
      .run(projectHash, `uncommitted-${i}`, 'crash-test');
  }

  // Step 3: Simulate hard crash -- exit without committing or closing
  process.exit(1);
} catch (err) {
  console.error('crash-writer error:', err);
  process.exit(1);
}
