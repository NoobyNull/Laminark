/**
 * Laminark Help tab -- in-app documentation for MCP tools,
 * knowledge graph concepts, UI features, and keyboard shortcuts.
 */

(function () {
  function renderHelp() {
    var container = document.getElementById('help-content');
    if (!container) return;

    container.innerHTML = '';

    // -----------------------------------------------------------------------
    // Section 1: Getting Started
    // -----------------------------------------------------------------------
    var startSection = document.createElement('div');
    startSection.className = 'help-section';

    var startTitle = document.createElement('h2');
    startTitle.className = 'help-section-title';
    startTitle.textContent = 'Getting Started';
    startSection.appendChild(startTitle);

    var startIntro = document.createElement('p');
    startIntro.className = 'help-intro';
    startIntro.textContent =
      'Laminark is a persistent adaptive memory system for Claude Code. ' +
      'It automatically captures observations during your coding sessions ' +
      'and builds a knowledge graph of entities and relationships across your projects.';
    startSection.appendChild(startIntro);

    container.appendChild(startSection);

    // -----------------------------------------------------------------------
    // Section 2: MCP Tools
    // -----------------------------------------------------------------------
    var toolsSection = document.createElement('div');
    toolsSection.className = 'help-section';

    var toolsTitle = document.createElement('h2');
    toolsTitle.className = 'help-section-title';
    toolsTitle.textContent = 'MCP Tools';
    toolsSection.appendChild(toolsTitle);

    var tools = [
      { name: 'save_memory', desc: 'Save a new memory observation. Provide text content and an optional title.' },
      { name: 'recall', desc: 'Search, view, purge, or restore memories. Search first to find matches, then act on specific results by ID.' },
      { name: 'topic_context', desc: 'Shows recently stashed context threads. Use when asked \'where was I?\' or to see abandoned conversation threads.' },
      { name: 'query_graph', desc: 'Query the knowledge graph to find entities and relationships. Answer questions like \'what files does this decision affect?\'' },
      { name: 'graph_stats', desc: 'Get knowledge graph statistics: entity counts, relationship distribution, health metrics.' },
      { name: 'status', desc: 'Show Laminark system status: connection info, memory count, token estimates, and capabilities.' },
      { name: 'discover_tools', desc: 'Search the tool registry to find available tools by keyword or description. Supports semantic search.' },
      { name: 'report_available_tools', desc: 'Register all tools available in this session with Laminark. Call once at session start.' },
    ];

    var toolsGrid = document.createElement('div');
    toolsGrid.className = 'help-cards';

    tools.forEach(function (tool) {
      var card = document.createElement('div');
      card.className = 'help-card';

      var name = document.createElement('div');
      name.className = 'help-card-name';
      name.textContent = tool.name;
      card.appendChild(name);

      var desc = document.createElement('div');
      desc.className = 'help-card-desc';
      desc.textContent = tool.desc;
      card.appendChild(desc);

      toolsGrid.appendChild(card);
    });

    toolsSection.appendChild(toolsGrid);
    container.appendChild(toolsSection);

    // -----------------------------------------------------------------------
    // Section 3: Knowledge Graph
    // -----------------------------------------------------------------------
    var graphSection = document.createElement('div');
    graphSection.className = 'help-section';

    var graphTitle = document.createElement('h2');
    graphTitle.className = 'help-section-title';
    graphTitle.textContent = 'Knowledge Graph';
    graphSection.appendChild(graphTitle);

    var entities = [
      { name: 'Project', color: '#58a6ff', desc: 'Represents a codebase or project workspace.' },
      { name: 'File', color: '#7ee787', desc: 'Source files, configs, or other project files.' },
      { name: 'Decision', color: '#d2a8ff', desc: 'Architectural or implementation decisions made during development.' },
      { name: 'Problem', color: '#f85149', desc: 'Issues, bugs, or challenges encountered.' },
      { name: 'Solution', color: '#3fb950', desc: 'Fixes, workarounds, or approaches that resolved problems.' },
      { name: 'Reference', color: '#f0883e', desc: 'External docs, libraries, APIs, or resources referenced.' },
    ];

    var entityList = document.createElement('div');
    entityList.className = 'help-entity-list';

    entities.forEach(function (entity) {
      var item = document.createElement('div');
      item.className = 'help-entity-item';

      var dot = document.createElement('span');
      dot.className = 'help-entity-dot';
      dot.style.background = entity.color;
      item.appendChild(dot);

      var name = document.createElement('span');
      name.className = 'help-entity-name';
      name.textContent = entity.name;
      item.appendChild(name);

      var desc = document.createElement('span');
      desc.className = 'help-entity-desc';
      desc.textContent = entity.desc;
      item.appendChild(desc);

      entityList.appendChild(item);
    });

    graphSection.appendChild(entityList);
    container.appendChild(graphSection);

    // -----------------------------------------------------------------------
    // Section 4: UI Guide
    // -----------------------------------------------------------------------
    var uiSection = document.createElement('div');
    uiSection.className = 'help-section';

    var uiTitle = document.createElement('h2');
    uiTitle.className = 'help-section-title';
    uiTitle.textContent = 'UI Guide';
    uiSection.appendChild(uiTitle);

    var tabs = [
      {
        name: 'Knowledge Graph',
        desc: 'Interactive visualization of entities and their relationships. Click nodes for details, use filters to focus on specific entity types, search to find nodes, and use layout buttons to change the graph arrangement.',
      },
      {
        name: 'Timeline',
        desc: 'Chronological view of sessions and observations. Shows when memories were captured and topic shifts detected.',
      },
      {
        name: 'Activity',
        desc: 'Live feed of real-time events from Laminark via SSE (Server-Sent Events). Shows new observations, entity updates, and session events as they happen.',
      },
      {
        name: 'Settings',
        desc: 'Database statistics and danger zone for resetting data. View counts of observations, graph nodes, sessions, etc.',
      },
    ];

    tabs.forEach(function (tab) {
      var item = document.createElement('div');
      item.className = 'help-tab-item';

      var name = document.createElement('div');
      name.className = 'help-tab-name';
      name.textContent = tab.name;
      item.appendChild(name);

      var desc = document.createElement('div');
      desc.className = 'help-tab-desc';
      desc.textContent = tab.desc;
      item.appendChild(desc);

      uiSection.appendChild(item);
    });

    container.appendChild(uiSection);

    // -----------------------------------------------------------------------
    // Section 5: Keyboard Shortcuts
    // -----------------------------------------------------------------------
    var kbSection = document.createElement('div');
    kbSection.className = 'help-section';

    var kbTitle = document.createElement('h2');
    kbTitle.className = 'help-section-title';
    kbTitle.textContent = 'Keyboard Shortcuts';
    kbSection.appendChild(kbTitle);

    var shortcuts = [
      { keys: ['Ctrl', 'Shift', 'P'], desc: 'Toggle performance overlay (graph view)' },
      { keys: ['Escape'], desc: 'Close detail panel / cancel dialog' },
      { keys: ['Enter'], desc: 'Trigger server-side search (graph search input)' },
      { keys: ['Arrow keys'], desc: 'Navigate search results dropdown' },
    ];

    var table = document.createElement('table');
    table.className = 'help-shortcuts';

    shortcuts.forEach(function (sc) {
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

    kbSection.appendChild(table);
    container.appendChild(kbSection);
  }

  // Auto-render when DOM is ready (help.js loads after app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderHelp);
  } else {
    renderHelp();
  }
})();
