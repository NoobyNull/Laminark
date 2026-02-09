// ---------------------------------------------------------------------------
// Topic Detection Configuration
// ---------------------------------------------------------------------------
// User-configurable sensitivity dial for topic shift detection.
// Supports three presets (sensitive/balanced/relaxed), custom multipliers,
// manual threshold override, and an enable/disable toggle.
//
// Configuration is loaded from .laminark/topic-detection.json with
// safe defaults when the file does not exist.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { debug } from '../shared/debug.js';
import { getConfigDir } from '../shared/config.js';
import type { TopicShiftDetector } from '../intelligence/topic-detector.js';
import type { AdaptiveThresholdManager } from '../intelligence/adaptive-threshold.js';

/**
 * Sensitivity preset names for topic detection.
 */
export type SensitivityPreset = 'sensitive' | 'balanced' | 'relaxed';

/**
 * Full configuration for topic detection behavior.
 */
export interface TopicDetectionConfig {
  /** Named sensitivity preset */
  sensitivityPreset: SensitivityPreset;
  /** Derived from preset or custom -- multiplied with EWMA stddev for threshold */
  sensitivityMultiplier: number;
  /** If set, overrides adaptive threshold entirely */
  manualThreshold: number | null;
  /** EWMA decay factor (0 < alpha <= 1) */
  ewmaAlpha: number;
  /** Hard bounds for adaptive threshold */
  thresholdBounds: { min: number; max: number };
  /** Master toggle -- when false, topic detection is disabled */
  enabled: boolean;
}

/**
 * Raw JSON shape for the configuration file.
 * All fields are optional -- missing fields use defaults.
 */
interface RawConfigJson {
  sensitivityPreset?: string;
  sensitivityMultiplier?: number;
  manualThreshold?: number | null;
  ewmaAlpha?: number;
  thresholdBounds?: { min?: number; max?: number };
  enabled?: boolean;
}

/**
 * Maps a sensitivity preset to its multiplier value.
 *
 * - sensitive (1.0): Detects smaller shifts -- lower bar for topic change
 * - balanced (1.5): Default -- moderate sensitivity
 * - relaxed (2.5): Only detects large shifts -- higher bar
 */
export function sensitivityPresetToMultiplier(preset: SensitivityPreset): number {
  switch (preset) {
    case 'sensitive':
      return 1.0;
    case 'balanced':
      return 1.5;
    case 'relaxed':
      return 2.5;
  }
}

/** Default configuration values */
const DEFAULTS: TopicDetectionConfig = {
  sensitivityPreset: 'balanced',
  sensitivityMultiplier: 1.5,
  manualThreshold: null,
  ewmaAlpha: 0.3,
  thresholdBounds: { min: 0.15, max: 0.6 },
  enabled: true,
};

/**
 * Loads topic detection configuration from disk.
 *
 * Reads .laminark/topic-detection.json (relative to the Laminark data
 * directory). Falls back to defaults if the file does not exist or
 * cannot be parsed. Validates threshold bounds constraints.
 */
export function loadTopicDetectionConfig(): TopicDetectionConfig {
  const configPath = join(getConfigDir(), 'topic-detection.json');

  let raw: RawConfigJson = {};

  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content) as RawConfigJson;
    debug('config', 'Loaded topic detection config', { path: configPath });
  } catch {
    // File doesn't exist or is invalid -- use all defaults
    debug('config', 'No topic detection config found, using defaults');
    return { ...DEFAULTS };
  }

  // Resolve sensitivity preset
  const validPresets: SensitivityPreset[] = ['sensitive', 'balanced', 'relaxed'];
  const preset: SensitivityPreset = validPresets.includes(raw.sensitivityPreset as SensitivityPreset)
    ? (raw.sensitivityPreset as SensitivityPreset)
    : DEFAULTS.sensitivityPreset;

  // Multiplier: explicit value > preset-derived > default
  const multiplier =
    typeof raw.sensitivityMultiplier === 'number' && raw.sensitivityMultiplier > 0
      ? raw.sensitivityMultiplier
      : sensitivityPresetToMultiplier(preset);

  // Manual threshold: null means use adaptive
  const manualThreshold =
    typeof raw.manualThreshold === 'number' ? raw.manualThreshold : null;

  // EWMA alpha
  const ewmaAlpha =
    typeof raw.ewmaAlpha === 'number' && raw.ewmaAlpha > 0 && raw.ewmaAlpha <= 1
      ? raw.ewmaAlpha
      : DEFAULTS.ewmaAlpha;

  // Threshold bounds with validation
  let boundsMin =
    typeof raw.thresholdBounds?.min === 'number'
      ? raw.thresholdBounds.min
      : DEFAULTS.thresholdBounds.min;
  let boundsMax =
    typeof raw.thresholdBounds?.max === 'number'
      ? raw.thresholdBounds.max
      : DEFAULTS.thresholdBounds.max;

  // Validate bounds: min >= 0.05, max <= 0.95, min < max
  if (boundsMin < 0.05) boundsMin = 0.05;
  if (boundsMax > 0.95) boundsMax = 0.95;
  if (boundsMin >= boundsMax) {
    boundsMin = DEFAULTS.thresholdBounds.min;
    boundsMax = DEFAULTS.thresholdBounds.max;
  }

  // Enabled toggle
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled;

  return {
    sensitivityPreset: preset,
    sensitivityMultiplier: multiplier,
    manualThreshold,
    ewmaAlpha,
    thresholdBounds: { min: boundsMin, max: boundsMax },
    enabled,
  };
}

/**
 * Applies a TopicDetectionConfig to a detector and adaptive manager.
 *
 * - If config.enabled is false, sets detector threshold to 999 (never triggers)
 * - If config.manualThreshold is set, uses it directly (bypasses adaptive)
 * - Otherwise, configures the adaptive manager with the sensitivity multiplier
 */
export function applyConfig(
  config: TopicDetectionConfig,
  detector: TopicShiftDetector,
  adaptiveManager: AdaptiveThresholdManager,
): void {
  if (!config.enabled) {
    // Disabled mode: set threshold so high that nothing triggers
    detector.setThreshold(999);
    debug('config', 'Topic detection disabled -- threshold set to 999');
    return;
  }

  if (config.manualThreshold !== null) {
    // Manual override: bypass adaptive entirely
    detector.setThreshold(config.manualThreshold);
    debug('config', 'Manual threshold override applied', {
      threshold: config.manualThreshold,
    });
    return;
  }

  // Adaptive mode: configure the manager's sensitivity
  // The adaptive manager uses sensitivityMultiplier internally via constructor,
  // but we can influence it by seeding or updating its state.
  // For now, apply the threshold from the adaptive manager to the detector.
  const adaptiveThreshold = adaptiveManager.getThreshold();
  detector.setThreshold(adaptiveThreshold);

  debug('config', 'Adaptive config applied', {
    preset: config.sensitivityPreset,
    multiplier: config.sensitivityMultiplier,
    threshold: adaptiveThreshold,
  });
}
