/**
 * Graph Extraction Configuration
 *
 * User-configurable settings for knowledge graph extraction behavior.
 * Follows the same pattern as topic-detection-config.ts.
 *
 * Configuration is loaded from .laminark/graph-extraction.json with
 * safe defaults when the file does not exist.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { debug } from '../shared/debug.js';
import { getConfigDir } from '../shared/config.js';
import type { EntityType } from '../graph/types.js';

// =============================================================================
// Types
// =============================================================================

export interface GraphExtractionConfig {
  /** Master toggle -- when false, all graph extraction is disabled */
  enabled: boolean;

  /** Signal classifier settings */
  signalClassifier: {
    /** Sources that get full extraction (entities + relationships) */
    highSignalSources: string[];
    /** Sources that get entities only (no relationship edges) */
    mediumSignalSources: string[];
    /** Sources that skip graph extraction entirely */
    skipSources: string[];
    /** Minimum content length to process (chars) */
    minContentLength: number;
  };

  /** Write-quality gate settings */
  qualityGate: {
    /** Minimum entity name length */
    minNameLength: number;
    /** Maximum entity name length */
    maxNameLength: number;
    /** Maximum File nodes per observation */
    maxFilesPerObservation: number;
    /** Per-type minimum confidence thresholds */
    typeConfidenceThresholds: Record<EntityType, number>;
    /** Confidence multiplier for File paths from non-change observations */
    fileNonChangeMultiplier: number;
  };

  /** Relationship detector settings */
  relationshipDetector: {
    /** Minimum edge confidence to persist */
    minEdgeConfidence: number;
  };

  /** Temporal decay settings */
  temporalDecay: {
    /** Half-life in days */
    halfLifeDays: number;
    /** Minimum floor weight */
    minFloor: number;
    /** Edges below this weight are deleted during curation */
    deletionThreshold: number;
    /** Maximum age in days before forced deletion */
    maxAgeDays: number;
  };

  /** Fuzzy deduplication settings */
  fuzzyDedup: {
    /** Maximum Levenshtein distance for typo matching */
    maxLevenshteinDistance: number;
    /** Minimum Jaccard similarity for word matching */
    jaccardThreshold: number;
  };
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULTS: GraphExtractionConfig = {
  enabled: true,

  signalClassifier: {
    highSignalSources: ['manual', 'hook:Write', 'hook:Edit', 'hook:WebFetch', 'hook:WebSearch'],
    mediumSignalSources: ['hook:Bash', 'curation:merge'],
    skipSources: [
      'hook:TaskUpdate', 'hook:TaskCreate', 'hook:EnterPlanMode',
      'hook:ExitPlanMode', 'hook:Read', 'hook:Glob', 'hook:Grep',
    ],
    minContentLength: 30,
  },

  qualityGate: {
    minNameLength: 3,
    maxNameLength: 200,
    maxFilesPerObservation: 5,
    typeConfidenceThresholds: {
      File: 0.95,
      Project: 0.8,
      Reference: 0.85,
      Decision: 0.65,
      Problem: 0.6,
      Solution: 0.6,
    },
    fileNonChangeMultiplier: 0.74,
  },

  relationshipDetector: {
    minEdgeConfidence: 0.45,
  },

  temporalDecay: {
    halfLifeDays: 30,
    minFloor: 0.05,
    deletionThreshold: 0.08,
    maxAgeDays: 180,
  },

  fuzzyDedup: {
    maxLevenshteinDistance: 2,
    jaccardThreshold: 0.7,
  },
};

// =============================================================================
// Raw JSON Type
// =============================================================================

interface RawConfigJson {
  enabled?: boolean;
  signalClassifier?: {
    highSignalSources?: string[];
    mediumSignalSources?: string[];
    skipSources?: string[];
    minContentLength?: number;
  };
  qualityGate?: {
    minNameLength?: number;
    maxNameLength?: number;
    maxFilesPerObservation?: number;
    typeConfidenceThresholds?: Partial<Record<EntityType, number>>;
    fileNonChangeMultiplier?: number;
  };
  relationshipDetector?: {
    minEdgeConfidence?: number;
  };
  temporalDecay?: {
    halfLifeDays?: number;
    minFloor?: number;
    deletionThreshold?: number;
    maxAgeDays?: number;
  };
  fuzzyDedup?: {
    maxLevenshteinDistance?: number;
    jaccardThreshold?: number;
  };
}

// =============================================================================
// Loader
// =============================================================================

/**
 * Loads graph extraction configuration from disk.
 *
 * Reads .laminark/graph-extraction.json (relative to the Laminark data
 * directory). Falls back to defaults if the file does not exist or
 * cannot be parsed. Validates threshold constraints.
 */
