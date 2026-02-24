# Phase 17: Replace Decisionmaking Regexes and Broken Haiku with Agent-SDK Haiku - Context

**Gathered:** 2026-02-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace all regex-based decision-making logic and the broken MCP sampling classifier with direct Haiku calls via `@anthropic-ai/agent-sdk`. This covers entity extraction, relationship inference, signal classification, noise filtering, and observation classification. Tool routing heuristics (heuristic-fallback.ts) are out of scope — they operate on conversation context, not observations.

</domain>

<decisions>
## Implementation Decisions

### Replacement Scope
- Replace ALL entity extraction with Haiku (including file paths, URLs, decisions, problems, solutions, projects) — not just the fuzzy ones
- Replace relationship detection (modifies, caused_by, solved_by, etc.) with Haiku inference
- Replace signal classification (observation importance scoring) with Haiku
- Replace noise filtering (build output, linter spam, etc.) with Haiku
- Keep tool routing heuristics (heuristic-fallback.ts) as-is — different domain, works fine
- Each concern gets its own separate Haiku agent/call — not a single mega-pass. Entity extraction, relationship inference, signal classification, and noise filtering are separate agents that each do one thing well

### Agent-SDK Integration
- Use `@anthropic-ai/agent-sdk` as new dependency for direct Haiku API calls
- Laminark requires its own separate API key configuration — not sharing ANTHROPIC_API_KEY from Claude Code environment
- Replaces the broken MCP sampling approach (mcpServer.server.createMessage) which Claude Code doesn't support from plugins

### Latency and Processing
- Haiku-only processing — no local pre-analysis pass. Queue everything for Haiku agents
- Processing is async/background — hooks return immediately, Haiku enrichment happens after
- No fallback to regexes needed: if Anthropic is down, Claude Code itself isn't running, so no hooks fire

### Broken Classifier Fix
- Replace MCP sampling (createMessage) with direct agent-sdk Haiku calls — the current approach never worked because Claude Code doesn't support createMessage from MCP servers
- Process observations individually (one per Haiku call), not batched — simpler, more fault-tolerant, easier to parallelize
- Remove the 5-minute auto-promote fallback — with working Haiku, no need to auto-classify stale observations as "discovery"
- Keep store-then-soft-delete for noise — observations are stored first, classified by Haiku, then noise is soft-deleted. Recoverable if Haiku misjudges

</decisions>

<specifics>
## Specific Ideas

- User wants each extraction concern separated into its own agent — "you can have as many subagents as you need" and "it is actually preferential to keep the task separated"
- Agents should "always go back to Laminark for decisions and more context" — Laminark orchestrates, agents do focused work
- User sees Haiku as fast enough that delay is acceptable but not problematic

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 17-replace-decisionmaking-regexes-and-broken-haiku-with-agent-sdk-haiku*
*Context gathered: 2026-02-13*
