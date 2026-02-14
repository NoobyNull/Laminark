# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-14)

**Core value:** You never lose context. Every thread is recoverable, every thought is findable. Claude always knows which tools are available and when to use them.
**Current focus:** v2.1 milestone complete. Planning next milestone.

## Current Position

Milestone: v2.1 Agent SDK Migration — SHIPPED 2026-02-14
All 18 phases complete across 3 milestones (v1.0, v2.0, v2.1)
Last activity: 2026-02-14 - Milestone v2.1 archived

## Performance Metrics

**V1 Velocity:**
- Total plans completed: 37
- Average duration: 3min
- Total execution time: 2.21 hours

**By Phase (V1):**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-storage-engine | 4/4 | 13min | 3min |
| 02-mcp-interface-and-search | 3/3 | 12min | 4min |
| 03-hook-integration-and-capture | 3/3 | 11min | 4min |
| 04-embedding-engine-and-semantic-search | 4/4 | 11min | 3min |
| 05-session-context-and-summaries | 3/3 | 9min | 3min |
| 06-topic-detection-and-context-stashing | 7/7 | 26min | 4min |
| 07-knowledge-graph-and-advanced-intelligence | 8/8 | 34min | 4min |
| 08-web-visualization | 5/5 | 25min | 5min |

**V2 Velocity:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 09-global-installation | 2/2 | 6min | 3min |
| 10-tool-discovery-registry | 2/2 | 4min | 2min |
| 11-scope-resolution | 1/1 | 3min | 3min |
| 12-usage-tracking | 1/1 | 2min | 2min |
| 13-context-enhancement | 1/1 | 3min | 3min |
| 14-conversation-routing | 2/2 | 5min | 2.5min |
| 15-tool-search | 2/2 | 4min | 2min |
| 16-staleness-management | 2/2 | 4min | 2min |
| 17-haiku-intelligence | 3/3 | 14min | 5min |
| 18-agent-sdk-migration | 2/2 | 3min | 1.5min |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [V2]: Laminark must be global (~/.claude/), not project-scoped (.mcp.json) — to act as universal tool router
- [V2]: Tool registry needs scope awareness — built-in, global, project, team scopes with resolution rules
- [V2]: Conversation-driven routing — map discussion patterns to appropriate tools from resolved scope set
- [V2]: Zero new dependencies — all builds on existing Node.js + SQLite + Zod stack
- [09-01]: Centralized dual-prefix detection in self-referential.ts — isLaminarksOwnTool() handles both mcp__laminark__ and mcp__plugin_laminark_laminark__
- [09-01]: Test file convention: src/hooks/__tests__/*.test.ts (not tests/ directory)
- [09-02]: Plugin manifest uses semver 1.0.0 (not internal version "7") for plugin system compatibility
- [09-02]: All config paths use ${CLAUDE_PLUGIN_ROOT} for portability -- no relative ./ paths in hooks.json or .mcp.json
- [09-02]: SessionStart hook is synchronous with statusMessage; all other hooks are async: true
- [10-01]: COALESCE(project_hash, '') for NULL-safe unique index -- global tools deduplicated in separate namespace
- [10-01]: ToolRegistryRepository is NOT project-scoped -- queries span all scopes for cross-project discovery
- [10-01]: recordOrCreate uses upsert-then-increment pattern for organic tool discovery
- [10-02]: Organic discovery runs BEFORE self-referential filter -- Laminark's own tools are registered
- [10-02]: Config scanning uses only synchronous fs operations (SessionStart is synchronous)
- [10-02]: All discovery writes wrapped in try/catch -- registry failures never block core pipeline
- [10-02]: projectHash threaded from main() to avoid redundant realpathSync in organic discovery
- [11-01]: Scope resolution uses explicit per-scope SQL conditions rather than generic scope hierarchy
- [11-01]: Tool section is lowest-priority context budget item -- dropped before observations on overflow
- [11-01]: formatToolSection is module-internal (not exported) -- implementation detail of injection.ts
- [11-01]: Built-in tools excluded from Available Tools display since Claude already knows them
- [12-01]: Event insert inside existing try/catch -- non-fatal, supplementary to aggregate counters
- [12-01]: sessionId=undefined skips event insert -- backward compatible with callers not providing session
- [12-01]: No transaction wrapping aggregate+event -- independent rows, acceptable if event fails alone
- [13-01]: 500-char sub-budget is primary tool section limiter; MAX_TOOLS_IN_CONTEXT kept as safety constant
- [13-01]: Relevance score = frequency * 0.7 + recency * 0.3 computed in TypeScript, not SQL
- [13-01]: MCP server entries aggregate usage from individual tool events via prefix regex
- [13-01]: 7-day getUsageSince window matches the recency decay half-life
- [14-01]: Heuristic functions are pure (no DB dependency) -- accept pre-fetched data for testability
- [14-01]: Confidence scored as matchCount/toolKeywords.length (tool-side Jaccard overlap)
- [14-01]: Stop word set covers 50 common English function words for keyword extraction
- [14-02]: ConversationRouter instantiated per-evaluation (no long-lived state) -- matches short-lived CLI handler model
- [14-02]: routing_state/routing_patterns tables created inline (no migration) -- transient data refreshed each session
- [14-02]: db parameter added explicitly to processPostToolUseFiltered (clean separation, Option A)
- [14-02]: Learned tier first, heuristic fallback -- progressive takeover as usage data accumulates
- [15-01]: FTS5 BM25 weights name 2x over description for tool name relevance boost
- [15-01]: Functional migration with try/catch for vec0 -- FTS5 always runs, vec0 degrades gracefully
- [15-01]: sanitizeQuery duplicated from SearchEngine (not imported) -- ToolRegistryRepository is not observation-scoped
- [15-01]: searchByVector returns snake_case tool_id matching SQL column convention
- [15-02]: discover_tools uses enforceTokenBudget at 2000 tokens matching recall.ts pattern
- [15-02]: Deduplication mirrors injection.ts formatToolSection -- server-level entries suppress individual mcp_tool entries
- [15-02]: processUnembeddedTools piggybacks on existing 5-second setInterval -- no new timer
- [15-02]: ToolRegistryRepository instance wrapped in try/catch at module level for pre-migration graceful degradation
- [16-01]: Three-state tool status (active/stale/demoted) with idempotent markStale/markActive transitions
- [16-01]: getConfigSourcedTools returns project-level AND global tools for complete staleness comparison
- [16-01]: Status ordering prepended before tool_type ordering in getAvailableForSession
- [16-01]: Upsert ON CONFLICT restores active status for re-discovered tools
- [16-02]: detectRemovedTools runs inside config scan timing for accurate performance monitoring
- [16-02]: MCP server removal cascades to individual mcp_tool entries from same server_name
- [16-02]: Age penalty computed in JS using MAX(last_used_at/discovered_at, updated_at) not SQL
- [16-02]: Router uses strict t.status === 'active' for forward-compatibility with new statuses
- [16-02]: Stacking score penalties: 0.25x for status (stale/demoted) and 0.5x for 30+ day age
- [17-01]: Used @anthropic-ai/sdk (not claude-agent-sdk) for simple Messages API calls -- agent SDK is overkill for structured extraction
- [17-01]: Combined noise/signal + observation classification into one Haiku call (one concern, cheaper)
- [17-01]: Defensive JSON extractor strips markdown fences and finds JSON arrays/objects in response text
- [17-02]: Deleted regex extraction rules entirely -- HaikuProcessor is sole extraction path, no fallback
- [17-02]: Store-then-classify pattern: observations stored unconditionally, classified by Haiku, noise soft-deleted
- [17-02]: Provenance/temporal edges removed from embedding loop along with regex extraction block
- [17-03]: Used vi.mock for all Haiku agents in processor tests -- real SQLite but mocked API calls
- [17-03]: Noise rejection tests converted to admission tests -- documents behavioral shift to post-storage classification
- [18-01]: Used V2 session API (unstable_v2_createSession) over V1 query() to avoid 12s cold-start per call
- [18-01]: Embedded system prompts in user messages rather than creating separate sessions per agent type
- [18-01]: SDKSessionOptions model takes full model ID string, not short name
- [18-01]: permissionMode bypassPermissions with allowedTools:[] for pure text completion
- [18-01]: isHaikuEnabled() always returns true -- errors propagate naturally

### Pending Todos

- ~~[v2] Global installation mechanism for Laminark~~ COMPLETE (Phase 09)
- ~~[v2] Scope-aware tool registry~~ COMPLETE (Phase 10-01: storage layer)
- ~~[v2] Tool discovery across config scopes~~ COMPLETE (Phase 10-02: config scanning + organic PostToolUse)
- ~~[v2] Scope-filtered tool resolution~~ COMPLETE (Phase 11-01: getAvailableForSession + session context)
- ~~[v2] Usage event tracking~~ COMPLETE (Phase 12-01: tool_usage_events + temporal queries)
- ~~[v2] Conversation-driven routing~~ COMPLETE (Phase 14: types, heuristic, learned patterns, router, handler + session integration)
- ~~[v2] Tool search and discovery~~ COMPLETE (Phase 15: FTS5+vec0 search foundation + discover_tools MCP tool + background embedding)
- [ ] Add PreToolUse hook for proactive context injection (surfaces relevant memories/graph before tool use)

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 2 | add in a help section to the Laminark GUI | 2026-02-12 | cd7bc1d | [2-add-in-a-help-section-to-the-laminark-gu](./quick/2-add-in-a-help-section-to-the-laminark-gu/) |

### Roadmap Evolution

- Phase 17 added: replace decisionmaking regexes and broken haiku with agent-sdk haiku
- Phase 18 added: Replace @anthropic-ai/sdk with Claude Agent SDK for subscription-based Haiku calls

### Blockers/Concerns

- ~~Global installation changes MCP prefix from `mcp__laminark__` to `mcp__plugin_laminark_laminark__` — dual-prefix support needed during migration~~ RESOLVED by 09-01
- ~~Tool discovery must handle missing/malformed config files gracefully~~ RESOLVED by 10-02 (all scanners wrapped in try/catch)
- ~~Routing cold start — heuristic fallback needed before learned patterns accumulate~~ RESOLVED by 14-01 (keyword-based heuristic fallback)
- ~~MCP Tool Search feature (`ENABLE_TOOL_SEARCH`) interaction with registry completeness~~ RESOLVED by 15-02 (discover_tools searches all registered tools with hybrid search)

## Session Continuity

Last session: 2026-02-14
Stopped at: Completed 18-02-PLAN.md -- Phase 18 complete, Agent SDK migration fully verified
Resume file: None
