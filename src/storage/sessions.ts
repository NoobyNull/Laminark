import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';
import type { Session } from '../shared/types.js';

/**
 * Raw session row from SQLite (snake_case column names).
 */
interface SessionRow {
  id: string;
  project_hash: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

/**
 * Maps a snake_case SessionRow to a camelCase Session interface.
 */
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectHash: row.project_hash,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
  };
}

/**
 * Repository for session lifecycle management.
 *
 * Every query is scoped to the projectHash provided at construction time.
 * All SQL statements are prepared once in the constructor.
 */
export class SessionRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  // Prepared statements
  private readonly stmtCreate: BetterSqlite3.Statement;
  private readonly stmtGetById: BetterSqlite3.Statement;
  private readonly stmtGetActive: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;

    this.stmtCreate = db.prepare(`
      INSERT INTO sessions (id, project_hash)
      VALUES (?, ?)
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM sessions
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtGetActive = db.prepare(`
      SELECT * FROM sessions
      WHERE ended_at IS NULL AND project_hash = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);

    debug('session', 'SessionRepository initialized', { projectHash });
  }

  /**
   * Creates a new session with the given ID, scoped to this project.
   */
  create(id: string): Session {
    this.stmtCreate.run(id, this.projectHash);

    const row = this.stmtGetById.get(id, this.projectHash) as
      | SessionRow
      | undefined;

    if (!row) {
      throw new Error('Failed to retrieve newly created session');
    }

    debug('session', 'Session created', { id });

    return rowToSession(row);
  }

  /**
   * Ends a session by setting ended_at and optionally a summary.
   * Returns the updated session or null if not found.
   */
  end(id: string, summary?: string): Session | null {
    const setClauses = ["ended_at = datetime('now')"];
    const params: unknown[] = [];

    if (summary !== undefined) {
      setClauses.push('summary = ?');
      params.push(summary);
    }

    params.push(id, this.projectHash);

    const sql = `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ? AND project_hash = ?`;
    const result = this.db.prepare(sql).run(...params);

    if (result.changes === 0) {
      return null;
    }

    debug('session', 'Session ended', { id, hasSummary: !!summary });

    return this.getById(id);
  }

  /**
   * Gets a session by ID, scoped to this project.
   */
  getById(id: string): Session | null {
    const row = this.stmtGetById.get(id, this.projectHash) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Gets the most recent sessions for this project, ordered by started_at DESC.
   */
  getLatest(limit?: number): Session[] {
    const effectiveLimit = limit ?? 10;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE project_hash = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(this.projectHash, effectiveLimit) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Gets the currently active (not ended) session for this project.
   * Returns the most recently started active session, or null if none.
   */
  getActive(): Session | null {
    const row = this.stmtGetActive.get(this.projectHash) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }
}
