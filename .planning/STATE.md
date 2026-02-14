# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-14)

**Core value:** You never lose context. Every thread is recoverable, every thought is findable. Claude always knows which tools are available and when to use them.
**Current focus:** v2.2 Debug Resolution Paths — MILESTONE COMPLETE

## Current Position

Phase: 21 of 21 (Graph Visualization) — COMPLETE
Plan: 3 of 3
Status: Milestone v2.2 Complete
Last activity: 2026-02-14 — All 3 phases complete (9/9 plans, all verified)

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

**V2.2 Velocity:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 19-path-detection-and-storage | 3/3 | 5min | 2min |
| 20-intelligence-and-mcp-tools | 3/3 | 7min | 2min |
| 21-graph-visualization | 2/3 | 4min | 2min |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [V2.1]: Replace regex extraction with Haiku AI — semantic understanding over brittle rules
- [V2.1]: Claude Agent SDK over Anthropic SDK — subscription auth, no API key needed
- [V2.1]: V2 session API over V1 query() — avoids 12s cold-start per call
- [V2.2]: Path detection extends existing classifier prompt (no separate Haiku call) — prevents API volume explosion
- [V2.2]: Paths stored in dedicated SQLite tables (not embedded in graph_nodes) — prevents graph pollution
- [V2.2]: PathTracker in MCP server process (not hook handler) — hooks are ephemeral subprocesses
- [V2.2]: Zod .default(null) for debug_signal backward compatibility — graceful degradation if Haiku omits field
- [V2.2]: debug_signal evaluated for noise and signal observations — build failures are noise but debug-relevant
- [V2.2]: PathTracker as optional dependency in HaikuProcessor — backward compatible, null if not provided
- [V2.2]: Waypoint summaries use first 200 chars (Phase 20 adds Haiku-generated summaries)
- [V2.2]: Jaccard similarity threshold 0.25 for path recall — balances recall vs noise on short text
- [V2.2]: Path recall capped at 2 results in PreToolUse to stay within context budget
- [V2.2]: findRecentActivePath uses 24h window query for cross-session staleness boundary
- [V2.2]: KISS generation is fire-and-forget (non-blocking) to avoid slowing path resolution
- [V2.2]: Full KissSummary stored as JSON string in kiss_summary TEXT column
- [V2.2]: Waypoints pre-filtered to key types and capped at 10 for Haiku prompt efficiency
- [V2.2]: Path API route order /paths, /paths/active, /paths/:id avoids Hono param matching conflicts
- [V2.2]: kiss_summary parsed from JSON string to object in GET /paths/:id for frontend convenience

### Pending Todos

- [x] Add PreToolUse hook for proactive context injection — SHIPPED
- [x] Add toggle to hide edge type labels on graph — SHIPPED

### Blockers/Concerns

None active.

## Session Continuity

Last session: 2026-02-14
Stopped at: Completed 21-02-PLAN.md (D3 Path Overlay)
Resume file: None
