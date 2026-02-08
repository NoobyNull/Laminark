import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import {
  ObservationInsertSchema,
  rowToObservation,
  type Observation,
  type ObservationInsert,
  type ObservationRow,
} from '../shared/types.js';

/**
 * Repository for observation CRUD operations.
 *
 * Every query is scoped to the projectHash provided at construction time.
 * Callers cannot accidentally query the wrong project -- project isolation
 * is baked into every prepared statement.
 *
 * All SQL statements are prepared once in the constructor and reused for
 * every call (better-sqlite3 performance best practice).
 */
export class ObservationRepository {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  // Prepared statements (prepared once, reused for every call)
  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtGetById: BetterSqlite3.Statement;
  private readonly stmtSoftDelete: BetterSqlite3.Statement;
  private readonly stmtRestore: BetterSqlite3.Statement;
  private readonly stmtCount: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;

    this.stmtInsert = db.prepare(`
      INSERT INTO observations (id, project_hash, content, source, session_id, embedding, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM observations
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `);

    this.stmtSoftDelete = db.prepare(`
      UPDATE observations
      SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `);

    this.stmtRestore = db.prepare(`
      UPDATE observations
      SET deleted_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `);

    this.stmtCount = db.prepare(`
      SELECT COUNT(*) AS count FROM observations
      WHERE project_hash = ? AND deleted_at IS NULL
    `);
  }

  /**
   * Creates a new observation scoped to this repository's project.
   * Validates input with Zod at runtime.
   */
  create(input: ObservationInsert): Observation {
    const validated = ObservationInsertSchema.parse(input);

    const id = randomBytes(16).toString('hex');
    const embeddingBuffer = validated.embedding
      ? Buffer.from(
          validated.embedding.buffer,
          validated.embedding.byteOffset,
          validated.embedding.byteLength,
        )
      : null;

    this.stmtInsert.run(
      id,
      this.projectHash,
      validated.content,
      validated.source,
      validated.sessionId,
      embeddingBuffer,
      validated.embeddingModel,
      validated.embeddingVersion,
    );

    // Fetch the created row (includes generated timestamps and rowid)
    const row = this.stmtGetById.get(id, this.projectHash) as
      | ObservationRow
      | undefined;

    if (!row) {
      throw new Error('Failed to retrieve newly created observation');
    }

    return rowToObservation(row);
  }

  /**
   * Gets an observation by ID, scoped to this project.
   * Returns null if not found or soft-deleted.
   */
  getById(id: string): Observation | null {
    const row = this.stmtGetById.get(id, this.projectHash) as
      | ObservationRow
      | undefined;
    return row ? rowToObservation(row) : null;
  }

  /**
   * Lists observations for this project, ordered by created_at DESC.
   * Excludes soft-deleted observations.
   */
  list(options?: {
    limit?: number;
    offset?: number;
    sessionId?: string;
    since?: string;
  }): Observation[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let sql =
      'SELECT * FROM observations WHERE project_hash = ? AND deleted_at IS NULL';
    const params: unknown[] = [this.projectHash];

    if (options?.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }

    if (options?.since) {
      sql += ' AND created_at >= ?';
      params.push(options.since);
    }

    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Updates an observation's content, embedding fields, or both.
   * Always sets updated_at to current time.
   * Scoped to this project; returns null if not found or soft-deleted.
   */
  update(
    id: string,
    updates: Partial<
      Pick<
        Observation,
        'content' | 'embedding' | 'embeddingModel' | 'embeddingVersion'
      >
    >,
  ): Observation | null {
    const setClauses: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      params.push(updates.content);
    }

    if (updates.embedding !== undefined) {
      setClauses.push('embedding = ?');
      params.push(
        updates.embedding
          ? Buffer.from(
              updates.embedding.buffer,
              updates.embedding.byteOffset,
              updates.embedding.byteLength,
            )
          : null,
      );
    }

    if (updates.embeddingModel !== undefined) {
      setClauses.push('embedding_model = ?');
      params.push(updates.embeddingModel);
    }

    if (updates.embeddingVersion !== undefined) {
      setClauses.push('embedding_version = ?');
      params.push(updates.embeddingVersion);
    }

    params.push(id, this.projectHash);

    const sql = `UPDATE observations SET ${setClauses.join(', ')} WHERE id = ? AND project_hash = ? AND deleted_at IS NULL`;
    const result = this.db.prepare(sql).run(...params);

    if (result.changes === 0) {
      return null;
    }

    return this.getById(id);
  }

  /**
   * Soft-deletes an observation by setting deleted_at.
   * Returns true if the observation was found and deleted.
   */
  softDelete(id: string): boolean {
    const result = this.stmtSoftDelete.run(id, this.projectHash);
    return result.changes > 0;
  }

  /**
   * Restores a soft-deleted observation by clearing deleted_at.
   * Returns true if the observation was found and restored.
   */
  restore(id: string): boolean {
    const result = this.stmtRestore.run(id, this.projectHash);
    return result.changes > 0;
  }

  /**
   * Counts non-deleted observations for this project.
   */
  count(): number {
    const row = this.stmtCount.get(this.projectHash) as { count: number };
    return row.count;
  }
}
