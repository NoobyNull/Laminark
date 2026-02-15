/**
 * Laminark Help tab — comprehensive in-app documentation.
 *
 * Data-driven: all content defined as structured sections, auto-generates
 * table of contents, supports search filtering, and cross-links between
 * sections via smooth-scroll anchors.
 */

(function () {
  // -----------------------------------------------------------------------
  // Section data
  // -----------------------------------------------------------------------

  var SECTIONS = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      blocks: [
        {
          type: 'text',
          content:
            'Laminark is a persistent adaptive memory system for Claude Code. ' +
            'It automatically captures observations during your coding sessions ' +
            'via hooks (PostToolUse, SessionStart, etc.), classifies them with ' +
            'Haiku AI, extracts entities and relationships into a knowledge graph, ' +
            'and streams live updates over SSE.',
        },
        {
          type: 'list',
          items: [
            'Observations are captured automatically — no manual tagging needed.',
            'Haiku classifies each observation by kind: change, finding, decision, reference, or verification.',
            'Graph extraction identifies entities (Project, File, Decision, Problem, Solution, Reference) and their relationships.',
            'Topic detection uses EWMA to identify conversation shifts.',
            'All data is project-scoped — switch projects via the selector in the nav bar.',
          ],
        },
        {
          type: 'tip',
          content:
            '<strong>Tip:</strong> Use the project selector in the top navigation bar to switch between projects. Each project maintains its own memory, graph, and timeline.',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'knowledge-graph', label: 'Knowledge Graph' },
            { target: 'mcp-tools', label: 'MCP Tools' },
          ],
        },
      ],
    },
    {
      id: 'knowledge-graph',
      title: 'Knowledge Graph',
      blocks: [
        {
          type: 'text',
          content:
            'The knowledge graph visualizes entities extracted from your observations and ' +
            'the relationships between them. Nodes are sized by observation count and degree ' +
            '(number of connections). Edges are colored by relationship type.',
        },
        {
          type: 'subsection',
          title: 'Entity Types',
        },
        {
          type: 'cards',
          items: [
            { name: 'Project', desc: 'Represents a codebase or project workspace.', color: '#58a6ff' },
            { name: 'File', desc: 'Source files, configs, or other project files.', color: '#3fb950' },
            { name: 'Decision', desc: 'Architectural or implementation decisions.', color: '#d29922' },
            { name: 'Problem', desc: 'Issues, bugs, or challenges encountered.', color: '#f85149' },
            { name: 'Solution', desc: 'Fixes, workarounds, or approaches that resolved problems.', color: '#a371f7' },
            { name: 'Reference', desc: 'External docs, libraries, APIs, or resources.', color: '#f0883e' },
          ],
        },
        {
          type: 'subsection',
          title: 'Relationship Types',
        },
        {
          type: 'table',
          rows: [
            ['related_to', 'General association between entities'],
            ['solved_by', 'Problem resolved by a Solution'],
            ['caused_by', 'Problem caused by another entity'],
            ['modifies', 'Decision or Solution that modifies a File'],
            ['informed_by', 'Decision informed by a Reference'],
            ['references', 'Entity references another entity'],
            ['verified_by', 'Change verified by a verification observation'],
            ['preceded_by', 'Temporal ordering between entities'],
          ],
        },
        {
          type: 'img',
          src: 'help/graph-view.png',
          caption: 'Knowledge graph showing entities and relationships',
        },
        {
          type: 'tip',
          content:
            '<strong>Tip:</strong> Node size reflects importance — larger nodes have more observations and connections. Hover over any node for a tooltip with details.',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'graph-interactions', label: 'Graph Interactions' },
            { target: 'graph-toolbar', label: 'Graph Toolbar' },
          ],
        },
      ],
    },
    {
      id: 'graph-interactions',
      title: 'Graph Interactions',
      blocks: [
        {
          type: 'text',
          content:
            'The graph is fully interactive. Click, drag, pan, and zoom to explore your knowledge.',
        },
        {
          type: 'list',
          items: [
            'Click a node to select it and open the detail panel with observations and relationships.',
            'Drag nodes to reposition them. The simulation will adjust.',
            'Pan by clicking and dragging the background.',
            'Zoom with the mouse wheel or trackpad.',
            'Right-click a node for a context menu with Focus, Find Path, and Details options.',
            'Click a relationship in the detail panel to navigate to the connected node.',
          ],
        },
        {
          type: 'subsection',
          title: 'Detail Panel',
        },
        {
          type: 'text',
          content:
            'When you click a node, the detail panel slides in from the right showing the entity type, ' +
            'creation date, a scrollable list of observations, and all relationships. Click any ' +
            'relationship to navigate to the connected node.',
        },
        {
          type: 'subsection',
          title: 'Focus Mode',
        },
        {
          type: 'text',
          content:
            'Focus mode zooms into a single node and its immediate neighbors. A breadcrumb bar ' +
            'appears at the top showing your navigation path. Click any breadcrumb to go back. ' +
            'Use the focus button in the detail panel or right-click context menu to enter focus mode.',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'graph-toolbar', label: 'Graph Toolbar' },
            { target: 'keyboard-shortcuts', label: 'Keyboard Shortcuts' },
          ],
        },
      ],
    },
    {
      id: 'graph-toolbar',
      title: 'Graph Toolbar',
      blocks: [
        {
          type: 'text',
          content:
            'The toolbar in the top-right corner of the graph view provides layout and analysis controls.',
        },
        {
          type: 'subsection',
          title: 'Layout Modes',
        },
        {
          type: 'table',
          rows: [
            ['Clustered', 'Force-directed layout grouping related nodes together (default)'],
            ['Hierarchical', 'Top-down tree layout organized by entity relationships'],
            ['Concentric', 'Radial layout with most-connected nodes at the center'],
            ['Communities', 'Detects and separates graph communities into distinct clusters'],
          ],
        },
        {
          type: 'subsection',
          title: 'Toolbar Buttons',
        },
        {
          type: 'list',
          items: [
            'Edge Labels — Toggle edge relationship labels on/off. Use the dropdown to show/hide specific relationship types.',
            'Pathfinder — Find the shortest path between two nodes. Click two nodes to see the highlighted path.',
            'Analysis — Open the analysis panel showing entity type distribution, relationship stats, top entities by degree, and detected clusters.',
            'Freeze — Pause live graph updates. A stale-data indicator appears when frozen and new data arrives.',
            'Fit to View — Reset zoom and pan to fit all nodes in the viewport.',
          ],
        },
        {
          type: 'subsection',
          title: 'Pathfinder',
        },
        {
          type: 'text',
          content:
            'Activate Pathfinder from the toolbar, then click a start node (green ring) and an end node ' +
            '(red ring). The shortest path is highlighted in orange. Non-path elements are dimmed. ' +
            'Click the Pathfinder button again or press Escape to exit.',
        },
        {
          type: 'img',
          src: 'help/graph-toolbar.png',
          caption: 'Graph toolbar: layout modes, edge labels, pathfinder, analysis, freeze, fit-to-view',
        },
        {
          type: 'img',
          src: 'help/analysis-panel.png',
          caption: 'Analysis panel showing entity types, relationship distribution, top entities, and clusters',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'graph-interactions', label: 'Graph Interactions' },
            { target: 'search-filtering', label: 'Search & Filtering' },
          ],
        },
      ],
    },
    {
      id: 'search-filtering',
      title: 'Search & Filtering',
      blocks: [
        {
          type: 'text',
          content:
            'Filter and search your knowledge graph to find exactly what you need.',
        },
        {
          type: 'subsection',
          title: 'Entity Type Filters',
        },
        {
          type: 'text',
          content:
            'The filter bar below the navigation shows colored pills for each entity type with counts. ' +
            'Click a pill to toggle that type on/off. Click "All" to show/hide everything. ' +
            'Active pills are highlighted with their entity color.',
        },
        {
          type: 'subsection',
          title: 'Time Range',
        },
        {
          type: 'text',
          content:
            'Below the filter bar, time range presets let you focus on recent data: All, Hour, Today, ' +
            'Week, or Month. For custom ranges, set the From/To date inputs and click Apply. ' +
            'Presets filter client-side instantly; custom ranges fetch from the server.',
        },
        {
          type: 'subsection',
          title: 'Search Box',
        },
        {
          type: 'list',
          items: [
            'Type to client-filter — matches are highlighted in the graph as you type.',
            'Press Enter to trigger a server-side full-text search for deeper results.',
            'Use Arrow keys to navigate the results dropdown.',
            'Press Escape to clear the search.',
            'Click a result to select and center that node in the graph.',
          ],
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'knowledge-graph', label: 'Knowledge Graph' },
            { target: 'keyboard-shortcuts', label: 'Keyboard Shortcuts' },
          ],
        },
      ],
    },
    {
      id: 'timeline',
      title: 'Timeline',
      blocks: [
        {
          type: 'text',
          content:
            'The Timeline tab shows a chronological view of your coding sessions and observations. ' +
            'Sessions are grouped as cards along a vertical spine.',
        },
        {
          type: 'list',
          items: [
            'Each session card shows the start time, duration, and observation count.',
            'Click the session header to expand/collapse its observations.',
            'Observations display timestamps, type dots (color-coded by source), and text previews.',
            'Topic shift markers appear between observations when the AI detects a conversation change, with a confidence percentage.',
            'Session summaries (italic text) provide an AI-generated overview of the session.',
            'Infinite scroll pagination loads older sessions as you scroll down.',
            'The "Jump to Today" button in the bottom-right corner scrolls to the most recent session.',
          ],
        },
        {
          type: 'img',
          src: 'help/timeline.png',
          caption: 'Timeline view with sessions, observations, and topic shift markers',
        },
        {
          type: 'tip',
          content:
            '<strong>Tip:</strong> Active sessions show a pulsing green badge. Completed sessions show a blue badge with the observation count.',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'activity-feed', label: 'Activity Feed' },
            { target: 'getting-started', label: 'Getting Started' },
          ],
        },
      ],
    },
    {
      id: 'activity-feed',
      title: 'Activity Feed',
      blocks: [
        {
          type: 'text',
          content:
            'The Activity tab shows a real-time event stream powered by Server-Sent Events (SSE). ' +
            'Events appear with a slide-in animation as they arrive.',
        },
        {
          type: 'subsection',
          title: 'Event Types',
        },
        {
          type: 'table',
          rows: [
            ['Observation', 'New memory observation captured (blue)'],
            ['Entity', 'Knowledge graph entity created or updated (purple)'],
            ['Topic Shift', 'Conversation topic change detected (orange)'],
            ['Session Start', 'New coding session began (green)'],
            ['Session End', 'Coding session ended (gray)'],
          ],
        },
        {
          type: 'list',
          items: [
            'Maximum 100 items are retained in the feed.',
            'Each item shows an icon, event type, description, and timestamp.',
            'Use the Clear button in the header to reset the feed.',
            'Events are project-scoped — only events from the selected project appear.',
          ],
        },
        {
          type: 'img',
          src: 'help/activity-feed.png',
          caption: 'Activity feed showing live SSE events',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'timeline', label: 'Timeline' },
            { target: 'settings', label: 'Settings' },
          ],
        },
      ],
    },
    {
      id: 'settings',
      title: 'Settings',
      blocks: [
        {
          type: 'text',
          content:
            'The Settings tab provides database statistics, configuration controls, and data management.',
        },
        {
          type: 'subsection',
          title: 'Database Statistics',
        },
        {
          type: 'text',
          content:
            'A grid of stat cards shows live metrics for the selected project scope:',
        },
        {
          type: 'table',
          rows: [
            ['Observations', 'Total memory observations stored'],
            ['Embeddings', 'Vector embeddings for semantic search'],
            ['Staleness', 'Percentage of observations without embeddings'],
            ['Graph Nodes', 'Total entities in the knowledge graph'],
            ['Graph Edges', 'Total relationships between entities'],
            ['Sessions', 'Coding sessions recorded'],
            ['Stashes', 'Saved context stashes'],
            ['Topic Shifts', 'Detected topic changes'],
            ['Notifications', 'System notifications generated'],
            ['Projects', 'Total projects tracked'],
          ],
        },
        {
          type: 'subsection',
          title: 'Topic Detection Config',
        },
        {
          type: 'text',
          content:
            'Enable or disable automatic topic detection. Choose sensitivity presets (Low, Medium, High) ' +
            'or fine-tune EWMA parameters: alpha (smoothing factor), threshold, and window size.',
        },
        {
          type: 'subsection',
          title: 'Graph Extraction Config',
        },
        {
          type: 'text',
          content:
            'Configure how entities and relationships are extracted: temporal decay rate, fuzzy dedup ' +
            'similarity threshold, quality gate thresholds for each entity type, and relationship ' +
            'detector sensitivity.',
        },
        {
          type: 'subsection',
          title: 'Danger Zone',
        },
        {
          type: 'text',
          content:
            'Choose a scope (global or current project), then use reset operations to clear specific data. ' +
            'All destructive actions require typing a confirmation phrase.',
        },
        {
          type: 'table',
          rows: [
            ['Reset Observations', 'Delete all observations and embeddings'],
            ['Reset Graph', 'Delete all knowledge graph nodes and edges'],
            ['Reset Sessions', 'Delete all session records and topic shifts'],
            ['Reset Everything', 'Complete data wipe — observations, graph, sessions, and config'],
          ],
        },
        {
          type: 'img',
          src: 'help/settings.png',
          caption: 'Settings view with database statistics, config sections, and danger zone',
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'getting-started', label: 'Getting Started' },
            { target: 'mcp-tools', label: 'MCP Tools' },
          ],
        },
      ],
    },
    {
      id: 'mcp-tools',
      title: 'MCP Tools',
      blocks: [
        {
          type: 'text',
          content:
            'Laminark exposes tools via the Model Context Protocol (MCP) that Claude Code uses ' +
            'to save memories, search knowledge, query the graph, and manage debug paths.',
        },
        {
          type: 'cards',
          items: [
            { name: 'save_memory', desc: 'Save a new memory observation with text content and optional title. Supports kind classification: change, reference, finding, decision, or verification.' },
            { name: 'recall', desc: 'Search, view, purge, or restore memories. Full-text search with detail levels: compact, timeline, or full.' },
            { name: 'topic_context', desc: 'Show recently stashed context threads. Use when asked "where was I?" to resume abandoned work.' },
            { name: 'query_graph', desc: 'Query the knowledge graph for entities and relationships with configurable traversal depth (1-4).' },
            { name: 'graph_stats', desc: 'Get knowledge graph statistics: entity counts, relationship distribution, and health metrics.' },
            { name: 'status', desc: 'Show Laminark system status: connection info, memory count, token estimates, and capabilities.' },
            { name: 'discover_tools', desc: 'Search the tool registry by keyword or description. Supports semantic search across all registered tools.' },
            { name: 'report_available_tools', desc: 'Register all tools available in this session with Laminark for discovery and routing.' },
            { name: 'path_start', desc: 'Start tracking a debug path. Use when actively debugging an issue to record the investigation.' },
            { name: 'path_resolve', desc: 'Resolve the active debug path with a resolution summary. Generates a KISS summary (Problem/Cause/Fix/Prevention).' },
            { name: 'path_show', desc: 'Show a debug path with its waypoints and KISS summary. Omit path ID for the active path.' },
            { name: 'path_list', desc: 'List recent debug paths, optionally filtered by status: active, resolved, or abandoned.' },
          ],
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'getting-started', label: 'Getting Started' },
            { target: 'settings', label: 'Settings' },
          ],
        },
      ],
    },
    {
      id: 'keyboard-shortcuts',
      title: 'Keyboard Shortcuts',
      blocks: [
        {
          type: 'shortcuts',
          items: [
            { keys: ['Ctrl', 'Shift', 'P'], desc: 'Toggle performance overlay (graph view)' },
            { keys: ['Escape'], desc: 'Close detail panel, cancel pathfinder, dismiss dialogs' },
            { keys: ['Enter'], desc: 'Trigger server-side search (in search input)' },
            { keys: ['Arrow Up', 'Arrow Down'], desc: 'Navigate search results dropdown' },
          ],
        },
        {
          type: 'crosslinks',
          links: [
            { target: 'graph-interactions', label: 'Graph Interactions' },
            { target: 'search-filtering', label: 'Search & Filtering' },
          ],
        },
      ],
    },
  ];

  // -----------------------------------------------------------------------
  // Render engine — sidebar tree layout
  // -----------------------------------------------------------------------

  /**
   * Extract subsections from a section's blocks (blocks with type 'subsection').
   */
  function getSubsections(section) {
    var subs = [];
    section.blocks.forEach(function (b) {
      if (b.type === 'subsection') {
        subs.push({ title: b.title, id: section.id + '--' + b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
      }
    });
    return subs;
  }

  var activeSection = null;
  var treeItems = {};
  var contentArea = null;

  /**
   * Build the sidebar tree from SECTIONS.
   */
  function renderSidebar() {
    var sidebar = document.createElement('aside');
    sidebar.className = 'help-sidebar';

    // Search
    var searchDiv = document.createElement('div');
    searchDiv.className = 'help-sidebar-search';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'help-search-input';
    searchInput.placeholder = 'Search...';
    searchDiv.appendChild(searchInput);
    sidebar.appendChild(searchDiv);

    // Tree container
    var treeContainer = document.createElement('div');
    treeContainer.className = 'help-tree-container';
    var tree = document.createElement('ul');
    tree.className = 'help-tree';

    SECTIONS.forEach(function (section) {
      var li = document.createElement('li');
      li.className = 'help-tree-item';
      li.setAttribute('data-section', section.id);

      var subs = getSubsections(section);

      // Label
      var label = document.createElement('span');
      label.className = 'help-tree-label';

      if (subs.length > 0) {
        var toggle = document.createElement('span');
        toggle.className = 'help-tree-toggle';
        toggle.textContent = '\u25B8'; // ▸
        label.appendChild(toggle);
      } else {
        // spacer for alignment
        var spacer = document.createElement('span');
        spacer.style.width = '16px';
        spacer.style.flexShrink = '0';
        label.appendChild(spacer);
      }

      var text = document.createTextNode(section.title);
      label.appendChild(text);
      li.appendChild(label);

      // Children (subsections)
      if (subs.length > 0) {
        var childUl = document.createElement('ul');
        childUl.className = 'help-tree-children';

        subs.forEach(function (sub) {
          var childLi = document.createElement('li');
          var childLabel = document.createElement('span');
          childLabel.className = 'help-tree-child-label';
          childLabel.textContent = sub.title;
          childLabel.addEventListener('click', function (e) {
            e.stopPropagation();
            showSection(section.id);
            // Scroll to subsection after rendering
            setTimeout(function () {
              var el = document.getElementById('help-sub-' + sub.id);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
          });
          childLi.appendChild(childLabel);
          childUl.appendChild(childLi);
        });

        li.appendChild(childUl);
      }

      // Click handler for top-level label
      label.addEventListener('click', function () {
        showSection(section.id);
      });

      treeItems[section.id] = li;
      tree.appendChild(li);
    });

    treeContainer.appendChild(tree);
    sidebar.appendChild(treeContainer);

    // Search filtering
    var debounce = null;
    searchInput.addEventListener('input', function () {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(function () {
        var query = searchInput.value.trim().toLowerCase();
        SECTIONS.forEach(function (section) {
          var li = treeItems[section.id];
          if (!query) {
            li.style.display = '';
            return;
          }
          var text = (section.title + ' ' + getBlocksText(section.blocks)).toLowerCase();
          li.style.display = text.indexOf(query) !== -1 ? '' : 'none';
        });
      }, 150);
    });

    return sidebar;
  }

  /**
   * Show a specific section in the content area. Updates tree active state.
   */
  function showSection(sectionId) {
    if (!contentArea) return;

    // Find section data
    var section = null;
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].id === sectionId) {
        section = SECTIONS[i];
        break;
      }
    }
    if (!section) return;

    activeSection = sectionId;

    // Update tree active states
    Object.keys(treeItems).forEach(function (id) {
      var li = treeItems[id];
      var label = li.querySelector('.help-tree-label');
      if (id === sectionId) {
        label.classList.add('active');
        li.classList.add('expanded');
      } else {
        label.classList.remove('active');
        li.classList.remove('expanded');
      }
    });

    // Render section content
    contentArea.innerHTML = '';
    contentArea.scrollTop = 0;
    var el = renderSection(section);
    contentArea.appendChild(el);
  }

  /**
   * Main entry point: builds layout, renders sidebar + content area.
   */
  function renderHelp() {
    var container = document.getElementById('help-content');
    if (!container) return;

    container.innerHTML = '';

    // Build sidebar
    var sidebar = renderSidebar();
    container.appendChild(sidebar);

    // Build content area
    contentArea = document.createElement('div');
    contentArea.className = 'help-content-area';
    container.appendChild(contentArea);

    // Select first section by default
    if (SECTIONS.length > 0) {
      showSection(SECTIONS[0].id);
    }
  }

  /**
   * Extract all text content from blocks for search matching.
   */
  function getBlocksText(blocks) {
    var parts = [];
    blocks.forEach(function (b) {
      if (b.type === 'text') parts.push(b.content);
      if (b.type === 'tip') parts.push(b.content);
      if (b.type === 'subsection') parts.push(b.title);
      if (b.type === 'list' && b.items) b.items.forEach(function (i) { parts.push(i); });
      if (b.type === 'cards' && b.items) b.items.forEach(function (c) { parts.push(c.name + ' ' + c.desc); });
      if (b.type === 'table' && b.rows) b.rows.forEach(function (r) { parts.push(r.join(' ')); });
      if (b.type === 'shortcuts' && b.items) b.items.forEach(function (s) { parts.push(s.keys.join('+') + ' ' + s.desc); });
    });
    return parts.join(' ');
  }

  /**
   * Render a single section with all its blocks.
   */
  function renderSection(section) {
    var el = document.createElement('div');
    el.className = 'help-section';
    el.id = 'help-' + section.id;

    var title = document.createElement('h2');
    title.className = 'help-section-title';
    title.textContent = section.title;
    el.appendChild(title);

    section.blocks.forEach(function (block) {
      el.appendChild(renderBlock(block));
    });

    return el;
  }

  /**
   * Render a single content block.
   */
  function renderBlock(block) {
    switch (block.type) {
      case 'text': return renderText(block);
      case 'list': return renderList(block);
      case 'cards': return renderCards(block);
      case 'table': return renderTable(block);
      case 'shortcuts': return renderShortcuts(block);
      case 'tip': return renderTip(block);
      case 'subsection': return renderSubsection(block);
      case 'crosslinks': return renderCrosslinks(block);
      case 'img': return renderImage(block);
      default:
        var el = document.createElement('div');
        return el;
    }
  }

  function renderText(block) {
    var p = document.createElement('p');
    p.className = 'help-intro';
    p.textContent = block.content;
    return p;
  }

  function renderList(block) {
    var ul = document.createElement('ul');
    ul.className = 'help-list';
    block.items.forEach(function (item) {
      var li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
    return ul;
  }

  function renderCards(block) {
    var grid = document.createElement('div');
    grid.className = 'help-cards';
    block.items.forEach(function (card) {
      var el = document.createElement('div');
      el.className = 'help-card';

      var name = document.createElement('div');
      name.className = 'help-card-name';
      name.textContent = card.name;
      if (card.color) {
        name.style.borderLeft = '3px solid ' + card.color;
        name.style.paddingLeft = '8px';
      }
      el.appendChild(name);

      var desc = document.createElement('div');
      desc.className = 'help-card-desc';
      desc.textContent = card.desc;
      el.appendChild(desc);

      grid.appendChild(el);
    });
    return grid;
  }

  function renderTable(block) {
    var table = document.createElement('table');
    table.className = 'help-table';
    block.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (cell) {
        var td = document.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    return table;
  }

  function renderShortcuts(block) {
    var table = document.createElement('table');
    table.className = 'help-shortcuts';
    block.items.forEach(function (sc) {
      var row = document.createElement('tr');

      var keyCell = document.createElement('td');
      sc.keys.forEach(function (key, idx) {
        var kbd = document.createElement('kbd');
        kbd.textContent = key;
        keyCell.appendChild(kbd);
        if (idx < sc.keys.length - 1) {
          keyCell.appendChild(document.createTextNode(' + '));
        }
      });
      row.appendChild(keyCell);

      var descCell = document.createElement('td');
      descCell.textContent = sc.desc;
      row.appendChild(descCell);

      table.appendChild(row);
    });
    return table;
  }

  function renderTip(block) {
    var div = document.createElement('div');
    div.className = 'help-tip';
    div.innerHTML = block.content;
    return div;
  }

  function renderSubsection(block) {
    var h3 = document.createElement('h3');
    h3.className = 'help-subsection-title';
    h3.textContent = block.title;
    // Generate an anchor ID for subsection scrolling
    if (activeSection) {
      h3.id = 'help-sub-' + activeSection + '--' + block.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    return h3;
  }

  function renderCrosslinks(block) {
    var div = document.createElement('div');
    div.className = 'help-crosslinks';

    var label = document.createTextNode('See also:');
    div.appendChild(label);

    block.links.forEach(function (link, idx) {
      var a = document.createElement('a');
      a.className = 'help-crosslink';
      a.textContent = link.label;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        showSection(link.target);
      });
      div.appendChild(a);

      if (idx < block.links.length - 1) {
        div.appendChild(document.createTextNode(','));
      }
    });

    return div;
  }

  function renderImage(block) {
    var wrap = document.createElement('div');
    wrap.className = 'help-screenshot';

    var img = document.createElement('img');
    img.src = block.src;
    img.alt = block.caption || '';
    img.loading = 'lazy';
    wrap.appendChild(img);

    if (block.caption) {
      var caption = document.createElement('div');
      caption.className = 'help-screenshot-caption';
      caption.textContent = block.caption;
      wrap.appendChild(caption);
    }

    return wrap;
  }

  // -----------------------------------------------------------------------
  // Auto-render
  // -----------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderHelp);
  } else {
    renderHelp();
  }
})();
