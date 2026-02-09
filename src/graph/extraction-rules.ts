/**
 * Rule-based pattern matchers for entity extraction.
 *
 * Each rule is a function that takes observation text and returns an array of
 * matched entities with type, confidence, and span information. Rules are
 * conservative -- only explicit patterns are matched, ambiguous text is skipped.
 *
 * Confidence scoring guidelines:
 *   0.95 - File paths (very reliable, unambiguous syntax)
 *   0.9  - Tool names (curated list, word-boundary matched)
 *   0.8  - Project names (org/repo pattern)
 *   0.7  - Decisions (language indicators)
 *   0.65 - Problems, Solutions (context-dependent phrases)
 *   0.6  - Person names (ambiguous, kept conservative)
 */

import type { EntityType } from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface ExtractionMatch {
  name: string;
  type: EntityType;
  confidence: number;
  span: [number, number];
}

export type ExtractionRule = (text: string) => ExtractionMatch[];

// =============================================================================
// File Path Rule
// =============================================================================

/**
 * Matches file paths like src/foo/bar.ts, ./config.json, /absolute/path.ext, package.json
 *
 * Regex: paths with at least one dot-extension, allowing /, ., -, _ in path segments.
 * Confidence: 0.95 (file paths are very reliable)
 */
export const filePathRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  // Match file paths: optional leading ./ or /, then segments with alphanumeric/-/_ separated by /,
  // ending with .extension. Must have at least one / or start with . or contain a known code extension.
  const regex = /(?<![a-zA-Z0-9@#])(?:\.\/|\/)?(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+(?![a-zA-Z0-9/])/g;
  // Also match standalone filenames with extensions that are common in dev contexts
  const standaloneRegex = /(?<![a-zA-Z0-9@#/])(?:[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|toml|css|scss|html|sql|sh|py|rs|go|java|rb|php|c|cpp|h|hpp|vue|svelte|astro|prisma|graphql|gql|env|lock|config|xml|csv|txt|log|gitignore|dockerignore|editorconfig))(?![a-zA-Z0-9/])/g;

  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    let name = match[0];
    // Normalize: strip leading ./
    if (name.startsWith('./')) name = name.slice(2);
    // Collapse //
    name = name.replace(/\/\//g, '/');

    matches.push({
      name,
      type: 'File',
      confidence: 0.95,
      span: [match.index, match.index + match[0].length],
    });
  }

  // Standalone files (e.g., "package.json", "tsconfig.json")
  while ((match = standaloneRegex.exec(text)) !== null) {
    const name = match[0];
    // Skip if already captured by the path regex (check for overlap)
    const overlaps = matches.some(
      (m) => match!.index >= m.span[0] && match!.index < m.span[1],
    );
    if (!overlaps) {
      matches.push({
        name,
        type: 'File',
        confidence: 0.95,
        span: [match.index, match.index + match[0].length],
      });
    }
  }

  return matches;
};

// =============================================================================
// Decision Rule
// =============================================================================

/**
 * Matches phrases following decision indicators: "decided to", "chose", "went with",
 * "selected", "opted for", "choosing between", "decision:", "the decision was".
 *
 * Extracts the clause following the indicator (up to period, comma, or end of sentence).
 * Confidence: 0.7 (decision language can be ambiguous)
 */
export const decisionRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  const indicators = [
    /\bdecided\s+to\s+/gi,
    /\bchose\s+(?:to\s+)?/gi,
    /\bwent\s+with\s+/gi,
    /\bselected\s+/gi,
    /\bopted\s+for\s+/gi,
    /\bchoosing\s+between\s+/gi,
    /\bdecision:\s*/gi,
    /\bthe\s+decision\s+was\s+(?:to\s+)?/gi,
  ];

  for (const pattern of indicators) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const clauseStart = match.index + match[0].length;
      // Extract until period, semicolon, newline, or end of text
      const remaining = text.slice(clauseStart);
      const clauseEnd = remaining.search(/[.;\n]|,\s+(?:and|but|so|which|because|since)/);
      let clause = clauseEnd >= 0 ? remaining.slice(0, clauseEnd) : remaining;
      clause = clause.trim();

      // Trim to max 100 chars
      if (clause.length > 100) clause = clause.slice(0, 100).trim();
      // Skip very short or empty clauses
      if (clause.length < 3) continue;

      matches.push({
        name: clause,
        type: 'Decision',
        confidence: 0.7,
        span: [match.index, clauseStart + (clauseEnd >= 0 ? clauseEnd : remaining.length)],
      });
    }
  }

  return matches;
};

