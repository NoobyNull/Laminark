---
created: 2026-02-14T17:53:22.088Z
title: Add PreToolUse hook for proactive context injection
area: hooks
files:
  - src/hooks/handler.ts
  - src/hooks/hooks.json:hooks/hooks.json
  - src/hooks/session-lifecycle.ts
  - src/storage/observations.ts
  - src/graph/schema.ts
  - src/context/injection.ts
---

## Problem

Laminark currently has no `PreToolUse` hook registered. The only synchronous context injection point is `SessionStart`, which fires once at session begin. During active tool use, Laminark is write-only — it captures observations via `PostToolUse` but never proactively surfaces relevant memories, graph entities, or past observations before a tool executes.

This means Claude never gets "here's what Laminark knows about this file/topic" before reading or editing it. The user must explicitly call `recall` or `query_graph` to benefit from stored knowledge.

Key constraints identified during investigation:
- `PreToolUse` is synchronous — stdout is injected into Claude's context window
- Must be FAST (blocks tool execution) — no Haiku calls, no heavy computation
- Should skip noise: no ctime/atime file stats, no tool usage tracking stats
- Should skip self-referential tools (Laminark's own)
- Should skip high-frequency low-value tools unless strong signal exists
- Only inject when there's genuinely relevant context to surface

## Solution

Add a `PreToolUse` entry to `hooks.json` and implement a handler that:

1. Extracts the target (file path, search query, URL) from `tool_input`
2. Searches observations via FTS5 for relevant past context about the target
3. Queries the knowledge graph for entities matching/related to the target
4. Returns a concise context block via stdout (token-budgeted, ~500 chars max)
5. Returns empty string when no relevant context exists (zero overhead)

Filter rules:
- Skip Laminark's own tools (self-referential filter)
- Skip Read/Glob/Grep unless targeting a file with known graph entities
- Focus on Write/Edit (most valuable — "last time this file was changed...")
- Include Bash for build/test commands with prior failure context
- No file metadata (ctime, atime, size) — only semantic observations
- No tool registry stats — only memories and graph relationships
