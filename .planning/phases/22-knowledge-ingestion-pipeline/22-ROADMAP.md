# Phase 22 Roadmap: Knowledge Ingestion Pipeline

**Phase:** 22 of v2.3 (Codebase & Tool Knowledge)
**Version Target:** v2.22.0
**Status:** Planning → Implementation
**Milestone:** v2.3 Codebase & Tool Knowledge

---

## Phase Goal

Structured documents become queryable per-project memories

- Convert markdown docs, JSON configs, CSV tables, and source code comments into queryable observations
- Store with full project isolation and metadata tracking
- Integrate seamlessly with existing search and embedding pipeline
- Support re-ingestion with smart deduplication

---

## Success Criteria

1. ✅ Ingestion pipeline accepts documents in 5+ formats
2. ✅ Per-project knowledge isolation (no cross-project leakage)
3. ✅ Query performance <500ms on typical projects
4. ✅ Ingested documents rank naturally in search results
5. ✅ Zero regression on existing functionality

---

## Implementation Timeline

| Week | Step | Deliverable |
|------|------|-------------|
| Week 1 | Database schema (Migration 022) | Schema migrations, indexes, type definitions |
| Week 1 | Format parsers (markdown, JSON, CSV, plaintext) | 5 parser implementations, 95%+ test coverage |
| Week 1-2 | Chunking & normalization service | Tokenization, title generation, metadata enrichment |
| Week 2 | Document registry repository | CRUD, dedup detection, cleanup utilities |
| Week 2 | Ingestion service orchestrator | End-to-end pipeline, error handling, logging |
| Week 2 | MCP tool integration | `ingest_document` tool, input validation |
| Week 2-3 | Search enhancement | Query filtering, snippet refinement, ranking |
| Week 3 | Full test suite | Unit, integration, performance tests |
| Week 3 | Documentation & release | CLAUDE.md updates, examples, v2.22.0 release |

---

## Key Implementation Decisions

| Decision | Rationale | Status |
|----------|-----------|--------|
| Chunk at format boundaries, not token count | Preserves semantics, enables deduplication | ✅ Decided |
| Store metadata as JSON blob in observations | Reuses existing table, no schema explosion | ✅ Decided |
| SHA256 source hash for dedup | Supports document updates and lifecycle | ✅ Decided |
| Delegate codebase mapping to GSD | Avoid duplicating proven tool, clear separation | ✅ Decided |
| All ingested obs participate in normal search | No special indexing, ranking stays consistent | ✅ Decided |

---

## Supported Formats

| Format | Parser | Use Cases | Key Features |
|--------|--------|-----------|--------------|
| Markdown | MarkdownParser | Docs, READMEs, ADRs | Heading extraction, code preservation |
| JSON | JsonParser | Config, API specs, data | Key-value navigation, array chunking |
| CSV/TSV | CsvParser | Tables, matrices, data | Header mapping, row-as-object |
| Plain Text | PlainTextParser | Notes, requirements | Paragraph segmentation, fallback |
| Code Comments | CodeParser | Source documentation | Function/class boundaries (future) |

---

## Database Schema (Migration 022)

```sql
-- Document registry
CREATE TABLE document_registry (
  id TEXT PRIMARY KEY,
  project_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  observation_ids TEXT NOT NULL,
  metadata TEXT NOT NULL,
  UNIQUE (project_hash, filename, source_hash)
);

-- Chunk tracking
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  observation_id TEXT NOT NULL,
  source_coordinates TEXT,
  FOREIGN KEY (document_id) REFERENCES document_registry(id)
);
```

---

## Critical Dependencies

**On Existing Infrastructure:**
- ObservationRepository (Phase 1) — storing ingested observations
- SearchEngine (Phases 8-11) — hybrid search on ingested content
- EmbeddingStore (Phase 4) — vector search and embeddings
- MCP server framework (Phase 2) — tool registration

**No New Dependencies Required** — all use existing stack

---

## MCP Tool: `ingest_document`

```
ingest_document(content, filename, format_hint?, metadata?)
  → {success, documentId, chunksCreated, observationsCreated, warnings}
```

**Features:**
- Auto-format detection with override option
- Size validation (default 1MB limit)
- Source hash deduplication
- Metadata tracking (URL, version, tags)
- Graceful error messages

---

## Integration Points

- **Storage** — Uses existing database + Migration pattern
- **Search** — Ingested obs in FTS5 + vector search
- **Embedding** — Automatic queue entry via EmbeddingStore
- **Sessions** — Full project scoping via projectHash
- **Context** — Eligible for session summaries and stashing

---

## Testing Strategy

**Unit Tests** (95%+ coverage):
- Format detection & parsing (all 5 formats)
- Chunking strategy (various sizes, boundaries)
- Metadata enrichment (title gen, kind classification)
- Registry CRUD & dedup detection
- Observation creation & project scoping

**Integration Tests:**
- Full pipeline: document → search → results
- Hybrid search (keyword + vector)
- Re-ingestion update scenario
- Cross-project isolation verification
- Embedding worker integration

**Performance Tests:**
- <500ms search on 5000+ observations
- 1MB document ingestion <2 seconds
- Database overhead <10% per MB
- No blocking of user queries

**Regression Tests:**
- Existing search functionality unchanged
- Session management unaffected
- Embedding worker stable
- All existing observations still queryable

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Large document DoS | Size limits (1MB), streaming parser (future) |
| Search regression | Comprehensive regression test suite |
| Format parsing errors | Try-catch, graceful fallback to plaintext |
| Per-project leakage | WHERE project_hash in all queries, unit test audit |
| Embedding overload | Queue prioritization, background batching |

---

## Phase Completion Checklist

- [ ] Migration 022 schema created and tested
- [ ] All 5 format parsers implemented (95%+ coverage)
- [ ] Document registry repository complete
- [ ] Ingestion service orchestrator working
- [ ] MCP `ingest_document` tool registered
- [ ] Search queries accept optional filters
- [ ] Full test suite passing (unit + integration + perf)
- [ ] Zero regressions on existing functionality
- [ ] Performance meets <500ms target
- [ ] Documentation updated (CLAUDE.md, examples)
- [ ] Release v2.22.0 ready

---

## Success Metrics

**Functionality:** All deliverables working as designed
**Performance:** <500ms search, <2s ingest, <10% DB overhead
**Quality:** 95%+ test coverage, zero regressions
**User Experience:** Ingested docs feel like native Laminark knowledge

---

## Next Phase (Phase 23)

**Suggested:** Deep Tool Capability Understanding
- Parse tool schemas and documentation
- Extract parameter definitions and use cases
- Populate trigger_hints for all tools
- Proactive suggestion engine

---

*Roadmap finalized: 2026-02-23*
