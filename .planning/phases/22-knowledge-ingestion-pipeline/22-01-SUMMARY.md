---
phase: 22-knowledge-ingestion-pipeline
plan: 01
completed_at: 2026-02-23T22:02:00Z
status: complete
---

# Phase 22-01: Markdown Section Parser & Knowledge Ingester — COMPLETE

## Summary

Implemented the core knowledge ingestion pipeline: a markdown section parser and knowledge ingester that transforms structured markdown documents into discrete, queryable reference observations with full idempotent re-ingestion support.

## Deliverables

### 1. `src/ingestion/markdown-parser.ts`

**Exports:**
- `ParsedSection` interface
- `parseMarkdownSections(fileContent, sourceFile): ParsedSection[]`

**Features:**
- Splits markdown on `## ` headings only (level 2)
- Uses `# ` doc title as prefix: "DocTitle > SectionHeading"
- Respects code block boundaries (does not split on `## ` inside fenced blocks)
- Skips empty sections and content before first heading
- Keeps `### ` subsections within their parent `## ` content

**Tests:** 9 comprehensive test cases covering:
- Title + section parsing
- No-title files
- Empty sections
- Subsections
- Prose-only files
- Whitespace normalization
- Code block handling
- Preamble skipping

### 2. `src/ingestion/knowledge-ingester.ts`

**Exports:**
- `IngestionStats` interface (filesProcessed, sectionsCreated, sectionsRemoved)
- `KnowledgeIngester` class with:
  - `constructor(db, projectHash)`
  - `async ingestDirectory(dirPath): IngestionStats`
  - `async ingestFile(filePath): IngestionStats`
  - `static detectKnowledgeDir(projectRoot): string | null`

**Implementation Details:**
- Reads all `.md` files from a directory
- Filters to `.md` files only
- Implements idempotent upsert via:
  1. Soft-delete ALL existing observations with matching source + project
  2. Create new observations for each parsed section
- Each observation has:
  - `kind: "reference"`
  - `source: "ingest:{filename}"`
  - `classification: "discovery"` (bypasses noise filter, immediately searchable)
  - `sessionId: null` (not a user conversation)
  - `title: section.title` (with doc title prefix)
  - `content: section.content`

**Directory Detection:**
- Checks `.planning/codebase/` first (GSD output)
- Falls back to `.laminark/codebase/`
- Returns `null` if neither exists

**Tests:** 9 comprehensive test cases covering:
- Multi-file ingestion with correct stats
- Idempotent re-ingestion (old deleted, new created)
- Single file removal cleanup
- Empty directory handling
- Non-existent directory handling
- Directory detection with precedence

## Test Results

```
✓ src/ingestion/__tests__/markdown-parser.test.ts (9 tests) — 3ms
✓ src/ingestion/__tests__/knowledge-ingester.test.ts (9 tests) — 36ms

Test Files: 2 passed (2)
Tests: 18 passed (18)
Duration: 187ms
```

**All tests pass.** No failures or warnings.

## Verification Checklist

- [x] `parseMarkdownSections` correctly splits GSD-format markdown into `ParsedSection` objects
- [x] All test cases pass (18/18)
- [x] Idempotent re-ingestion works (soft-delete + recreate pattern)
- [x] Observations created with `kind="reference"`, `source="ingest:{filename}"`, `classification="discovery"`
- [x] Directory detection helper returns correct path or null
- [x] Code handles edge cases: empty dirs, missing dirs, empty files
- [x] No unhandled exceptions

## Commits

- `c2ebba5` feat(22-01): markdown section parser for knowledge ingestion
- `45f6b5a` feat(22-01): implement knowledge ingester with idempotent upsert

## Requirements Met

- [x] FR-2.1: Markdown files split into sections by ## headings
- [x] FR-2.2: Each section becomes a kind=reference observation
- [x] FR-2.4: Re-ingestion replaces stale sections without duplication
- [x] FR-2.5: Removed sections cleaned up on re-ingestion

## Next Steps

Ready for Phase 22-02: MCP tool integration (`ingest-knowledge` command) and UI integration (`map-codebase` command).

The knowledge ingestion pipeline is now complete and ready for production use.
