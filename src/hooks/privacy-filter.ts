import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { debug } from '../shared/debug.js';

// =============================================================================
// Types
// =============================================================================

interface PrivacyPattern {
  name: string;
  regex: RegExp;
  replacement: string;
  category: string;
}

interface UserPrivacyConfig {
  additionalPatterns?: Array<{
    regex: string;
    replacement: string;
  }>;
  excludedFiles?: string[];
}

// =============================================================================
// Default Patterns
// =============================================================================

/**
 * Built-in privacy patterns that are always active.
 *
 * Order matters: more specific patterns should come before more general ones.
 * For example, api_key patterns before env_variable to avoid double-matching.
 */
const DEFAULT_PRIVACY_PATTERNS: PrivacyPattern[] = [
  {
    name: 'private_key',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private_key]',
    category: 'private_key',
  },
  {
    name: 'jwt_token',
    regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED:jwt]',
    category: 'jwt',
  },
  {
    name: 'connection_string',
    regex: /(postgresql|mongodb|mysql|redis):\/\/[^\s]+/g,
    replacement: '$1://[REDACTED:connection_string]',
    category: 'connection_string',
  },
  {
    name: 'api_key_openai',
    regex: /sk-[a-zA-Z0-9]{20,}/g,
    replacement: '[REDACTED:api_key]',
    category: 'api_key',
  },
  {
    name: 'api_key_github',
    regex: /ghp_[a-zA-Z0-9]{36,}/g,
    replacement: '[REDACTED:api_key]',
    category: 'api_key',
  },
  {
    name: 'aws_access_key',
    regex: /AKIA[A-Z0-9]{12,}/g,
    replacement: '[REDACTED:api_key]',
    category: 'api_key',
  },
  {
    name: 'env_variable',
    // Match KEY=value where value is 8+ chars and NOT already redacted
    regex: /\b([A-Z][A-Z0-9_]{2,})=(["']?)(?!\[REDACTED:)([^\s"']{8,})\2/g,
    replacement: '$1=[REDACTED:env]',
    category: 'env',
  },
];

/**
 * Default file patterns that trigger full exclusion (return null).
 */
const DEFAULT_EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /\.env(\.|$)/, // .env, .env.local, .env.production
  /credentials/i, // credentials.json, etc.
  /secrets/i, // secrets.yaml, etc.
  /\.pem$/, // SSL certificates
  /\.key$/, // Private keys
  /id_rsa/, // SSH keys
];

// =============================================================================
// Pattern Loading
// =============================================================================

/**
 * Cached patterns (loaded once per process).
 * null = not yet loaded.
 */
let _cachedPatterns: PrivacyPattern[] | null = null;
let _cachedExcludedFiles: RegExp[] | null = null;

/**
 * Loads user privacy patterns from ~/.laminark/config.json.
 * Merges with defaults. Caches result.
 *
 * If the config file doesn't exist or is invalid, returns defaults only.
 */
function loadPatterns(): PrivacyPattern[] {
  if (_cachedPatterns !== null) {
    return _cachedPatterns;
  }

  const patterns = [...DEFAULT_PRIVACY_PATTERNS];

  try {
    const configPath = join(homedir(), '.laminark', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const privacy = config.privacy as UserPrivacyConfig | undefined;

    if (privacy?.additionalPatterns) {
      for (const p of privacy.additionalPatterns) {
        patterns.push({
          name: `user_${p.regex}`,
          regex: new RegExp(p.regex, 'g'),
          replacement: p.replacement,
          category: 'user',
        });
      }
      debug('privacy', 'Loaded user privacy patterns', {
        count: privacy.additionalPatterns.length,
      });
    }
  } catch {
    // Config file doesn't exist or is invalid -- use defaults only
  }

  _cachedPatterns = patterns;
  return patterns;
}

/**
 * Loads excluded file patterns (default + user-configured).
 */
function loadExcludedFiles(): RegExp[] {
  if (_cachedExcludedFiles !== null) {
    return _cachedExcludedFiles;
  }

  const patterns = [...DEFAULT_EXCLUDED_FILE_PATTERNS];

  try {
    const configPath = join(homedir(), '.laminark', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const privacy = config.privacy as UserPrivacyConfig | undefined;

    if (privacy?.excludedFiles) {
      for (const pattern of privacy.excludedFiles) {
        patterns.push(new RegExp(pattern));
      }
    }
  } catch {
    // Config file doesn't exist or is invalid -- use defaults only
  }

  _cachedExcludedFiles = patterns;
  return patterns;
}

/**
 * Reset cached patterns. Used for testing when HOME changes.
 * @internal
 */
export function _resetPatternCache(): void {
  _cachedPatterns = null;
  _cachedExcludedFiles = null;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Checks whether a file path matches any excluded file pattern.
 *
 * Excluded files should have their observations fully dropped (return null
 * from redactSensitiveContent) rather than just redacted.
 *
 * @param filePath - The file path to check (can be absolute or relative)
 * @returns true if the file should be excluded from observation storage
 */
export function isExcludedFile(filePath: string): boolean {
  const name = basename(filePath);
  const patterns = loadExcludedFiles();

  for (const pattern of patterns) {
    if (pattern.test(name) || pattern.test(filePath)) {
      return true;
    }
  }

  return false;
}

/**
 * Redacts sensitive content before storage.
 *
 * - If filePath is provided and matches an excluded file pattern, returns null
 *   (the entire observation should be dropped)
 * - Otherwise, applies all privacy patterns (default + user-configured)
 *   sequentially to the text
 * - Returns the redacted text, or the original if no patterns matched
 *
 * @param text - The observation text to redact
 * @param filePath - Optional file path that triggered the observation
 * @returns Redacted text, or null if the file should be fully excluded
 */
export function redactSensitiveContent(
  text: string,
  filePath?: string,
): string | null {
  // Check file exclusion first
  if (filePath && isExcludedFile(filePath)) {
    debug('privacy', 'File excluded from observation', { filePath });
    return null;
  }

  const patterns = loadPatterns();
  let result = text;
  const matchedPatterns: string[] = [];

  for (const pattern of patterns) {
    // Reset regex lastIndex (global flag means stateful)
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(result)) {
      matchedPatterns.push(pattern.name);
      // Reset lastIndex again before replace
      pattern.regex.lastIndex = 0;
      result = result.replace(pattern.regex, pattern.replacement);
    }
  }

  if (matchedPatterns.length > 0) {
    debug('privacy', 'Content redacted', { patterns: matchedPatterns });
  }

  return result;
}
