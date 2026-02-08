---
created: 2026-02-08T18:48:21.049Z
title: Add cross-project memory sharing between Claude instances
area: database
files: []
---

## Problem

Multiple Claude Code instances running across different projects and different sessions need to write to memory synchronously and share context across project boundaries. The current Phase 1 design enforces strict project isolation via `project_hash` — observations from project A are never visible when querying from project B. This is correct for the default case, but there are real scenarios where cross-project memory sharing is needed:

- A user working on multiple related projects (e.g., a frontend and backend repo) wants shared context about architecture decisions, deployment notes, or cross-cutting concerns.
- Multiple Claude sessions running in parallel on the same or different projects need to see each other's observations in near-real-time.
- A "workspace" concept where several projects are grouped and share a memory pool.

This is a new capability — not a modification of the existing project isolation guarantee. Project-scoped memory should remain the default; cross-project sharing would be opt-in.

## Solution

TBD — needs design discussion. Possible approaches:

1. **Global observations:** A special `project_hash` value (e.g., `"global"`) that is always included in queries regardless of project scope.
2. **Workspace groups:** A config-defined set of project paths that share a "workspace ID" added as an additional query dimension.
3. **Cross-project query tool:** A separate MCP tool that explicitly searches across all projects (distinct from the default project-scoped search).
4. **Shared tags/channels:** Observations can be tagged with a "channel" that spans projects — queries can opt into channel-scoped results.

Concurrent write safety is already handled by WAL + busy_timeout (Phase 1), so multiple instances writing simultaneously is architecturally supported. The main design question is the query/visibility model.
