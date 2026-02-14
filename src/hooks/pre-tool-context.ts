/**
 * PreToolUse hook: proactively surfaces relevant memories and graph entities
 * before Claude executes a tool.
 *
 * This is a synchronous hook -- stdout is injected into Claude's context window.
 * Must be fast (<100ms target, 2s timeout).
 */

import type BetterSqlite3 from 'better-sqlite3';
import { basename } from 'node:path';

import { isLaminarksOwnTool } from './self-referential.js';
import { SearchEngine } from '../storage/search.js';
import { getNodeByNameAndType, traverseFrom } from '../graph/schema.js';
import { debug } from '../shared/debug.js';

/** Tools where we skip context injection entirely. */
const SKIP_TOOLS = new Set(['Glob', 'Task', 'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);

/** Bash commands that are navigation/noise -- not worth searching for. */
const NOISE_BASH_RE = /^\s*(cd|ls|pwd|echo|cat|head|tail|mkdir|rm|cp|mv|npm\s+(run|start|test|install)|yarn|pnpm|git\s+(status|log|diff|add|branch)|exit|clear)\b/;

/**
 * Extracts a search query from tool input based on tool type.
 * Returns null if the tool should be skipped or has no meaningful target.
 */
function extractSearchQuery(toolName: string, toolInput: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'Read': {
      const filePath = toolInput.file_path as string | undefined;
      if (!filePath) return null;
      // Use stem (without extension) for FTS5 search since dots get stripped
      const base = basename(filePath);
      const stem = base.replace(/\.[^.]+$/, '');
      return stem.length >= 2 ? stem : base;
    }
    case 'Bash': {
      const command = (toolInput.command as string | undefined) ?? '';
      if (NOISE_BASH_RE.test(command)) return null;
      // Extract key terms: strip common prefixes and take first meaningful words
      const cleaned = command
        .replace(/^\s*(sudo|bash|sh|env)\s+/, '')
        .replace(/[|><&;]+.*$/, '') // stop at pipes/redirects
        .trim();
      if (!cleaned || cleaned.length < 3) return null;
      // Take first 3 words as search terms
      const words = cleaned.split(/\s+/).slice(0, 3).join(' ');
      return words.length >= 3 ? words : null;
    }
    case 'Grep': {
      const pattern = toolInput.pattern as string | undefined;
      return pattern && pattern.length >= 2 ? pattern : null;
    }
    case 'WebFetch': {
      const url = toolInput.url as string | undefined;
      if (!url) return null;
      try {
        return new URL(url).hostname;
      } catch {
        return null;
      }
    }
    case 'WebSearch': {
      return (toolInput.query as string | undefined) ?? null;
    }
    default:
      return null;
  }
}

/**
 * Formats age of an observation as a human-readable string.
 */
function formatAge(createdAt: string): string {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

/**
 * Truncates text to a max length, adding ellipsis if needed.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

/**
 * Main PreToolUse handler. Searches observations and graph for context
 * relevant to the tool about to execute.
 *
 * Returns a formatted context string to inject via stdout, or null if
 * no relevant context was found.
 */
export function handlePreToolUse(
  input: Record<string, unknown>,
  db: BetterSqlite3.Database,
  projectHash: string,
): string | null {
  const toolName = input.tool_name as string | undefined;
  if (!toolName) return null;

  // Skip Laminark's own tools
  if (isLaminarksOwnTool(toolName)) return null;

  // Skip tools with no meaningful target
  if (SKIP_TOOLS.has(toolName)) return null;

  const toolInput = (input.tool_input as Record<string, unknown>) ?? {};
  const query = extractSearchQuery(toolName, toolInput);
  if (!query) return null;

  debug('hook', 'PreToolUse searching', { tool: toolName, query });

  const lines: string[] = [];

  // 1. FTS5 search for relevant observations
  try {
    const search = new SearchEngine(db, projectHash);
    const results = search.searchKeyword(query, { limit: 3 });
    for (const result of results) {
      const snippet = result.snippet
        ? result.snippet.replace(/<\/?mark>/g, '')
        : truncate(result.observation.content, 120);
      const age = formatAge(result.observation.created_at);
      lines.push(`- ${truncate(snippet, 120)} (${result.observation.source}, ${age})`);
    }
  } catch {
    debug('hook', 'PreToolUse FTS5 search failed');
  }

  // 2. Graph lookup for file entities
  try {
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
      const filePath = toolInput.file_path as string | undefined;
      if (filePath) {
        const node = getNodeByNameAndType(db, filePath, 'File');
        if (node) {
          const connected = traverseFrom(db, node.id, { depth: 1, direction: 'both' });
          if (connected.length > 0) {
            const names = connected
              .slice(0, 5)
              .map(r => `${r.node.name} (${r.node.type})`)
              .join(', ');
            lines.push(`Related: ${names}`);
          }
        }
      }
    }
  } catch {
    debug('hook', 'PreToolUse graph lookup failed');
  }

  if (lines.length === 0) return null;

  // Format as a compact context block — use basename for display (not the search stem)
  let target = query;
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') && toolInput.file_path) {
    target = basename(toolInput.file_path as string);
  }
  const output = `[Laminark] Context for ${target}:\n${lines.join('\n')}\n`;

  // Cap total output to ~500 chars
  if (output.length > 500) {
    return output.slice(0, 497) + '...\n';
  }

  return output;
}
