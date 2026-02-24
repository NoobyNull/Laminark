# Phase 22: Knowledge Ingestion Pipeline

**Goal:** Structured documents become queryable per-project memories

**Success Criteria:**
- ✓ Ingestion pipeline accepts documents in multiple formats (markdown, JSON, CSV, plaintext, code)
- ✓ Extracted knowledge stored in Laminark with proper project isolation
- ✓ Per-project knowledge isolation working (no cross-project leakage)
- ✓ Query performance acceptable (<500ms on typical project)
- ✓ Ingested observations participate in hybrid search (keyword + vector)

---

## Architecture Overview

### Ingestion Pipeline Flow

```
Document Input
    ↓
Format Detection & Validation
    ↓
Content Extraction & Parsing
    ↓
Normalization & Chunking
    ↓
Knowledge Extraction
    ↓
Metadata Generation
    ↓
Observation Storage (per-project)
    ↓
Embedding Queue
    ↓
Vector Search Integration
```

### Key Design Principles

1. **Delegate, Don't Duplicate** — GSD handles codebase mapping; Laminark handles knowledge storage
2. **Per-Project Isolation** — All ingested documents scoped via `projectHash` (existing mechanism)
3. **Format Agnostic** — Support multiple input formats through pluggable parsers
4. **Metadata Preservation** — Track document source, chunk lineage, extraction timestamps
5. **Graceful Degradation** — Ingestion continues if embedding fails (existing pattern)
6. **Query Integration** — Ingested knowledge participates in hybrid search (keyword + vector)

---

## Implementation Steps

### Step 1: Database Schema (Migration 022)

**Files to modify:**
- `src/storage/migrations.ts` — Add Migration 022
- `src/storage/schema.ts` — Define schema types

**Schema additions:**

```sql
-- Document registry tracks ingested documents
CREATE TABLE document_registry (
  id TEXT PRIMARY KEY,                 -- UUID
  project_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,                -- 'markdown', 'json', 'csv', 'plaintext', 'code'
  source_hash TEXT NOT NULL,           -- SHA256 of content (for dedup)
  ingested_at TEXT NOT NULL,           -- ISO timestamp
  chunk_count INTEGER NOT NULL,
  observation_ids TEXT NOT NULL,       -- JSON array of observation IDs
  metadata TEXT NOT NULL,              -- JSON: {source_url?, version?, tags?}
  FOREIGN KEY (project_hash) REFERENCES projects(hash),
  UNIQUE (project_hash, filename, source_hash)
);

-- Track chunk-to-observation mapping
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  observation_id TEXT NOT NULL,
  source_coordinates TEXT,             -- JSON: {lineStart, lineEnd, section}
  FOREIGN KEY (document_id) REFERENCES document_registry(id),
  FOREIGN KEY (observation_id) REFERENCES observations(id)
);

-- Indexes for common queries
CREATE INDEX idx_doc_registry_project ON document_registry(project_hash);
CREATE INDEX idx_doc_registry_filename ON document_registry(filename);
CREATE INDEX idx_doc_chunks_document ON document_chunks(document_id);
CREATE INDEX idx_doc_chunks_observation ON document_chunks(observation_id);
```

**Tests:**
- [ ] Migration runs successfully on empty database
- [ ] Schema constraints enforced (NOT NULL, UNIQUE)
- [ ] Indexes created correctly
- [ ] Foreign keys enforced

---

### Step 2: Format Parsers

**Files to create:**
- `src/ingestion/format-parsers.ts` — Parser implementations
- `src/ingestion/format-detection.ts` — Format detection logic

**Parser interface:**

```typescript
interface DocumentParser {
  parse(content: string): ChunkResult[];
  canHandle(format: DetectedFormat): boolean;
}

interface ChunkResult {
  title: string | null;
  content: string;
  metadata: {
    lineStart?: number;
    lineEnd?: number;
    section?: string;
    codeType?: string;  // 'function', 'class', 'comment'
  };
}

type DetectedFormat = 'markdown' | 'json' | 'csv' | 'plaintext' | 'code';
```

**Parsers to implement:**

1. **MarkdownParser**
   - Chunk at heading level (configurable: h1, h2, h3)
   - Preserve code blocks and inline code
   - Extract title from first heading or heading level
   - Track heading hierarchy for context

2. **PlainTextParser**
   - Chunk by paragraphs (double newline)
   - Fallback to fixed paragraph count (N lines per chunk)
   - Generate title from first sentence
   - Line number tracking

3. **JsonParser**
   - Chunk at top-level keys
   - For arrays: chunk per element or per N elements
   - Generate title from key name or array index
   - Stringify values for readability

4. **CsvParser**
   - Chunk per row (or per N rows configurable)
   - Use header row as keys
   - Generate title from first column or rowIndex
   - Preserve column structure

5. **Format Detection**
   - By file extension (`.md`, `.json`, `.csv`, `.ts`, etc.)
   - Fallback to content analysis (JSON: starts with `{` or `[`, etc.)
   - Default to plaintext if uncertain

