---
phase: quick-2
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - ui/index.html
  - ui/app.js
  - ui/help.js
  - ui/styles.css
autonomous: true
must_haves:
  truths:
    - "User can click a Help tab in the nav bar to see help content"
    - "Help view displays sections covering MCP tools, knowledge graph concepts, UI features, and keyboard shortcuts"
    - "Help tab integrates seamlessly with the existing dark theme and tab navigation"
  artifacts:
    - path: "ui/help.js"
      provides: "Help content rendering"
      min_lines: 30
    - path: "ui/index.html"
      provides: "Help tab button and help-view container"
      contains: "help-view"
    - path: "ui/styles.css"
      provides: "Help view styling"
      contains: "help-section"
  key_links:
    - from: "ui/index.html"
      to: "ui/app.js"
      via: "data-view='help-view' tab navigation"
      pattern: "help-view"
    - from: "ui/index.html"
      to: "ui/help.js"
      via: "script tag loads help module"
      pattern: "help.js"
---

<objective>
Add a Help tab to the Laminark web GUI that provides users with documentation about MCP tools, knowledge graph concepts, UI navigation, and keyboard shortcuts.

Purpose: Users currently have no in-app guidance on what Laminark does or how to use it. A Help tab provides immediate, contextual documentation without leaving the GUI.
Output: New Help tab with styled documentation sections integrated into the existing tab navigation.
</objective>

<execution_context>
@.planning/quick/2-add-in-a-help-section-to-the-laminark-gu/2-PLAN.md
</execution_context>

<context>
@ui/index.html
@ui/app.js
@ui/styles.css
@ui/settings.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add Help tab to HTML and wire up navigation</name>
  <files>ui/index.html, ui/app.js</files>
  <action>
In ui/index.html:
1. Add a new nav tab button after the Settings tab button inside `.nav-tabs`:
   `<button class="nav-tab" data-view="help-view">Help</button>`

2. Add a new view container inside `<main id="main-content">` after the settings-view div (before the closing `</main>` tag):
```html
<div id="help-view" class="view-container">
  <div class="help-container" id="help-content">
    <p class="empty-state">Loading help...</p>
  </div>
</div>
```

3. Add the help.js script tag before the closing `</body>`, after settings.js:
   `<script src="/help.js"></script>`

In ui/app.js:
- The existing `initNavigation()` function already handles tab switching generically via `.nav-tab` buttons and `.view-container` elements using `data-view` attributes. It will automatically work for the new help-view tab. No changes needed to app.js navigation logic.
- However, add the help-view to the `no-bars` logic: the filter bar and time range bar should be hidden for help-view (same as settings/timeline/activity). This is already handled by the `isGraph` check -- only graph-view shows the bars. So NO changes to app.js are needed.
  </action>
  <verify>Open ui/index.html in a browser at localhost:37820. The Help tab should appear in the nav bar. Clicking it should show the help-view container and hide other views. The filter bar and time range bar should be hidden when Help is active.</verify>
  <done>Help tab button visible in nav bar, clicking it activates help-view and hides other views, filter/time bars hidden.</done>
</task>

<task type="auto">
  <name>Task 2: Create help.js with documentation content and styles</name>
  <files>ui/help.js, ui/styles.css</files>
  <action>
Create ui/help.js as a self-contained IIFE (following the same pattern as settings.js) that renders help documentation into the `#help-content` container.

