# Requirements: v2.3 Codebase Knowledge Pre-loading

## Problem Statement

Every new Claude Code session starts cold — Claude must re-explore the codebase via Glob/Grep/Read before it can do meaningful work. This wastes tokens, adds latency, and scales poorly with project size. Laminark already captures session-level observations, but lacks the "supply side" — pre-populated architectural knowledge that Claude can query instead of re-discovering.

## Success Criteria

1. **Cold-start elimination**: A new session on a mapped project can answer "where is X?" and "how does Y work?" by querying Laminark memories without reading files
2. **Freshness guarantee**: Knowledge stays current — file edits trigger background re-analysis, session starts catch up on external changes
3. **Standalone operation**: Works without GSD installed; bundles its own mapping capability
4. **GSD interop**: When GSD's .planning/codebase/ docs exist, ingests them rather than duplicating work
5. **Per-project isolation**: Each project's knowledge is scoped and doesn't leak into other projects

## Functional Requirements

### FR-1: Codebase Mapping Agents (Supply Side)

**FR-1.1**: Bundle codebase mapper agent definitions (adapted from GSD's gsd-codebase-mapper, with attribution) that can be invoked via Laminark's own skill/command
**FR-1.2**: Produce 7 structured analysis docs: STACK.md, ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, INTEGRATIONS.md, CONCERNS.md
**FR-1.3**: Use parallel agent execution (4 agents: tech, architecture, quality, concerns) for speed
**FR-1.4**: Store mapping output in project-scoped location (e.g., .laminark/codebase/ or .planning/codebase/)

### FR-2: Knowledge Ingestion Pipeline

**FR-2.1**: Parse structured markdown docs into discrete, queryable reference memories
**FR-2.2**: Each section becomes a separate memory with kind="reference" and appropriate title/tags
**FR-2.3**: Support ingesting existing .planning/codebase/ docs (GSD output) when detected
**FR-2.4**: Ingestion is idempotent — re-running replaces stale memories, doesn't duplicate
**FR-2.5**: Per-project scoping — memories are tagged with project identifier

### FR-3: Hook-Driven Incremental Updates

**FR-3.1**: PostToolUse hook on Write/Edit detects file changes
**FR-3.2**: Changed files trigger background re-analysis of affected knowledge sections
**FR-3.3**: Re-analysis updates only the relevant memories, not full re-index
**FR-3.4**: Updates are non-blocking — happen in background after tool response

### FR-4: Session-Start Catch-Up

**FR-4.1**: On SessionStart, detect git changes since last index timestamp
**FR-4.2**: Queue affected files for background re-analysis
**FR-4.3**: If no prior index exists, suggest running initial mapping
**FR-4.4**: Catch-up is fast — only processes changed files, not full codebase

### FR-5: MCP Tools

**FR-5.1**: `index_project` tool — trigger full or partial re-indexing on demand
**FR-5.2**: Tool accepts optional file/directory path for targeted re-index
**FR-5.3**: Returns confirmation with stats (files analyzed, memories updated)

### FR-6: GSD Interop

**FR-6.1**: Detect if GSD plugin is installed (check ~/.claude/ for GSD presence)
**FR-6.2**: Detect if .planning/codebase/ docs exist for current project
**FR-6.3**: When GSD output exists, ingest it directly instead of running mapper
**FR-6.4**: When GSD is installed but no output exists, can delegate to GSD's map-codebase
**FR-6.5**: Attribution: clearly credit GSD in any bundled agent definitions

## Non-Functional Requirements

### NFR-1: Performance
- Initial mapping: acceptable to take 1-5 minutes (parallel agents)
- Incremental updates: < 5 seconds per changed file (background)
- Session-start catch-up: < 10 seconds for typical git diff
- Memory queries: existing recall performance (< 100ms)

### NFR-2: Token Budget
- Mapping output ingested into memories should use compact format
- Recall queries against codebase knowledge should respect existing token budgets
- Context injection should prioritize codebase knowledge for unmapped queries

### NFR-3: Storage
- All knowledge stored in existing SQLite database (observations table)
- No new database files or external storage
- Knowledge tagged for easy identification and cleanup

## Out of Scope

- Real-time file watching (inotify/fswatch) — hook-driven is sufficient
- Cross-project knowledge sharing — per-project only
- Embedding-based semantic search over codebase — FTS5 keyword search is sufficient for structured docs
- IDE integration — Claude Code plugin only
