---
phase: 22-knowledge-ingestion-pipeline
plan: 02
wave: 2
completed: 2026-02-23
---

# Phase 22 Wave 2 - Summary

## Objectives
Wire the knowledge ingestion pipeline into Laminark's MCP tool interface and create the `/laminark:map-codebase` slash command for user-facing ingestion workflows.

**Status: ✅ COMPLETE**

## Deliverables

### Task 1: ingest_knowledge MCP Tool ✅
**File:** `src/mcp/tools/ingest-knowledge.ts`

Implements the `registerIngestKnowledge` function that:

**Function Signature:**
```typescript
export function registerIngestKnowledge(
  server: McpServer,
  db: BetterSqlite3.Database,
  projectHashRef: ProjectHashRef,
  notificationStore: NotificationStore | null = null,
  statusCache: StatusCache | null = null,
): void
```

**Tool Configuration:**
- Name: `ingest_knowledge`
- Title: "Ingest Knowledge"
- Description: "Ingest structured markdown documents from a directory into queryable per-project memories. Reads .md files, splits by ## headings, and stores each section as a reference observation. Supports .planning/codebase/ (GSD output) and .laminark/codebase/."
- Input schema: `directory` (string, optional)

**Implementation Details:**
- **Auto-detection:** When directory is omitted, queries project_metadata table to find project_path, then calls `KnowledgeIngester.detectKnowledgeDir()` to locate .planning/codebase/ or .laminark/codebase/
- **Error handling:** Returns clear error messages if project path cannot be resolved or knowledge directory not found
- **Ingestion:** Creates `KnowledgeIngester` instance and calls `ingestDirectory(resolvedDir)`
- **Response formatting:** Uses `verboseResponse()` to return stats-based message with three verbosity levels
- **Notification integration:** Prepends pending notifications to response via `notificationStore.consumePending()`
- **Cache management:** Calls `statusCache?.markDirty()` after successful ingestion

**Wiring in index.ts (line 314):**
```typescript
registerIngestKnowledge(server, db.db, projectHashRef, notificationStore, statusCache);
```

### Task 2: /laminark:map-codebase Slash Command ✅
**File:** `commands/map-codebase.md`

Implements user-facing command that guides codebase mapping workflow:

**Command Format:**
- Path: `/laminark:map-codebase [directory]`
- Title: "Map and ingest codebase knowledge into Laminark for instant recall"

**Instruction Flow:**
1. **Check for existing docs:**
   - If `.planning/codebase/` exists with .md files: Offer direct ingestion via `ingest_knowledge` MCP tool
   - User accepts → call `ingest_knowledge` with absolute path

2. **Check GSD availability:**
   - If GSD plugin available: Instruct user to run `/gsd:map-codebase` first, then return to ingest
   - If GSD not available: Suggest installing GSD plugin or placing manual docs in `.laminark/codebase/`

3. **Explicit directory support:**
   - If directory argument provided: Call `ingest_knowledge` with that directory directly

4. **Confirmation:**
   - After successful ingestion: "Ingested X files (Y sections) into Laminark. Your codebase knowledge is now queryable with /laminark:recall."

**Examples Included:**
- Existing GSD docs ready to ingest
- User provides explicit directory
- No docs found, GSD available
- Manual docs workflow

**Notes Section:**
- Explains Laminark's role as knowledge layer, GSD as analysis layer
- Documents idempotent re-ingestion behavior
- Clarifies instant recall via `/laminark:recall`
- Describes per-project scoping
- Explains manual markdown workflow

## Verification

✅ All ingestion tests still pass (18/18):
```
npx vitest run src/ingestion/
✓ src/ingestion/__tests__/markdown-parser.test.ts (9 tests)
✓ src/ingestion/__tests__/knowledge-ingester.test.ts (9 tests)
```

✅ Tool registration verified:
```
grep registerIngestKnowledge src/index.ts  # Shows import + call
grep ingest_knowledge src/mcp/tools/ingest-knowledge.ts  # Shows tool name
```

✅ Command file created:
```
ls -la commands/map-codebase.md  # File exists
grep "ingest_knowledge" commands/map-codebase.md  # References tool
```

## Wave 2 Requirements Coverage

| Requirement | Status | Notes |
|---|---|---|
| Claude can call ingest_knowledge MCP tool | ✅ | Tool registered with McpServer |
| Auto-detects knowledge directory | ✅ | Queries project_metadata, calls detectKnowledgeDir |
| Returns clear stats | ✅ | Files processed, sections created, sections removed |
| /laminark:map-codebase command | ✅ | Guides users through GSD delegation flow |
| Tool wired into index.ts | ✅ | Import + registration call with correct parameters |

## Architecture Integration

**MCP Tool Layer:**
- `ingest_knowledge` tool allows Claude to trigger ingestion programmatically
- Follows same pattern as `save_memory` and `recall` tools
- Proper error handling and response formatting via `verboseResponse()`

**User-Facing Command:**
- `/laminark:map-codebase` slash command for explicit user workflows
- Integrates with GSD ecosystem (suggests delegation to GSD)
- Supports both auto-detection and manual ingestion

**Data Flow:**
```
User Input (.md files)
  ↓
/laminark:map-codebase command
  ↓
ingest_knowledge MCP tool
  ↓
KnowledgeIngester.ingestDirectory()
  ↓
parseMarkdownSections() (from Wave 1)
  ↓
ObservationRepository.createClassified()
  ↓
Queryable per-project memories (kind=reference, classification=discovery)
```

## Commits

- `04071eb` feat(22-02): implement ingest_knowledge MCP tool and map-codebase command

## Integration with Previous Phases

- **Wave 1 (Ingestion Foundation):** Uses `KnowledgeIngester` and `parseMarkdownSections` from Wave 1
- **Observation Storage:** Leverages existing `ObservationRepository` for persistence
- **Project Scoping:** Enforces per-project knowledge via `projectHash` parameter
- **Notification System:** Integrates with `NotificationStore` for communication
- **Status Management:** Uses `StatusCache` to mark dirty state after ingestion

## Completion Status

**Phase 22 is now complete (Waves 1 & 2):**
- ✅ Wave 1: Markdown parser + Knowledge ingester foundation
- ✅ Wave 2: MCP tool + Slash command user interface

The knowledge ingestion pipeline is fully operational:
1. Structured markdown from GSD (or manual) can be ingested via MCP tool
2. Claude can programmatically trigger ingestion
3. Users have clear command-line interface via `/laminark:map-codebase`
4. All knowledge is queryable with `/laminark:recall`
5. Per-project scoping ensures isolation
6. Idempotent re-ingestion prevents duplicates

## Next Steps

Phase 22 is complete. The next phase would involve:
- Testing user workflows with real GSD output
- Monitoring ingestion performance at scale
- Gathering feedback on knowledge discovery patterns
- Potentially adding refinements to section granularity or search weighting
