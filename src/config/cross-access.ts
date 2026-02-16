/**
 * Cross-Project Access Configuration
 *
 * Per-project config that controls which other projects' memories
 * the current project can read from. Read-only access — no writes
 * cross projects.
 *
 * Config stored at: {configDir}/cross-access-{projectHash}.json
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getConfigDir } from '../shared/config.js';

export interface CrossAccessConfig {
  readableProjects: string[];
}

const DEFAULTS: CrossAccessConfig = {
  readableProjects: [],
};

function getConfigPath(projectHash: string): string {
  return join(getConfigDir(), `cross-access-${projectHash}.json`);
}

export function loadCrossAccessConfig(projectHash: string): CrossAccessConfig {
  const configPath = getConfigPath(projectHash);
  try {
    if (!existsSync(configPath)) return { ...DEFAULTS };
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CrossAccessConfig>;
    return {
      readableProjects: Array.isArray(parsed.readableProjects)
        ? parsed.readableProjects.filter((h): h is string => typeof h === 'string')
        : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveCrossAccessConfig(projectHash: string, config: CrossAccessConfig): void {
  const configPath = getConfigPath(projectHash);
  const validated: CrossAccessConfig = {
    readableProjects: Array.isArray(config.readableProjects)
      ? config.readableProjects.filter((h): h is string => typeof h === 'string' && h !== projectHash)
      : [],
  };
  writeFileSync(configPath, JSON.stringify(validated, null, 2), 'utf-8');
}

export function resetCrossAccessConfig(projectHash: string): void {
  const configPath = getConfigPath(projectHash);
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch { /* ignore */ }
}
