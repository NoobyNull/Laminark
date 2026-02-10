/**
 * Semantic signal extractor for Claude piggyback embeddings.
 *
 * Processes Claude's response text (available during PostToolUse hook) and
 * extracts semantic signals using fast rule-based processing (< 10ms).
 *
 * This module does NO LLM calls or external API calls -- pure string/regex
 * processing for zero-added-latency extraction.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An entity mentioned in Claude's response, with a probable type hint.
 */
export interface EntityMention {
  name: string;
  probable_type: string;
}

/**
 * Semantic signals extracted from Claude's response text.
 *
 * These signals are used by PiggybackEmbeddingStrategy to augment ONNX
 * embeddings with higher-quality semantic information derived from Claude's
 * own reasoning.
 */
export interface SemanticSignal {
  /** Top significant terms extracted from response (TF-IDF-like scoring) */
  keywords: string[];
  /** Detected topic labels from keyword clusters */
  topics: string[];
  /** Overall sentiment of the response */
  sentiment: 'positive' | 'negative' | 'neutral' | 'technical';
  /** Lightweight entity hints for knowledge graph */
  entities_mentioned: EntityMention[];
  /** Placeholder for piggyback embedding vector (populated by strategy) */
  summary_vector: number[] | null;
}

// ---------------------------------------------------------------------------
// Stop words -- common English words filtered from keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'this',
  'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we',
  'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our',
  'their', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'not', 'no', 'nor', 'if', 'then', 'else', 'so', 'up', 'out', 'about',
  'into', 'over', 'after', 'before', 'between', 'under', 'again', 'just',
  'also', 'very', 'too', 'only', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'than', 'here', 'there', 'now',
  'well', 'get', 'got', 'like', 'make', 'made', 'one', 'two', 'new',
  'first', 'last', 'see', 'use', 'used', 'using', 'way', 'need', 'say',
  'said', 'let', 'll', 've', 're', 'don', 't', 's', 'm', 'd',
]);

// ---------------------------------------------------------------------------
// Known tool names (Claude Code tools)
// ---------------------------------------------------------------------------

const KNOWN_TOOLS = new Set([
  'read', 'write', 'edit', 'bash', 'glob', 'grep', 'task', 'todowrite',
  'todoread', 'mcp', 'webfetch', 'computer', 'texteditor',
]);

// ---------------------------------------------------------------------------
// Regex patterns (compiled once for performance)
// ---------------------------------------------------------------------------

/** File paths: /foo/bar.ts, src/hooks/handler.ts, ./relative/path.js */
const FILE_PATH_RE = /(?:\/[\w.-]+){2,}\.[\w]+|(?:[\w.-]+\/){1,}[\w.-]+\.[\w]+/g;

/** Decision language: "decided to", "chose", "went with", etc. */
const DECISION_RE = /(?:decided\s+to|chose|went\s+with|selected|opted\s+for|picked)\s+([^.,;!?\n]{3,60})/gi;

/** Person references: "@username" patterns (trailing punctuation stripped) */
const PERSON_REF_RE = /@([\w][\w-]*[\w]|[\w])/g;

// ---------------------------------------------------------------------------
// Sentiment indicators
// ---------------------------------------------------------------------------

const POSITIVE_WORDS = new Set([
  'works', 'working', 'success', 'succeeded', 'fixed', 'resolved', 'correct',
  'passed', 'complete', 'completed', 'done', 'good', 'great', 'perfect',
  'excellent', 'improved', 'better', 'clean', 'ready',
]);

const NEGATIVE_WORDS = new Set([
  'error', 'errors', 'failed', 'failing', 'broken', 'bug', 'bugs', 'wrong',
  'issue', 'issues', 'problem', 'problems', 'crash', 'crashed', 'missing',
  'undefined', 'null', 'exception', 'rejected', 'corrupt', 'invalid',
]);

const TECHNICAL_WORDS = new Set([
  'function', 'class', 'interface', 'type', 'import', 'export', 'module',
  'async', 'await', 'promise', 'return', 'const', 'let', 'var', 'if',
  'for', 'while', 'switch', 'case', 'try', 'catch', 'throw', 'new',
  'extends', 'implements', 'abstract', 'static', 'private', 'public',
  'typescript', 'javascript', 'node', 'npm', 'api', 'http', 'sql',
  'database', 'query', 'schema', 'migration', 'test', 'spec', 'mock',
  'config', 'deploy', 'build', 'compile', 'runtime', 'dependency',
]);

// ---------------------------------------------------------------------------
// Core extraction logic
// ---------------------------------------------------------------------------

/**
 * Tokenize text into lowercase words, filtering punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Extract top N keywords using TF-IDF-like scoring.
 * Term frequency in response, penalized by stop-word membership.
 */