**Tests:**
- [ ] Each parser handles well-formed input
- [ ] Edge cases: empty documents, malformed input, encoding issues
- [ ] Title generation fallbacks work
- [ ] Metadata tracking accurate
- [ ] Format detection correct for common file types
- [ ] 95%+ coverage on parser logic

---

### Step 3: Chunking & Normalization

**Files to create:**
- `src/ingestion/document-chunker.ts` — Chunking orchestrator
- `src/ingestion/metadata-enricher.ts` — Metadata generation

**Chunking orchestrator:**

```typescript
interface DocumentChunker {
  chunk(
    content: string,
    format: DetectedFormat,
    options?: ChunkingOptions
  ): NormalizedChunk[];
}

interface NormalizedChunk {
  title: string | null;
  content: string;
  kind: 'reference' | 'finding' | 'decision';  // classified
  metadata: {
    sourceDocument: string;
    sourceFormat: DetectedFormat;
    chunkIndex: number;
    chunkTotal: number;
    sourceLineStart?: number;
    sourceLineEnd?: number;
    parentSection?: string;
    extractedAt: string;
  };
}
```

**Metadata enrichment:**

- **Title Generation**
  - Heading extraction (markdown) or first sentence (plaintext)
  - Fallback: truncate first 100 chars of content
  - Normalize: trim, remove markdown syntax, keep <100 chars

- **Kind Classification**
  - Heuristics: look for "Decision", "Requirement", "Issue", "Note"
  - Default to 'reference' if uncertain
  - Can be overridden by user metadata hints

- **Lineage Tracking**
  - Record source coordinates (start/end line, section)
  - Support round-trip back to original document
  - Used for update detection on re-ingestion

**Tests:**
- [ ] Title generation handles all formats
- [ ] Kind classification matches test cases
- [ ] Metadata JSON valid
- [ ] Chunk boundaries correct (no partial words)
- [ ] Large documents chunked properly (1MB+ files)

---

### Step 4: Document Registry Repository

**Files to create:**
- `src/storage/document-registry.ts` — Repository implementation

**Key methods:**

```typescript
class DocumentRegistry {
  // CRUD operations
  insert(doc: DocumentInput): string;
  findById(id: string): Document | null;
  findByProjectAndFilename(projectHash: string, filename: string): Document[];
  updateChunkCount(docId: string, count: number): void;
  delete(id: string): void;

  // Re-ingestion detection
  findExistingByHash(projectHash: string, sourceHash: string): Document | null;

  // Query helpers
  listByProject(projectHash: string): Document[];
  listByFormat(projectHash: string, format: DetectedFormat): Document[];

  // Cleanup
  deleteOrphanedChunks(docId: string): void;  // clean up chunks for deleted docs
}
```

**Source hash strategy:**
- SHA256 of document content
- Enables deduplication on re-ingestion
- Allows efficient diff-based partial updates (future)

**Tests:**
- [ ] CRUD operations work correctly
- [ ] Constraint enforcement (project_hash foreign key, UNIQUE compound key)
- [ ] Re-ingestion detection via source_hash
- [ ] Project isolation (queries scoped properly)
- [ ] Orphan cleanup removes unreferenced chunks

---

### Step 5: Ingestion Service Orchestrator

**Files to create:**
- `src/ingestion/ingestion-service.ts` — Main orchestrator

**Service interface:**

```typescript
class DocumentIngestionService {
  async ingestDocument(
    projectHash: string,
    filename: string,
    content: string,
    metadata?: DocumentMetadata
  ): Promise<IngestionResult>;
}

interface IngestionResult {
  success: boolean;
  documentId: string;
  chunksCreated: number;
  observationsCreated: string[];  // observation IDs
  warnings: string[];
}
```

**Orchestration steps:**

1. Validate document size (default max 1MB, configurable)
2. Detect format (extension → content analysis → default)
3. Calculate source hash (dedup check)
4. Check for existing document
5. If exists with same hash: skip (return existing)
6. If exists with different hash: update (delete old observations, re-ingest)
7. Parse document into chunks
8. Generate title & metadata for each chunk
9. Create Observation records with standard fields
10. Add source pattern: `"ingest:{format}:{docId}"`
11. Store document registry entry
12. Queue observations for embedding
13. Return summary

**Error handling:**
- Graceful degradation if embedding fails
- Detailed error messages for format issues
- Logging at each step (LAMINARK_DEBUG=1)

**Tests:**
- [ ] Full pipeline: document → chunks → observations → registry
- [ ] Re-ingestion detection and update
- [ ] Project scoping correct (projectHash in all observations)
- [ ] Observation source pattern correct
- [ ] Metadata JSON valid
- [ ] Error recovery (malformed input, oversized docs)

---

### Step 6: MCP Tool Integration

**Files to modify:**
- `src/mcp/tools.ts` — Add `ingest_document` tool

**Tool definition:**

