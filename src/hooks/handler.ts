import { openDatabase } from '../storage/database.js';
import { getDatabaseConfig, getProjectHash } from '../shared/config.js';
import { ObservationRepository } from '../storage/observations.js';
import { SessionRepository } from '../storage/sessions.js';
import { processPostToolUse } from './capture.js';
import { handleSessionStart, handleSessionEnd } from './session-lifecycle.js';
import { debug } from '../shared/debug.js';

/**
 * Hook handler entry point.
 *
 * This file is the CLI entry point for all Claude Code hook events.
 * It reads stdin JSON, opens a direct SQLite connection (no HTTP intermediary),
 * dispatches to the appropriate handler based on hook_event_name, and exits 0.
 *
 * CRITICAL CONSTRAINTS:
 * - NEVER writes to stdout (stdout output is interpreted by Claude Code)
 * - ALWAYS exits 0 (non-zero exit codes surface as errors to Claude)
 * - Opens its own database connection (WAL mode handles concurrent access with MCP server)
 * - Imports only storage modules -- NO @modelcontextprotocol/sdk (cold start overhead)
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as Record<string, unknown>;

  const eventName = input.hook_event_name as string;
  const cwd = input.cwd as string;

  if (!eventName || !cwd) {
    debug('hook', 'Missing hook_event_name or cwd in input');
    return;
  }

  const projectHash = getProjectHash(cwd);

  debug('hook', 'Processing hook event', { eventName, projectHash });

  // Open database -- cheap with WAL mode (~2ms)
  const laminarkDb = openDatabase(getDatabaseConfig());

  try {
    const obsRepo = new ObservationRepository(laminarkDb.db, projectHash);
    const sessionRepo = new SessionRepository(laminarkDb.db, projectHash);

    switch (eventName) {
      case 'PostToolUse':
      case 'PostToolUseFailure':
        processPostToolUse(input, obsRepo);
        break;
      case 'SessionStart':
        handleSessionStart(input, sessionRepo);
        break;
      case 'SessionEnd':
        handleSessionEnd(input, sessionRepo);
        break;
      case 'Stop':
        // Stop has no tool data (per research open question #2).
        // Do NOT create observations. Log for future Phase 5 session summary triggers.
        debug('hook', 'Stop event received', { sessionId: input.session_id });
        break;
      default:
        debug('hook', 'Unknown hook event', { eventName });
        break;
    }
  } finally {
    laminarkDb.close();
  }
}

// Wrap in .catch() -- hooks must NEVER fail. Always exit 0.
main().catch((err: Error) => {
  debug('hook', 'Hook handler error', { error: err.message });
});
