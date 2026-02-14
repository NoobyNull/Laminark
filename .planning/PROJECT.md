# Laminark

## What This Is

A global Claude Code plugin that gives Claude persistent, adaptive memory and intelligent tool routing across all sessions and projects. It's the ground-up rebuild of Engram — same mission (Claude never forgets), but lightweight, fast, with rich visual memory exploration and scope-aware tool orchestration. Built for the way people actually think — scattered, nonlinear, and constantly branching.

## Core Value

You never lose context. No matter how many tangents, topic jumps, or scattered sessions, every thread is recoverable and every thought is findable. Claude always knows which tools are available and when to use them.

## Current State

Building v2.2. Laminark is a globally-installed Claude Code plugin with persistent adaptive memory, intelligent tool routing, and AI-powered observation enrichment via Claude Agent SDK.

**Shipped versions:**
- v1.0 Persistent Adaptive Memory (Phases 1-8, 2026-02-09)
- v2.0 Global Tool Intelligence (Phases 9-16, 2026-02-10)
- v2.1 Agent SDK Migration (Phases 17-18, 2026-02-14)

## Current Milestone: v2.2 Debug Resolution Paths

**Goal:** Make the debugging journey a first-class knowledge artifact — Laminark automatically tracks the path from problem to resolution, captures what was tried and why it failed, and distills the KISS fix.

**Target features:**
- Automatic debug session detection (Haiku recognizes error/failure patterns in PostToolUse stream)
- Automatic waypoint capture (breadcrumbs recorded from tool activity — edits, tests, reverts, approach changes)
- Automatic resolution detection (tests passing, error pattern stops, clean commit)
- KISS summary generation (Haiku distills "next time, just do X" from the messy journey)
- Path as first-class graph entity (connected to files, decisions, problems touched along the way)
- MCP tools for explicit control (path start/resolve/show) and querying past paths
- D3 graph overlay for visualizing breadcrumb trails on the knowledge graph
- Multi-layer path dimensions (logical, programmatic, development)

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

- [ ] Automatic debug session detection from error/failure patterns
- [ ] Automatic waypoint capture from PostToolUse activity stream
- [ ] Automatic resolution detection and path closure
- [ ] KISS summary generation via Haiku on path resolution
- [ ] Path as first-class graph entity with typed relationships
- [ ] MCP tools: path start, path resolve, path show
- [ ] D3 graph breadcrumb trail overlay
- [ ] Multi-layer path dimensions (logical, programmatic, development)

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

## Context

Shipped through v2.1 with 18 phases, 55 plans total. Tech stack: Node.js + TypeScript + SQLite (WAL + FTS5 + sqlite-vec) + Hono web server + D3/vanilla JS UI. All observation enrichment (entity extraction, relationship inference, classification) now flows through Haiku AI via Claude Agent SDK V2 session API — no separate API key required.

v2.2 insight: During debugging, developers accumulate layers of attempted fixes — patches on patches — and the final codebase carries cruft even when the actual solution was simple. The principle: the knowledge graph gets the full story (every attempt, failure, reasoning), the codebase gets only the KISS result. Debug paths are first-class memory artifacts, not throwaway noise. This extends Laminark's core value ("you never lose context") to the debugging journey itself.

Key constraint: path detection and waypoint capture must be fully automatic ("vibe tool"). Errors during any task constitute debugging — not just explicit debug sessions. Haiku analyzes the PostToolUse stream to detect patterns: repeated failures, reverts, approach changes, resolution.

---
*Last updated: 2026-02-14 after v2.2 milestone start*
