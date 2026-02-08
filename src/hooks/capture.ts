import type { ObservationRepository } from '../storage/observations.js';
import { debug } from '../shared/debug.js';

/**
 * Payload shape for PostToolUse / PostToolUseFailure hook events.
 * Matches the official Claude Code hook JSON format.
 */
export interface PostToolUsePayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
}

/**
 * Truncates a string to maxLength, appending '...' if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Extracts a semantic observation summary from a PostToolUse payload.
 * Returns null if no meaningful observation can be derived.
 *
 * Summaries are human-readable, not raw tool output. Each tool type
 * gets a format optimized for later search and recall.
 */
export function extractObservation(payload: PostToolUsePayload): string | null {
  const { tool_name, tool_input, tool_response } = payload;

  switch (tool_name) {
    case 'Write':
      // High signal: file creation. Include path and first ~200 chars of content.
      return `[Write] Created ${tool_input.file_path}\n${truncate(String(tool_input.content ?? ''), 200)}`;

    case 'Edit':
      // High signal: code change. Include path, old->new summary.
      return `[Edit] Modified ${tool_input.file_path}: replaced "${truncate(String(tool_input.old_string ?? ''), 80)}" with "${truncate(String(tool_input.new_string ?? ''), 80)}"`;

    case 'Bash': {
      // Medium signal: command execution. Include command and first ~200 chars of response.
      const cmd = truncate(String(tool_input.command ?? ''), 100);
      const output = truncate(JSON.stringify(tool_response ?? ''), 200);
      return `[Bash] $ ${cmd}\n${output}`;
    }

    case 'Read':
      // Low signal: file reads are usually noise. Admission filter will often reject.
      return `[Read] ${tool_input.file_path}`;

    case 'Glob':
    case 'Grep':
      // Low signal: search operations.
      return `[${tool_name}] pattern=${tool_input.pattern ?? ''} in ${tool_input.path ?? 'cwd'}`;

    default:
      // MCP tools and others -- capture tool name + input summary.
      return `[${tool_name}] ${truncate(JSON.stringify(tool_input), 200)}`;
  }
}

/**
 * Processes a PostToolUse or PostToolUseFailure event.
 *
 * Validates the input, skips self-referential mcp__laminark__ tools,
 * extracts a semantic observation summary, and persists it to the database.
 */
export function processPostToolUse(
  input: Record<string, unknown>,
  obsRepo: ObservationRepository,
): void {
  const toolName = input.tool_name as string | undefined;

  if (!toolName) {
    debug('hook', 'PostToolUse missing tool_name, skipping');
    return;
  }

  // Skip self-referential capture (Laminark observing its own operations)
  if (toolName.startsWith('mcp__laminark__')) {
    debug('hook', 'Skipping self-referential tool', { tool: toolName });
    return;
  }

  const payload: PostToolUsePayload = {
    session_id: input.session_id as string,
    cwd: input.cwd as string,
    hook_event_name: input.hook_event_name as string,
    tool_name: toolName,
    tool_input: (input.tool_input as Record<string, unknown>) ?? {},
    tool_response: input.tool_response as Record<string, unknown> | undefined,
    tool_use_id: input.tool_use_id as string | undefined,
  };

  const summary = extractObservation(payload);

  if (summary === null) {
    debug('hook', 'No observation extracted', { tool: toolName });
    return;
  }

  obsRepo.create({
    content: summary,
    source: 'hook:' + toolName,
    sessionId: payload.session_id ?? null,
  });

  debug('hook', 'Captured observation', { tool: toolName, length: summary.length });
}