// =============================================================================
// Tool Rule
// =============================================================================

/**
 * Known tool/technology names -- curated list for conservative matching.
 * Case-insensitive, word-boundary aware.
 * Confidence: 0.9
 */
const KNOWN_TOOLS = [
  // Linters & Formatters
  'eslint', 'prettier', 'biome', 'stylelint', 'oxlint',
  // Languages & Runtimes
  'typescript', 'javascript', 'python', 'rust', 'golang',
  'node', 'deno', 'bun',
  // Package Managers
  'npm', 'pnpm', 'yarn', 'cargo', 'pip',
  // Bundlers & Build Tools
  'webpack', 'vite', 'rollup', 'esbuild', 'tsup', 'tsdown', 'turbopack', 'parcel', 'swc',
  // Test Frameworks
  'jest', 'vitest', 'mocha', 'cypress', 'playwright', 'pytest',
  // Frontend Frameworks
  'react', 'vue', 'svelte', 'angular', 'solid', 'astro', 'next', 'nuxt', 'remix', 'gatsby',
  // CSS Frameworks
  'tailwind', 'tailwindcss', 'bootstrap', 'chakra',
  // Databases
  'sqlite', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'supabase', 'dynamodb',
  // ORMs & Query Builders
  'prisma', 'drizzle', 'typeorm', 'sequelize', 'knex', 'kysely',
  // Containers & Infrastructure
  'docker', 'kubernetes', 'terraform', 'nginx', 'caddy',
  // Version Control & CI
  'git', 'github', 'gitlab', 'circleci', 'jenkins',
  // Auth & Security
  'jwt', 'oauth', 'bcrypt', 'argon2', 'jose',
  // API & Communication
  'graphql', 'grpc', 'trpc', 'express', 'fastify', 'hono', 'koa',
  // AI/ML
  'openai', 'anthropic', 'langchain', 'huggingface', 'onnx',
  // Misc
  'zod', 'ajv', 'winston', 'pino', 'socket.io', 'rxjs',
  'storybook', 'chromatic', 'figma',
] as const;

