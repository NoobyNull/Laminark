import type BetterSqlite3 from 'better-sqlite3';

import { debug, debugTimed } from '../shared/debug.js';
import {
  rowToObservation,
  type ObservationRow,
  type SearchResult,
} from '../shared/types.js';

/**
 * FTS5 search engine with BM25 ranking, snippet extraction, and strict project scoping.
 *
 * All queries are scoped to the projectHash provided at construction time.
 * Queries are sanitized to prevent FTS5 syntax errors and injection.
 */
export class SearchEngine {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;
  }

  /**
   * Full-text search with BM25 ranking and snippet extraction.
   *
   * bm25() returns NEGATIVE values where more negative = more relevant.
   * ORDER BY rank (ascending) puts best matches first.
   *
   * @param query - User's search query (sanitized for FTS5 safety)
   * @param options - Optional limit and sessionId filter
   * @returns SearchResult[] ordered by relevance (best match first)
   */
  searchKeyword(
    query: string,
    options?: { limit?: number; sessionId?: string },
  ): SearchResult[] {
    const sanitized = this.sanitizeQuery(query);
    if (!sanitized) {
      return [];
    }

    const limit = options?.limit ?? 20;

    let sql = `
      SELECT
        o.*,
        bm25(observations_fts, 2.0, 1.0) AS rank,
        snippet(observations_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project_hash = ?
        AND o.deleted_at IS NULL
        AND (o.classification IS NULL OR o.classification != 'noise')
    `;
    const params: unknown[] = [sanitized, this.projectHash];

    if (options?.sessionId) {
      sql += ' AND o.session_id = ?';
      params.push(options.sessionId);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    const results = debugTimed('search', 'FTS5 keyword search', () => {
      const rows = this.db.prepare(sql).all(...params) as (ObservationRow & {
        rank: number;
        snippet: string;
      })[];

      return rows.map((row) => ({
        observation: rowToObservation(row),
        score: Math.abs(row.rank),
        matchType: 'fts' as const,
        snippet: row.snippet,
      }));
    });

    debug('search', 'Keyword search completed', { query: sanitized, resultCount: results.length });

    return results;
  }

  /**
   * Prefix search for autocomplete-style matching.
   * Appends `*` to each word for prefix matching.
   */
  searchByPrefix(prefix: string, limit?: number): SearchResult[] {
    const words = prefix.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [];
    }

    // Sanitize each word and append * for prefix matching
    const sanitizedWords = words
      .map((w) => this.sanitizeWord(w))
      .filter(Boolean);
    if (sanitizedWords.length === 0) {
      return [];
    }

    const ftsQuery = sanitizedWords.map((w) => `${w}*`).join(' ');
    const effectiveLimit = limit ?? 20;

    const sql = `
      SELECT
        o.*,
        bm25(observations_fts, 2.0, 1.0) AS rank,
        snippet(observations_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project_hash = ?
        AND o.deleted_at IS NULL
        AND (o.classification IS NULL OR o.classification != 'noise')
      ORDER BY rank
      LIMIT ?
    `;

    const results = debugTimed('search', 'FTS5 prefix search', () => {
      const rows = this.db
        .prepare(sql)
        .all(ftsQuery, this.projectHash, effectiveLimit) as (ObservationRow & {
        rank: number;
        snippet: string;
      })[];

      return rows.map((row) => ({
        observation: rowToObservation(row),
        score: Math.abs(row.rank),
        matchType: 'fts' as const,
        snippet: row.snippet,
      }));
    });

    debug('search', 'Prefix search completed', { prefix, resultCount: results.length });

    return results;
  }

  /**
   * Rebuild the FTS5 index if it gets out of sync.
   */
  rebuildIndex(): void {
    debug('search', 'Rebuilding FTS5 index');
    this.db.exec(
      "INSERT INTO observations_fts(observations_fts) VALUES('rebuild')",
    );
  }

  /**
   * Sanitizes a user query for safe FTS5 MATCH usage.
   * Removes FTS5 operators and special characters.
   * Returns null if the query is empty after sanitization.
   */
  private sanitizeQuery(query: string): string | null {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return null;
    }

    const sanitizedWords = words
      .map((w) => this.sanitizeWord(w))
      .filter(Boolean);

    if (sanitizedWords.length === 0) {
      return null;
    }

    // FTS5 defaults to implicit AND for space-separated words
    return sanitizedWords.join(' ');
  }

  /**
   * Sanitizes a single word for FTS5 safety.
   * Removes quotes, parentheses, asterisks, and FTS5 operator keywords.
   */
  private sanitizeWord(word: string): string {
    // Remove FTS5 special characters
    let cleaned = word.replace(/["*()^{}[\]]/g, '');

    // Remove FTS5 operator keywords (case-insensitive, only when the whole word is an operator)
    if (/^(NEAR|OR|AND|NOT)$/i.test(cleaned)) {
      return '';
    }

    // Remove any remaining non-alphanumeric characters except hyphens and underscores
    cleaned = cleaned.replace(/[^\w\-]/g, '');

    return cleaned;
  }
}
