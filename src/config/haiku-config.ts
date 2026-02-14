/**
 * Haiku configuration.
 *
 * With the Claude Agent SDK, authentication is handled by the user's
 * Claude Code subscription -- no API key needed.
 */

export interface HaikuConfig {
  model: string;
  maxTokensPerCall: number;
}

export function loadHaikuConfig(): HaikuConfig {
  return {
    model: 'claude-haiku-4-5-20251001',
    maxTokensPerCall: 1024,
  };
}
