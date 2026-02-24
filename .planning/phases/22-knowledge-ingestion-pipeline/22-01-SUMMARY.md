---
phase: 22-knowledge-ingestion-pipeline
plan: 01
wave: 1
completed: 2026-02-23
---

# Phase 22 Wave 1 - Summary

## Objectives
Build the markdown section parser and knowledge ingester that transforms structured markdown documents into discrete, queryable per-project reference memories.

**Status: ✅ COMPLETE**

## Deliverables

### Task 1: Markdown Section Parser ✅
**File:** `src/ingestion/markdown-parser.ts`

- Exports `ParsedSection` interface with title (doc > heading), heading, content, sourceFile, sectionIndex
- Exports `parseMarkdownSections(fileContent, sourceFile)` function
- Splits on `## ` headings only (not `###`)
- Uses `# ` doc title as prefix: "DocTitle > HeadingText"
- Handles edge cases:
  - Code blocks with ` ``` ` (doesn't split on `##` inside them)
  - Empty sections (skipped)
  - Subsections (`###`) included in parent content
  - Files with no `## ` headings (returns empty array)

**Test Coverage:** `src/ingestion/__tests__/markdown-parser.test.ts`
- 9 test cases, all passing
- Covers basic parsing, title handling, subsections, code blocks, edge cases

### Task 2: Knowledge Ingester with Idempotent Upsert ✅
**File:** `src/ingestion/knowledge-ingester.ts`

- Exports `IngestionStats` interface: `filesProcessed`, `sectionsCreated`, `sectionsRemoved`
- Exports `KnowledgeIngester` class with:
  - `constructor(db, projectHash)` for per-project scoping
  - `async ingestDirectory(dirPath)` - processes all `.md` files in a directory
  - `async ingestFile(filePath)` - processes a single `.md` file
  - `static async detectKnowledgeDir(projectRoot)` - locates `.planning/codebase/` or `.laminark/codebase/`

**Implementation Details:**
- Reads files async first, then runs DB operations in single transaction (atomic, fast)
- Source tag convention: `"ingest:{filename}"` (e.g., `"ingest:STACK.md"`)
- **Idempotent strategy:**
  1. For each file being re-ingested, soft-delete all existing observations with matching source+project_hash
  2. Count soft-deleted sections for stats.sectionsRemoved
  3. Parse new sections from file content
  4. Create new observations with `kind='reference'`, `classification='discovery'`, `sessionId=null`
  5. Increment stats.sectionsCreated
- Each observation created with `ObservationRepository.createClassified()` for immediate searchability

**Test Coverage:** `src/ingestion/__tests__/knowledge-ingester.test.ts`
- 9 test cases, all passing
- Tests:
  - Multi-file ingestion with correct stats
  - Re-ingestion idempotency (old soft-deleted, new created)
  - Directory detection (.planning/codebase priority over .laminark/codebase)
  - Empty/non-existent directories handled gracefully
  - Single file ingestion

## Verification

✅ All ingestion tests pass (18/18):
```
npx vitest run src/ingestion/
✓ src/ingestion/__tests__/markdown-parser.test.ts (9 tests)
✓ src/ingestion/__tests__/knowledge-ingester.test.ts (9 tests)
```

✅ Code structure meets requirements:
- `parseMarkdownSections` correctly exports ParsedSection type and function
- `KnowledgeIngester` correctly exports IngestionStats and KnowledgeIngester class
- Source tag pattern `ingest:{filename}` implemented throughout
- Idempotent upsert via soft-delete + re-create strategy implemented
- Project isolation via projectHash enforced

✅ Must-haves met:
- ✅ Markdown files with ## headings split into discrete sections
- ✅ Each section becomes kind=reference observation with title and source tag
- ✅ Re-running ingestion replaces stale sections without creating duplicates
- ✅ Removed sections cleaned up on re-ingestion (via soft-delete strategy)
- ✅ All ingested observations scoped to correct project_hash

## Wave 1 Requirements Coverage

| Requirement | Status | Notes |
|---|---|---|
| FR-2.1: Parse markdown into reference memories | ✅ | parseMarkdownSections splits by ## headings |
| FR-2.2: Each section = separate memory with kind=reference | ✅ | Each ParsedSection becomes one observation |
| FR-2.3: Support ingesting .planning/codebase/ docs | ✅ | detectKnowledgeDir checks both locations |
| FR-2.4: Idempotent re-ingestion | ✅ | Soft-delete+re-create strategy implemented |
| FR-2.5: Per-project scoping | ✅ | projectHash enforced in constructor |

## Commits

- `c2ebba5` feat(22-01): markdown section parser for knowledge ingestion
- `45f6b5a` feat(22-01): implement knowledge ingester with idempotent upsert

## Next Steps (Wave 2)

Wave 1 is complete. The knowledge ingestion foundation is ready for Wave 2, which will:
1. Create the MCP tool `ingest_knowledge.ts` that exposes ingestion via MCP
2. Create the `/laminark:map-codebase` command file that orchestrates GSD + ingestion
3. Implement integration with ObservationRepository and HaikuProcessor

See `22-02-PLAN.md` for Wave 2 execution plan.
