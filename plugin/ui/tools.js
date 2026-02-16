/**
 * Laminark Tool Topology Visualization (D3.js)
 *
 * Force-directed graph of tool relationships clustered by server/plugin.
 * Nodes sized by usage, edges from routing patterns and session co-occurrence.
 *
 * @module tools
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var initialized = false;
  var svg, svgGroup, simulation;
  var toolNodes = [];
  var flowEdges = [];
  var clusterHulls = [];
  var showClusters = true;
  var currentLayout = 'force';
  var filterType = '';
  var filterServer = '';
  var selectedTool = null;

  // Color palette for server clusters
  var CLUSTER_COLORS = [
    '#58a6ff', '#3fb950', '#d2a8ff', '#f0883e', '#f85149',
    '#79c0ff', '#d29922', '#7ee787', '#f778ba', '#a5d6ff',
  ];

  // Tool type shapes (map to D3 symbols)
  var TOOL_TYPE_ICONS = {
    mcp_server: d3.symbolSquare,
    mcp_tool: d3.symbolCircle,
    slash_command: d3.symbolDiamond,
    skill: d3.symbolStar,
    plugin: d3.symbolTriangle,
    builtin: d3.symbolCross,
    unknown: d3.symbolCircle,
  };

  var serverColorMap = {};
  var serverColorIdx = 0;

  function getServerColor(serverName) {
    var key = serverName || '__none__';
    if (!serverColorMap[key]) {
      serverColorMap[key] = CLUSTER_COLORS[serverColorIdx % CLUSTER_COLORS.length];
      serverColorIdx++;
    }
    return serverColorMap[key];
  }

  // ---------------------------------------------------------------------------
  // Display name helper
  // ---------------------------------------------------------------------------

  function shortName(name) {
    // Strip mcp__ prefix and server name prefix for readability
    return name.replace(/^mcp__[^_]+__/, '').replace(/^mcp__/, '');
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  function fetchTools() {
    return fetch('/api/tools').then(function (r) { return r.json(); }).catch(function () { return { tools: [] }; });
  }

  function fetchFlows() {
    var params = new URLSearchParams();
    if (window.laminarkState && window.laminarkState.currentProject) {
      params.set('project', window.laminarkState.currentProject);
    }
    var qs = params.toString();
    return fetch('/api/tools/flows' + (qs ? '?' + qs : '')).then(function (r) { return r.json(); }).catch(function () { return { edges: [] }; });
  }

  function fetchToolStats(name) {
    var params = new URLSearchParams();
    if (window.laminarkState && window.laminarkState.currentProject) {
      params.set('project', window.laminarkState.currentProject);
    }
    var qs = params.toString();
    return fetch('/api/tools/' + encodeURIComponent(name) + '/stats' + (qs ? '?' + qs : ''))
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  function fetchToolSessions() {
    var params = new URLSearchParams();
    if (window.laminarkState && window.laminarkState.currentProject) {
      params.set('project', window.laminarkState.currentProject);
    }
    params.set('limit', '10');
    var qs = params.toString();
    return fetch('/api/tools/sessions' + (qs ? '?' + qs : ''))
      .then(function (r) { return r.json(); })
      .catch(function () { return { sessions: [] }; });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function initTools(containerId) {
    if (initialized) return;
    initialized = true;

    var container = document.getElementById(containerId);
    if (!container) return;

    var graphArea = container.querySelector('.tools-graph-area');
    if (!graphArea) return;

    svg = d3.select('#tools-svg');
    svgGroup = svg.append('g').attr('class', 'tools-zoom-group');

    // Zoom behavior
    var zoom = d3.zoom()
      .scaleExtent([0.1, 6])
      .on('zoom', function (event) {
        svgGroup.attr('transform', event.transform);
      });
    svg.call(zoom);

    // Layer ordering
    svgGroup.append('g').attr('class', 'hull-layer');
    svgGroup.append('g').attr('class', 'edge-layer');
    svgGroup.append('g').attr('class', 'node-layer');
    svgGroup.append('g').attr('class', 'label-layer');

    // Resize handler
    function resize() {
      var rect = graphArea.getBoundingClientRect();
      svg.attr('width', rect.width).attr('height', rect.height);
    }
    resize();
    window.addEventListener('resize', resize);

    // Toolbar event bindings
    initToolbar(container);

    // Load data
    loadToolData();
  }

  function initToolbar(container) {
    // Layout buttons
    var layoutBtns = container.querySelectorAll('.tools-layout-btn');
    layoutBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        layoutBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentLayout = btn.getAttribute('data-layout');
        updateSimulation();
      });
    });

    // Cluster toggle
    var clusterToggle = document.getElementById('tools-cluster-toggle');
    if (clusterToggle) {
      clusterToggle.addEventListener('change', function () {
        showClusters = clusterToggle.checked;
        renderHulls();
      });
    }

    // Filter by type
    var typeSelect = document.getElementById('tools-filter-type');
    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        filterType = typeSelect.value;
        applyFilters();
      });
    }

    // Filter by server
    var serverSelect = document.getElementById('tools-filter-server');
    if (serverSelect) {
      serverSelect.addEventListener('change', function () {
        filterServer = serverSelect.value;
        applyFilters();
      });
    }

    // Detail panel close
    var closeBtn = document.getElementById('tools-detail-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        var panel = document.getElementById('tools-detail-panel');
        if (panel) panel.classList.add('hidden');
        selectedTool = null;
        // Remove selection highlight
        svgGroup.selectAll('.tool-node').classed('selected', false);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Data loading and rendering
  // ---------------------------------------------------------------------------

  function loadToolData() {
    Promise.all([fetchTools(), fetchFlows(), fetchToolSessions()])
      .then(function (results) {
        var toolsData = results[0];
        var flowsData = results[1];
        var sessionsData = results[2];

        toolNodes = (toolsData.tools || []).map(function (t) {
          return {
            id: t.name,
            name: t.name,
            shortName: shortName(t.name),
            toolType: t.toolType,
            scope: t.scope,
            status: t.status,
            usageCount: t.usageCount || 0,
            serverName: t.serverName,
            description: t.description,
            x: 0,
            y: 0,
          };
        });

        // Build a name set for filtering edges
        var nameSet = new Set(toolNodes.map(function (n) { return n.id; }));

        flowEdges = (flowsData.edges || [])
          .filter(function (e) { return nameSet.has(e.source) && nameSet.has(e.target); })
          .map(function (e) {
            return {
              source: e.source,
              target: e.target,
              frequency: e.frequency,
              edgeType: e.edgeType,
            };
          });

        // Populate server filter dropdown
        populateServerFilter();

        // Update stats
        updateStats();

        // Render if non-empty
        if (toolNodes.length === 0) {
          showEmptyState();
        } else {
          renderGraph();
        }

        // Render session strip
        renderSessionStrip(sessionsData.sessions || []);
      });
  }

  function populateServerFilter() {
    var serverSelect = document.getElementById('tools-filter-server');
    if (!serverSelect) return;

    var servers = new Set();
    toolNodes.forEach(function (n) {
      if (n.serverName) servers.add(n.serverName);
    });

    // Clear existing options except first
    while (serverSelect.options.length > 1) {
      serverSelect.remove(1);
    }

    Array.from(servers).sort().forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      serverSelect.appendChild(opt);
    });
  }

  function updateStats() {
    var statsEl = document.getElementById('tools-stats');
    if (statsEl) {
      var visibleNodes = getFilteredNodes();
      var visibleEdges = getFilteredEdges(visibleNodes);
      statsEl.textContent = visibleNodes.length + ' tools, ' + visibleEdges.length + ' flows';
    }
  }

  function showEmptyState() {
    svgGroup.selectAll('*').remove();
    var rect = svg.node().getBoundingClientRect();
    svgGroup.append('text')
      .attr('x', rect.width / 2)
      .attr('y', rect.height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#8b949e')
      .attr('font-size', '16px')
      .text('No tools discovered yet. Use Claude Code tools to populate this view.');
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  function getFilteredNodes() {
    return toolNodes.filter(function (n) {
      if (filterType && n.toolType !== filterType) return false;
      if (filterServer && n.serverName !== filterServer) return false;
      return true;
    });
  }

  function getFilteredEdges(nodes) {
    var nodeSet = new Set(nodes.map(function (n) { return n.id; }));
    return flowEdges.filter(function (e) {
      var srcId = typeof e.source === 'object' ? e.source.id : e.source;
      var tgtId = typeof e.target === 'object' ? e.target.id : e.target;
      return nodeSet.has(srcId) && nodeSet.has(tgtId);
    });
  }

  function applyFilters() {
    renderGraph();
    updateStats();
  }

  // ---------------------------------------------------------------------------
  // Graph rendering
  // ---------------------------------------------------------------------------

  function renderGraph() {
    var nodes = getFilteredNodes();
    var edges = getFilteredEdges(nodes);

    // Size scale
    var maxUsage = d3.max(nodes, function (d) { return d.usageCount; }) || 1;
    var sizeScale = d3.scaleSqrt().domain([0, maxUsage]).range([6, 28]).clamp(true);

    // Edge thickness scale
    var maxFreq = d3.max(edges, function (d) { return d.frequency; }) || 1;
    var edgeScale = d3.scaleLinear().domain([1, maxFreq]).range([1, 5]).clamp(true);

    var rect = svg.node().getBoundingClientRect();
    var width = rect.width || 800;
    var height = rect.height || 600;

    // Clear previous
    svgGroup.select('.hull-layer').selectAll('*').remove();
    svgGroup.select('.edge-layer').selectAll('*').remove();
    svgGroup.select('.node-layer').selectAll('*').remove();
    svgGroup.select('.label-layer').selectAll('*').remove();

    // Edges
    var edgeSel = svgGroup.select('.edge-layer')
      .selectAll('line')
      .data(edges, function (d) {
        var s = typeof d.source === 'object' ? d.source.id : d.source;
        var t = typeof d.target === 'object' ? d.target.id : d.target;
        return s + '->' + t;
      })
      .join('line')
      .attr('class', 'tool-edge')
      .attr('stroke', function (d) { return d.edgeType === 'pattern' ? '#58a6ff' : '#30363d'; })
      .attr('stroke-width', function (d) { return edgeScale(d.frequency); })
      .attr('stroke-opacity', 0.4)
      .attr('marker-end', 'url(#tool-arrow)');

    // Arrow marker
    svg.selectAll('defs').remove();
    var defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'tool-arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 20)
      .attr('refY', 5)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,0 L10,5 L0,10 Z')
      .attr('fill', '#8b949e')
      .attr('fill-opacity', 0.5);

    // Nodes
    var nodeSel = svgGroup.select('.node-layer')
      .selectAll('path')
      .data(nodes, function (d) { return d.id; })
      .join('path')
      .attr('class', 'tool-node')
      .attr('d', function (d) {
        var size = sizeScale(d.usageCount);
        var symbolType = TOOL_TYPE_ICONS[d.toolType] || TOOL_TYPE_ICONS.unknown;
        return d3.symbol().type(symbolType).size(size * size * 2)();
      })
      .attr('fill', function (d) { return getServerColor(d.serverName); })
      .attr('stroke', function (d) {
        return d.status === 'demoted' ? '#f85149' : d.status === 'stale' ? '#d29922' : 'rgba(255,255,255,0.2)';
      })
      .attr('stroke-width', function (d) {
        return d.status !== 'active' ? 2 : 1;
      })
      .attr('cursor', 'pointer')
      .on('click', function (event, d) {
        event.stopPropagation();
        selectToolNode(d);
      })
      .call(d3.drag()
        .on('start', function (event, d) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', function (event, d) {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', function (event, d) {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }));

    // Tooltip on hover
    nodeSel
      .on('mouseenter', function (event, d) {
        d3.select(this).attr('stroke-width', 3).attr('stroke', '#ffffff');
        // Show tooltip
        var tooltip = d3.select('#tools-svg').selectAll('.tool-tooltip').data([d]);
        var tooltipEnter = tooltip.enter().append('g').attr('class', 'tool-tooltip');
        tooltipEnter.append('rect');
        tooltipEnter.append('text');
        var g = tooltip.merge(tooltipEnter);
        var text = g.select('text')
          .text(d.name + (d.usageCount > 0 ? ' (' + d.usageCount + ' uses)' : ''))
          .attr('x', 0).attr('y', 0)
          .attr('fill', '#c9d1d9')
          .attr('font-size', '11px')
          .attr('text-anchor', 'middle');
        var bbox = text.node().getBBox();
        g.select('rect')
          .attr('x', bbox.x - 4).attr('y', bbox.y - 2)
          .attr('width', bbox.width + 8).attr('height', bbox.height + 4)
          .attr('fill', '#161b22').attr('stroke', '#30363d').attr('rx', 3);
        text.raise();
        g.attr('transform', 'translate(' + d.x + ',' + (d.y - sizeScale(d.usageCount) - 12) + ')');
      })
      .on('mouseleave', function (event, d) {
        d3.select(this)
          .attr('stroke-width', d.status !== 'active' ? 2 : 1)
          .attr('stroke', d.status === 'demoted' ? '#f85149' : d.status === 'stale' ? '#d29922' : 'rgba(255,255,255,0.2)');
        svg.selectAll('.tool-tooltip').remove();
      });

    // Labels
    var labelSel = svgGroup.select('.label-layer')
      .selectAll('text')
      .data(nodes, function (d) { return d.id; })
      .join('text')
      .attr('class', 'tool-label')
      .text(function (d) { return d.shortName; })
      .attr('fill', '#8b949e')
      .attr('font-size', '10px')
      .attr('text-anchor', 'middle')
      .attr('dy', function (d) { return sizeScale(d.usageCount) + 12; })
      .attr('pointer-events', 'none');

    // Simulation
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id(function (d) { return d.id; }).distance(80).strength(0.3))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(function (d) { return sizeScale(d.usageCount) + 8; }))
      .on('tick', function () {
        edgeSel
          .attr('x1', function (d) { return d.source.x; })
          .attr('y1', function (d) { return d.source.y; })
          .attr('x2', function (d) { return d.target.x; })
          .attr('y2', function (d) { return d.target.y; });

        nodeSel
          .attr('transform', function (d) { return 'translate(' + d.x + ',' + d.y + ')'; });

        labelSel
          .attr('x', function (d) { return d.x; })
          .attr('y', function (d) { return d.y; });

        // Update tooltip position if visible
        svg.selectAll('.tool-tooltip').each(function () {
          var g = d3.select(this);
          var d = g.datum();
          if (d) g.attr('transform', 'translate(' + d.x + ',' + (d.y - sizeScale(d.usageCount) - 12) + ')');
        });

        // Render cluster hulls
        renderHulls();
      });

    // Apply cluster forces if layout is 'cluster'
    updateSimulation();

    // Click on SVG background to deselect
    svg.on('click', function () {
      var panel = document.getElementById('tools-detail-panel');
      if (panel) panel.classList.add('hidden');
      selectedTool = null;
      svgGroup.selectAll('.tool-node').classed('selected', false);
    });
  }

  function updateSimulation() {
    if (!simulation) return;
    var rect = svg.node().getBoundingClientRect();
    var width = rect.width || 800;
    var height = rect.height || 600;

    if (currentLayout === 'cluster') {
      // Compute cluster centers per serverName
      var servers = {};
      var nodes = getFilteredNodes();
      nodes.forEach(function (n) {
        var key = n.serverName || '__none__';
        if (!servers[key]) servers[key] = [];
        servers[key].push(n);
      });
      var serverKeys = Object.keys(servers);
      var cols = Math.ceil(Math.sqrt(serverKeys.length));
      var clusterCenters = {};
      serverKeys.forEach(function (key, i) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        clusterCenters[key] = {
          x: (col + 0.5) * (width / cols),
          y: (row + 0.5) * (height / Math.ceil(serverKeys.length / cols)),
        };
      });

      simulation
        .force('x', d3.forceX(function (d) {
          var key = d.serverName || '__none__';
          return clusterCenters[key] ? clusterCenters[key].x : width / 2;
        }).strength(0.4))
        .force('y', d3.forceY(function (d) {
          var key = d.serverName || '__none__';
          return clusterCenters[key] ? clusterCenters[key].y : height / 2;
        }).strength(0.4))
        .force('center', null);
    } else {
      simulation
        .force('x', null)
        .force('y', null)
        .force('center', d3.forceCenter(width / 2, height / 2));
    }

    simulation.alpha(0.6).restart();
  }

  // ---------------------------------------------------------------------------
  // Cluster hulls
  // ---------------------------------------------------------------------------

  function renderHulls() {
    var hullLayer = svgGroup.select('.hull-layer');
    hullLayer.selectAll('*').remove();

    if (!showClusters) return;

    var nodes = getFilteredNodes();
    var groups = {};
    nodes.forEach(function (n) {
      var key = n.serverName || '__none__';
      if (!groups[key]) groups[key] = [];
      groups[key].push([n.x, n.y]);
    });

    Object.keys(groups).forEach(function (key) {
      var points = groups[key];
      if (points.length < 3) return; // Need at least 3 points for a hull

      var hull = d3.polygonHull(points);
      if (!hull) return;

      // Expand hull slightly for padding
      var cx = d3.mean(points, function (p) { return p[0]; });
      var cy = d3.mean(points, function (p) { return p[1]; });
      var expandedHull = hull.map(function (p) {
        var dx = p[0] - cx;
        var dy = p[1] - cy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var expand = 25;
        return [
          p[0] + (dx / (dist || 1)) * expand,
          p[1] + (dy / (dist || 1)) * expand,
        ];
      });

      hullLayer.append('path')
        .attr('d', 'M' + expandedHull.join('L') + 'Z')
        .attr('fill', getServerColor(key === '__none__' ? null : key))
        .attr('fill-opacity', 0.06)
        .attr('stroke', getServerColor(key === '__none__' ? null : key))
        .attr('stroke-opacity', 0.15)
        .attr('stroke-width', 1.5)
        .attr('rx', 8);

      // Cluster label
      hullLayer.append('text')
        .attr('x', cx)
        .attr('y', d3.min(hull, function (p) { return p[1]; }) - 12)
        .attr('text-anchor', 'middle')
        .attr('fill', getServerColor(key === '__none__' ? null : key))
        .attr('fill-opacity', 0.5)
        .attr('font-size', '11px')
        .attr('font-weight', '500')
        .text(key === '__none__' ? 'Other' : key);
    });
  }

  // ---------------------------------------------------------------------------
  // Detail panel
  // ---------------------------------------------------------------------------

  function selectToolNode(d) {
    selectedTool = d;

    // Highlight selected node
    svgGroup.selectAll('.tool-node')
      .classed('selected', function (n) { return n.id === d.id; });

    // Show panel with loading state
    var panel = document.getElementById('tools-detail-panel');
    var title = document.getElementById('tools-detail-title');
    var body = document.getElementById('tools-detail-body');
    if (!panel || !title || !body) return;

    title.textContent = d.shortName;
    body.innerHTML = '<p class="empty-state">Loading stats...</p>';
    panel.classList.remove('hidden');

    // Fetch detailed stats
    fetchToolStats(d.name).then(function (data) {
      if (!data || !data.tool) {
        body.innerHTML = '<p class="empty-state">No stats available</p>';
        return;
      }

      renderToolDetail(body, data);
    });
  }

  function renderToolDetail(container, data) {
    container.innerHTML = '';
    var tool = data.tool;

    // Info section
    var infoSection = document.createElement('div');
    infoSection.className = 'detail-section';

    var fields = [
      { label: 'Full name', value: tool.name },
      { label: 'Type', value: tool.toolType },
      { label: 'Scope', value: tool.scope },
      { label: 'Status', value: tool.status },
      { label: 'Server', value: tool.serverName || 'N/A' },
      { label: 'Usage count', value: String(tool.usageCount) },
      { label: 'Success rate', value: data.successRate != null ? (data.successRate * 100).toFixed(0) + '%' : 'N/A' },
      { label: 'Sessions used in', value: String(data.sessionsUsedIn) },
      { label: 'Last used', value: tool.lastUsedAt ? new Date(tool.lastUsedAt).toLocaleString() : 'Never' },
      { label: 'Discovered', value: new Date(tool.discoveredAt).toLocaleString() },
    ];

    fields.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'detail-field';
      var lbl = document.createElement('span');
      lbl.className = 'field-label';
      lbl.textContent = f.label + ': ';
      var val = document.createElement('span');
      val.className = 'field-value';
      val.textContent = f.value;
      if (f.label === 'Status') {
        val.className = 'tool-status-badge ' + tool.status;
      }
      row.appendChild(lbl);
      row.appendChild(val);
      infoSection.appendChild(row);
    });

    container.appendChild(infoSection);

    // Description
    if (tool.description) {
      var descSection = document.createElement('div');
      descSection.className = 'detail-section';
      var descTitle = document.createElement('div');
      descTitle.className = 'detail-section-title';
      descTitle.textContent = 'Description';
      descSection.appendChild(descTitle);
      var descText = document.createElement('p');
      descText.className = 'tool-description';
      descText.textContent = tool.description;
      descSection.appendChild(descText);
      container.appendChild(descSection);
    }

    // Co-occurring tools
    if (data.coOccurring && data.coOccurring.length > 0) {
      var coSection = document.createElement('div');
      coSection.className = 'detail-section';
      var coTitle = document.createElement('div');
      coTitle.className = 'detail-section-title';
      coTitle.textContent = 'Top co-occurring tools';
      coSection.appendChild(coTitle);

      data.coOccurring.forEach(function (co) {
        var item = document.createElement('div');
        item.className = 'tool-co-occurring-item';
        item.style.cursor = 'pointer';

        var name = document.createElement('span');
        name.className = 'tool-co-name';
        name.textContent = shortName(co.name);

        var count = document.createElement('span');
        count.className = 'tool-co-count';
        count.textContent = co.count + 'x';

        item.appendChild(name);
        item.appendChild(count);

        item.addEventListener('click', function () {
          var node = toolNodes.find(function (n) { return n.id === co.name; });
          if (node) selectToolNode(node);
        });

        coSection.appendChild(item);
      });

      container.appendChild(coSection);
    }
  }

  // ---------------------------------------------------------------------------
  // Session flow strip
  // ---------------------------------------------------------------------------

  function renderSessionStrip(sessions) {
    var content = document.getElementById('tools-session-strip-content');
    if (!content) return;

    content.innerHTML = '';

    if (!sessions || sessions.length === 0) {
      content.innerHTML = '<span class="tools-session-empty">No recent sessions with tool usage</span>';
      return;
    }

    sessions.forEach(function (session) {
      var strip = document.createElement('div');
      strip.className = 'tools-session-item';

      var label = document.createElement('span');
      label.className = 'tools-session-id';
      label.textContent = session.sessionId.substring(0, 8);
      strip.appendChild(label);

      var toolsDiv = document.createElement('div');
      toolsDiv.className = 'tools-session-tools';

      // Deduplicate consecutive same-tool calls and show flow
      var prev = '';
      var displayTools = [];
      session.tools.forEach(function (t) {
        if (t.name !== prev) {
          displayTools.push(t);
          prev = t.name;
        }
      });

      // Limit display to 15 tools
      var maxDisplay = 15;
      var showing = displayTools.slice(0, maxDisplay);

      showing.forEach(function (t, i) {
        if (i > 0) {
          var arrow = document.createElement('span');
          arrow.className = 'tools-session-arrow';
          arrow.textContent = '\u2192';
          toolsDiv.appendChild(arrow);
        }

        var chip = document.createElement('span');
        chip.className = 'tools-session-chip';
        chip.textContent = shortName(t.name);
        chip.style.borderColor = getServerColor(
          toolNodes.find(function (n) { return n.id === t.name; })?.serverName || null
        );
        chip.title = t.name;
        toolsDiv.appendChild(chip);
      });

      if (displayTools.length > maxDisplay) {
        var more = document.createElement('span');
        more.className = 'tools-session-more';
        more.textContent = '+' + (displayTools.length - maxDisplay) + ' more';
        toolsDiv.appendChild(more);
      }

      strip.appendChild(toolsDiv);
      content.appendChild(strip);
    });
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  window.laminarkTools = {
    initTools: initTools,
    loadToolData: loadToolData,
  };
})();