function extractKeywords(text: string, topN: number = 15): string[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();

  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/**
 * Detect sentiment from keyword frequencies.
 */
function detectSentiment(tokens: string[]): SemanticSignal['sentiment'] {
  let positive = 0;
  let negative = 0;
  let technical = 0;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (POSITIVE_WORDS.has(lower)) positive++;
    if (NEGATIVE_WORDS.has(lower)) negative++;
    if (TECHNICAL_WORDS.has(lower)) technical++;
  }

  // Technical wins if dominant (common in code-related responses)
  if (technical > positive + negative && technical >= 3) return 'technical';
  if (negative > positive && negative >= 2) return 'negative';
  if (positive > negative && positive >= 2) return 'positive';
  return 'neutral';
}

/**
 * Extract entity mentions: file paths, decisions, tool names, person refs.
 */
function extractEntities(text: string): EntityMention[] {
  const entities: EntityMention[] = [];
  const seen = new Set<string>();

  // File paths
  const filePaths = text.match(FILE_PATH_RE);
  if (filePaths) {
    for (const fp of filePaths) {
      const normalized = fp.trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        entities.push({ name: normalized, probable_type: 'file_path' });
      }
    }
  }

  // Decision language
  let match: RegExpExecArray | null;
  const decisionRe = new RegExp(DECISION_RE.source, DECISION_RE.flags);
  while ((match = decisionRe.exec(text)) !== null) {
    const decision = match[1].trim();
    if (decision.length > 3 && !seen.has(decision)) {
      seen.add(decision);
      entities.push({ name: decision, probable_type: 'decision' });
    }
  }

  // Tool names (check words against known tools)
  const tokens = tokenize(text);
  for (const token of tokens) {
    if (KNOWN_TOOLS.has(token) && !seen.has(token)) {
      seen.add(token);
      entities.push({ name: token, probable_type: 'tool' });
    }
  }

  // Person references (@username)
  const personRe = new RegExp(PERSON_REF_RE.source, PERSON_REF_RE.flags);
  while ((match = personRe.exec(text)) !== null) {
    const person = match[1];
    if (person.length > 1 && !seen.has(person)) {
      seen.add(person);
      entities.push({ name: person, probable_type: 'person' });
    }
  }

  return entities;
}

/**
 * Group keywords into simple topic clusters.
 *
 * Uses a co-occurrence heuristic: keywords that appear near each other
 * in the text are grouped. Returns the top N topic labels.
 */
function detectTopics(keywords: string[], text: string, topN: number = 5): string[] {
  if (keywords.length === 0) return [];

  // Simple approach: group consecutive keywords that appear within
  // 100 chars of each other in the original text
  const positions = new Map<string, number>();
  const lowerText = text.toLowerCase();

  for (const kw of keywords) {
    const idx = lowerText.indexOf(kw);
    if (idx !== -1) {
      positions.set(kw, idx);
    }
  }

  // Sort by position and group nearby keywords
  const sorted = Array.from(positions.entries()).sort((a, b) => a[1] - b[1]);
  const topics: string[] = [];
  let currentGroup: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (currentGroup.length === 0) {
      currentGroup.push(sorted[i][0]);
    } else {
      const lastPos = positions.get(currentGroup[currentGroup.length - 1])!;
      const curPos = sorted[i][1];
      if (curPos - lastPos < 100) {
        currentGroup.push(sorted[i][0]);
      } else {
        // Emit topic from current group
        topics.push(currentGroup.slice(0, 3).join('-'));
        currentGroup = [sorted[i][0]];
      }
    }
  }

  // Emit last group
  if (currentGroup.length > 0) {
    topics.push(currentGroup.slice(0, 3).join('-'));
  }

  return topics.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract semantic signals from Claude's response text.
 *
 * Rule-based extraction -- no LLM calls, no external APIs.
 * Designed to run in < 10ms for typical response sizes.
 *
 * Never throws. On any error, returns a minimal empty signal.
 */
export function extractSemanticSignals(responseText: string): SemanticSignal {
  try {
    if (!responseText || responseText.trim().length === 0) {
      return emptySignal();
    }

    const keywords = extractKeywords(responseText);
    const tokens = tokenize(responseText);
    const sentiment = detectSentiment(tokens);
    const entities_mentioned = extractEntities(responseText);
    const topics = detectTopics(keywords, responseText);

    return {
      keywords,
      topics,
      sentiment,
      entities_mentioned,
      summary_vector: null,
    };
  } catch {
    return emptySignal();
  }
}

/**
 * Returns a minimal empty signal for graceful degradation.
 */
function emptySignal(): SemanticSignal {
  return {
    keywords: [],
    topics: [],
    sentiment: 'neutral',
    entities_mentioned: [],
    summary_vector: null,
  };
}
