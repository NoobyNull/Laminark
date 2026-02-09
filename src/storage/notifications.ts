import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { debug } from '../shared/debug.js';

export interface PendingNotification {
  id: string;
  projectId: string;
  message: string;
  createdAt: string;
}

export class NotificationStore {
  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtConsume: BetterSqlite3.Statement;
  private readonly stmtSelect: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    // Create table inline (no migration needed -- simple transient store)
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_notifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.stmtInsert = db.prepare(
      'INSERT INTO pending_notifications (id, project_id, message) VALUES (?, ?, ?)'
    );
    this.stmtSelect = db.prepare(
      'SELECT * FROM pending_notifications WHERE project_id = ? ORDER BY created_at ASC LIMIT 10'
    );
    this.stmtConsume = db.prepare(
      'DELETE FROM pending_notifications WHERE project_id = ?'
    );
    debug('db', 'NotificationStore initialized');
  }

  add(projectId: string, message: string): void {
    const id = randomBytes(16).toString('hex');
    this.stmtInsert.run(id, projectId, message);
    debug('db', 'Notification added', { projectId });
  }

  /** Fetch and delete all pending notifications for a project (consume pattern). */
  consumePending(projectId: string): PendingNotification[] {
    const rows = this.stmtSelect.all(projectId) as Array<{
      id: string; project_id: string; message: string; created_at: string;
    }>;
    if (rows.length > 0) {
      this.stmtConsume.run(projectId);
    }
    return rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      message: r.message,
      createdAt: r.created_at,
    }));
  }
}
