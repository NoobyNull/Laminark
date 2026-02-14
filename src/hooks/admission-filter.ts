import { isLaminarksOwnTool } from './self-referential.js';
import { debug } from '../shared/debug.js';

/**
 * Tools that are always admitted regardless of content.
 *
 * Write and Edit observations are high-signal by definition --
 * they represent intentional code changes. Content pattern matching
 * must NEVER reject these tools (see research pitfall #3).
 *
 * WebFetch and WebSearch are reference material -- always valuable.
 */
const HIGH_SIGNAL_TOOLS = new Set(['Write', 'Edit', 'WebFetch', 'WebSearch']);

// =============================================================================
// Bash Command Filtering
// =============================================================================

/**
 * Navigation/exploration Bash commands that produce noise observations.
 * Matched against the start of the command string (after trimming).
 */
const NAVIGATION_BASH_PREFIXES = [
  'ls', 'cd ', 'pwd', 'cat ', 'head ', 'tail ', 'echo ',
  'wc ', 'which ', 'find ', 'tree', 'file ',
];

/**
 * Git read-only commands that are navigation (not mutations).
 */
const NAVIGATION_GIT_PATTERNS = [
  /^git\s+status\b/,
  /^git\s+log\b/,
  /^git\s+diff\b(?!.*--)/,
  /^git\s+branch\b(?!\s+-[dDmM])/,
  /^git\s+show\b/,
  /^git\s+remote\b/,
  /^git\s+stash\s+list\b/,
];

/**
 * Commands that are always meaningful and should be admitted.
 */
const MEANINGFUL_BASH_PATTERNS = [
  // Test runners
  /^npm\s+test\b/, /^npx\s+vitest\b/, /^npx\s+jest\b/, /^vitest\b/, /^jest\b/,
  /^pytest\b/, /^cargo\s+test\b/, /^go\s+test\b/, /^make\s+test\b/,
  // Build commands
  /^npm\s+run\s+build\b/, /^npx\s+tsc\b/, /^cargo\s+build\b/, /^make\b/,
  /^go\s+build\b/, /^gradle\b/, /^mvn\b/,
  // Git mutations
  /^git\s+commit\b/, /^git\s+push\b/, /^git\s+merge\b/, /^git\s+rebase\b/,
  /^git\s+cherry-pick\b/, /^git\s+reset\b/, /^git\s+revert\b/,
  /^git\s+checkout\s+-b\b/, /^git\s+switch\s+-c\b/,
  /^git\s+stash\s+(?:push|pop|apply|drop)\b/,
  // Containers and infra
  /^docker\b/, /^kubectl\b/, /^terraform\b/, /^helm\b/,
  // Package management (mutations)
  /^npm\s+install\b/, /^npm\s+i\b/, /^yarn\s+add\b/, /^pnpm\s+add\b/,
  /^pip\s+install\b/, /^cargo\s+add\b/,
];

/**
 * Determines if a Bash command is meaningful enough to capture.
 *
 * Navigation commands (ls, cd, pwd, cat, git status, git log, etc.) are
 * filtered out. Test runners, build commands, git mutations, and container
 * commands are always admitted. Unknown commands default to admit.
 */
export function isMeaningfulBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Always admit meaningful commands
  for (const pattern of MEANINGFUL_BASH_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Reject navigation commands
  for (const prefix of NAVIGATION_BASH_PREFIXES) {
    if (trimmed.startsWith(prefix) || trimmed === prefix.trim()) return false;
  }

  // Reject git read-only commands
  for (const pattern of NAVIGATION_GIT_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // Default: admit unknown commands (they might be significant)
  return true;
}

/**
 * Maximum content length before requiring decision/error indicators.
 * Content over this threshold with no meaningful indicators is likely
 * a raw file dump or verbose command output.
 */
const MAX_CONTENT_LENGTH = 5000;

/**
 * Patterns that indicate meaningful content even in long output.
 * If content exceeds MAX_CONTENT_LENGTH, it must contain at least
 * one of these to be admitted.
 */
const DECISION_OR_ERROR_INDICATORS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\bbug\b/i,
  /\bdecided\b/i,
  /\bchose\b/i,
  /\bbecause\b/i,
  /\binstead of\b/i,
];

/**
 * Decides whether an observation is worth storing in the database.
 *
 * This is the primary quality gate for the observation pipeline.
 * It prevents the database from filling with noise (build output,
 * linter spam, package install logs).
 *
 * Critical rule: Write and Edit tools are NEVER rejected based on
 * content patterns alone. Tool type is the primary signal.
 *
 * @param toolName - The name of the tool that produced the observation
 * @param content - The observation content to evaluate
 * @returns true if the observation should be stored, false to reject
 */
export function shouldAdmit(toolName: string, content: string): boolean {
  // Reject Laminark self-referential MCP tools
  if (isLaminarksOwnTool(toolName)) {
    debug('hook', 'Observation rejected', { tool: toolName, reason: 'self-referential' });
    return false;
  }

  // Empty/whitespace content is always rejected, even for high-signal tools
  if (!content || content.trim().length === 0) {
    debug('hook', 'Observation rejected', { tool: toolName, reason: 'empty' });
    return false;
  }

  // High-signal tools are always admitted (Write, Edit)
  if (HIGH_SIGNAL_TOOLS.has(toolName)) {
    return true;
  }

  // Noise pattern detection is now handled post-storage by the HaikuProcessor.
  // Observations are stored first, then classified by Haiku, and noise is soft-deleted.
  // Only cheap structural filters remain here as pre-storage gates.

  // Long content without decision/error indicators is likely noise
  if (content.length > MAX_CONTENT_LENGTH) {
    const hasIndicator = DECISION_OR_ERROR_INDICATORS.some((pattern) =>
      pattern.test(content),
    );
    if (!hasIndicator) {
      debug('hook', 'Observation rejected', {
        tool: toolName,
        reason: 'long_content_no_indicators',
        length: content.length,
      });
      return false;
    }
  }

  return true;
}
