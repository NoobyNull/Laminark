/**
 * Database Hygiene Configuration
 *
 * Controls signal weights and tier thresholds used by the hygiene
 * analyzer to score observations for deletion candidacy.
 *
 * Configuration is loaded from .laminark/hygiene.json with
 * a 5-second cache to avoid repeated disk reads.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { debug } from '../shared/debug.js';
import { getConfigDir } from '../shared/config.js';

export interface AutoCleanupConfig {
  enabled: boolean;
  tier: 'high' | 'medium' | 'all';
  maxOrphanNodes: number;
}

export interface HygieneConfig {
  signalWeights: {
    orphaned: number;
    islandNode: number;
    noiseClassified: number;
    shortContent: number;
    autoCaptured: number;
    stale: number;
  };
  tierThresholds: {
    high: number;
    medium: number;
  };
  shortContentThreshold: number;
  autoCleanup: AutoCleanupConfig;
}

const DEFAULT_AUTO_CLEANUP: AutoCleanupConfig = {
  enabled: true,
  tier: 'high',
  maxOrphanNodes: 500,
};

const DEFAULTS: HygieneConfig = {
  signalWeights: {
    orphaned: 0.30,
    islandNode: 0.25,
    noiseClassified: 0.25,
    shortContent: 0.10,
    autoCaptured: 0.10,
    stale: 0.10,
  },
  tierThresholds: {
    high: 0.70,
    medium: 0.50,
  },
  shortContentThreshold: 50,
  autoCleanup: { ...DEFAULT_AUTO_CLEANUP },
};

const CACHE_TTL_MS = 5000;

let cachedConfig: HygieneConfig | null = null;
let cachedAt = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validate(raw: Record<string, unknown>): HygieneConfig {
  const config = { ...DEFAULTS };

  if (raw.signalWeights && typeof raw.signalWeights === 'object' && !Array.isArray(raw.signalWeights)) {
    const sw = raw.signalWeights as Record<string, unknown>;
    const weights = { ...DEFAULTS.signalWeights };
    for (const key of Object.keys(DEFAULTS.signalWeights) as (keyof typeof DEFAULTS.signalWeights)[]) {
      if (typeof sw[key] === 'number') {
        weights[key] = clamp(sw[key] as number, 0, 1);
      }
    }
    config.signalWeights = weights;
  }

  if (raw.tierThresholds && typeof raw.tierThresholds === 'object' && !Array.isArray(raw.tierThresholds)) {
    const tt = raw.tierThresholds as Record<string, unknown>;
    let high = typeof tt.high === 'number' ? clamp(tt.high as number, 0, 1) : DEFAULTS.tierThresholds.high;
    let medium = typeof tt.medium === 'number' ? clamp(tt.medium as number, 0, 1) : DEFAULTS.tierThresholds.medium;
    // Enforce medium < high
    if (medium >= high) {
      medium = Math.max(0, high - 0.1);
    }
    config.tierThresholds = { high, medium };
  }

  if (typeof raw.shortContentThreshold === 'number') {
    config.shortContentThreshold = Math.max(0, Math.round(raw.shortContentThreshold as number));
  }

  if (raw.autoCleanup && typeof raw.autoCleanup === 'object' && !Array.isArray(raw.autoCleanup)) {
    const ac = raw.autoCleanup as Record<string, unknown>;
    const cleanup = { ...DEFAULT_AUTO_CLEANUP };
    if (typeof ac.enabled === 'boolean') cleanup.enabled = ac.enabled;
    if (ac.tier === 'high' || ac.tier === 'medium' || ac.tier === 'all') cleanup.tier = ac.tier;
    if (typeof ac.maxOrphanNodes === 'number') cleanup.maxOrphanNodes = Math.max(0, Math.round(ac.maxOrphanNodes));
    config.autoCleanup = cleanup;
  }

  return config;
}

/**
 * Loads hygiene configuration from disk with a 5-second cache.
 */
export function loadHygieneConfig(): HygieneConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  const configPath = join(getConfigDir(), 'hygiene.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    cachedConfig = validate(raw);
    debug('config', 'Loaded hygiene config', { ...cachedConfig });
  } catch {
    cachedConfig = { ...DEFAULTS, signalWeights: { ...DEFAULTS.signalWeights }, tierThresholds: { ...DEFAULTS.tierThresholds } };
  }

  cachedAt = now;
  return cachedConfig;
}

/**
 * Saves hygiene configuration to disk and invalidates cache.
 */
export function saveHygieneConfig(config: HygieneConfig): void {
  const configPath = join(getConfigDir(), 'hygiene.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  cachedConfig = config;
  cachedAt = Date.now();
}

/**
 * Resets hygiene config to defaults by invalidating cache.
 */
export function resetHygieneConfig(): HygieneConfig {
  cachedConfig = null;
  cachedAt = 0;
  return { ...DEFAULTS, signalWeights: { ...DEFAULTS.signalWeights }, tierThresholds: { ...DEFAULTS.tierThresholds }, autoCleanup: { ...DEFAULT_AUTO_CLEANUP } };
}
