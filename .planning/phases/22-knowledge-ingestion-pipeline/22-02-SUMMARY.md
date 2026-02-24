---
phase: 22-knowledge-ingestion-pipeline
plan: 02
completed_at: 2026-02-23T22:04:30Z
status: complete
---

# Phase 22-02: MCP Tool Integration & Map-Codebase Command — COMPLETE

## Summary

Wired the knowledge ingestion pipeline into Laminark's MCP tool interface and created the `/laminark:map-codebase` slash command. Claude can now trigger ingestion programmatically, and users have a guided workflow for codebase documentation integration.

## Deliverables

### 1. `src/mcp/tools/ingest-knowledge.ts`

**Exports:**
- `registerIngestKnowledge(server, db, projectHashRef, statusCache): void`

**Tool Registration:**
- Name: `'ingest_knowledge'`
- Title: "Ingest Knowledge"
- Description: "Ingest structured markdown documents from a directory into queryable per-project memories."

**Input Schema:**
```typescript
{
  directory?: string  // Optional; auto-detects if omitted
}
```

**Behavior:**
- If directory provided: ingests that directory directly
- If directory omitted:
  1. Queries `project_metadata` table for `project_path` matching current `projectHash`
  2. Calls `KnowledgeIngester.detectKnowledgeDir(projectPath)` to find `.planning/codebase/` or `.laminark/codebase/`
  3. Returns clear error if project path not found or knowledge directory doesn't exist

**Response:**
- Success: `"Ingested {filesProcessed} files: {sectionsCreated} sections created, {sectionsRemoved} stale sections removed."`
- Error: Clear, actionable error message with troubleshooting steps

**Side Effects:**
- Calls `statusCache?.markDirty()` after successful ingestion
- Follows save-memory.ts pattern for error handling and logging

**Integration:**
- Imported and registered in `src/index.ts` after `registerSaveMemory`
- Passes: `server, db.db, projectHashRef, statusCache`

### 2. `commands/map-codebase.md`

**Command:** `/laminark:map-codebase [optional directory path]`

**Workflow:**
1. Check if `.planning/codebase/` exists with .md files:
   - YES → Offer to ingest: "I found codebase documentation. Ingest into Laminark?"
   - If user agrees, call `ingest_knowledge` with absolute path to `.planning/codebase/`

2. If no existing docs, check for GSD availability:
   - GSD available → Guide user: "Run `/gsd:map-codebase` first to generate docs, then I'll ingest them."
   - GSD not available → Suggest installing GSD or placing docs in `.laminark/codebase/` manually

3. If directory argument provided:
   - Call `ingest_knowledge` directly with that path

**User Guidance:**
- 3 example scenarios (GSD docs exist, no docs with GSD available, explicit directory)
- Clear explanation of architecture: GSD is analysis layer, Laminark is knowledge layer
- Notes on idempotency, immediate queryability, per-project scoping, source tagging

**Format:**
- Follows command conventions from `remember.md` and `recall.md`
- Includes Usage, Instructions, Examples, and Notes sections
- Clear, user-friendly language with actionable guidance

## Architecture & Integration

```
User → /laminark:map-codebase
  ↓
[Detect .planning/codebase/ in current project]
  ↓
[If found, offer to ingest → ingest_knowledge MCP tool]
[If not found, suggest /gsd:map-codebase → /gsd:map-codebase → then back to step 1]
  ↓
KnowledgeIngester.ingestDirectory()
  ↓
Parse markdown → Create reference observations
  ↓
Return stats: "Ingested X files (Y sections)"
```

## Verification Checklist

- [x] `registerIngestKnowledge` exported from ingest-knowledge.ts
- [x] MCP tool properly registered with correct schema
- [x] Tool accepts optional directory parameter
- [x] Auto-detection queries project_metadata correctly
- [x] Error handling matches save-memory.ts pattern
- [x] Integration in src/index.ts at correct location
- [x] statusCache marked dirty after successful ingestion
- [x] /laminark:map-codebase command file created at correct path
- [x] Command format follows project conventions
- [x] Command includes all 3 example scenarios
- [x] Command explains GSD delegation and architecture
- [x] All ingestion tests still pass (no regressions)

## Test Results

```
✓ src/ingestion/__tests__/markdown-parser.test.ts (9 tests) — 3ms
✓ src/ingestion/__tests__/knowledge-ingester.test.ts (9 tests) — 35ms

Test Files: 2 passed (2)
Tests: 18 passed (18)
Duration: 187ms
```

No regressions. All existing tests continue to pass.

## Commits

- `b88ba40` feat(22-02): ingest_knowledge MCP tool and map-codebase command

## Requirements Met

- [x] FR-2.1: Markdown files split by ## headings (via ingester)
- [x] FR-2.2: Each section is a kind=reference observation (via ingester)
- [x] FR-2.3: Claude can call ingest_knowledge MCP tool (tool registered and wired)
- [x] FR-2.4: Re-ingestion replaces stale sections (via idempotent upsert)
- [x] FR-2.5: Removed sections cleaned up on re-ingestion (via soft-delete)

## User-Facing Features

1. **MCP Tool: `ingest_knowledge`**
   - Claude can programmatically trigger knowledge ingestion
   - Auto-detection of knowledge directories from project metadata
   - Clear error messages for troubleshooting
   - Immediate stats on ingestion results

2. **Slash Command: `/laminark:map-codebase`**
   - User-friendly guided workflow
   - GSD integration detection and guidance
   - Support for explicit directory paths
   - Clear explanation of architecture and capabilities

## Next Steps

Phase 22 core functionality is complete. Knowledge ingestion pipeline is now:
- ✓ Implemented and tested (22-01)
- ✓ Integrated into MCP interface (22-02)
- ✓ Exposed to users via slash command (22-02)

Ready for Phase 23+: Recall optimization, GSD integration, and knowledge context injection.

