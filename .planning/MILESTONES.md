# Milestones

## Completed

### v1.0 — Persistent Adaptive Memory

**Completed:** 2026-02-09
**Phases:** 1-8 (37 plans, 2.21 hours total)
**Last phase number:** 8

**Delivered:**
- SQLite storage engine with WAL, concurrency, crash recovery
- MCP interface with keyword search and progressive disclosure
- Automatic observation capture via Claude Code hooks
- Vector embeddings with pluggable strategy and hybrid search
- Session context injection and summaries
- Adaptive topic detection and context stashing
- Knowledge graph with entity extraction and relationship mapping
- Interactive web visualization (graph + timeline + activity)

### v2.0 — Global Tool Intelligence

**Completed:** 2026-02-10
**Phases:** 9-16 (13 plans)
**Last phase number:** 16

**Delivered:**
- Global plugin installation with project-aware session bootstrapping
- Tool discovery across all Claude Code config scopes (.mcp.json, ~/.claude.json, commands, skills, plugins)
- Scope-aware tool registry with built-in/global/project/plugin classification
- Usage tracking with per-session and per-project event history
- Context-enhanced session start with relevance-ranked tool suggestions
- Conversation-driven tool routing with learned patterns and heuristic fallback
- Tool search MCP tool with hybrid FTS5+vector semantic search
- Staleness management with config rescan, age deprioritization, and failure demotion

### v2.1 — Agent SDK Migration

**Completed:** 2026-02-14
**Phases:** 17-18 (5 plans, 12 tasks)
**Last phase number:** 18

**Delivered:**
- Replaced regex entity extraction and broken MCP classifier with 3 focused Haiku AI agents
- Created HaikuProcessor background orchestrator for classification, entity extraction, and relationship inference
- Migrated from @anthropic-ai/sdk to @anthropic-ai/claude-agent-sdk for subscription-based auth (no API key needed)
- Full test coverage maintained: 727 tests across 46 files, zero failures

### v2.2 — Debug Resolution Paths

**Completed:** 2026-02-14
**Phases:** 19-21 (9 plans)
**Last phase number:** 21

**Delivered:**
- Automatic debug path detection from error patterns without manual intervention
- Debug journey captured as ordered waypoints (error, attempt, failure, success, pivot, revert, discovery, resolution)
- Automatic path resolution detection when consecutive success signals meet threshold
- SQLite persistence with dedicated debug_paths and path_waypoints tables
- KISS summaries for resolved paths ("next time, just do X") with multi-layer dimensions (logical, programmatic, development)
- Proactive recall of relevant past debug paths during new debugging sessions
- Cross-session path linking for continued debugging across Claude Code sessions
- MCP tools for explicit path lifecycle control (start, resolve, show, list)
- D3 breadcrumb trail visualization with animated dashed lines overlaid on knowledge graph
- Color-coded waypoint markers (error: red, attempt: yellow, resolution: green)
- Path detail panel with ordered waypoint timeline and KISS summary display
- Toggle control for showing/hiding path overlay without affecting knowledge graph

### v2.3 — Codebase Knowledge Pre-loading

**Started:** 2026-02-23
**Phases:** 22-26
**Last phase number:** 26

**Target:**
- Bundled codebase mapper (adapted from GSD, with attribution) producing 7 structured analysis docs
- Knowledge ingestion pipeline: markdown docs → per-project queryable reference memories
- Hook-driven incremental updates on Write/Edit for real-time freshness
- Session-start git-diff catch-up for external changes
- MCP tool for on-demand re-indexing
- GSD interop: detect and ingest existing .planning/codebase/ output when present

---

