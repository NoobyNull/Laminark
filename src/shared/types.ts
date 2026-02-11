import { z } from 'zod';

// =============================================================================
// Database Layer Types (snake_case, matches SQL columns)
// =============================================================================

/**
 * ObservationRow -- the raw database row shape.
 * Uses snake_case to match SQL column names directly.
 * rowid is INTEGER PRIMARY KEY AUTOINCREMENT for FTS5 content_rowid compatibility.
 */
export const ObservationRowSchema = z.object({
  rowid: z.number(),
  id: z.string(),
  project_hash: z.string(),
  content: z.string(),
  title: z.string().nullable(),
  source: z.string(),
  session_id: z.string().nullable(),
  embedding: z.instanceof(Buffer).nullable(),
  embedding_model: z.string().nullable(),
  embedding_version: z.string().nullable(),
  kind: z.string().default('finding'),
  classification: z.string().nullable(),
  classified_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type ObservationRow = z.infer<typeof ObservationRowSchema>;

// =============================================================================
// Application Layer Types (camelCase)
// =============================================================================

/**
 * Observation -- the application-layer shape.
 * Uses camelCase for idiomatic TypeScript.
 * embedding is Float32Array (converted from Buffer during mapping).
 */
export type ObservationClassification = 'discovery' | 'problem' | 'solution' | 'noise';

export type ObservationKind = 'change' | 'reference' | 'finding' | 'decision' | 'verification';

export interface Observation {
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

// =============================================================================
// Input Types (validated with Zod)
// =============================================================================

/**
 * ObservationInsert -- input for creating observations.
 * Validated at runtime via Zod schema.
 */
export const ObservationInsertSchema = z.object({
  content: z.string().min(1).max(100_000),
  title: z.string().max(200).nullable().default(null),
  source: z.string().default('unknown'),
  kind: z.string().default('finding'),
  sessionId: z.string().nullable().default(null),
  embedding: z.instanceof(Float32Array).nullable().default(null),
  embeddingModel: z.string().nullable().default(null),
  embeddingVersion: z.string().nullable().default(null),
});

export type ObservationInsert = z.input<typeof ObservationInsertSchema>;

// =============================================================================
// Session Types
// =============================================================================

export interface Session {
  id: string;
  projectHash: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
}

// =============================================================================
// Search Types
// =============================================================================

export interface SearchResult {
  observation: Observation;
  score: number;
  matchType: 'fts' | 'vector' | 'hybrid';
  snippet: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

export interface DatabaseConfig {
  dbPath: string;
  busyTimeout: number;
}

// =============================================================================
// Mapping Helpers
// =============================================================================

/**
 * Maps a snake_case ObservationRow (from SQLite) to a camelCase Observation.
 * Converts embedding Buffer to Float32Array for application use.
 */
export function rowToObservation(row: ObservationRow): Observation {
  return {
    rowid: row.rowid,
    id: row.id,
    projectHash: row.project_hash,
    content: row.content,
    title: row.title,
    source: row.source,
    sessionId: row.session_id,
    kind: (row.kind ?? 'finding') as ObservationKind,
    embedding: row.embedding
      ? new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        )
      : null,
    embeddingModel: row.embedding_model,
    embeddingVersion: row.embedding_version,
    classification: row.classification as ObservationClassification | null,
    classifiedAt: row.classified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