The help content should be organized into collapsible sections using the following structure. Build all content via DOM createElement (matching existing patterns in app.js -- no innerHTML with user content, though static help content is fine to use innerHTML for since it's all developer-controlled strings).

**Sections to include:**

1. **Getting Started** - Brief overview paragraph: "Laminark is a persistent adaptive memory system for Claude Code. It automatically captures observations during your coding sessions and builds a knowledge graph of entities and relationships across your projects."

2. **MCP Tools** - A card grid (reuse the existing settings card-like styling) listing each tool with name and description:
   - **save_memory** - "Save a new memory observation. Provide text content and an optional title."
   - **recall** - "Search, view, purge, or restore memories. Search first to find matches, then act on specific results by ID."
   - **topic_context** - "Shows recently stashed context threads. Use when asked 'where was I?' or to see abandoned conversation threads."
   - **query_graph** - "Query the knowledge graph to find entities and relationships. Answer questions like 'what files does this decision affect?'"
   - **graph_stats** - "Get knowledge graph statistics: entity counts, relationship distribution, health metrics."
   - **status** - "Show Laminark system status: connection info, memory count, token estimates, and capabilities."
   - **discover_tools** - "Search the tool registry to find available tools by keyword or description. Supports semantic search."
   - **report_available_tools** - "Register all tools available in this session with Laminark. Call once at session start."

3. **Knowledge Graph** - Explain entity types with their color dots (reuse the legend color styles):
   - **Project** (blue #58a6ff) - "Represents a codebase or project workspace."
   - **File** (green #7ee787) - "Source files, configs, or other project files."
   - **Decision** (purple #d2a8ff) - "Architectural or implementation decisions made during development."
   - **Problem** (red #f85149) - "Issues, bugs, or challenges encountered."
   - **Solution** (green #3fb950) - "Fixes, workarounds, or approaches that resolved problems."
   - **Reference** (orange #f0883e) - "External docs, libraries, APIs, or resources referenced."

4. **UI Guide** - Brief descriptions of each tab:
   - **Knowledge Graph** - "Interactive visualization of entities and their relationships. Click nodes for details, use filters to focus on specific entity types, search to find nodes, and use layout buttons to change the graph arrangement."
   - **Timeline** - "Chronological view of sessions and observations. Shows when memories were captured and topic shifts detected."
   - **Activity** - "Live feed of real-time events from Laminark via SSE (Server-Sent Events). Shows new observations, entity updates, and session events as they happen."
   - **Settings** - "Database statistics and danger zone for resetting data. View counts of observations, graph nodes, sessions, etc."

5. **Keyboard Shortcuts** - A two-column table:
   - `Ctrl+Shift+P` - "Toggle performance overlay (graph view)"
   - `Escape` - "Close detail panel / cancel dialog"
   - `Enter` - "Trigger server-side search (graph search input)"
   - `Arrow keys` - "Navigate search results dropdown"

**Implementation pattern:**

```javascript
(function () {
  function renderHelp() {
    var container = document.getElementById('help-content');
    if (!container) return;
    container.innerHTML = '';
    // Build sections using DOM or innerHTML (static content is safe)
    // Use a single large innerHTML build for simplicity since all content is static developer-controlled strings
  }

  // Auto-render when DOM is ready (help.js loads after app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderHelp);
  } else {
    renderHelp();
  }
})();
```

Each section should use a `<div class="help-section">` with an `<h2 class="help-section-title">` header and content below. Tool cards should use a grid layout similar to `.db-stats-grid` but with left-aligned text. The keyboard shortcuts should use a simple definition-list or table layout with `<kbd>` elements for keys.

**Add styles to ui/styles.css** at the end of the file:

```css
/* Help view */
#help-view {
  overflow-y: auto;
}

.help-container {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px;
}

.help-section {
  margin-bottom: 32px;
}

.help-section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.help-intro {
  font-size: 13px;
  color: var(--text);
  line-height: 1.6;
  margin-bottom: 16px;
}

.help-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 10px;
}

.help-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}

.help-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  margin-bottom: 4px;
}

.help-card-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.help-entity-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.help-entity-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.help-entity-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.help-entity-name {
  font-weight: 600;
  color: var(--text);
  min-width: 70px;
}

.help-entity-desc {
  color: var(--text-muted);
}

.help-shortcuts {
  width: 100%;
  border-collapse: collapse;
}

.help-shortcuts td {
  padding: 6px 8px;
  font-size: 13px;
  border-bottom: 1px solid rgba(48, 54, 61, 0.5);
}

.help-shortcuts td:first-child {
  white-space: nowrap;
  width: 180px;
}

.help-shortcuts td:last-child {
  color: var(--text-muted);
}

.help-shortcuts kbd {
  display: inline-block;
  padding: 2px 6px;
  font-size: 11px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.help-tab-item {
  margin-bottom: 10px;
}

.help-tab-name {
  font-weight: 600;
  color: var(--text);
  font-size: 13px;
  margin-bottom: 2px;
}

.help-tab-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}
```
  </action>
  <verify>
1. Run `ls -la /data/Laminark/ui/help.js` to confirm the file exists.
2. Open localhost:37820 in a browser, click the Help tab. Verify all 5 sections render with proper styling: Getting Started, MCP Tools (8 tool cards), Knowledge Graph (6 entity types with colored dots), UI Guide (4 tab descriptions), Keyboard Shortcuts (table with kbd elements).
3. Verify the help view scrolls properly and matches the dark theme.
  </verify>
  <done>Help tab shows complete documentation with 5 sections. Tool cards display in a responsive grid. Entity types show with correct color dots. Keyboard shortcuts render with styled kbd elements. All content matches the existing dark theme.</done>
</task>

</tasks>

<verification>
- Help tab appears in nav bar between Settings and the status indicator
- Clicking Help tab shows the help view and hides other views
- Filter bar and time range bar are hidden when Help is active
- All 5 help sections render with correct content
- Styling matches existing dark theme (colors, fonts, spacing)
- Help view scrolls properly for content overflow
- No JavaScript errors in console
- Existing tabs (Knowledge Graph, Timeline, Activity, Settings) still work correctly
</verification>

<success_criteria>
- Help tab is accessible from the main navigation
- Help content covers: MCP tools (8), entity types (6), UI features (4 tabs), keyboard shortcuts
- Visual styling is consistent with existing dark theme
- No regressions to existing tab functionality
</success_criteria>

<output>
After completion, create `.planning/quick/2-add-in-a-help-section-to-the-laminark-gu/2-SUMMARY.md`
</output>