export function loadGraphExtractionConfig(): GraphExtractionConfig {
  const configPath = join(getConfigDir(), 'graph-extraction.json');

  let raw: RawConfigJson = {};

  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content) as RawConfigJson;
    debug('config', 'Loaded graph extraction config', { path: configPath });
  } catch {
    debug('config', 'No graph extraction config found, using defaults');
    return { ...DEFAULTS };
  }

  // Enabled toggle
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled;

  // Signal classifier
  const signalClassifier = {
    highSignalSources: Array.isArray(raw.signalClassifier?.highSignalSources)
      ? raw.signalClassifier!.highSignalSources
      : DEFAULTS.signalClassifier.highSignalSources,
    mediumSignalSources: Array.isArray(raw.signalClassifier?.mediumSignalSources)
      ? raw.signalClassifier!.mediumSignalSources
      : DEFAULTS.signalClassifier.mediumSignalSources,
    skipSources: Array.isArray(raw.signalClassifier?.skipSources)
      ? raw.signalClassifier!.skipSources
      : DEFAULTS.signalClassifier.skipSources,
    minContentLength: typeof raw.signalClassifier?.minContentLength === 'number'
      && raw.signalClassifier.minContentLength >= 0
      ? raw.signalClassifier.minContentLength
      : DEFAULTS.signalClassifier.minContentLength,
  };

  // Quality gate
  const rawQG = raw.qualityGate;
  const typeConf = { ...DEFAULTS.qualityGate.typeConfidenceThresholds };
  if (rawQG?.typeConfidenceThresholds) {
    for (const [key, val] of Object.entries(rawQG.typeConfidenceThresholds)) {
      if (typeof val === 'number' && val >= 0 && val <= 1) {
        typeConf[key as EntityType] = val;
      }
    }
  }

  let fileMultiplier = typeof rawQG?.fileNonChangeMultiplier === 'number'
    ? rawQG.fileNonChangeMultiplier
    : DEFAULTS.qualityGate.fileNonChangeMultiplier;
  if (fileMultiplier < 0 || fileMultiplier > 1) {
    fileMultiplier = DEFAULTS.qualityGate.fileNonChangeMultiplier;
  }

  const qualityGate = {
    minNameLength: typeof rawQG?.minNameLength === 'number' && rawQG.minNameLength >= 1
      ? rawQG.minNameLength
      : DEFAULTS.qualityGate.minNameLength,
    maxNameLength: typeof rawQG?.maxNameLength === 'number' && rawQG.maxNameLength >= 10
      ? rawQG.maxNameLength
      : DEFAULTS.qualityGate.maxNameLength,
    maxFilesPerObservation: typeof rawQG?.maxFilesPerObservation === 'number'
      && rawQG.maxFilesPerObservation >= 1
      ? rawQG.maxFilesPerObservation
      : DEFAULTS.qualityGate.maxFilesPerObservation,
    typeConfidenceThresholds: typeConf,
    fileNonChangeMultiplier: fileMultiplier,
  };

  // Relationship detector
  let minEdge = typeof raw.relationshipDetector?.minEdgeConfidence === 'number'
    ? raw.relationshipDetector.minEdgeConfidence
    : DEFAULTS.relationshipDetector.minEdgeConfidence;
  if (minEdge < 0 || minEdge > 1) {
    minEdge = DEFAULTS.relationshipDetector.minEdgeConfidence;
  }
  const relationshipDetector = { minEdgeConfidence: minEdge };

  // Temporal decay
  const rawTD = raw.temporalDecay;
  const temporalDecay = {
    halfLifeDays: typeof rawTD?.halfLifeDays === 'number' && rawTD.halfLifeDays > 0
      ? rawTD.halfLifeDays
      : DEFAULTS.temporalDecay.halfLifeDays,
    minFloor: typeof rawTD?.minFloor === 'number' && rawTD.minFloor >= 0 && rawTD.minFloor < 1
      ? rawTD.minFloor
      : DEFAULTS.temporalDecay.minFloor,
    deletionThreshold: typeof rawTD?.deletionThreshold === 'number'
      && rawTD.deletionThreshold >= 0 && rawTD.deletionThreshold < 1
      ? rawTD.deletionThreshold
      : DEFAULTS.temporalDecay.deletionThreshold,
    maxAgeDays: typeof rawTD?.maxAgeDays === 'number' && rawTD.maxAgeDays > 0
      ? rawTD.maxAgeDays
      : DEFAULTS.temporalDecay.maxAgeDays,
  };

  // Fuzzy dedup
  const rawFD = raw.fuzzyDedup;
  const fuzzyDedup = {
    maxLevenshteinDistance: typeof rawFD?.maxLevenshteinDistance === 'number'
      && rawFD.maxLevenshteinDistance >= 1
      ? rawFD.maxLevenshteinDistance
      : DEFAULTS.fuzzyDedup.maxLevenshteinDistance,
    jaccardThreshold: typeof rawFD?.jaccardThreshold === 'number'
      && rawFD.jaccardThreshold > 0 && rawFD.jaccardThreshold <= 1
      ? rawFD.jaccardThreshold
      : DEFAULTS.fuzzyDedup.jaccardThreshold,
  };

  return {
    enabled,
    signalClassifier,
    qualityGate,
    relationshipDetector,
    temporalDecay,
    fuzzyDedup,
  };
}
