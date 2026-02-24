---
phase: 22-knowledge-ingestion-pipeline
plan: 02
subsystem: mcp-tools, commands
tags: [mcp-tool, slash-command, knowledge-ingestion, auto-detection]
dependency_graph:
  requires: [ingestion/knowledge-ingester, storage/observations, mcp/server]
  provides: [mcp/tools/ingest-knowledge, commands/map-codebase]
  affects: [tool-registration, user-commands, knowledge-pipeline]
tech_stack:
  added: []
  patterns: [auto-detect-from-project-metadata, delegation-to-gsd]
key_files:
  created:
    - src/mcp/tools/ingest-knowledge.ts
    - commands/map-codebase.md
  modified:
    - src/index.ts
decisions:
  - Auto-detect knowledge dir from project_metadata table rather than requiring explicit path
  - Delegate codebase analysis to GSD; Laminark handles storage and recall only
metrics:
  duration: 2min
  completed: 2026-02-23
---

# Phase 22 Plan 02: MCP Tool Wiring and Slash Command Summary

ingest_knowledge MCP tool with project_metadata auto-detection and /laminark:map-codebase slash command with GSD delegation flow

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | ingest_knowledge MCP tool | 0496315 | src/mcp/tools/ingest-knowledge.ts, src/index.ts |
| 2 | /laminark:map-codebase slash command | 04071eb | commands/map-codebase.md |

## Implementation Details

**Task 1 - ingest_knowledge MCP tool:**
- `registerIngestKnowledge` function with standard MCP tool registration pattern (matches save-memory.ts)
- Optional `directory` parameter; when omitted, resolves project root from `project_metadata` table via project_hash
- Calls `KnowledgeIngester.detectKnowledgeDir()` synchronously to find `.planning/codebase/` or `.laminark/codebase/`
- Returns ingestion stats: files processed, sections created, stale sections removed
- Follows save-memory.ts patterns: try/catch with isError, notification prepend, verboseResponse, statusCache.markDirty()
- Wired into index.ts with import and registration call near other tool registrations

**Task 2 - /laminark:map-codebase slash command:**
- Three-step instruction flow: check for existing GSD docs, check GSD availability, handle explicit directory
- Three examples: docs ready to ingest, explicit directory provided, no docs found
- Notes section covering: delegation to GSD, idempotent re-runs, instant recall, per-project scoping, manual docs option
- Follows same markdown structure and tone as remember.md and other existing commands

## Verification Results

- No TypeScript errors in ingest-knowledge.ts
- All 18 ingestion tests pass (9 parser + 9 ingester)
- `registerIngestKnowledge` imported and called in src/index.ts (line 17 import, line 314 registration)
- `ingest_knowledge` tool name registered in tool file
- commands/map-codebase.md exists with correct structure (Usage, Instructions, Examples, Notes)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed await on synchronous detectKnowledgeDir**
- **Found during:** Task 1
- **Issue:** Prior implementation used `await` on `KnowledgeIngester.detectKnowledgeDir()` which is a synchronous method returning `string | null`
- **Fix:** Removed `await`, stored result in intermediate `detected` variable to handle null-to-undefined type narrowing
- **Files modified:** src/mcp/tools/ingest-knowledge.ts
- **Commit:** 0496315

**2. [Rule 1 - Bug] Fixed null-to-undefined type assignment**
- **Found during:** Task 1
- **Issue:** `detectKnowledgeDir` returns `string | null` but `resolvedDir` (from zod optional) expects `string | undefined`
- **Fix:** Used intermediate `detected` variable with null check guard before assigning to `resolvedDir`
- **Files modified:** src/mcp/tools/ingest-knowledge.ts
- **Commit:** 0496315

## Self-Check: PASSED
