---
phase: 22-knowledge-ingestion-pipeline
plan: 01
subsystem: ingestion
tags: [markdown-parser, knowledge-ingestion, idempotent-upsert, observations]
dependency_graph:
  requires: [storage/observations, shared/types]
  provides: [ingestion/markdown-parser, ingestion/knowledge-ingester]
  affects: [search, context-injection, embedding-loop]
tech_stack:
  added: []
  patterns: [soft-delete-recreate, source-tag-convention, per-file-transaction]
key_files:
  created:
    - src/ingestion/markdown-parser.ts
    - src/ingestion/knowledge-ingester.ts
    - src/ingestion/__tests__/markdown-parser.test.ts
    - src/ingestion/__tests__/knowledge-ingester.test.ts
  modified: []
decisions:
  - Split on ## headings only for useful granularity (~5-10 sections per file)
  - detectKnowledgeDir is synchronous (uses existsSync) since it runs at startup
  - Pre-classify ingested observations as 'discovery' to bypass noise filter
metrics:
  duration: 4min
  completed: 2026-02-23
---

# Phase 22 Plan 01: Markdown Parser and Knowledge Ingester Summary

Markdown section parser and idempotent knowledge ingester that transforms structured docs into per-project kind=reference observations with soft-delete+recreate upsert strategy

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Markdown section parser | c2ebba5 | src/ingestion/markdown-parser.ts, src/ingestion/__tests__/markdown-parser.test.ts |
| 2 | Knowledge ingester with idempotent upsert | 45f6b5a | src/ingestion/knowledge-ingester.ts, src/ingestion/__tests__/knowledge-ingester.test.ts |

## Implementation Details

**Task 1 - Markdown Section Parser:**
- `parseMarkdownSections(fileContent, sourceFile)` splits on `## ` headings
- `# ` heading used as doc title prefix: "DocTitle > SectionHeading"
- `### ` subsections kept within parent `## ` content
- Code blocks tracked to avoid splitting on `##` inside fenced blocks
- Empty sections skipped; content before first `## ` skipped
- 9 tests covering: basic splitting, no title, empty sections, subsections, code blocks, edge cases

**Task 2 - Knowledge Ingester:**
- `KnowledgeIngester` class with `ingestDirectory()` and `ingestFile()` methods
- Idempotent strategy: soft-delete all observations with matching source+project_hash, then create new ones
- Source tag: `ingest:{filename}` (e.g., `ingest:STACK.md`)
- Each observation: kind=reference, classification=discovery, sessionId=null
- Files read async first, then DB operations run in a single transaction per file
- `detectKnowledgeDir(projectRoot)` checks `.planning/codebase/` then `.laminark/codebase/`
- 9 tests covering: multi-file ingestion, re-ingestion idempotency, directory detection, empty/missing dirs

## Verification Results

- All 18 ingestion tests pass (9 parser + 9 ingester)
- No new TypeScript errors introduced (pre-existing errors in unrelated files only)
- Observations created with correct properties: kind=reference, source=ingest:{filename}, classification=discovery, sessionId=null

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] detectKnowledgeDir changed from async to sync**
- **Found during:** Task 2
- **Issue:** Linter reformatted detectKnowledgeDir to use synchronous fs operations
- **Fix:** Adopted sync approach using existsSync+statSync (appropriate since it runs at startup, not in hot path)
- **Files modified:** src/ingestion/knowledge-ingester.ts
- **Impact:** Tests call method without await; no functional difference

**2. [Rule 3 - Blocking] Linter auto-restructured knowledge-ingester.ts**
- **Found during:** Task 2
- **Issue:** Linter refactored to use private ingestFileSync() helper with per-file transactions instead of single directory-wide transaction
- **Fix:** Accepted refactored structure; per-file transactions are equally correct and more granular
- **Files modified:** src/ingestion/knowledge-ingester.ts
- **Impact:** None -- same idempotent behavior, same test results

## Self-Check: PASSED
