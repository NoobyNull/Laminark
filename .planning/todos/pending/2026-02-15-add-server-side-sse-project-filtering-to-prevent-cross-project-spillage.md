---
created: 2026-02-15T07:56:02.507Z
title: Add server-side SSE project filtering to prevent cross-project spillage
area: sse
files:
  - src/web/routes/sse.ts
  - src/intelligence/haiku-processor.ts:211-218
  - src/index.ts:174-179
  - plugin/ui/app.js:1481-1501
---

## Problem

Cross-project memory spillage keeps recurring in the graph UI. While client-side filtering has been tightened (strict projectHash matching, batch queue clearing on project switch), the SSE server broadcasts ALL events to ALL connected clients regardless of project. The ring buffer replay on reconnection also replays events from all projects.

This means every client must independently filter out events from other projects, and any gap in client-side filtering (new event types, edge cases) causes spillage. The current architecture is "broadcast everything, filter on client" which is fragile.

Observed: momentary cross-project data appearing in graph during SSE reconnection or rapid event bursts.

## Solution

Add server-side project filtering to the SSE endpoint:

1. Accept `project` query param on `/api/sse?project=<hash>` connection
2. Store the project hash on the `SSEClient` interface
3. In `broadcast()`, only send events to clients whose project matches the event's projectHash
4. Ring buffer replay should also filter by project
5. Events without projectHash (heartbeat, connected) go to all clients

This eliminates the entire class of client-side filtering bugs by ensuring clients only receive events for their selected project.
