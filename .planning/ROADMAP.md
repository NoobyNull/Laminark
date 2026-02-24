# Roadmap: Laminark

## Milestones

- ✅ **v1.0 Persistent Adaptive Memory** — Phases 1-8 (shipped 2026-02-09)
- ✅ **v2.0 Global Tool Intelligence** — Phases 9-16 (shipped 2026-02-10)
- ✅ **v2.1 Agent SDK Migration** — Phases 17-18 (shipped 2026-02-14)
- ✅ **v2.2 Debug Resolution Paths** — Phases 19-21 (shipped 2026-02-14)
- 🔄 **v2.3 Codebase & Tool Knowledge** — Phases 22-26

## Phases

<details>
<summary>✅ v1.0 Persistent Adaptive Memory (Phases 1-8) — SHIPPED 2026-02-09</summary>

- [x] Phase 1: Storage Engine (4/4 plans) — completed 2026-02-08
- [x] Phase 2: MCP Interface and Search (3/3 plans) — completed 2026-02-08
- [x] Phase 3: Hook Integration and Capture (3/3 plans) — completed 2026-02-08
- [x] Phase 4: Embedding Engine and Semantic Search (4/4 plans) — completed 2026-02-08
- [x] Phase 5: Session Context and Summaries (3/3 plans) — completed 2026-02-08
- [x] Phase 6: Topic Detection and Context Stashing (7/7 plans) — completed 2026-02-08
- [x] Phase 7: Knowledge Graph and Advanced Intelligence (8/8 plans) — completed 2026-02-08
- [x] Phase 8: Web Visualization (5/5 plans) — completed 2026-02-08

</details>

<details>
<summary>✅ v2.0 Global Tool Intelligence (Phases 9-16) — SHIPPED 2026-02-10</summary>

- [x] Phase 9: Global Installation (2/2 plans) — completed 2026-02-10
- [x] Phase 10: Tool Discovery and Registry (2/2 plans) — completed 2026-02-11
- [x] Phase 11: Scope Resolution (1/1 plan) — completed 2026-02-11
- [x] Phase 12: Usage Tracking (1/1 plan) — completed 2026-02-11
- [x] Phase 13: Context Enhancement (1/1 plan) — completed 2026-02-11
- [x] Phase 14: Conversation Routing (2/2 plans) — completed 2026-02-10
- [x] Phase 15: Tool Search (2/2 plans) — completed 2026-02-10
- [x] Phase 16: Staleness Management (2/2 plans) — completed 2026-02-10

</details>

<details>
<summary>✅ v2.1 Agent SDK Migration (Phases 17-18) — SHIPPED 2026-02-14</summary>

- [x] Phase 17: Replace Decisionmaking Regexes with Agent-SDK Haiku (3/3 plans) — completed 2026-02-14
- [x] Phase 18: Replace @anthropic-ai/sdk with Claude Agent SDK (2/2 plans) — completed 2026-02-14

</details>

<details>
<summary>✅ v2.2 Debug Resolution Paths (Phases 19-21) — SHIPPED 2026-02-14</summary>

- [x] Phase 19: Path Detection & Storage (3/3 plans) — completed 2026-02-14
- [x] Phase 20: Intelligence & MCP Tools (3/3 plans) — completed 2026-02-14
- [x] Phase 21: Graph Visualization (3/3 plans) — completed 2026-02-14

</details>

### v2.3 Codebase & Tool Knowledge (Phases 22-26)

**Goal:** Laminark understands the full environment — codebase structure and tool capabilities equally. It delegates analysis to existing tools (GSD for mapping), ingests their output into queryable knowledge, and deeply understands what every tool can do. No duplication, no bundling — Laminark is the knowledge layer.

**Philosophy:** Laminark doesn't duplicate — it delegates, ingests, and understands. GSD maps codebases. Playwright browses. Agent SDK builds agents. Laminark knows what they all do and when to use them.

### Phase 22: Knowledge Ingestion Pipeline

**Goal:** Structured documents become queryable per-project memories

- Parse structured markdown sections into discrete reference memories (kind="reference")
- Each section becomes separate memory with title, project tag, source doc reference
- Idempotent ingestion: re-running replaces stale memories by matching title+project
- Ingest from .planning/codebase/ (GSD output), .laminark/codebase/, or any user-specified directory
- /laminark:map-codebase skill: thin wrapper that detects GSD → suggests /gsd:map-codebase (or install GSD) → ingests output after mapping completes
- New DB columns/tags for knowledge source identification

