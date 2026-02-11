import type BetterSqlite3 from 'better-sqlite3';

import { debug } from '../shared/debug.js';

/**
 * Lightweight buffer for exploration tool events (Read, Glob, Grep).
 *
 * Instead of creating full observations for these low-signal tools,
 * they are stored in a temporary buffer. When a Write/Edit observation
 * is created, the recent buffer entries are attached as research context,
 * creating provenance links between exploration and changes.
 *
 * Buffer entries are flushed after 30 minutes.
 */
export class ResearchBufferRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtGetRecent: BetterSqlite3.Statement;
  private readonly stmtFlush: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;

    this.stmtInsert = db.prepare(`
      INSERT INTO research_buffer (project_hash, session_id, tool_name, target)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtGetRecent = db.prepare(`
      SELECT tool_name, target, created_at FROM research_buffer
      WHERE session_id = ? AND project_hash = ?
        AND created_at >= datetime('now', '-' || ? || ' minutes')
      ORDER BY created_at DESC
    `);

    this.stmtFlush = db.prepare(`
      DELETE FROM research_buffer
      WHERE created_at < datetime('now', '-' || ? || ' minutes')
    `);

    debug('research-buffer', 'ResearchBufferRepository initialized', { projectHash });
  }

  /**
   * Records a research tool event in the buffer.
   */
  add(entry: {
    sessionId: string | null;
    toolName: string;
    target: string;
  }): void {
    this.stmtInsert.run(
      this.projectHash,
      entry.sessionId,
      entry.toolName,
      entry.target,
    );
    debug('research-buffer', 'Buffered research event', {
      tool: entry.toolName,
      target: entry.target,
    });
  }

  /**
   * Returns recent buffer entries for a session within a time window.
   */
  getRecent(
    sessionId: string,
    windowMinutes: number = 5,
  ): Array<{ toolName: string; target: string; createdAt: string }> {
    const rows = this.stmtGetRecent.all(
      sessionId,
      this.projectHash,
      windowMinutes,
    ) as Array<{ tool_name: string; target: string; created_at: string }>;

    return rows.map(r => ({
      toolName: r.tool_name,
      target: r.target,
      createdAt: r.created_at,
    }));
  }

  /**
   * Deletes buffer entries older than the specified number of minutes.
   */
  flush(olderThanMinutes: number = 30): number {
    const result = this.stmtFlush.run(olderThanMinutes);
    if (result.changes > 0) {
      debug('research-buffer', 'Flushed old entries', { deleted: result.changes });
    }
    return result.changes;
  }
}
