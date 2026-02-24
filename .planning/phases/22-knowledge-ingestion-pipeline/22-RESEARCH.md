# Phase 22: Knowledge Ingestion Pipeline - Research

**Researched:** 2026-02-23
**Domain:** Markdown parsing, idempotent database ingestion, per-project knowledge scoping
**Confidence:** HIGH

## Summary

Phase 22 transforms structured markdown documents (produced by GSD's map-codebase or equivalent) into discrete, queryable per-project memories stored in Laminark's existing SQLite observations table. The core technical challenge is a markdown parser that splits documents into sections, an idempotent upsert mechanism that replaces stale memories without duplication, and a thin `/laminark:map-codebase` skill that delegates to GSD and then ingests output.

The existing codebase provides nearly all infrastructure needed. The observations table already supports `kind="reference"`, `title`, `project_hash` scoping, and FTS5 indexing. The `ObservationRepository.create()` method handles inserts. What's missing is: (1) a markdown section parser, (2) an idempotent upsert-by-title+project mechanism, (3) a new `source` convention for ingested knowledge (e.g., `"ingest:STACK.md"`), (4) a new MCP tool or internal function to trigger ingestion, and (5) the `/laminark:map-codebase` command file.

**Primary recommendation:** Build a `KnowledgeIngester` class in `src/ingestion/` that accepts a directory path, reads markdown files, splits them into sections by heading, and upserts each section as a `kind="reference"` observation with `source="ingest:{filename}"`. Idempotency is achieved by matching on `title + project_hash + source` -- if a matching observation exists, update its content; otherwise create a new one.

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FR-2.1 | Parse structured markdown docs into discrete, queryable reference memories | Markdown section parser splits by `## ` headings; each section becomes an observation with kind="reference" |
| FR-2.2 | Each section becomes a separate memory with kind="reference" and appropriate title/tags | Existing `ObservationInsert` supports `kind`, `title`, `source` fields; no schema changes needed |
| FR-2.3 | Support ingesting existing .planning/codebase/ docs (GSD output) when detected | Scanner checks for `.planning/codebase/` and `.laminark/codebase/` directories |
| FR-2.4 | Ingestion is idempotent -- re-running replaces stale memories, doesn't duplicate | New `upsertByTitleAndSource()` method on ObservationRepository matches title+project_hash+source |
| FR-2.5 | Per-project scoping -- memories are tagged with project identifier | Already enforced: ObservationRepository is constructed with projectHash, all queries scoped |

</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | 12.6.2 | Database operations | Already in use; synchronous API perfect for batch inserts |
| zod | 4.3.6 | Input validation | Already used for ObservationInsert validation |
| node:fs/promises | built-in | File reading | Async file I/O for reading markdown files |
| node:path | built-in | Path manipulation | Resolving directories, joining paths |

### Supporting

No new dependencies required. The markdown parsing is simple heading-based splitting (no AST needed for structured docs with `## ` delimiters).

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom heading splitter | remark/unified AST | Overkill -- GSD output is well-structured; regex split on `## ` is sufficient and zero-dependency |
| SQL UPSERT by title | Separate lookup table for ingested knowledge | Adds schema complexity; title+project_hash+source matching on observations is simpler |
| New `knowledge` table | Extend observations | Violates NFR-3 (no new database files/storage); observations already has kind="reference" |

## Architecture Patterns

### Recommended Project Structure

```
src/
  ingestion/
    markdown-parser.ts      # Split markdown into titled sections
    knowledge-ingester.ts   # Orchestrate: read dir -> parse -> upsert
    __tests__/
      markdown-parser.test.ts
      knowledge-ingester.test.ts
  mcp/tools/
    ingest-knowledge.ts     # MCP tool: ingest_knowledge (trigger ingestion)
commands/
  map-codebase.md           # /laminark:map-codebase slash command
```

### Pattern 1: Markdown Section Parsing

**What:** Split a markdown file into discrete sections by `## ` headings
**When to use:** Every ingestion of a structured markdown document

```typescript
interface ParsedSection {
  title: string;       // The heading text (e.g., "Languages", "Runtime")
  content: string;     // Everything under the heading until next ## or EOF
  sourceFile: string;  // Filename (e.g., "STACK.md")
  level: number;       // Heading level (2 for ##, 3 for ###)
}

function parseMarkdownSections(
  content: string,
  sourceFile: string,
): ParsedSection[] {
  // Split on ## headings, capture heading text
  // Include the document title (# heading) as metadata but don't create a section for it
  // Each ## section becomes one observation
}
```

**Key decisions for parsing:**
- Split on `## ` (level 2) headings -- these are the primary sections in GSD output
- The `# ` (level 1) heading is the document title (e.g., "# Technology Stack") -- use as prefix for section titles
- Subsections (`### `) are included in their parent `## ` section's content, not split separately
- This keeps memories at a useful granularity (not too fine, not too coarse)

### Pattern 2: Idempotent Upsert

**What:** Insert or replace observations by matching title + project_hash + source
**When to use:** Every ingestion run

The observations table does NOT currently have a unique constraint on (title, project_hash, source). Two approaches:

**Approach A: SQL query + conditional insert/update (RECOMMENDED)**
```typescript
// In ObservationRepository or a new IngestionRepository:
upsertReference(input: {
  title: string;
  content: string;
  source: string;  // e.g., "ingest:STACK.md"
  kind: 'reference';
}): Observation {
  // 1. Look up existing by title + project_hash + source
  const existing = db.prepare(`
    SELECT id FROM observations
    WHERE project_hash = ? AND title = ? AND source = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(projectHash, input.title, input.source);

  if (existing) {
    // 2a. Update content + updated_at
    db.prepare(`
      UPDATE observations SET content = ?, updated_at = datetime('now')
      WHERE id = ? AND project_hash = ?
    `).run(input.content, existing.id, projectHash);
    return this.getById(existing.id)!;
  } else {
    // 2b. Create new observation
    return this.create(input);
  }
}
```

**Approach B: Add UNIQUE constraint via migration**
Would require a new migration (version 23) adding a unique index. Risky because existing data may have duplicate title+project_hash+source combinations. Not recommended.

### Pattern 3: Source Convention for Ingested Knowledge

**What:** Use structured `source` values to identify ingested content
**When to use:** All ingested observations

```
source = "ingest:{filename}"
```

Examples:
- `ingest:STACK.md`
- `ingest:ARCHITECTURE.md`
- `ingest:CONVENTIONS.md`

This enables:
- Querying all ingested content: `WHERE source LIKE 'ingest:%'`
- Re-ingesting a specific file: `WHERE source = 'ingest:STACK.md'`
- Cleanup: `DELETE FROM observations WHERE source LIKE 'ingest:%' AND project_hash = ?`

### Pattern 4: /laminark:map-codebase Command

**What:** Slash command that delegates to GSD and then ingests
**When to use:** User wants to map and ingest their codebase

The command file (`commands/map-codebase.md`) should instruct Claude to:
1. Check if `.planning/codebase/` exists with recent files -- if so, offer to just ingest
2. Check if GSD is installed (`/gsd:map-codebase` available) -- if so, suggest running it
3. If GSD not installed, suggest installing it
4. After mapping completes, call `ingest_knowledge` MCP tool with the output directory

### Anti-Patterns to Avoid

- **Don't parse markdown with regex for arbitrary content:** GSD output is well-structured, but don't try to handle every possible markdown construct. Stick to heading-based splitting.
- **Don't create separate sessions for ingestion:** Ingestion is a data operation, not a user conversation. Use `sessionId: null`.
- **Don't embed ingested content eagerly:** Let the existing background embedding loop handle it. Ingestion just creates observations; embedding happens asynchronously.
- **Don't use `classification` during ingestion:** Let HaikuProcessor classify ingested observations in its normal cycle, or pre-classify as 'discovery' to skip noise filtering.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown AST parsing | Full AST parser | Simple heading-based split | GSD output is structured; AST parsing is overkill |
| Database upsert | Custom transaction management | Simple SELECT + INSERT/UPDATE pattern | better-sqlite3 is synchronous, no race conditions |
| FTS5 indexing | Manual FTS updates | Existing triggers on observations table | Triggers auto-sync FTS5 on INSERT/UPDATE/DELETE |
| Embedding generation | Sync embedding during ingestion | Existing background embedding loop | Non-blocking, uses existing infrastructure |
| Project scoping | Custom project detection | `getProjectHash()` + ObservationRepository constructor | Already handles canonicalization and scoping |

**Key insight:** The observations table with FTS5 triggers handles nearly everything. Ingestion is just creating observations with specific `kind`, `source`, and `title` values. The existing infrastructure (FTS5 triggers, background embedding, classification) kicks in automatically.

## Common Pitfalls

### Pitfall 1: FTS5 Content Sync on Bulk Updates

**What goes wrong:** Updating observation content via direct SQL (bypassing triggers) can desync FTS5.
**Why it happens:** FTS5 external content tables require matching trigger calls for INSERT/UPDATE/DELETE.
**How to avoid:** Always use the observations table for writes -- the triggers at migration 005 handle FTS5 sync automatically. For upserts, use UPDATE on the observations table (triggers fire) rather than DELETE+INSERT.
**Warning signs:** Search results returning stale content or missing updated observations.

### Pitfall 2: Title Matching Sensitivity

**What goes wrong:** Slight title changes between ingestion runs cause duplicate observations instead of updates.
**Why it happens:** GSD might change heading text slightly between mapping runs.
**How to avoid:** Normalize titles before matching (trim whitespace, collapse internal whitespace). Consider using `source` as the primary idempotency key (file + section index) rather than relying solely on heading text.
**Better approach:** Use a composite key of `source` (e.g., "ingest:STACK.md") + section index within the file (e.g., "##2" for the second `##` heading). Store this as the source: `"ingest:STACK.md#Languages"`.