### Phase 23: Deep Tool Capability Understanding

**Goal:** Laminark knows what every tool can actually do, not just that it exists

- Extend tool registry beyond name+description to capture capabilities, parameters, use cases
- Parse MCP tool input schemas (parameters, types, required fields) from session tool definitions
- Parse plugin skill/command/agent .md files for rich capability data (beyond frontmatter)
- Populate trigger_hints for ALL tools — fixes proactive suggestion blind spot where MCP tools have null trigger_hints
- Result: discover_tools returns what tools can do, not just that they exist
- Equal coverage: Playwright (screenshot, navigate, click, fill), GSD (plan, execute, debug), Agent SDK (sessions, agents), all first-class

### Phase 24: Hook-Driven Incremental Updates

**Goal:** Knowledge stays current as Claude edits files

- PostToolUse hook on Write/Edit extracts file path from tool input
- Background re-analysis: determine which knowledge sections the file affects
- Haiku-powered targeted update: re-analyze only the relevant section(s), update memory
- Non-blocking: updates happen after tool response, in background processing queue

### Phase 25: Session-Start Catch-Up

**Goal:** External changes (editor, git pull, other tools) don't leave knowledge stale

- On SessionStart, run `git diff --name-only` against last-indexed commit hash
- Queue changed files for incremental re-analysis (same pipeline as Phase 24)
- Store last-indexed commit hash per project in DB
- If no prior index exists, suggest running /gsd:map-codebase (or installing GSD)

### Phase 26: Context Integration

**Goal:** Codebase + tool knowledge flows into context injection and on-demand queries

- `index_project` MCP tool: full or targeted re-index on demand
- Context injection prioritizes codebase knowledge for project structure queries
- Context injection surfaces tool capabilities for "how do I..." queries
- Update CLAUDE.md template: instruct Claude to query Laminark before file exploration
- Web UI: index status page showing per-project knowledge freshness and coverage

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Storage Engine | v1.0 | 4/4 | Complete | 2026-02-08 |
| 2. MCP Interface and Search | v1.0 | 3/3 | Complete | 2026-02-08 |
| 3. Hook Integration and Capture | v1.0 | 3/3 | Complete | 2026-02-08 |
| 4. Embedding Engine and Semantic Search | v1.0 | 4/4 | Complete | 2026-02-08 |
| 5. Session Context and Summaries | v1.0 | 3/3 | Complete | 2026-02-08 |
| 6. Topic Detection and Context Stashing | v1.0 | 7/7 | Complete | 2026-02-08 |
| 7. Knowledge Graph and Advanced Intelligence | v1.0 | 8/8 | Complete | 2026-02-08 |
| 8. Web Visualization | v1.0 | 5/5 | Complete | 2026-02-08 |
| 9. Global Installation | v2.0 | 2/2 | Complete | 2026-02-10 |
| 10. Tool Discovery and Registry | v2.0 | 2/2 | Complete | 2026-02-11 |
| 11. Scope Resolution | v2.0 | 1/1 | Complete | 2026-02-11 |
| 12. Usage Tracking | v2.0 | 1/1 | Complete | 2026-02-11 |
| 13. Context Enhancement | v2.0 | 1/1 | Complete | 2026-02-11 |
| 14. Conversation Routing | v2.0 | 2/2 | Complete | 2026-02-10 |
| 15. Tool Search | v2.0 | 2/2 | Complete | 2026-02-10 |
| 16. Staleness Management | v2.0 | 2/2 | Complete | 2026-02-10 |
| 17. Haiku Intelligence | v2.1 | 3/3 | Complete | 2026-02-14 |
| 18. Agent SDK Migration | v2.1 | 2/2 | Complete | 2026-02-14 |
| 19. Path Detection & Storage | v2.2 | 3/3 | Complete | 2026-02-14 |
| 20. Intelligence & MCP Tools | v2.2 | 3/3 | Complete | 2026-02-14 |
| 21. Graph Visualization | v2.2 | 3/3 | Complete | 2026-02-14 |
| 22. Knowledge Ingestion Pipeline | v2.3 | 0/? | Pending | — |
| 23. Deep Tool Capability Understanding | v2.3 | 0/? | Pending | — |
| 24. Hook-Driven Incremental Updates | v2.3 | 0/? | Pending | — |
| 25. Session-Start Catch-Up | v2.3 | 0/? | Pending | — |
| 26. Context Integration | v2.3 | 0/? | Pending | — |
