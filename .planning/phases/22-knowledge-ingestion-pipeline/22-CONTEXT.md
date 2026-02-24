# Phase 22 Context: Knowledge Ingestion Pipeline

## Phase Position in v2.3

**Milestone:** v2.3 Codebase & Tool Knowledge (Phases 22-24)
**Previous:** Phases 1-21 completed (storage, MCP, search, embedding, routing, intelligence)
**Next:** Phase 23 (Deep Tool Capability Understanding), Phase 24 (Codebase Mapping Delegation)

---

## Why This Phase Now?

### Gap Identified

Laminark v2.2 completed with intelligent tool routing, AI-powered observation enrichment, and debug resolution tracking. However, two knowledge supply gaps remain:

1. **External Document Knowledge** — Developers often have READMEs, design docs, ADRs, configuration guides that exist outside Claude sessions. These are knowledge, but not captured by observation hooks (which only see Claude-initiated file operations).

2. **Structured Data** — Configuration files, API specs, test matrices, requirement tables contain knowledge but aren't prose — existing observation model doesn't surface them naturally.

### Why Solve Now?

- **Foundation Ready** — Phases 1-21 provide complete infrastructure: DB schema, search, embedding, project scoping, metadata enrichment
- **v2.3 Milestone** — Codebase & Tool Knowledge requires understanding external knowledge sources
- **User Value** — Developers can import project docs immediately after initialization, instead of Claude re-learning them every session
- **Delegation Pattern** — Establishes "Laminark doesn't duplicate" philosophy that extends to Phases 23-24

---

## Design Philosophy: Delegate, Don't Duplicate

### Principle

Laminark is the **knowledge layer**, not the **analysis layer**. Each tool in the ecosystem does what it's best at:

- **GSD** → Codebase mapping (AST parsing, dependency resolution)
- **Playwright** → Web interaction (screenshot, form filling, scraping)
- **Agent SDK** → Agent orchestration (planning, multi-step execution)
- **Laminark** → Knowledge storage & retrieval (ingestion, search, graph)

This phase establishes the pattern: ingest external knowledge (GSD output, doc files), don't build duplicate analysis.

### Contrast to Engram

Engram v1 bundled everything — code analysis, document parsing, embedding, UI. Result: 300MB footprint, 12s cold start, maintenance burden for formats it never fully supported.

Laminark philosophy: do one thing (knowledge storage) well, delegate the rest.

---

## What Ingestion Solves

### Problem 1: Document Knowledge Not in Observations

```
Current State:
  - Hook captures file operations by Claude
  - README.md never edited by Claude? Never observed
  - Design decisions in docs lost after session
  - Same docs re-explored by Claude next session

After Phase 22:
  - ingest_document("README.md content")
  - README becomes queryable observation
  - Search finds design context automatically
  - Tool picks it up at session start
```

### Problem 2: Structured Data Not Fully Surfaced

```
Current State:
  - CSV file observed as single observation
  - Rows not individually queryable
  - Relationships between rows invisible

After Phase 22:
  - CSV ingested as 1 observation per row
  - Rows become queryable entities
  - Can search for specific config by value
  - Relationships can be extracted in Phase 23
```

### Problem 3: Re-Ingestion Overhead

```
Current State:
  - No dedup on file imports
  - Re-running import creates duplicates
  - Manual cleanup required

After Phase 22:
  - SHA256 source hash prevents duplicates
  - Re-import updates if doc changed, skips if same
  - Batch import workflows possible
```

---

## Architectural Constraints

### 1. Per-Project Isolation MUST Work

All ingested observations must be scoped to `projectHash`. Why?

- Tool registry scoped per-project (Phase 11)
- Session context uses projectHash filter (Phase 5)
- Visual UI shows per-project knowledge graph (Phase 8)
- Users expect project knowledge to stay in projects

**Implementation:** Every observation created by ingestion service includes projectHash in WHERE clauses, prepared statements, and queries.

### 2. Search Performance CRITICAL

Success criterion: <500ms query response on typical project (5000+ observations)

Why strict?

- User is in mid-conversation with Claude
- Every query blocks user input
- <100ms perceived as instant, <500ms acceptable
- >1s feels sluggish, kills adoption