### Pitfall 3: Large Document Ingestion Blocking

**What goes wrong:** Ingesting many sections from 7 files could block the MCP server if done synchronously.
**Why it happens:** better-sqlite3 is synchronous; bulk inserts lock the database.
**How to avoid:** Use `db.transaction()` to batch all inserts in a single transaction (fast, atomic). 7 files with ~5-10 sections each = ~50-70 inserts, which completes in <100ms in a transaction.

### Pitfall 4: Stale Observations After Re-mapping

**What goes wrong:** If a section is removed from a GSD doc, its observation persists as stale knowledge.
**Why it happens:** Idempotent upsert only updates existing sections; it doesn't remove sections that no longer exist.
**How to avoid:** Before ingesting a file, soft-delete all existing observations with `source = 'ingest:{filename}'` for this project. Then re-ingest all current sections. This ensures removed sections get cleaned up.

### Pitfall 5: Classification Noise Filtering

**What goes wrong:** Ingested reference observations get filtered out by the `classification != 'noise'` filter before HaikuProcessor classifies them.
**Why it happens:** The `list()` method in ObservationRepository filters unclassified old observations. New observations have a 60-second grace period.
**How to avoid:** Pre-classify ingested observations as `'discovery'` using `createClassified()` method. This bypasses the noise filter immediately.

