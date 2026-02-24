# Phase 22 Summary: Knowledge Ingestion Pipeline

**Phase:** 22 of v2.3 (Codebase & Tool Knowledge)
**Status:** Planning Complete ✅
**Created:** 2026-02-23
**Deliverables:** 4 planning documents (PLAN, ROADMAP, RESEARCH, CONTEXT)

---

## What This Phase Does

Transforms Phase 22 from abstract goal into concrete implementation plan. Structured documents (markdown, JSON, CSV, plaintext, code) become queryable per-project observations.

---

## Planning Documents

### 22-PLAN.md
- **Scope:** Detailed implementation steps (8 steps across 10 phases)
- **Contents:** Architecture, database schema, format parsers, orchestration, MCP tool, search integration, testing strategy, metrics
- **Key File Outputs:** 12 new source files + test suite
- **Effort:** ~10-12 hours development + testing

### 22-ROADMAP.md
- **Scope:** Timeline and deliverables
- **Contents:** Weekly breakdown, success criteria, supported formats, MCP tool spec, testing strategy, risk mitigation
- **Key Decisions:** 5 decision points with rationale
- **Next Phase:** Preview of Phase 23 (Deep Tool Capability Understanding)

### 22-RESEARCH.md
- **Scope:** Design decisions and trade-off analysis
- **Contents:** 8 major decision points (formats, chunking, metadata, dedup, isolation, search, embedding, errors)
- **Options Explored:** 2-3 alternatives per decision with pros/cons
- **Outcome:** Clear rationale for each choice

### 22-CONTEXT.md
- **Scope:** Phase positioning and philosophical framework
- **Contents:** Why now, design philosophy, architectural constraints, comparison to existing patterns, assumptions, risks
- **Lessons From:** v2.2 phases 19-21 (what worked, what to avoid)
- **Integration Points:** Dependencies and enablements for future phases

---

## Key Decisions Locked In

| Decision | Choice | Confidence |
|----------|--------|-----------|
| **Supported Formats** | 5: Markdown, JSON, CSV, Plaintext, Code | 95% |
| **Chunking Strategy** | Format-native boundaries (not token-count) | 90% |
| **Metadata Storage** | JSON blob in observations + registry table | 95% |
| **De-duplication** | SHA256 content hash detection | 95% |
| **Per-Project Isolation** | projectHash in all queries (existing pattern) | 99% |
| **Search Integration** | Unified FTS5 (no special index) | 90% |
| **Embedding Pipeline** | Reuse existing worker (no new code) | 95% |
| **Error Handling** | Graceful degradation to plaintext | 90% |

---

## Architecture Summary

```
Input Document
    ↓
[Format Detection] → markdown? JSON? CSV? plaintext? code?
    ↓
[Format Parser] → Extract structured content
    ↓
[Chunking] → Create logical units (sections, keys, rows)
    ↓
[Normalization] → Generate titles, classify kind, enrich metadata
    ↓
[Observation Creation] → Store in DB with projectHash
    ↓
[Registry Entry] → Track document lineage in document_registry
    ↓
[Embedding Queue] → Auto-queue for background embedding
    ↓
[Search Integration] → Participate in FTS5 + vector search
```

---

## Database Changes (Migration 022)

**New Tables:**
- `document_registry` — Track ingested documents (id, project_hash, filename, format, source_hash, metadata)
- `document_chunks` — Map chunks to observations (document_id, observation_id, source_coordinates)

**No Schema Modifications:**
- Observations table unchanged (metadata JSON blob holds ingestion metadata)
- Full backward compatibility with v2.21.x

---

## MCP Tool: ingest_document

**Signature:**
```
ingest_document(content, filename, format_hint?, metadata?)
  → {success, documentId, chunksCreated, observationsCreated, warnings}
```

**Features:**
- Auto-format detection with override
- Size limits (1MB default)
- SHA256 deduplication
- Graceful error messages

---

## Implementation Phases

| Week | Steps | Deliverable |
|------|-------|-------------|
| 1 | DB schema + parsers + chunking | Migration 022 + all parsers tested |
| 2 | Registry + orchestrator + MCP tool | Full pipeline wired |
| 2-3 | Search integration + tests + docs | Release-ready with <500ms perf |

---

## Success Criteria (All Defined)

✅ **Functionality:**
- All 5 formats parse correctly
- Per-project isolation verified
- Re-ingestion deduplication works
- Ingested observations rank naturally in search

