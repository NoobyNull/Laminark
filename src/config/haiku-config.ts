/**
 * Haiku API configuration.
 *
 * Loads the Laminark API key for direct Haiku calls.
 * Resolution order: LAMINARK_API_KEY env var > config.json apiKey > disabled.
 * Follows the same pattern as LAMINARK_DEBUG and LAMINARK_DATA_DIR.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getConfigDir } from '../shared/config.js';
import { debug } from '../shared/debug.js';

export interface HaikuConfig {
  apiKey: string | null;
  model: string;
  maxTokensPerCall: number;
  enabled: boolean;
}

/**
 * Loads the Haiku configuration with a 3-tier resolution order:
 *
 * 1. LAMINARK_API_KEY environment variable (highest priority)
 * 2. config.json in getConfigDir() with `apiKey` field
 * 3. Not configured (returns { enabled: false, apiKey: null })
 */
export function loadHaikuConfig(): HaikuConfig {
  // Priority 1: Environment variable
  const envKey = process.env.LAMINARK_API_KEY;
  if (envKey) {
    return {
      apiKey: envKey,
      model: 'claude-haiku-4-5-20251001',
      maxTokensPerCall: 1024,
      enabled: true,
    };
  }

  // Priority 2: config.json in data directory
  try {
    const configPath = join(getConfigDir(), 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config.apiKey === 'string' && config.apiKey.length > 0) {
      return {
        apiKey: config.apiKey,
        model: (typeof config.haikuModel === 'string' ? config.haikuModel : null) ?? 'claude-haiku-4-5-20251001',
        maxTokensPerCall: 1024,
        enabled: true,
      };
    }
  } catch {
    // Config file doesn't exist or is invalid -- that's fine
  }

  // Priority 3: Not configured
  debug('config', 'No Laminark API key found -- Haiku enrichment disabled');
  return {
    apiKey: null,
    model: 'claude-haiku-4-5-20251001',
    maxTokensPerCall: 1024,
    enabled: false,
  };
}