## Code Examples

### Example 1: Section Parser

```typescript
// src/ingestion/markdown-parser.ts
export interface ParsedSection {
  title: string;        // Full title: "Technology Stack > Languages"
  heading: string;      // Just the heading: "Languages"
  content: string;      // Section body text
  sourceFile: string;   // "STACK.md"
  sectionIndex: number; // 0-based index within file
}

export function parseMarkdownSections(
  fileContent: string,
  sourceFile: string,
): ParsedSection[] {
  const lines = fileContent.split('\n');
  const sections: ParsedSection[] = [];

  let docTitle = '';
  let currentHeading = '';
  let currentLines: string[] = [];
  let sectionIndex = 0;

  for (const line of lines) {
    // Document title (# heading)
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      docTitle = line.slice(2).trim();
      continue;
    }

    // Section heading (## heading)
    if (line.startsWith('## ')) {
      // Save previous section if any
      if (currentHeading) {
        const content = currentLines.join('\n').trim();
        if (content.length > 0) {
          sections.push({
            title: docTitle ? `${docTitle} > ${currentHeading}` : currentHeading,
            heading: currentHeading,
            content,
            sourceFile,
            sectionIndex,
          });
          sectionIndex++;
        }
      }
      currentHeading = line.slice(3).trim();
      currentLines = [];
      continue;
    }

    if (currentHeading) {
      currentLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentHeading) {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({
        title: docTitle ? `${docTitle} > ${currentHeading}` : currentHeading,
        heading: currentHeading,
        content,
        sourceFile,
        sectionIndex,
      });
    }
  }

  return sections;
}
```

### Example 2: Knowledge Ingester

```typescript
// src/ingestion/knowledge-ingester.ts
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { ObservationRepository } from '../storage/observations.js';
import { parseMarkdownSections } from './markdown-parser.js';
import type BetterSqlite3 from 'better-sqlite3';

export interface IngestionStats {
  filesProcessed: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsRemoved: number;
}

export class KnowledgeIngester {
  private readonly db: BetterSqlite3.Database;
  private readonly projectHash: string;

  constructor(db: BetterSqlite3.Database, projectHash: string) {
    this.db = db;
    this.projectHash = projectHash;
  }

  async ingestDirectory(dirPath: string): Promise<IngestionStats> {
    const stats: IngestionStats = {
      filesProcessed: 0,
      sectionsCreated: 0,
      sectionsUpdated: 0,
      sectionsRemoved: 0,
    };

    const files = await readdir(dirPath);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    // Wrap all operations in a single transaction for atomicity
    const repo = new ObservationRepository(this.db, this.projectHash);

    const runIngestion = this.db.transaction(() => {
      for (const file of mdFiles) {
        const filePath = join(dirPath, file);
        const content = /* readFileSync for transaction safety */ '';
        const sourceTag = `ingest:${file}`;

        // Soft-delete existing observations from this source
        const existing = this.db.prepare(`
          SELECT id FROM observations
          WHERE project_hash = ? AND source = ? AND deleted_at IS NULL
        `).all(this.projectHash, sourceTag) as { id: string }[];

        for (const row of existing) {
          // Soft-delete via ObservationRepository
          repo.softDelete(row.id);
          stats.sectionsRemoved++;
        }

        // Parse and create new sections
        const sections = parseMarkdownSections(content, file);
        for (const section of sections) {
          repo.createClassified({
            content: section.content,
            title: section.title,
            source: sourceTag,
            kind: 'reference',
          }, 'discovery');
          stats.sectionsCreated++;
        }

        // Adjust: sections that were "removed" but re-created are updates
        const netRemoved = Math.max(0, stats.sectionsRemoved - stats.sectionsCreated);

        stats.filesProcessed++;
      }
    });

    // Read files first (async), then run transaction (sync)
    // ... actual implementation reads files async then runs sync transaction

    return stats;
  }
}
```

