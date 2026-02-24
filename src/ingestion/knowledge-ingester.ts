/**
 * Knowledge ingester for markdown documents.
 *
 * Transforms structured markdown files (from .planning/codebase/ or .laminark/codebase/)
 * into discrete, queryable reference observations. Implements idempotent re-ingestion
 * via soft-delete + recreate strategy.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseMarkdownSections } from './markdown-parser.js';
import { ObservationRepository } from '../storage/observations.js';

/**
 * Statistics from an ingestion operation.
 */
export interface IngestionStats {
  filesProcessed: number;
  sectionsCreated: number;
  sectionsRemoved: number;
}

/**
 * Ingests markdown files into the knowledge store.
 *
 * Creates one observation per ## section, with idempotent re-ingestion
 * that cleans up stale sections without duplication.
 */
export class KnowledgeIngester {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;
  }

  /**
   * Detects the knowledge directory for a project.
   * Checks in order:
   * 1. {projectRoot}/.planning/codebase/ (GSD output)
   * 2. {projectRoot}/.laminark/codebase/
   * Returns the first existing directory, or null if none exist.
   */
  static detectKnowledgeDir(projectRoot: string): string | null {
    const candidates = [
      join(projectRoot, '.planning', 'codebase'),
      join(projectRoot, '.laminark', 'codebase'),
    ];

    for (const candidate of candidates) {
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // Directory doesn't exist, try next
      }
    }

    return null;
  }

  /**
   * Ingests all markdown files from a directory.
   * Reads all files async first, then runs DB operations in a single transaction.
   */
  async ingestDirectory(dirPath: string): Promise<IngestionStats> {
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      // Directory doesn't exist or can't be read
      return { filesProcessed: 0, sectionsCreated: 0, sectionsRemoved: 0 };
    }

    // Filter to .md files only
    const mdFiles = files.filter((f) => f.endsWith('.md'));

    // Read all file contents async first
    const fileContents = new Map<string, string>();
    for (const file of mdFiles) {
      const filePath = join(dirPath, file);
      try {
        const content = await readFile(filePath, 'utf-8');
        fileContents.set(file, content);
      } catch {
        // Skip files that can't be read
      }
    }

    // Aggregate stats
    let totalCreated = 0;
    let totalRemoved = 0;

    // Process each file in a transaction
    for (const [filename, content] of fileContents) {
      const stats = this.ingestFileSync(filename, content);
      totalCreated += stats.sectionsCreated;
      totalRemoved += stats.sectionsRemoved;
    }

    return {
      filesProcessed: fileContents.size,
      sectionsCreated: totalCreated,
      sectionsRemoved: totalRemoved,
    };
  }

  /**
   * Ingests a single markdown file.
   * Wraps async file reading with sync ingestion.
   */
  async ingestFile(filePath: string): Promise<IngestionStats> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const filename = basename(filePath);
      return this.ingestFileSync(filename, content);
    } catch {
      // File can't be read
      return { filesProcessed: 0, sectionsCreated: 0, sectionsRemoved: 0 };
    }
  }

  /**
   * Internal sync ingestion method (runs within transaction).
   * Implements idempotent upsert via soft-delete + recreate.
   */
  private ingestFileSync(filename: string, fileContent: string): IngestionStats {
    const sourceTag = `ingest:${filename}`;

    // Parse sections from file
    const sections = parseMarkdownSections(fileContent, filename);

    // Run DB operations in a transaction
    return this.db.transaction(() => {
      const repo = new ObservationRepository(this.db, this.projectHash);

      // Soft-delete ALL existing observations with matching source and project
      const deleteResult = this.db
        .prepare(
          `UPDATE observations
           SET deleted_at = datetime('now'), updated_at = datetime('now')
           WHERE project_hash = ? AND source = ? AND deleted_at IS NULL`,
        )
        .run(this.projectHash, sourceTag);

      const sectionsRemoved = deleteResult.changes;

      // Create new observations for each parsed section
      let sectionsCreated = 0;
      for (const section of sections) {
        repo.createClassified(
          {
            content: section.content,
            title: section.title,
            source: sourceTag,
            kind: 'reference',
            sessionId: null,
          },
          'discovery', // Bypass noise filter, make immediately searchable
        );
        sectionsCreated++;
      }

      return {
        filesProcessed: 1,
        sectionsCreated,
        sectionsRemoved,
      };
    })();
  }
}