```typescript
{
  name: "ingest_document",
  description: "Ingest structured documents into Laminark as queryable knowledge",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Document content (markdown, JSON, CSV, or plain text)"
      },
      filename: {
        type: "string",
        description: "Filename with extension (e.g., 'README.md', 'config.json')"
      },
      format_hint: {
        type: "string",
        enum: ["markdown", "json", "csv", "plaintext", "code"],
        description: "Optional format hint (auto-detected if omitted)"
      },
      metadata: {
        type: "object",
        description: "Optional metadata: {source_url, version, tags}"
      }
    },
    required: ["content", "filename"]
  }
}
```

**Tool behavior:**
- Accept file content or file path (with size validation)
- Format detection with override option
- Return ingestion summary (chunks, observations, any warnings)
- Handle errors gracefully with clear messages

**Tests:**
- [ ] Tool callable via MCP
- [ ] Input validation works
- [ ] Response format matches spec
- [ ] Error handling returns helpful messages

---

### Step 7: Search Integration

**Files to modify:**
- `src/search/search-engine.ts` — Enhance query capabilities

**Enhancement options:**

```typescript
// New optional parameters
searchKeyword(query: string, options?: SearchOptions & {
  sourceDocument?: string;   // filter to specific document
  ingestionOnly?: boolean;   // filter to only ingested observations
  format?: DetectedFormat;   // filter to specific format
}): SearchResult[]
```

**Query logic:**
- Ingested observations participate in existing FTS5 search
- Results ranked consistently (BM25, no special favoritism)
- Optional filtering by source document or format
- Snippet extraction works for ingested content

**Snippet refinement:**
- Include observation title in snippet context
- For markdown, include heading hierarchy context
- For JSON, include key path context

**Tests:**
- [ ] Ingested documents appear in search results
- [ ] Ranking consistency (ingested vs auto-captured)
- [ ] Filtering by sourceDocument works
- [ ] Snippet generation correct
- [ ] Query performance <500ms target maintained

---

### Step 8: Graph Integration (Future)

**Note:** Can be deferred to Phase 23 if time-constrained

- Add document nodes to knowledge graph
- Extract relationships from document content
- Enable graph traversal through ingested documents
- Link documents to observations and entities

---

## Testing Strategy

### Unit Tests

**Format Detection & Parsing:**
- ✓ Markdown: headings, code blocks, links
- ✓ JSON: nested objects, arrays
- ✓ CSV: headers, rows, types
- ✓ Plain text: paragraphs, line counts
- ✓ Edge cases: empty, malformed, encoding

**Chunking:**
- ✓ Various document sizes (100B to 1MB)
- ✓ Chunk boundary accuracy
- ✓ Metadata correctness
- ✓ Dedup detection

**Registry:**
- ✓ CRUD operations
- ✓ Foreign key constraints
- ✓ Project scoping
- ✓ Orphan cleanup

### Integration Tests

**End-to-End:**
- ✓ Full pipeline: parse → chunk → normalize → store → search
- ✓ Hybrid search on ingested docs
- ✓ Vector search integration
- ✓ Per-project isolation

**Regression:**
- ✓ Existing search unchanged
- ✓ Observation repo still project-scoped
- ✓ Session management unaffected
- ✓ Embedding worker stable

### Performance Tests

- ✓ <500ms search on typical project (5000+ observations)
- ✓ Ingest 1MB document in <2s
- ✓ Database overhead <10% per ingested MB
- ✓ Vector embedding doesn't block queries

---

## Success Metrics

### Functionality
- [ ] All 5 formats parse correctly
- [ ] Document registry accurate
- [ ] Re-ingestion detection works
- [ ] Ingested observations in search results
- [ ] Per-project isolation verified

### Performance
- [ ] Query <500ms (target)
- [ ] 1MB ingest <2s
- [ ] DB overhead <10% per MB
- [ ] Background embedding non-blocking

### Quality
- [ ] 95%+ test coverage
- [ ] Zero regressions
- [ ] Type-safe (Zod)
- [ ] Comprehensive logging

---

## File Summary

**Files to Create:**
- `src/ingestion/format-parsers.ts` — Parser implementations
- `src/ingestion/format-detection.ts` — Format detection
- `src/ingestion/document-chunker.ts` — Chunking orchestrator
- `src/ingestion/metadata-enricher.ts` — Metadata generation
- `src/ingestion/ingestion-service.ts` — Main orchestrator
- `src/storage/document-registry.ts` — Repository
- `tests/ingestion/` — Full test suite
- `tests/storage/document-registry.test.ts` — Registry tests

**Files to Modify:**
- `src/storage/migrations.ts` — Add Migration 022
- `src/storage/schema.ts` — Schema types
- `src/search/search-engine.ts` — Query enhancement
- `src/mcp/tools.ts` — Add `ingest_document` tool

**Total Effort:** ~8-10 hours development + testing

---

## Next Phase Preview (Phase 23)

**Suggested Next:** Deep Tool Capability Understanding
- Parse tool schemas and parameter definitions
- Extract use cases and examples from tool documentation
- Populate trigger_hints for ALL tools (not just slash commands)
- Proactive suggestion engine with tool capability awareness

---

*Plan created: 2026-02-23 for v2.3 Codebase & Tool Knowledge milestone*
