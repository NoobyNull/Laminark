import Database from "better-sqlite3";
import { z } from "zod";

//#region src/shared/types.d.ts
/**
 * Observation -- the application-layer shape.
 * Uses camelCase for idiomatic TypeScript.
 * embedding is Float32Array (converted from Buffer during mapping).
 */
type ObservationClassification = 'discovery' | 'problem' | 'solution' | 'noise';
type ObservationKind = 'change' | 'reference' | 'finding' | 'decision' | 'verification';
interface Observation {
  rowid: number;
  id: string;
  projectHash: string;
  content: string;
  title: string | null;
  source: string;
  sessionId: string | null;
  kind: ObservationKind;
  embedding: Float32Array | null;
  embeddingModel: string | null;
  embeddingVersion: string | null;
  classification: ObservationClassification | null;
  classifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
/**
 * ObservationInsert -- input for creating observations.
 * Validated at runtime via Zod schema.
 */
declare const ObservationInsertSchema: z.ZodObject<{
  content: z.ZodString;
  title: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  source: z.ZodDefault<z.ZodString>;
  kind: z.ZodDefault<z.ZodString>;
  sessionId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  embedding: z.ZodDefault<z.ZodNullable<z.ZodCustom<Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>>>>;
  embeddingModel: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  embeddingVersion: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
type ObservationInsert = z.input<typeof ObservationInsertSchema>;
interface Session {
  id: string;
  projectHash: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
}
interface SearchResult {
  observation: Observation;
  score: number;
  matchType: 'fts' | 'vector' | 'hybrid';
  snippet: string;
}
interface DatabaseConfig {
  dbPath: string;
  busyTimeout: number;
}
//#endregion
//#region src/storage/observations.d.ts
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
declare class ObservationRepository {
  private readonly db;
  private readonly projectHash;
  private readonly stmtInsert;
  private readonly stmtGetById;
  private readonly stmtGetByIdIncludingDeleted;
  private readonly stmtSoftDelete;
  private readonly stmtRestore;
  private readonly stmtCount;
  constructor(db: Database.Database, projectHash: string);
  /**
   * Creates a new observation scoped to this repository's project.
   * Validates input with Zod at runtime.
   */
  create(input: ObservationInsert): Observation;
  /**
   * Gets an observation by ID, scoped to this project.
   * Returns null if not found or soft-deleted.
   */
  getById(id: string): Observation | null;
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
  }): Observation[];
  /**
   * Updates an observation's content, embedding fields, or both.
   * Always sets updated_at to current time.
   * Scoped to this project; returns null if not found or soft-deleted.
   */
  update(id: string, updates: Partial<Pick<Observation, 'content' | 'embedding' | 'embeddingModel' | 'embeddingVersion'>>): Observation | null;
  /**
   * Soft-deletes an observation by setting deleted_at.
   * Returns true if the observation was found and deleted.
   */
  softDelete(id: string): boolean;
  /**
   * Restores a soft-deleted observation by clearing deleted_at.
   * Returns true if the observation was found and restored.
   */
  restore(id: string): boolean;
  /**
   * Updates the classification of an observation.
   * Sets classified_at to current time. Returns true if found and updated.
   */
  updateClassification(id: string, classification: ObservationClassification): boolean;
  /**
   * Creates an observation with an initial classification (bypasses classifier).
   * Used for explicit user saves that should be immediately visible.
   */
  createClassified(input: ObservationInsert, classification: ObservationClassification): Observation;
  /**
   * Fetches unclassified observations for the background classifier.
   * Returns observations ordered by created_at ASC (oldest first).
   */
  listUnclassified(limit?: number): Observation[];
  /**
   * Fetches observations surrounding a given timestamp for classification context.
   * Returns observations regardless of classification status.
   */
  listContext(aroundTime: string, windowSize?: number): Observation[];
  /**
   * Counts non-deleted observations for this project.
   */
  count(): number;
  /**
   * Gets an observation by ID, including soft-deleted observations.
   * Used by the recall tool for restore operations (must find purged items).
   */
  getByIdIncludingDeleted(id: string): Observation | null;
  /**
   * Lists observations for this project, including soft-deleted ones.
   * Used by recall with include_purged: true to show all items.
   */
  listIncludingDeleted(options?: {
    limit?: number;
    offset?: number;
  }): Observation[];
  /**
   * Searches observations by title substring (partial match via LIKE).
   * Optionally includes soft-deleted items.
   */
  getByTitle(title: string, options?: {
    limit?: number;
    includePurged?: boolean;
  }): Observation[];
}
//#endregion
export { SearchResult as a, ObservationInsert as i, DatabaseConfig as n, Session as o, Observation as r, ObservationRepository as t };
//# sourceMappingURL=observations-Ch0nc47i.d.mts.map