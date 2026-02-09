import { openDatabase } from '../storage/database.js';
import { getDatabaseConfig, getProjectHash } from '../shared/config.js';
import { ObservationRepository } from '../storage/observations.js';
import { SessionRepository } from '../storage/sessions.js';
import { extractObservation } from './capture.js';
import { handleSessionStart, handleSessionEnd, handleStop } from './session-lifecycle.js';
import { redactSensitiveContent, isExcludedFile } from './privacy-filter.js';
import { shouldAdmit } from './admission-filter.js';
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
 *
 * Filter pipeline (PostToolUse/PostToolUseFailure):
 *   1. Self-referential filter (mcp__laminark__ prefix)
 *   2. Extract observation text from payload
 *   3. Privacy filter: exclude sensitive files, redact secrets
 *   4. Admission filter: reject noise content
 *   5. Store to database
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Processes a PostToolUse or PostToolUseFailure event through the full
 * filter pipeline: extract -> privacy -> admission -> store.
 *
 * Exported for unit testing of the pipeline logic.
 */
export function processPostToolUseFiltered(
  input: Record<string, unknown>,
  obsRepo: ObservationRepository,
): void {
  const toolName = input.tool_name as string | undefined;

  if (!toolName) {
    debug('hook', 'PostToolUse missing tool_name, skipping');
    return;
  }

  // 1. Skip self-referential capture (Laminark observing its own operations)
  if (toolName.startsWith('mcp__laminark__')) {
    debug('hook', 'Skipping self-referential tool', { tool: toolName });
    return;
  }

  // 2. Extract file path from tool_input (for file exclusion check)
  const toolInput = (input.tool_input as Record<string, unknown>) ?? {};
  const filePath = toolInput.file_path as string | undefined;

  // 3. Privacy filter: check file exclusion first
  if (filePath && isExcludedFile(filePath)) {
    debug('hook', 'Observation excluded (sensitive file)', { tool: toolName, filePath });
    return;
  }

  // 4. Extract observation text from payload
  const payload = {
    session_id: input.session_id as string,
    cwd: input.cwd as string,
    hook_event_name: input.hook_event_name as string,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: input.tool_response as Record<string, unknown> | undefined,
    tool_use_id: input.tool_use_id as string | undefined,
  };

  const summary = extractObservation(payload);

  if (summary === null) {
    debug('hook', 'No observation extracted', { tool: toolName });
    return;
  }

  // 5. Privacy filter: redact sensitive content
  const redacted = redactSensitiveContent(summary, filePath);

  if (redacted === null) {
    debug('hook', 'Observation excluded by privacy filter', { tool: toolName });
    return;
  }

  // 6. Admission filter: reject noise
  if (!shouldAdmit(toolName, redacted)) {
    debug('hook', 'Observation rejected by admission filter', { tool: toolName });
    return;
  }

  // 7. Store the filtered, redacted observation
  obsRepo.create({
    content: redacted,
    source: 'hook:' + toolName,
    sessionId: payload.session_id ?? null,
  });

  debug('hook', 'Captured observation', { tool: toolName, length: redacted.length });
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
        processPostToolUseFiltered(input, obsRepo);
        break;
      case 'SessionStart':
        handleSessionStart(input, sessionRepo);
        break;
      case 'SessionEnd':
        handleSessionEnd(input, sessionRepo);
        break;
      case 'Stop':
        handleStop(input, obsRepo, sessionRepo);
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
