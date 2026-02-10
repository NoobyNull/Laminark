# Phase 2: MCP Interface and Search - Context

**Gathered:** 2026-02-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Claude-facing MCP tools that let Claude search, save, and manage memories through keyword search with token-budget-aware progressive disclosure. This phase delivers the tool interface layer on top of the Phase 1 storage engine. Automatic capture (hooks), semantic search (embeddings), and slash commands are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Save behavior (save_memory tool)
- Optional title parameter — caller can provide a title, auto-generated from text if omitted
- System should track additions and subtractions to code — when implementing new code, Claude shouldn't loop back into already-removed code
- Save is a simple persist operation with no confirmation flow

### Unified recall tool
- Single `recall` tool replaces separate forget/restore/get_observations tools
- Interface pattern: `search [textFST|Id|title] [view|purge|restore]`
- Search by full-text (FTS5), observation ID, or title
- Actions after search: **view**, **purge** (soft-delete), or **restore** (un-delete)

### Multi-result selection
- Search returns a compact list of matches
- Caller selects one, multiple, or all/none before applying an action
- No blind "act on all matches" — always list first, then select, then act

### Purge and restore semantics
- Purge is soft-delete: flags memory with deleted_at timestamp, hides from normal search, keeps in DB
- Restore un-deletes a previously purged memory, making it searchable again
- No hard delete exposed in MCP tools

### View behavior (progressive disclosure)
- View uses 3-layer progressive disclosure: compact index → timeline context → full details
- Respects token budgets for large result sets
- Claude requests more detail as needed rather than receiving everything upfront

### Claude's Discretion
- Tool naming conventions and exact parameter schemas
- Error message wording and empty-result formatting
- Token budget thresholds and truncation strategy
- Auto-title generation algorithm

</decisions>

<specifics>
## Specific Ideas

- The recall tool should feel like a single unified interface for all memory retrieval and management — not scattered across many tools
- Code change awareness: the system should help Claude avoid re-implementing code that was previously removed, by remembering additions and subtractions

</specifics>

<deferred>
## Deferred Ideas

- `/laminark:recall` slash command interface — Phase 5 (this phase builds the MCP tool that powers it)
- `/laminark:remember` slash command — Phase 5

</deferred>

---

*Phase: 02-mcp-interface-and-search*
*Context gathered: 2026-02-08*
