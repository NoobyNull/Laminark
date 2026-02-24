# Laminark

## What This Is

A global Claude Code plugin that gives Claude persistent, adaptive memory and intelligent tool routing across all sessions and projects. It's the ground-up rebuild of Engram — same mission (Claude never forgets), but lightweight, fast, with rich visual memory exploration and scope-aware tool orchestration. Built for the way people actually think — scattered, nonlinear, and constantly branching.

## Core Value

You never lose context. No matter how many tangents, topic jumps, or scattered sessions, every thread is recoverable and every thought is findable. Claude always knows which tools are available and when to use them.

## Current State

Building v2.3. Laminark is a globally-installed Claude Code plugin with persistent adaptive memory, intelligent tool routing, AI-powered observation enrichment via Claude Agent SDK, and debug resolution path tracking.

**Shipped versions:**
- v1.0 Persistent Adaptive Memory (Phases 1-8, 2026-02-09)
- v2.0 Global Tool Intelligence (Phases 9-16, 2026-02-10)
- v2.1 Agent SDK Migration (Phases 17-18, 2026-02-14)
- v2.2 Debug Resolution Paths (Phases 19-21, 2026-02-14)

## Current Milestone: v2.3 Codebase & Tool Knowledge

**Goal:** Laminark understands the full environment — codebase structure and tool capabilities equally. It delegates analysis to existing tools (GSD for mapping), ingests their output into queryable knowledge, and deeply understands what every tool can do. No duplication — Laminark is the knowledge layer.

**Philosophy:** Laminark doesn't duplicate — it delegates, ingests, and understands. GSD maps codebases. Playwright browses. Agent SDK builds agents. Laminark knows what they all do and when to use them.

**Target features:**
- Knowledge ingestion pipeline: structured markdown docs → per-project queryable reference memories
- /laminark:map-codebase skill: delegates to GSD (or suggests installing it), then ingests output
- Deep tool capability understanding: parse schemas, .md files, parameters — know what tools CAN DO, not just that they exist
- Populate trigger_hints for ALL tools (fixing proactive suggestion blind spot for MCP tools)
- Hook-driven incremental updates on Write/Edit (background re-analysis of changed files)
- Session-start git-diff catch-up for changes made outside Claude
- Context injection that surfaces codebase + tool knowledge for relevant queries

## Requirements

### Validated

- [x] Persistent memory storage across Claude Code sessions — v1.0 Phase 1
- [x] Automatic observation capture via SDK hooks — v1.0 Phase 3
- [x] Adaptive topic shift detection — v1.0 Phase 6
- [x] Silent context stashing — v1.0 Phase 6
- [x] User notification on stash — v1.0 Phase 6
- [x] Real-time semantic analysis (zero latency) — v1.0 Phase 4
- [x] Pluggable embedding strategy — v1.0 Phase 4/7
- [x] MCP tools for memory management — v1.0 Phase 2
- [x] Hybrid search (FTS5 + vector) — v1.0 Phase 4
- [x] Knowledge graph with typed relationships — v1.0 Phase 7
- [x] Web UI knowledge graph visualization — v1.0 Phase 8
- [x] Web UI timeline view — v1.0 Phase 8
- [x] Slash commands (/remember, /recall, /stash, /resume) — v1.0 Phase 5/6
- [x] Session-aware concurrency — v1.0 Phase 1
- [x] Crash recovery with WAL journaling — v1.0 Phase 1
- [x] Global installation — always present regardless of project — v2.0 Phase 9
- [x] Project context awareness — detect and scope to current project — v2.0 Phase 9
- [x] Tool discovery across all config scopes — v2.0 Phase 10
- [x] Scope-aware tool registry — v2.0 Phase 11
- [x] Conversation-driven tool routing with learned patterns — v2.0 Phase 14
- [x] Routing memory that improves over time — v2.0 Phase 14
- [x] AI-powered entity extraction via Haiku — v2.1 Phase 17
- [x] Subscription-based auth via Claude Agent SDK — v2.1 Phase 18

### Active

- [ ] Knowledge ingestion pipeline: structured markdown → per-project reference memories in SQLite
- [ ] /laminark:map-codebase skill: delegate to GSD, ingest output
- [ ] Deep tool capability understanding: schemas, parameters, use cases for all tools
- [ ] Populate trigger_hints for all tools (not just slash commands/skills)
- [ ] Hook-driven incremental updates on Write/Edit (background re-analysis)
- [ ] Session-start git-diff catch-up for changes made outside Claude
- [ ] MCP tool for on-demand re-index (file, directory, or full project)
- [ ] Context injection: surface codebase + tool knowledge for relevant queries

### Out of Scope

- Mobile app — web UI on localhost is sufficient
- Cloud sync — local-first, single machine
- Multi-user — this is a personal developer tool
- Electron/Tauri desktop wrapper — browser-based web UI keeps it simple
- Integration with non-Claude AI tools — Claude Code plugin only

## Context

