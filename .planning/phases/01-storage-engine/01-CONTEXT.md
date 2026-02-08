# Phase 1: Storage Engine - Context

**Gathered:** 2026-02-08
**Status:** Ready for planning

<domain>
## Phase Boundary

A durable, concurrent-safe SQLite database that stores observations with full-text indexing and never loses data. This is the foundational storage layer that all other phases build on.

</domain>

<decisions>
## Implementation Decisions

### Package & Distribution
- npm package name: `@laminark/memory` (scoped, leaves room for future packages like `@laminark/cli`)
- Must be installable via Claude plugins — never require users to clone and run from source
- Support both install methods:
  - **npx** (quick start, always latest): `claude mcp add laminark -- npx @laminark/memory`
  - **Global install** (pinned version): `npm i -g @laminark/memory`, then `claude mcp add laminark -- laminark-server`
- No other Claude official plugins required as dependencies — self-contained MCP server

### Database Location
- SQLite database stored at `~/.laminark/data.db`
- Dedicated dot-directory in home (`~/.laminark/`) — easy to find, back up, and delete

### Configuration
- Config file at `~/.laminark/config.json` alongside the database
- One directory for everything Laminark-related

### Claude's Discretion
- Database schema details and migration strategy
- WAL mode and concurrency implementation approach
- FTS5 configuration and tokenizer choice
- Project isolation mechanism (how project scoping works internally)
- Data retention defaults and observation size limits

</decisions>

<specifics>
## Specific Ideas

- "NEVER run from source. Plugin must be installed via Claude plugins" — this is a hard requirement, not a preference
- The plugin must work as a standard MCP server that Claude Code manages

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-storage-engine*
*Context gathered: 2026-02-08*
