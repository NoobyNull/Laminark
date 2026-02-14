---
created: 2026-02-14T18:11:02.655Z
title: Add toggle to hide edge type labels on graph
area: ui
files:
  - ui/graph.js
  - ui/index.html
  - ui/styles.css
---

## Problem

The knowledge graph visualization displays edge type labels (related_to, modifies, references, verified_by, etc.) on every edge. With many edges visible, this creates significant visual clutter and makes the graph harder to read. There is currently no way to hide these labels.

## Solution

Add a toggle button (in the graph toolbar area, near layout selector) that shows/hides edge type labels. Likely implementation:
- Toggle button in `.graph-toolbar` (eye icon or similar)
- Toggles visibility of `edgeLabelsGroup` (already exists as a layer group in graph.js)
- Persist preference in localStorage (like `laminark-layout`)
- Default: labels visible (current behavior)
- Could also integrate with the existing LOD system (labels already hidden at zoom < 0.5)
