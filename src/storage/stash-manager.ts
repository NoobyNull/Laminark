import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import { debug } from '../shared/debug.js';
import type {
  ContextStash,
  StashObservation,
  CreateStashInput,
} from '../types/stash.js';

/**
 * Raw context_stashes row from SQLite (snake_case column names).
 */
interface StashRow {
  id: string;
  project_id: string;
  session_id: string;
  topic_label: string;
  summary: string;
  observation_snapshots: string; // JSON string
  observation_ids: string; // JSON string
  status: string;
  created_at: string;
  resumed_at: string | null;
}

/**
 * Maps a snake_case StashRow to a camelCase ContextStash interface.
 * JSON-parses observation_snapshots and observation_ids from their
 * serialized TEXT column format back into arrays.
 */
function rowToStash(row: StashRow): ContextStash {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    topicLabel: row.topic_label,
    summary: row.summary,
    observationIds: JSON.parse(row.observation_ids) as string[],
    observationSnapshots: JSON.parse(
      row.observation_snapshots,
    ) as StashObservation[],
    createdAt: row.created_at,
    resumedAt: row.resumed_at,
    status: row.status as ContextStash['status'],
  };
}

/**
 * Repository for context stash CRUD operations.
 *
 * Manages the lifecycle of stashed context threads: creating snapshots
 * when topic shifts are detected, listing available stashes, retrieving
 * full stash records, resuming stashes, and deleting them.
 *
 * All SQL statements are prepared once in the constructor and reused
 * for every call (better-sqlite3 performance best practice).
 */
export class StashManager {
  private readonly db: BetterSqlite3.Database;

  // Prepared statements
  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtGetById: BetterSqlite3.Statement;
  private readonly stmtResume: BetterSqlite3.Statement;
  private readonly stmtDelete: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;

    this.stmtInsert = db.prepare(`
      INSERT INTO context_stashes (id, project_id, session_id, topic_label, summary, observation_snapshots, observation_ids, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'stashed')
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM context_stashes WHERE id = ?
    `);

    this.stmtResume = db.prepare(`
      UPDATE context_stashes
      SET status = 'resumed', resumed_at = datetime('now')
      WHERE id = ?
    `);

    this.stmtDelete = db.prepare(`
      DELETE FROM context_stashes WHERE id = ?
    `);

    debug('db', 'StashManager initialized');
  }

  /**
   * Creates a new stash record from a context thread snapshot.
   * JSON-serializes observation snapshots and IDs for TEXT column storage.
   * Uses randomBytes(16) hex for ID generation (matches ObservationRepository pattern).
   */
  createStash(input: CreateStashInput): ContextStash {
    const id = randomBytes(16).toString('hex');
    const observationIds = input.observations.map((o) => o.id);
    const snapshotsJson = JSON.stringify(input.observations);
    const idsJson = JSON.stringify(observationIds);

    debug('db', 'Creating stash', {
      topicLabel: input.topicLabel,
      observationCount: input.observations.length,
    });

    this.stmtInsert.run(
      id,
      input.projectId,
      input.sessionId,
      input.topicLabel,
      input.summary,
      snapshotsJson,
      idsJson,
    );

    const row = this.stmtGetById.get(id) as StashRow | undefined;
    if (!row) {
      throw new Error('Failed to retrieve newly created stash');
    }

    debug('db', 'Stash created', { id });

    return rowToStash(row);
  }

  /**
   * Lists stashes for a project, ordered by created_at DESC.
   * Supports optional filtering by session_id and status.
   */
  listStashes(
    projectId: string,
    options?: { sessionId?: string; status?: string; limit?: number },
  ): ContextStash[] {
    const limit = options?.limit ?? 10;

    let sql =
      'SELECT * FROM context_stashes WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (options?.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    debug('db', 'Listing stashes', { projectId, ...options });

    const rows = this.db.prepare(sql).all(...params) as StashRow[];
    return rows.map(rowToStash);
  }

  /**
   * Retrieves a single stash by ID with full observation snapshot data.
   * Returns null for nonexistent IDs.
   */
  getStash(id: string): ContextStash | null {
    const row = this.stmtGetById.get(id) as StashRow | undefined;
    return row ? rowToStash(row) : null;
  }

  /**
   * Marks a stash as resumed and sets resumed_at timestamp.
   * Returns the updated record.
   * Throws if the stash does not exist.
   */
  resumeStash(id: string): ContextStash {
    const result = this.stmtResume.run(id);

    if (result.changes === 0) {
      throw new Error(`Stash not found: ${id}`);
    }

    debug('db', 'Stash resumed', { id });

    const row = this.stmtGetById.get(id) as StashRow | undefined;
    if (!row) {
      throw new Error(`Failed to retrieve resumed stash: ${id}`);
    }

    return rowToStash(row);
  }

  /**
   * Hard-deletes a stash record.
   */
  deleteStash(id: string): void {
    this.stmtDelete.run(id);
    debug('db', 'Stash deleted', { id });
  }

  /**
   * Returns stashes with status='stashed' (excludes resumed) for a project,
   * ordered by created_at DESC.
   */
  getRecentStashes(projectId: string, limit?: number): ContextStash[] {
    return this.listStashes(projectId, {
      status: 'stashed',
      limit: limit ?? 10,
    });
  }
}