// Build a regex that matches any tool name at word boundaries
const toolPattern = new RegExp(
  `\\b(${KNOWN_TOOLS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

export const toolRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  // Reset regex state
  toolPattern.lastIndex = 0;
  while ((match = toolPattern.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);

    matches.push({
      name,
      type: 'Tool',
      confidence: 0.9,
      span: [match.index, match.index + match[0].length],
    });
  }

  return matches;
};

// =============================================================================
// Person Rule
// =============================================================================

/**
 * Matches @-mentions and "by/with [Capitalized Name]" patterns.
 * Confidence: 0.6 (names are tricky, keep conservative)
 */
export const personRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  const seen = new Set<string>();

  // @-mentions: @username (alphanumeric, hyphens, underscores)
  const mentionRegex = /@([a-zA-Z][a-zA-Z0-9_-]{1,38})\b/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    const name = match[1];
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    matches.push({
      name: `@${name}`,
      type: 'Person',
      confidence: 0.6,
      span: [match.index, match.index + match[0].length],
    });
  }

  // "by [Capitalized Name]" -- e.g., "reviewed by John Smith"
  const byRegex = /\bby\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
  while ((match = byRegex.exec(text)) !== null) {
    const name = match[1];
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    matches.push({
      name,
      type: 'Person',
      confidence: 0.6,
      span: [match.index, match.index + match[0].length],
    });
  }

  // "with [Capitalized Name]" when preceded by interaction verbs
  const withRegex = /\b(?:decided|worked|paired|collaborated|discussed|met)\s+with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
  while ((match = withRegex.exec(text)) !== null) {
    const name = match[1];
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    matches.push({
      name,
      type: 'Person',
      confidence: 0.6,
      span: [match.index, match.index + match[0].length],
    });
  }

  return matches;
};

// =============================================================================
// Problem Rule
// =============================================================================

/**
 * Matches phrases following problem indicators: "bug in", "issue with",
 * "problem:", "error:", "failing", "broken", "doesn't work", "can't", etc.
 * Confidence: 0.65
 */
export const problemRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  const indicators = [
    /\bbug\s+in\s+/gi,
    /\bissue\s+with\s+/gi,
    /\bproblem:\s*/gi,
    /\berror:\s*/gi,
    /\bfailing\s+(?:to\s+)?/gi,
    /\bbroken\s+/gi,
    /\bdoesn'?t\s+work\s*/gi,
    /\bcan'?t\s+/gi,
    /\bunable\s+to\s+/gi,
    /\bcrash(?:es|ing|ed)?\s+(?:in|on|when|during)\s+/gi,
  ];

  for (const pattern of indicators) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const clauseStart = match.index + match[0].length;
      const remaining = text.slice(clauseStart);
      const clauseEnd = remaining.search(/[.;\n]|,\s+(?:and|but|so|which|because|since)/);
      let clause = clauseEnd >= 0 ? remaining.slice(0, clauseEnd) : remaining;
      clause = clause.trim();

      if (clause.length > 100) clause = clause.slice(0, 100).trim();
      if (clause.length < 3) continue;

      matches.push({
        name: clause,
        type: 'Problem',
        confidence: 0.65,
        span: [match.index, clauseStart + (clauseEnd >= 0 ? clauseEnd : remaining.length)],
      });
    }
  }

  return matches;
};

// =============================================================================
// Solution Rule
// =============================================================================

/**
 * Matches phrases following solution indicators: "fixed by", "solved by",
 * "the fix was", "solution:", "resolved by", "workaround:".
 * Confidence: 0.65
 */
export const solutionRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  const indicators = [
    /\bfixed\s+by\s+/gi,
    /\bsolved\s+by\s+/gi,
    /\bthe\s+fix\s+was\s+/gi,
    /\bsolution:\s*/gi,
    /\bresolved\s+by\s+/gi,
    /\bworkaround:\s*/gi,
  ];

  for (const pattern of indicators) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const clauseStart = match.index + match[0].length;
      const remaining = text.slice(clauseStart);
      const clauseEnd = remaining.search(/[.;\n]|,\s+(?:and|but|so|which|because|since)/);
      let clause = clauseEnd >= 0 ? remaining.slice(0, clauseEnd) : remaining;
      clause = clause.trim();

      if (clause.length > 100) clause = clause.slice(0, 100).trim();
      if (clause.length < 3) continue;

      matches.push({
        name: clause,
        type: 'Solution',
        confidence: 0.65,
        span: [match.index, clauseStart + (clauseEnd >= 0 ? clauseEnd : remaining.length)],
      });
    }
  }

  return matches;
};

// =============================================================================
// Project Rule
// =============================================================================

/**
 * Matches repository-style names (org/repo), project names in quotes after "project" keyword,
 * and package.json name references.
 * Confidence: 0.8
 */
export const projectRule: ExtractionRule = (text: string): ExtractionMatch[] => {
  const matches: ExtractionMatch[] = [];
  const seen = new Set<string>();

  // org/repo pattern (e.g., "facebook/react", "vercel/next.js")
  // Must have org/ prefix to distinguish from file paths (file paths have extensions)
  const orgRepoRegex = /\b([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)(?!\.[a-zA-Z]{1,4}(?:\b|\/))(?!\/)/g;
  let match: RegExpExecArray | null;
  while ((match = orgRepoRegex.exec(text)) !== null) {
    const candidate = match[1];
    // Filter out things that look like file paths (contain dot-extension patterns mid-path)
    if (/\.[a-zA-Z]{1,6}$/.test(candidate) && !/\.js$/.test(candidate)) continue;
    // Filter out common non-project patterns
    if (/^(src|dist|lib|test|tests|node_modules|build|public)\//.test(candidate)) continue;

    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    matches.push({
      name: candidate,
      type: 'Project',
      confidence: 0.8,
      span: [match.index, match.index + match[0].length],
    });
  }

  // "project [name]" or "project: [name]" with quoted name
  const projectNameRegex = /\bproject\s*[:]\s*["']([^"']+)["']/gi;
  while ((match = projectNameRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    matches.push({
      name,
      type: 'Project',
      confidence: 0.8,
      span: [match.index, match.index + match[0].length],
    });
  }

  // @scope/package pattern (npm scoped packages)
  const scopedRegex = /@([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)\b/g;
  while ((match = scopedRegex.exec(text)) !== null) {
    const name = `@${match[1]}`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    matches.push({
      name,
      type: 'Project',
      confidence: 0.8,
      span: [match.index, match.index + match[0].length],
    });
  }

  return matches;
};

// =============================================================================
// Aggregated Rules Array
// =============================================================================

/**
 * All extraction rules in priority order (higher confidence first).
 * Use this for iteration in the extraction pipeline.
 */
export const ALL_RULES: ExtractionRule[] = [
  filePathRule,
  toolRule,
  projectRule,
  decisionRule,
  problemRule,
  solutionRule,
  personRule,
];
