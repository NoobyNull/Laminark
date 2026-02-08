# Laminark

## What This Is

A Claude Code plugin that gives Claude persistent, adaptive memory across sessions. It's the ground-up rebuild of Engram — same mission (Claude never forgets), but lightweight, fast, and with rich visual memory exploration. Built for the way people actually think — scattered, nonlinear, and constantly branching.

## Core Value

You never lose context. No matter how many tangents, topic jumps, or scattered sessions, every thread is recoverable and every thought is findable.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Persistent memory storage across Claude Code sessions
- [ ] Automatic observation capture via SDK hooks (PostToolUse, SessionStart, SessionEnd, etc.)
- [ ] Adaptive topic shift detection that learns per-user, per-session thresholds
- [ ] Silent context stashing when topic drift exceeds adaptive threshold
- [ ] User notification when context has been stashed with option to return
- [ ] Real-time semantic analysis during Claude's response generation (zero added latency)
- [ ] Pluggable embedding strategy (local model, Claude piggyback, hybrid)
- [ ] MCP tools for memory search, save, timeline, retrieval, and management
- [ ] Hybrid search (FTS5 keyword + vector semantic)
- [ ] Knowledge graph with typed relationships between all memory entities
- [ ] Web UI with interactive knowledge graph visualization (all entity types as nodes)
- [ ] Web UI with timeline view showing conversation flow and topic shifts
- [ ] Slash commands for user-facing memory operations (/remember, /recall, /stash, /resume)
- [ ] Session-aware concurrency (multiple Claude sessions, no cross-contamination)
- [ ] Crash recovery with write-ahead journaling

### Out of Scope

- Mobile app — web UI on localhost is sufficient
- Cloud sync — local-first, single machine
- Multi-user — this is a personal developer tool
- Electron/Tauri desktop wrapper — browser-based web UI keeps it simple
- Integration with non-Claude AI tools — Claude Code plugin only

## Context

Engram (v1) proved the concept works and hit #1 on GitHub. But it was too heavy — too many dependencies, slow startup, embedding overhead that blocked the user experience. The core insight for Laminark: do semantic processing during time the user is already waiting (while Claude generates responses), making the memory layer effectively invisible from a performance perspective.

The target user is a developer with ADHD-like working patterns — jumping between topics frequently, not always staying on track. The system must adapt to this rather than fight it. Some days you're laser-focused, some days you're scattered. The adaptive threshold learns this per-session rather than using a static cutoff.

Engram's architecture (SQLite + WAL, FTS5, sqlite-vec, fastembed, MCP stdio) was sound. The issues were in implementation weight and overhead, not fundamental design choices.

## Constraints

- **Deployment**: Claude Code plugin (hooks + MCP server) — must work within plugin lifecycle
- **Performance**: Zero perceptible latency added to user workflow — all analysis happens in parallel
- **Dependencies**: Minimal — Node.js + SQLite. No Python, no Bun, no heavyweight ML frameworks
- **Storage**: SQLite with WAL mode — single file, no external database servers
- **Embeddings**: Must support multiple strategies (local ONNX, Claude extraction, hybrid) — no single point of failure

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Rebuild from scratch (not fork Engram) | Engram's weight problems are architectural, not patchable | — Pending |
| Adaptive per-user topic thresholds | Static thresholds fail for ADHD/variable focus patterns | — Pending |
| Pluggable embedding strategy | Different environments need different tradeoffs (speed vs quality vs cost) | — Pending |
| SQLite + WAL + FTS5 + sqlite-vec | Proven in Engram, sound fundamentals — keep what works | — Pending |
| Local web server for visualization | Keeps it simple, no native app overhead, browser is universal | — Pending |
| Process semantics during response generation | "Free" computation — user is already waiting for Claude | — Pending |

---
*Last updated: 2026-02-08 after initialization*
