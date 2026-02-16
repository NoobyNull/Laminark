/**
 * Tool Response Verbosity Configuration
 *
 * Controls how much detail MCP tool responses include.
 * Three levels:
 *   1 (minimal): Just confirms the tool ran
 *   2 (standard): Shows title/key info (default)
 *   3 (verbose):  Full formatted text with all details
 *
 * Configuration is loaded from .laminark/tool-verbosity.json with
 * a 5-second cache to avoid repeated disk reads.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { debug } from '../shared/debug.js';
import { getConfigDir } from '../shared/config.js';

export type VerbosityLevel = 1 | 2 | 3;

export interface ToolVerbosityConfig {
  level: VerbosityLevel;
}

const DEFAULTS: ToolVerbosityConfig = { level: 2 };
const CACHE_TTL_MS = 5000;

let cachedConfig: ToolVerbosityConfig | null = null;
let cachedAt = 0;

/**
 * Loads tool verbosity configuration from disk with a 5-second cache.
 */
export function loadToolVerbosityConfig(): ToolVerbosityConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const configPath = join(getConfigDir(), 'tool-verbosity.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    const level = raw.level;
    if (level === 1 || level === 2 || level === 3) {
      cachedConfig = { level };
    } else {
      cachedConfig = { ...DEFAULTS };
    }
    debug('config', 'Loaded tool verbosity config', { level: cachedConfig.level });
  } catch {
    cachedConfig = { ...DEFAULTS };
  }

  cachedAt = now;
  return cachedConfig;
}

/**
 * Saves tool verbosity configuration to disk and invalidates cache.
 */
export function saveToolVerbosityConfig(config: ToolVerbosityConfig): void {
  const configPath = join(getConfigDir(), 'tool-verbosity.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  cachedConfig = config;
  cachedAt = Date.now();
}

/**
 * Resets tool verbosity to defaults by invalidating cache.
 */
export function resetToolVerbosityConfig(): ToolVerbosityConfig {
  cachedConfig = null;
  cachedAt = 0;
  return { ...DEFAULTS };
}

/**
 * Selects the appropriate response text based on the current verbosity level.
 *
 * Each tool passes three pre-built strings:
 * - minimal:  Level 1 — just confirms the tool ran
 * - standard: Level 2 — shows title/key info
 * - verbose:  Level 3 — full formatted text
 */
export function formatResponse(
  level: VerbosityLevel,
  minimal: string,
  standard: string,
  verbose: string,
): string {
  switch (level) {
    case 1: return minimal;
    case 2: return standard;
    case 3: return verbose;
  }
}

/**
 * Convenience: loads config and selects the response in one call.
 */
export function verboseResponse(
  minimal: string,
  standard: string,
  verbose: string,
): string {
  const { level } = loadToolVerbosityConfig();
  return formatResponse(level, minimal, standard, verbose);
}
