/**
 * Standalone script forked by concurrency tests for true multi-process testing.
 *
 * Receives dbPath, projectHash, and count via process.argv.
 * Opens its own database connection, writes `count` observations,
 * then closes and exits with code 0.
 *
 * On any error: logs to stderr and exits with code 1.
 *
 * This file is NOT a test -- it is forked by concurrency.test.ts.
 */

import { openDatabase } from '../database.js';
import { ObservationRepository } from '../observations.js';

const args = process.argv.slice(2);
const dbPath = args[0];
const projectHash = args[1];
const count = parseInt(args[2], 10);

if (!dbPath || !projectHash || isNaN(count)) {
  console.error(
    'Usage: concurrent-writer.ts <dbPath> <projectHash> <count>',
  );
  process.exit(1);
}

try {
  const ldb = openDatabase({ dbPath, busyTimeout: 5000 });
  const repo = new ObservationRepository(ldb.db, projectHash);

  for (let i = 0; i < count; i++) {
    repo.create({
      content: `obs-${process.pid}-${i}`,
      source: 'concurrency-test',
    });
  }

  ldb.close();
  process.exit(0);
} catch (err) {
  console.error('concurrent-writer error:', err);
  process.exit(1);
}
