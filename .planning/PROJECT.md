# Laminark

## What This Is

A global Claude Code plugin that gives Claude persistent, adaptive memory and intelligent tool routing across all sessions and projects. It's the ground-up rebuild of Engram — same mission (Claude never forgets), but lightweight, fast, with rich visual memory exploration and scope-aware tool orchestration. Built for the way people actually think — scattered, nonlinear, and constantly branching.

## Core Value

You never lose context. No matter how many tangents, topic jumps, or scattered sessions, every thread is recoverable and every thought is findable. Claude always knows which tools are available and when to use them.

## Current Milestone: v2.0 Global Tool Intelligence

**Goal:** Transform Laminark from a project-scoped memory plugin into a globally-installed tool intelligence layer that discovers, maps, and routes to available tools based on conversation context and scope awareness.

**Target features:**
- Global installation (always present, project-aware)
- Tool discovery across all Claude Code config scopes
- Scope-aware tool registry in Laminark's DB
- Conversation-driven tool routing with learned patterns
- Routing memory that improves over time

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

### Active

- [ ] Global installation — Laminark always present regardless of project
- [ ] Project context awareness — detect and scope to current project from global install
- [ ] Tool discovery — introspect Claude Code config at all scopes on session start
- [ ] Scope-aware tool registry — store tools with scope metadata (built-in, global, project, team)
- [ ] Conversation-driven tool routing — map discussion intents to appropriate tools
- [ ] Routing memory — record tool choice outcomes and learn from patterns

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
| Laminark must be global, not project-scoped | To act as universal tool router, must be present in all projects | — Pending |
| Tool registry with scope awareness | No sense calling personal tools in team context, or project tools globally | — Pending |

---
*Last updated: 2026-02-10 after V2 milestone initialization*
