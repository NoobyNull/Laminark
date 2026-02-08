---
created: 2026-02-08T19:32:34.157Z
title: Add debug logging for all interactions
area: general
files: []
---

## Problem

When debugging Laminark, there is no way to see what the plugin is doing internally. All interactions — MCP tool calls, database operations, hook events, observation writes, search queries, FTS5 results — should be loggable when a debug flag is enabled. Without this, diagnosing issues in production requires guesswork.

This applies across all phases: storage operations (Phase 1), MCP tool handling (Phase 2), hook capture (Phase 3), embedding generation (Phase 4), topic detection (Phase 6), etc.

## Solution

Add a debug/verbose logging system that:
- Is controlled by a config flag (e.g., `~/.laminark/config.json` → `"debug": true`) or environment variable (`LAMINARK_DEBUG=1`)
- Logs all MCP tool invocations with arguments and results
- Logs all database operations (queries, inserts, migrations)
- Logs hook events as they're received
- Logs search queries with result counts and timing
- Writes to a log file (e.g., `~/.laminark/debug.log`) or stderr
- Is silent by default — zero output when debug is off

Consider adding this as a cross-cutting concern early, so all phases can use it from the start.
