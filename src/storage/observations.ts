import type BetterSqlite3 from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import { debug } from '../shared/debug.js';
import {
  ObservationInsertSchema,
  rowToObservation,
  type Observation,
  type ObservationClassification,
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
  private readonly stmtGetByIdIncludingDeleted: BetterSqlite3.Statement;
  private readonly stmtSoftDelete: BetterSqlite3.Statement;
  private readonly stmtRestore: BetterSqlite3.Statement;
  private readonly stmtCount: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;

    this.stmtInsert = db.prepare(`
      INSERT INTO observations (id, project_hash, content, title, source, kind, session_id, embedding, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM observations
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `);

    this.stmtGetByIdIncludingDeleted = db.prepare(`
      SELECT * FROM observations
      WHERE id = ? AND project_hash = ?
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

    debug('obs', 'ObservationRepository initialized', { projectHash });
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

    debug('obs', 'Creating observation', { source: validated.source, contentLength: validated.content.length });

    this.stmtInsert.run(
      id,
      this.projectHash,
      validated.content,
      validated.title,
      validated.source,
      validated.kind,
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

    debug('obs', 'Observation created', { id });

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
    kind?: string;
    includeUnclassified?: boolean;
  }): Observation[] {
    debug('obs', 'Listing observations', { ...options });

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const includeUnclassified = options?.includeUnclassified ?? false;

    let sql =
      'SELECT * FROM observations WHERE project_hash = ? AND deleted_at IS NULL';
    const params: unknown[] = [this.projectHash];

    if (!includeUnclassified) {
      sql += " AND ((classification IS NOT NULL AND classification != 'noise') OR created_at >= datetime('now', '-60 seconds'))";
    }

    if (options?.kind) {
      sql += ' AND kind = ?';
      params.push(options.kind);
    }

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

    debug('obs', 'Listed observations', { count: rows.length });

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
    debug('obs', 'Updating observation', { id });

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
      debug('obs', 'Observation not found for update', { id });
      return null;
    }

    debug('obs', 'Observation updated', { id });

    return this.getById(id);
  }

  /**
   * Soft-deletes an observation by setting deleted_at.
   * Returns true if the observation was found and deleted.
   */
  softDelete(id: string): boolean {
    debug('obs', 'Soft-deleting observation', { id });
    const result = this.stmtSoftDelete.run(id, this.projectHash);
    debug('obs', result.changes > 0 ? 'Observation soft-deleted' : 'Observation not found for delete', { id });
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
   * Updates the classification of an observation.
   * Sets classified_at to current time. Returns true if found and updated.
   */
  updateClassification(
    id: string,
    classification: ObservationClassification,
  ): boolean {
    debug('obs', 'Updating classification', { id, classification });
    const sql = `
      UPDATE observations
      SET classification = ?, classified_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND project_hash = ? AND deleted_at IS NULL
    `;
    const result = this.db.prepare(sql).run(classification, id, this.projectHash);
    return result.changes > 0;
  }

  /**
   * Creates an observation with an initial classification (bypasses classifier).
   * Used for explicit user saves that should be immediately visible.
   */
  createClassified(input: ObservationInsert, classification: ObservationClassification): Observation {
    const obs = this.create(input);
    this.updateClassification(obs.id, classification);
    // Re-fetch to get the updated classification fields
    return this.getById(obs.id)!;
  }

  /**
   * Fetches unclassified observations for the background classifier.
   * Returns observations ordered by created_at ASC (oldest first).
   */
  listUnclassified(limit: number = 20): Observation[] {
    const sql = `
      SELECT * FROM observations
      WHERE project_hash = ? AND classification IS NULL AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(this.projectHash, limit) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Fetches observations surrounding a given timestamp for classification context.
   * Returns observations regardless of classification status.
   */
  listContext(aroundTime: string, windowSize: number = 5): Observation[] {
    // Get N observations before
    const beforeSql = `
      SELECT * FROM observations
      WHERE project_hash = ? AND deleted_at IS NULL AND created_at <= ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `;
    const beforeRows = this.db.prepare(beforeSql).all(
      this.projectHash, aroundTime, windowSize + 1,
    ) as ObservationRow[];

    // Get N observations after
    const afterSql = `
      SELECT * FROM observations
      WHERE project_hash = ? AND deleted_at IS NULL AND created_at > ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `;
    const afterRows = this.db.prepare(afterSql).all(
      this.projectHash, aroundTime, windowSize,
    ) as ObservationRow[];

    // Combine in chronological order (before is DESC, so reverse it)
    const allRows = [...beforeRows.reverse(), ...afterRows];
    // Deduplicate by id
    const seen = new Set<string>();
    const unique = allRows.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return unique.map(rowToObservation);
  }

  /**
   * Counts non-deleted observations for this project.
   */
  count(): number {
    const row = this.stmtCount.get(this.projectHash) as { count: number };
    return row.count;
  }

  /**
   * Gets an observation by ID, including soft-deleted observations.
   * Used by the recall tool for restore operations (must find purged items).
   */
  getByIdIncludingDeleted(id: string): Observation | null {
    debug('obs', 'Getting observation including deleted', { id });
    const row = this.stmtGetByIdIncludingDeleted.get(id, this.projectHash) as
      | ObservationRow
      | undefined;
    return row ? rowToObservation(row) : null;
  }

  /**
   * Lists observations for this project, including soft-deleted ones.
   * Used by recall with include_purged: true to show all items.
   */
  listIncludingDeleted(options?: {
    limit?: number;
    offset?: number;
  }): Observation[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    debug('obs', 'Listing observations including deleted', { limit, offset });

    const sql =
      'SELECT * FROM observations WHERE project_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?';
    const rows = this.db
      .prepare(sql)
      .all(this.projectHash, limit, offset) as ObservationRow[];

    debug('obs', 'Listed observations including deleted', {
      count: rows.length,
    });

    return rows.map(rowToObservation);
  }

  /**
   * Searches observations by title substring (partial match via LIKE).
   * Optionally includes soft-deleted items.
   */
  getByTitle(
    title: string,
    options?: { limit?: number; includePurged?: boolean },
  ): Observation[] {
    const limit = options?.limit ?? 20;
    const includePurged = options?.includePurged ?? false;

    debug('obs', 'Searching by title', { title, limit, includePurged });

    let sql = 'SELECT * FROM observations WHERE project_hash = ? AND title LIKE ?';
    if (!includePurged) {
      sql += ' AND deleted_at IS NULL';
    }
    sql += " AND classification IS NOT NULL AND classification != 'noise'";
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';

    const rows = this.db
      .prepare(sql)
      .all(this.projectHash, `%${title}%`, limit) as ObservationRow[];

    debug('obs', 'Title search completed', { count: rows.length });

    return rows.map(rowToObservation);
  }
}