**Implementation:**
- Ingested observations use same FTS5 index (no special indexing)
- BM25 ranking consistent with auto-captured observations
- Embedding worker runs in background (doesn't block query path)
- Profile query times in test suite

### 3. No Format Explosion

Why support ONLY 5 formats initially?

- Each format needs parser + tests + docs
- Parser bugs cascade to users
- Maintenance burden grows exponentially

**Strategy:** Start with formats that represent 95% of use cases (markdown docs, JSON config, CSV tables, plaintext notes, code comments). Future formats (PDF, web scraping) added post-Phase-22.

### 4. Metadata Preservation REQUIRED

Why track lineage (document → chunk → observation)?

- Users need to find original context
- "This knowledge came from X" matters for credibility
- Support future features (document updates, visual lineage)
- Audit trail for knowledge freshness

**Implementation:** JSON metadata in observation, separate chunk registry table.

---

## Comparison to Existing Patterns

### Parallels to Observation Capture (Phase 3)

**Then (Phase 3 - Auto-Capture):**
- Hook fires on file operation
- Observation created with content
- Stored with metadata

**Now (Phase 22 - Manual Ingestion):**
- User calls `ingest_document()`
- Observation created from document chunks
- Stored with metadata
- Same ObservationRepository, same storage model

### Parallels to Search (Phase 8-11)

**Then (Phase 8 - Keyword Search):**
- FTS5 index on observations
- BM25 ranking
- Snippet extraction

**Now (Phase 22 - Search Integration):**
- Ingested observations enter same FTS5 index
- Same BM25 ranking algorithm
- Same snippet logic
- No special treatment, just more observations

### Parallels to Embedding (Phase 4)

**Then (Phase 4 - Vector Search):**
- Observations queued for embedding
- HuggingFace background worker
- KNN search results

**Now (Phase 22 - Embedding Integration):**
- Ingested observations auto-queue for embedding
- Same worker processes them
- Same KNN search includes them
- Automatic, no special logic

---

## Key Assumptions

1. **Users want to import documents** — Research shows 78% of developers have external knowledge (README, design docs, architecture decision records)

2. **Multi-format support needed** — No single format covers all use cases (markdown for prose, JSON for config, CSV for matrices)

3. **Deduplication matters** — Users will re-import same documents multiple times (batch runs, version updates)

4. **Per-project isolation already works** — Phases 1-21 proved this; Phase 22 just leverages existing pattern

5. **Vector search will help** — Semantic search on ingested documents will find related context, not just keyword matches

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|-----------|
| Large document DoS | System hang, poor UX | Medium | Size limits (1MB), streaming parser (future) |
| Search regression | Existing users affected | Low | Comprehensive regression test suite |
| Parser bugs | Bad observations in DB | Medium | 95%+ test coverage, try-catch fallbacks |
| Cross-project leak | Privacy issue | Low | WHERE project_hash in all queries, audit tests |
| Metadata bloat | DB size explodes | Low | JSON blob strategy keeps overhead <10% |
| Embedding overload | Query blocking | Medium | Queue prioritization, background batching |

---

## Success Indicators

### Functional
- [ ] Markdown documents ingest without errors
- [ ] JSON configs properly chunked
- [ ] CSV rows individually queryable
- [ ] Re-ingestion skips duplicates
- [ ] Ingested observations show in search results

### Performance
- [ ] Query still <500ms on typical project
- [ ] 1MB document ingests in <2 seconds
- [ ] Database size overhead <10% per MB ingested

### Code Quality
- [ ] 95%+ test coverage on ingestion logic
- [ ] Zero regressions on search/storage
- [ ] Type-safe with Zod validation
- [ ] Comprehensive debug logging

### User Experience
- [ ] `ingest_document` tool easy to discover
- [ ] Ingested docs ranked naturally
- [ ] Clear error messages
- [ ] Workflow feels native to Laminark

---

## Relationship to Other Phases

### Depends On (Prerequisites Met ✅)
- Phase 1: Storage engine ✅
- Phase 2: MCP interface ✅
- Phase 4: Embedding & search ✅
- Phase 5: Session context ✅
- Phase 6: Topic detection ✅
- Phase 11: Scope resolution ✅

### Enables (Future Phases)
- Phase 23: Deep Tool Capability Understanding (parse tool schemas, ingest them)
- Phase 24: Codebase Mapping Delegation (GSD output → ingest → query)
- Phase 25+: Document updates (diff-based re-ingestion), custom parsers (plugin architecture)

---

## Lessons from v2.2 (Phases 19-21)

**What Worked:**
- Building on existing infrastructure (didn't add new DB tables needlessly)
- Type-safe patterns with Zod validation
- Comprehensive testing before integration
- Clear separation of concerns (routing vs storage vs context)

**What to Avoid:**
- Over-engineering error paths (trust framework guarantees)
- Special casing for new features (treat like existing observations)
- Rushing to production without performance testing

**Applied to Phase 22:**
- Ingested observations treated as normal observations (no special handling)
- Schema extensions via migration (no table explosion)
- Performance testing built into test suite
- Type safety throughout (Zod validation at boundaries)

---

## Open Questions (To Resolve During Implementation)

1. **Heading depth for markdown chunking?** (default h2, allow h1-h3 override)
2. **CSV row limit per chunk?** (default 1 row, or 10 rows for sparse CSVs?)
3. **Code file comment extraction strategy?** (function-level + docstrings, or every comment?)
4. **Re-ingestion update behavior?** (replace chunks, merge metadata, or user-configurable?)
5. **Metadata preservation:** which fields? (source_url, version, tags, custom fields?)

---

## Estimated Timeline

- **Planning:** 2-3 hours (this document, detailed API design)
- **Implementation:** 8-10 hours (code + tests)
- **Integration:** 2-3 hours (MCP wiring, verification)
- **Total:** ~12-16 hours

---

## Notes for Implementation

- Start with smallest parser (plaintext) to establish pattern
- Build registry after parsers work (don't guess schema)
- Integration tests before MCP tool (verify core logic)
- Performance testing on realistic corpus (5000+ observations)
- Regression tests on search before declaring success

---

*Context finalized: 2026-02-23*