Engram (v1) proved the concept works and hit #1 on GitHub. But it was too heavy — too many dependencies, slow startup, embedding overhead that blocked the user experience. The core insight for Laminark: do semantic processing during time the user is already waiting (while Claude generates responses), making the memory layer effectively invisible from a performance perspective.

The target user is a developer with ADHD-like working patterns — jumping between topics frequently, not always staying on track. The system must adapt to this rather than fight it. Some days you're laser-focused, some days you're scattered. The adaptive threshold learns this per-session rather than using a static cutoff.

Laminark V1 shipped all 8 phases in 2.21 hours (37 plans). V2 extends from memory plugin to tool intelligence layer. The key insight: Laminark already has the infrastructure (DB, knowledge graph, memory, hooks) to understand conversation context — now it needs to also understand which tools exist and when to route to them.

Claude Code tool scoping model (discovered during V2 planning):
- Built-in tools: Always available (Read, Write, Edit, Glob, Grep, Bash, Task, Web*)
- Global (~/.claude/): settings.json, settings.local.json, hooks, plugins (e.g., GSD, frontend-design)
- Project (.mcp.json): Project-scoped MCP servers (e.g., Laminark itself currently)
- Team (.claude/settings.json committed to repo): Shared team config
- Resolution: built_in + global + project + team = available_tools for session

## Constraints

- **Deployment**: Global Claude Code plugin (hooks + MCP server) — must work at ~/.claude/ level while remaining project-aware
- **Performance**: Zero perceptible latency added to user workflow — all analysis happens in parallel
- **Dependencies**: Minimal — Node.js + SQLite. No Python, no Bun, no heavyweight ML frameworks
- **Storage**: SQLite with WAL mode — single file, no external database servers
- **Embeddings**: Must support multiple strategies (local ONNX, Claude extraction, hybrid) — no single point of failure
- **Scope correctness**: Never suggest tools that aren't available in the current session's resolved scope

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Rebuild from scratch (not fork Engram) | Engram's weight problems are architectural, not patchable | ✓ Good |
| Adaptive per-user topic thresholds | Static thresholds fail for ADHD/variable focus patterns | ✓ Good |
| Pluggable embedding strategy | Different environments need different tradeoffs (speed vs quality vs cost) | ✓ Good |
| SQLite + WAL + FTS5 + sqlite-vec | Proven in Engram, sound fundamentals — keep what works | ✓ Good |
| Local web server for visualization | Keeps it simple, no native app overhead, browser is universal | ✓ Good |
| Process semantics during response generation | "Free" computation — user is already waiting for Claude | ✓ Good |
| Laminark must be global, not project-scoped | To act as universal tool router, must be present in all projects | ✓ Good |
| Tool registry with scope awareness | No sense calling personal tools in team context, or project tools globally | ✓ Good |
| Replace regex extraction with Haiku AI | Regex rules too brittle, Haiku provides semantic understanding | ✓ Good |
| Claude Agent SDK over Anthropic SDK | Routes through subscription auth, no separate API key needed | ✓ Good |
| V2 session API over V1 query() | Avoids 12s cold-start per call with persistent session singleton | ✓ Good |
| Delegate to GSD, don't bundle mapper | Laminark is the knowledge layer, not the analysis layer; avoid duplicating GSD's proven codebase mapping | Pending |
| Deep tool capability understanding | Tool registry stores names+descriptions but not what tools can DO; proactive suggestions blind to MCP tool capabilities | Pending |
| Two-pronged freshness (hooks + session-start) | Covers both Claude-made changes (immediate) and external changes (catch-up) | Pending |
| Per-project knowledge scoping | Each project gets its own indexed knowledge set, isolated from others | Pending |
| Know all tools equally | Playwright, GSD, Agent SDK, MCP servers — Laminark should understand them all at the same depth, not favor any one ecosystem | Pending |

## Context

Shipped through v2.2 with 21 phases, 64 plans total. Tech stack: Node.js + TypeScript + SQLite (WAL + FTS5 + sqlite-vec) + Hono web server + D3/vanilla JS UI. All observation enrichment (entity extraction, relationship inference, classification) now flows through Haiku AI via Claude Agent SDK V2 session API — no separate API key required.

v2.3 insight: Laminark captures knowledge well during sessions but has two gaps on the supply side. First, codebase knowledge — Claude re-explores files every session. GSD already solves this with map-codebase; Laminark should delegate to it and ingest the output, not duplicate it. Second, tool knowledge — Laminark knows tool names and descriptions but not capabilities. It can't tell you that Playwright screenshots pages or that GSD has plan-phase vs execute-phase. Deep tool understanding (schemas, parameters, use cases) makes proactive suggestions actually work for ALL tools, not just slash commands.

Philosophy shift: Laminark doesn't duplicate — it delegates, ingests, and understands. Each tool in the ecosystem does what it's best at. Laminark's job is to know what they all do and surface that knowledge at the right time. Freshness is two-pronged: immediate PostToolUse updates for files changed by Claude, session-start git-diff catch-up for changes made outside Claude.

---
*Last updated: 2026-02-24 after v2.3 philosophy revision — delegate don't duplicate*
