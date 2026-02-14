/**
 * DEPRECATED: Noise detection is now handled by Haiku classifier agent
 * (haiku-classifier-agent.ts). This file is retained only for reference.
 * No active code imports it.
 *
 * Previously: Noise pattern definitions by category that identified
 * low-signal content to be rejected by the admission filter before
 * database storage.
 */

/**
 * Noise pattern categories with detection regexes.
 *
 * Each category groups patterns for a specific type of noise.
 * Patterns are case-insensitive where appropriate.
 */
export const NOISE_PATTERNS: Record<string, RegExp[]> = {
  BUILD_OUTPUT: [
    /npm WARN/i,
    /npm ERR/i,
    /Successfully compiled/i,
    /webpack compiled/i,
    /error TS\d+/i,
    /Build completed/i,
    /Compiling\b/i,
    /Module not found/i,
  ],
  PACKAGE_INSTALL: [
    /added \d+ packages?/i,
    /npm install/i,
    /up to date/i,
    /removed \d+ packages?/i,
    /audited \d+ packages?/i,
  ],
  LINTER_WARNING: [
    /eslint/i,
    /prettier/i,
    /\d+ problems?\s*\(/i,
    // 3+ "warning" lines = noise (eslint format: "1:1  warning  ...")
    /(?:.*\bwarning\b.*[\n]?){3,}/i,
  ],
  EMPTY_OUTPUT: [
    /^(OK|Success|Done|undefined|null)?\s*$/is,
  ],
};

/**
 * Checks whether the given content matches any noise pattern category.
 *
 * @param content - The text content to check
 * @returns Object with `isNoise` flag and optional `category` name
 */
export function isNoise(content: string): { isNoise: boolean; category?: string } {
  // Check EMPTY_OUTPUT first -- most common rejection
  for (const pattern of NOISE_PATTERNS.EMPTY_OUTPUT) {
    if (pattern.test(content)) {
      return { isNoise: true, category: 'EMPTY_OUTPUT' };
    }
  }

  // Check other categories
  for (const [category, patterns] of Object.entries(NOISE_PATTERNS)) {
    if (category === 'EMPTY_OUTPUT') continue;
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return { isNoise: true, category };
      }
    }
  }

  return { isNoise: false };
}