✅ **Performance:**
- Query <500ms on 50k+ observations
- 1MB document ingests in <2s
- DB overhead <10% per MB

✅ **Quality:**
- 95%+ test coverage
- Zero regressions on existing search
- Type-safe with Zod validation
- Comprehensive debug logging

---

## Critical Dependencies

**On Existing Infrastructure:**
- ObservationRepository (Phase 1) ✅
- SearchEngine (Phases 8-11) ✅
- EmbeddingStore (Phase 4) ✅
- MCP server framework (Phase 2) ✅

**New Dependencies Added:**
- None! Uses existing stack exclusively

---

## Risk Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Format parsing errors | Medium | Try-catch, graceful fallback to plaintext |
| Search regression | Low | Comprehensive regression test suite |
| Per-project leakage | Low | WHERE project_hash in all queries, audit tests |
| Large doc DoS | Medium | Size limits (1MB), streaming parser (future) |
| Embedding overload | Medium | Queue prioritization, background batching |

---

## Integration Points

**Phase 1-7:** Storage engine, migration framework
**Phase 8-11:** Search (FTS5, ranking, snippet extraction)
**Phase 4:** Embedding (vector search, background worker)
**Phase 2:** MCP tools framework
**Phase 5-6:** Session scoping via projectHash
**Phase 10-11:** Tool registry scoping (per project)

**Enables:**
- Phase 23: Deep tool capability understanding (parse tool schemas)
- Phase 24: Codebase mapping delegation (GSD output → ingest)
- Phase 25+: Document updates, custom parsers, visualization

---

## Files to Create (12)

**Ingestion System:**
- `src/ingestion/format-parsers.ts` — All parser implementations
- `src/ingestion/format-detection.ts` — Detection logic
- `src/ingestion/document-chunker.ts` — Chunking orchestrator
- `src/ingestion/metadata-enricher.ts` — Metadata generation
- `src/ingestion/ingestion-service.ts` — Main orchestrator

**Storage:**
- `src/storage/document-registry.ts` — Repository (CRUD)
- `src/storage/migrations.ts` — Migration 022 (existing file, append)

**MCP & Search:**
- `src/mcp/tools.ts` — Add ingest_document tool (existing file, append)
- `src/search/search-engine.ts` — Enhance with filtering (existing file, modify)

**Tests:**
- `tests/ingestion/format-parsers.test.ts`
- `tests/ingestion/document-registry.test.ts`
- `tests/ingestion/ingestion-service.test.ts`

---

## Files to Modify (3)

1. **src/storage/migrations.ts** — Add Migration 022 schema
2. **src/mcp/tools.ts** — Register ingest_document tool
3. **src/search/search-engine.ts** — Add optional filtering parameters

---

## Estimated Effort

| Category | Hours |
|----------|-------|
| Format parsers + tests | 3-4 |
| Chunking & normalization | 2-3 |
| Registry & orchestrator | 2-3 |
| MCP tool + integration | 1-2 |
| Search enhancement | 1-2 |
| Full test suite | 2-3 |
| Documentation & release | 1-2 |
| **Total** | **12-16** |

---

## Next Steps for Implementation

1. ✅ Planning complete (this document)
2. ⏳ **Ready for:** Step 1 — Database schema (Migration 022)
3. ⏳ **Then:** Format parsers (plaintext first to establish pattern)
4. ⏳ **Then:** Orchestrator and end-to-end testing

---

## Knowledge Transfer

- All 4 planning documents provide complete context for implementation
- RESEARCH.md documents all trade-offs and rationale
- PLAN.md provides exact implementation steps
- ROADMAP.md provides timeline and dependencies
- CONTEXT.md provides philosophical grounding and integration points

---

## Success Metrics (Measurable)

- [ ] Markdown README (2KB) ingests and appears in search: <2s
- [ ] JSON config (1KB) ingests and queries return results: <500ms
- [ ] CSV table (5KB) ingests per-row, individual rows queryable: <500ms
- [ ] Document re-ingest (same hash) skips duplication: 0 new observations
- [ ] Document update (different hash) replaces: old observations deleted, new created
- [ ] Cross-project test: Project A doc not visible in Project B search: PASS

---

*Planning Phase 22 complete. Ready for implementation.*

**Next Phase:** Phase 23 — Deep Tool Capability Understanding (Phases 22-24 in v2.3 Codebase & Tool Knowledge milestone)

---

📌 **For Implementation:** Refer to 22-PLAN.md Step 1 for database schema details.
