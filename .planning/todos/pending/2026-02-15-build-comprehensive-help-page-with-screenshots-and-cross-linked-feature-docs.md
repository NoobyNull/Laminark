---
created: 2026-02-15T08:16:10.308Z
title: Build comprehensive help page with screenshots and cross-linked feature docs
area: ui
files:
  - plugin/ui/help.js
  - plugin/ui/index.html
  - plugin/ui/styles.css
---

## Problem

The current Help page in the Laminark UI is minimal. Users need comprehensive documentation covering all features, with visual examples showing how each feature works in practice. The help content should be self-contained within the UI (no external docs site), searchable, indexed, and cross-linked so users can navigate between related features.

## Solution

Build an extensive Help page within the existing Laminark UI:

1. **Content coverage** — Document every feature:
   - Knowledge Graph (nodes, edges, entity types, layouts, focus mode, pathfinder, freeze/sync, edge labels, analysis panel, search)
   - Timeline (sessions, observations, topic shifts, time filtering, pagination)
   - Activity feed (live events, event types, clearing)
   - Settings (topic detection config, graph extraction config, danger zone)
   - Project switching and multi-project isolation
   - SSE connection status and reconnection
   - Debug paths (path overlay, path details, KISS summaries)
   - Node details panel (focus mode, observation counts)

2. **Screenshots** — Use Playwright MCP to capture live screenshots of each feature in action, using the Laminark project's own data as the guinea pig. Save as static assets in `plugin/ui/help/` or inline as base64.

3. **Structure** —
   - Table of contents / index at the top
   - Sections with anchor IDs for deep linking
   - Search/filter box to find features by keyword
   - Cross-links between related features (e.g., "See also: Graph Freeze" from the Pathfinder section)
   - Keyboard shortcut reference if applicable

4. **Implementation** — Extend `help.js` to render structured documentation with sections, images, search filtering, and smooth-scroll navigation. Style to match the existing dark theme.