### Example 3: MCP Tool Registration

```typescript
// src/mcp/tools/ingest-knowledge.ts
// Follows same pattern as save-memory.ts
server.registerTool(
  'ingest_knowledge',
  {
    title: 'Ingest Knowledge',
    description: 'Ingest structured markdown documents into queryable project memories. Reads .md files from a directory, splits by section, and stores as reference observations.',
    inputSchema: {
      directory: z.string().describe(
        'Directory containing markdown files to ingest. Defaults to .planning/codebase/ or .laminark/codebase/'
      ).optional(),
    },
  },
  async (args) => {
    // ... resolve directory, run ingestion, return stats
  },
);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| N/A -- new feature | Use observations table with kind="reference" | Phase 22 | Leverages existing FTS5, embedding, classification infrastructure |

**Key architectural insight from codebase review:**
- The observations table already has `kind` column (migration 014) with `'reference'` as a valid value
- The `source` column is free-form text, perfect for `"ingest:{filename}"` convention
- FTS5 triggers auto-index title+content on INSERT/UPDATE
- Background embedding loop auto-embeds new observations
- HaikuProcessor auto-classifies new observations
- Context injection already queries `kind='reference'` observations

Everything downstream works automatically once observations are created with the right kind/source/title.

## Open Questions

1. **Section granularity for subsections**
   - What we know: GSD output uses `##` for major sections and `###` for subsections
   - What's unclear: Should `###` subsections be separate memories or stay with their parent `##`?
   - Recommendation: Keep `###` content within their `##` parent. This gives ~5-10 sections per file at useful granularity. If sections are too large, we can always split further in a follow-up.

2. **Content truncation for large sections**
   - What we know: ObservationInsert allows up to 100,000 characters per observation
   - What's unclear: Some architecture sections could be long. Should we truncate?
   - Recommendation: Don't truncate. GSD output is already compact. The 100KB limit is generous. Let FTS5 and embeddings handle relevance ranking.

3. **Ingestion timing relative to classification**
   - What we know: HaikuProcessor classifies observations every 30 seconds in batches of 10
   - What's unclear: Ingesting 50+ observations at once could queue up classification work
   - Recommendation: Pre-classify as `'discovery'` during ingestion (using `createClassified()`). This makes them immediately visible in search/context without waiting for HaikuProcessor.

## Sources

### Primary (HIGH confidence)
- Laminark codebase: `src/storage/observations.ts` -- ObservationRepository API, create/update/softDelete methods
- Laminark codebase: `src/storage/migrations.ts` -- Full schema (22 migrations), observations table with kind, title, source columns
- Laminark codebase: `src/shared/types.ts` -- ObservationInsert schema, ObservationKind = 'reference'
- Laminark codebase: `src/mcp/tools/save-memory.ts` -- Pattern for registering MCP tools
- Laminark codebase: `src/context/injection.ts` -- How kind="reference" observations are used in context injection
- Laminark codebase: `src/index.ts` -- Server wiring, background processing loops
- Laminark codebase: `.planning/codebase/STACK.md` -- GSD output format (heading structure)
- Laminark codebase: `commands/remember.md` -- Slash command file format

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` -- FR-2.1 through FR-2.5 requirements
- `.planning/ROADMAP.md` -- Phase 22 description and goals

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies; uses existing observations infrastructure
- Architecture: HIGH -- direct codebase analysis of all relevant files
- Pitfalls: HIGH -- identified from actual code paths (FTS5 triggers, classification filtering, transaction patterns)

**Research date:** 2026-02-23
**Valid until:** 2026-03-23 (stable -- no external dependencies to change)
