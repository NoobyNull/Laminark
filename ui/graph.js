/**
 * Laminark Knowledge Graph Visualization (D3.js)
 *
 * Renders the knowledge graph as an interactive D3.js force-directed SVG.
 * Entities appear as colored/shaped nodes by type. Relationships render as
 * labeled directed edges. Level-of-detail reduces visual complexity at low
 * zoom levels. Force-collide prevents the hairball problem.
 *
 * @module graph
 */

// ---------------------------------------------------------------------------
// Debounce utility
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  var timer;
  return function () { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

// ---------------------------------------------------------------------------
// Entity type visual map
// ---------------------------------------------------------------------------

const ENTITY_STYLES = {
  Project:   { color: '#58a6ff', shape: 'round-rectangle' },
  File:      { color: '#3fb950', shape: 'rectangle' },
  Decision:  { color: '#d29922', shape: 'diamond' },
  Problem:   { color: '#f85149', shape: 'triangle' },
  Solution:  { color: '#a371f7', shape: 'star' },
  Reference: { color: '#f0883e', shape: 'hexagon' },
};

// Relationship type colors for edge coloring
var EDGE_TYPE_COLORS = {
  related_to: '#8b949e',
  solved_by: '#3fb950',
  caused_by: '#f85149',
  modifies: '#58a6ff',
  informed_by: '#d2a8ff',
  references: '#f0883e',
  verified_by: '#d29922',
  preceded_by: '#79c0ff',
};

// ---------------------------------------------------------------------------
// D3 symbol generators per entity type
// ---------------------------------------------------------------------------

var nodeSizeScale = d3.scaleSqrt().domain([0, 50]).range([15, 40]).clamp(true);
var degreeSizeScale = d3.scaleSqrt().domain([0, 20]).range([0, 20]).clamp(true);

function getNodeSize(d) {
  var base = nodeSizeScale(d.observationCount || 0);
  var degreeBonus = degreeSizeScale(d._degree || 0);
  return base + degreeBonus;
}

// Custom hexagon symbol
var hexagonSymbol = {
  draw: function (context, size) {
    var r = Math.sqrt(size / (1.5 * Math.sqrt(3)));
    for (var i = 0; i < 6; i++) {
      var angle = (Math.PI / 3) * i - Math.PI / 2;
      var x = r * Math.cos(angle);
      var y = r * Math.sin(angle);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
  }
};

// Custom rounded rectangle symbol
var roundRectSymbol = {
  draw: function (context, size) {
    var s = Math.sqrt(size) * 0.9;
    var r = s * 0.2;
    var hs = s / 2;
    context.moveTo(-hs + r, -hs);
    context.lineTo(hs - r, -hs);
    context.quadraticCurveTo(hs, -hs, hs, -hs + r);
    context.lineTo(hs, hs - r);
    context.quadraticCurveTo(hs, hs, hs - r, hs);
    context.lineTo(-hs + r, hs);
    context.quadraticCurveTo(-hs, hs, -hs, hs - r);
    context.lineTo(-hs, -hs + r);
    context.quadraticCurveTo(-hs, -hs, -hs + r, -hs);
    context.closePath();
  }
};

function getSymbolType(type) {
  switch (type) {
    case 'Project': return roundRectSymbol;
    case 'File': return d3.symbolSquare;
    case 'Decision': return d3.symbolDiamond;
    case 'Problem': return d3.symbolTriangle;
    case 'Solution': return d3.symbolStar;
    case 'Reference': return hexagonSymbol;
    default: return d3.symbolCircle;
  }
}

function getSymbolPath(type, size) {
  var area = size * size * 2.5;
  return d3.symbol().type(getSymbolType(type)).size(area)();
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

var svg = null;
var svgG = null; // Main group that receives zoom transforms
var simulation = null;
var zoomBehavior = null;
var containerEl = null;

// Data arrays (the simulation operates on these directly)
var nodeData = [];
var edgeData = [];

// D3 selections
var edgeSelection = null;
var edgeLabelSelection = null;
var nodeGroupSelection = null;
var nodeLabelSelection = null;

// Layer groups
var edgesGroup = null;
var edgeLabelsGroup = null;
var nodesGroup = null;
var nodeLabelsGroup = null;

var activeEntityTypes = new Set(Object.keys(ENTITY_STYLES));

// Level-of-detail state
var currentLodLevel = 0;
var currentZoom = 1;

// Performance stats overlay state
var perfOverlayVisible = false;
var perfOverlayEl = null;
var perfFrameCount = 0;
var perfLastFpsTime = 0;
var perfFps = 0;
var perfRafId = null;

// Focus mode state
var focusStack = [];
var isFocusMode = false;
var cachedFullData = null;

// Current layout setting
var currentLayout = localStorage.getItem('laminark-layout') || 'clustered';
var isStaticLayout = false; // True when using hierarchical/concentric (no simulation)

// Batch update queue for SSE events
var batchQueue = [];
var batchFlushTimer = null;
var BATCH_DELAY_MS = 200;

// Context menu state
var contextMenuEl = null;
var contextMenuVisible = false;
var contextMenuTargetNode = null;

// Time range state
var activeTimeRange = { from: null, to: null };

// Selected node
var selectedNodeId = null;

// Tooltip element
var tooltipEl = null;

// Community data
var communityNodeMap = {};
var communityColorMap = {};

// Edge label visibility (per-type)
var edgeLabelsVisible = localStorage.getItem('laminark-edge-labels') !== 'false';
var hiddenEdgeLabelTypes = new Set(
  JSON.parse(localStorage.getItem('laminark-hidden-edge-types') || '[]')
);

// ---------------------------------------------------------------------------
// initGraph
// ---------------------------------------------------------------------------

function initGraph(containerId) {
  containerEl = document.getElementById(containerId);
  if (!containerEl) {
    console.error('[laminark:graph] Container not found:', containerId);
    return null;
  }

  // Clear any previous content
  containerEl.innerHTML = '';

  var width = containerEl.clientWidth || 800;
  var height = containerEl.clientHeight || 600;

  svg = d3.select(containerEl)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', [0, 0, width, height].join(' '))
    .attr('class', 'graph-svg');

  // Arrow marker definitions (one per edge type color)
  var defs = svg.append('defs');
  var markerColors = {};
  Object.keys(EDGE_TYPE_COLORS).forEach(function (k) { markerColors[k] = EDGE_TYPE_COLORS[k]; });
  markerColors['default'] = '#8b949e';

  Object.keys(markerColors).forEach(function (key) {
    defs.append('marker')
      .attr('id', 'arrow-' + key)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L10,0L0,4')
      .attr('fill', markerColors[key]);
  });

  // Main zoom group
  svgG = svg.append('g').attr('class', 'graph-zoom-group');

  // Layer groups in paint order (back to front)
  edgesGroup = svgG.append('g').attr('class', 'edges-group');
  edgeLabelsGroup = svgG.append('g').attr('class', 'edge-labels-group');
  nodesGroup = svgG.append('g').attr('class', 'nodes-group');
  nodeLabelsGroup = svgG.append('g').attr('class', 'node-labels-group');

  // Zoom behavior
  zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 3.0])
    .on('zoom', function (event) {
      svgG.attr('transform', event.transform);
      currentZoom = event.transform.k;
      updateLevelOfDetail();
    });
  svg.call(zoomBehavior);

  // Background click: deselect + hide detail panel
  svg.on('click', function (event) {
    if (event.target === svg.node() || event.target.closest('.graph-zoom-group') === svgG.node() && !event.target.closest('.node-group')) {
      hideDetailPanel();
      selectedNodeId = null;
      if (nodesGroup) nodesGroup.selectAll('.node-group').classed('selected', false);
    }
  });

  // Right-click on background
  svg.on('contextmenu', function (event) {
    event.preventDefault();
    // Check if click is on a node
    var nodeGroup = event.target.closest('.node-group');
    if (nodeGroup) return; // Handled by node's own contextmenu handler

    contextMenuTargetNode = null;
    var items = [
      { type: 'header', label: 'Filter' },
      { type: 'item', label: 'Reset filters (show all)', action: 'reset-filters' },
      { type: 'divider' },
      { type: 'header', label: 'Arrange' },
      { type: 'item', label: 'Re-layout graph', action: 'relayout' },
      { type: 'item', label: 'Fit to view', action: 'fit' },
    ];
    showContextMenu(event.pageX, event.pageY, items);
  });

  // Performance stats keyboard shortcut: Ctrl+Shift+P
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      togglePerfOverlay();
    }
  });

  initContextMenu();
  initEdgeLabelToggle();

  // Create tooltip element
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'graph-tooltip hidden';
  containerEl.appendChild(tooltipEl);

  console.log('[laminark:graph] D3 initialized with force simulation');
  return svg;
}

// ---------------------------------------------------------------------------
// Resolve edge source/target from string IDs to node object references
// ---------------------------------------------------------------------------

function resolveEdgeReferences() {
  var nodeMap = {};
  nodeData.forEach(function (d) { nodeMap[d.id] = d; });
  edgeData.forEach(function (d) {
    if (typeof d.source === 'string') d.source = nodeMap[d.source] || d.source;
    if (typeof d.target === 'string') d.target = nodeMap[d.target] || d.target;
  });
}

// ---------------------------------------------------------------------------
// Force simulation setup
// ---------------------------------------------------------------------------

function computeDegrees() {
  var degreeMap = {};
  edgeData.forEach(function (d) {
    var srcId = typeof d.source === 'object' ? d.source.id : d.source;
    var tgtId = typeof d.target === 'object' ? d.target.id : d.target;
    degreeMap[srcId] = (degreeMap[srcId] || 0) + 1;
    degreeMap[tgtId] = (degreeMap[tgtId] || 0) + 1;
  });
  nodeData.forEach(function (d) {
    d._degree = degreeMap[d.id] || 0;
  });
}

function createSimulation() {
  if (simulation) simulation.stop();

  computeDegrees();

  var width = containerEl ? containerEl.clientWidth : 800;
  var height = containerEl ? containerEl.clientHeight : 600;

  var visibleEdges = edgeData.filter(function (d) {
    return !d.source.hidden && !d.target.hidden;
  });

  // Degree-scaled repulsion: more links = stronger push away
  var chargeScale = d3.scaleLinear().domain([0, 20]).range([-200, -1200]).clamp(true);

  simulation = d3.forceSimulation(nodeData.filter(function (d) { return !d.hidden; }))
    .force('link', d3.forceLink(visibleEdges)
      .id(function (d) { return d.id; })
      .distance(function (d) {
        // Longer links between high-degree nodes so they spread out
        var srcDeg = (typeof d.source === 'object' ? d.source._degree : 0) || 0;
        var tgtDeg = (typeof d.target === 'object' ? d.target._degree : 0) || 0;
        return 100 + Math.sqrt(srcDeg + tgtDeg) * 20;
      }))
    .force('charge', d3.forceManyBody().strength(function (d) {
      return chargeScale(d._degree || 0);
    }))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(function (d) {
      return getNodeSize(d) + 12;
    }).strength(0.8))
    .force('x', d3.forceX(width / 2).strength(0.03))
    .force('y', d3.forceY(height / 2).strength(0.03))
    .alphaDecay(0.02)
    .velocityDecay(0.35)
    .on('tick', ticked);
}

function ticked() {
  if (edgeSelection) {
    edgeSelection
      .attr('x1', function (d) { return (d.source && d.source.x) || 0; })
      .attr('y1', function (d) { return (d.source && d.source.y) || 0; })
      .attr('x2', function (d) {
        if (!d.source || !d.target || d.source.x == null || d.target.x == null) return 0;
        return shortenLine(d.source, d.target, getNodeSize(d.target) + 5).x;
      })
      .attr('y2', function (d) {
        if (!d.source || !d.target || d.source.y == null || d.target.y == null) return 0;
        return shortenLine(d.source, d.target, getNodeSize(d.target) + 5).y;
      });
  }

  if (edgeLabelSelection) {
    edgeLabelSelection
      .attr('x', function (d) { var sx = (d.source && d.source.x) || 0; var tx = (d.target && d.target.x) || 0; return (sx + tx) / 2; })
      .attr('y', function (d) { var sy = (d.source && d.source.y) || 0; var ty = (d.target && d.target.y) || 0; return (sy + ty) / 2; });
  }

  if (nodeGroupSelection) {
    nodeGroupSelection.attr('transform', function (d) {
      return 'translate(' + (d.x || 0) + ',' + (d.y || 0) + ')';
    });
  }

  if (nodeLabelSelection) {
    nodeLabelSelection
      .attr('x', function (d) { return d.x || 0; })
      .attr('y', function (d) { return (d.y || 0) + getNodeSize(d) + 12; });
  }
}

// Shorten line endpoint to stop at node boundary
function shortenLine(source, target, offset) {
  var sx = source.x || 0, sy = source.y || 0;
  var tx = target.x || 0, ty = target.y || 0;
  var dx = tx - sx;
  var dy = ty - sy;
  var dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return { x: tx, y: ty };
  var ratio = (dist - offset) / dist;
  return {
    x: sx + dx * ratio,
    y: sy + dy * ratio,
  };
}

// ---------------------------------------------------------------------------
// renderGraph - D3 data join
// ---------------------------------------------------------------------------

function renderGraph() {
  if (!svg) return;
  computeDegrees();

  var visibleNodes = nodeData.filter(function (d) { return !d.hidden; });
  var visibleNodeIds = new Set(visibleNodes.map(function (d) { return d.id; }));
  var visibleEdges = edgeData.filter(function (d) {
    var srcId = typeof d.source === 'object' ? d.source.id : d.source;
    var tgtId = typeof d.target === 'object' ? d.target.id : d.target;
    return visibleNodeIds.has(srcId) && visibleNodeIds.has(tgtId);
  });

  // --- Edges ---
  edgeSelection = edgesGroup.selectAll('line.edge')
    .data(visibleEdges, function (d) { return d.id; });
  edgeSelection.exit().remove();
  edgeSelection = edgeSelection.enter()
    .append('line')
    .attr('class', 'edge')
    .merge(edgeSelection);
  edgeSelection
    .attr('stroke', function (d) { return EDGE_TYPE_COLORS[d.type] || '#8b949e'; })
    .attr('marker-end', function (d) {
      var key = EDGE_TYPE_COLORS[d.type] ? d.type : 'default';
      return 'url(#arrow-' + key + ')';
    });

  // --- Edge labels ---
  edgeLabelSelection = edgeLabelsGroup.selectAll('text.edge-label')
    .data(visibleEdges, function (d) { return d.id; });
  edgeLabelSelection.exit().remove();
  edgeLabelSelection = edgeLabelSelection.enter()
    .append('text')
    .attr('class', 'edge-label')
    .merge(edgeLabelSelection);
  edgeLabelSelection
    .text(function (d) { return d.type; });

  // --- Node groups ---
  nodeGroupSelection = nodesGroup.selectAll('g.node-group')
    .data(visibleNodes, function (d) { return d.id; });
  nodeGroupSelection.exit().remove();
  var nodeEnter = nodeGroupSelection.enter()
    .append('g')
    .attr('class', 'node-group')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

  nodeEnter.append('path').attr('class', 'node-shape');
  nodeEnter.append('text').attr('class', 'node-degree-label');

  nodeGroupSelection = nodeEnter.merge(nodeGroupSelection);

  // Update shapes and colors
  nodeGroupSelection.select('path.node-shape')
    .attr('d', function (d) { return getSymbolPath(d.type, getNodeSize(d)); })
    .attr('fill', function (d) {
      if (communityColorMap[d.id]) return communityColorMap[d.id];
      return ENTITY_STYLES[d.type] ? ENTITY_STYLES[d.type].color : '#8b949e';
    })
    .attr('stroke', 'none');

  // Degree count centered in node
  nodeGroupSelection.select('text.node-degree-label')
    .text(function (d) { return d._degree || ''; })
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', function (d) { return Math.max(9, getNodeSize(d) * 0.55) + 'px'; })
    .attr('fill', '#fff')
    .attr('font-weight', '700')
    .attr('pointer-events', 'none');

  // Update selection state
  nodeGroupSelection.classed('selected', function (d) { return d.id === selectedNodeId; });
  nodeGroupSelection.classed('focus-root', function (d) {
    return isFocusMode && focusStack.length > 0 && focusStack[focusStack.length - 1].nodeId === d.id;
  });

  // Node interactions
  nodeGroupSelection
    .on('click', function (event, d) {
      event.stopPropagation();
      handleNodeClick(d);
    })
    .on('dblclick', function (event, d) {
      event.stopPropagation();
      event.preventDefault();
      enterFocusMode(d.id, d.label);
    })
    .on('contextmenu', function (event, d) {
      event.preventDefault();
      event.stopPropagation();
      handleNodeContextMenu(event, d);
    })
    .on('mouseenter', function (event, d) {
      showTooltip(event, d);
    })
    .on('mousemove', function (event) {
      moveTooltip(event);
    })
    .on('mouseleave', function () {
      hideTooltip();
    });

  // --- Node labels ---
  nodeLabelSelection = nodeLabelsGroup.selectAll('text.node-label')
    .data(visibleNodes, function (d) { return d.id; });
  nodeLabelSelection.exit().remove();
  nodeLabelSelection = nodeLabelSelection.enter()
    .append('text')
    .attr('class', 'node-label')
    .merge(nodeLabelSelection);
  nodeLabelSelection
    .text(function (d) {
      var label = d.label || '';
      return label.length > 24 ? label.substring(0, 22) + '...' : label;
    });

  // Restart simulation only for force-directed layouts
  if (!isStaticLayout) {
    createSimulation();
  } else {
    // For static layouts, resolve edge references and position elements
    resolveEdgeReferences();
    ticked();
  }

  updateLevelOfDetail();
  updateGraphStatsFromData();
}

// ---------------------------------------------------------------------------
// Drag handlers
// ---------------------------------------------------------------------------

function dragStarted(event, d) {
  if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragEnded(event, d) {
  if (!event.active && simulation) simulation.alphaTarget(0);
  // Keep pinned: d.fx and d.fy remain set
}

// ---------------------------------------------------------------------------
// Node interaction handlers
// ---------------------------------------------------------------------------

async function handleNodeClick(d) {
  selectedNodeId = d.id;
  if (nodesGroup) {
    nodesGroup.selectAll('.node-group').classed('selected', function (n) { return n.id === d.id; });
  }

  if (window.laminarkApp && window.laminarkApp.fetchNodeDetails) {
    var details = await window.laminarkApp.fetchNodeDetails(d.id);
    if (details && window.laminarkApp.showNodeDetails) {
      window.laminarkApp.showNodeDetails(details);
    }
  }
}

function handleNodeContextMenu(event, d) {
  contextMenuTargetNode = { id: d.id, label: d.label, type: d.type };

  var items = [
    { type: 'header', label: 'Filter' },
    { type: 'item', label: 'This type only (' + d.type + ')',
      action: 'filter-type:' + d.type,
      color: ENTITY_STYLES[d.type] ? ENTITY_STYLES[d.type].color : null },
    { type: 'item', label: 'Focus on this node', action: 'focus' },
    { type: 'divider' },
    { type: 'header', label: 'Show Linked' },
  ];

  Object.keys(ENTITY_STYLES).forEach(function (t) {
    if (t !== d.type) {
      items.push({
        type: 'item',
        label: t,
        action: 'show-linked:' + t,
        color: ENTITY_STYLES[t].color,
      });
    }
  });

  items.push({ type: 'divider' });
  items.push({ type: 'header', label: 'Arrange' });
  items.push({ type: 'item', label: 'Re-layout graph', action: 'relayout' });
  items.push({ type: 'item', label: 'Fit to view', action: 'fit' });

  showContextMenu(event.pageX, event.pageY, items);
}

// ---------------------------------------------------------------------------
// loadGraphData
// ---------------------------------------------------------------------------

async function loadGraphData(filters) {
  if (!svg) {
    console.error('[laminark:graph] D3 not initialized');
    return { nodeCount: 0, edgeCount: 0 };
  }

  // Don't reload full graph data while in focus mode — it would
  // replace the neighborhood data and corrupt breadcrumbs/state.
  // SSE reconnects and tab switches should not interrupt focus.
  if (isFocusMode) {
    console.log('[laminark:graph] Skipping loadGraphData (focus mode active)');
    return { nodeCount: nodeData.length, edgeCount: edgeData.length };
  }

  var data;
  if (window.laminarkApp && window.laminarkApp.fetchGraphData) {
    data = await window.laminarkApp.fetchGraphData(filters);
  } else {
    var params = new URLSearchParams();
    if (filters && filters.type) params.set('type', filters.type);
    if (filters && filters.since) params.set('since', filters.since);
    if (filters && filters.until) params.set('until', filters.until);
    var url = '/api/graph' + (params.toString() ? '?' + params.toString() : '');
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (err) {
      console.error('[laminark:graph] Failed to fetch graph data:', err);
      data = { nodes: [], edges: [] };
    }
  }

  if (!data.nodes.length && !data.edges.length) {
    nodeData = [];
    edgeData = [];
    renderGraph();
    updateGraphStats(0, 0);
    showEmptyState();
    return { nodeCount: 0, edgeCount: 0 };
  }

  hideEmptyState();

  // Build data arrays
  nodeData = data.nodes.map(function (node) {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      observationCount: node.observationCount || 0,
      createdAt: node.createdAt,
      hidden: false,
    };
  });

  edgeData = data.edges.map(function (edge) {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      label: edge.label || edge.type,
    };
  });

  // For static layouts, re-apply layout positioning after fresh data load
  if (isStaticLayout) {
    // Reset to force-directed first so renderGraph creates a simulation
    isStaticLayout = false;
    renderGraph();
    // Re-apply the current static layout (which sets isStaticLayout back to true)
    if (currentLayout === 'hierarchical') {
      setTimeout(function () { applyHierarchicalLayout(); }, 100);
    } else if (currentLayout === 'concentric') {
      setTimeout(function () { applyConcentricLayout(); }, 100);
    }
  } else {
    renderGraph();
    // Fit to view after simulation settles a bit
    setTimeout(function () { fitToView(); }, 800);
  }

  var counts = { nodeCount: data.nodes.length, edgeCount: data.edges.length };
  updateGraphStats(counts.nodeCount, counts.edgeCount);
  console.log('[laminark:graph] Loaded', counts.nodeCount, 'nodes,', counts.edgeCount, 'edges');
  return counts;
}

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

function addNode(nodeDataIn) {
  if (!svg) return;

  var existing = nodeData.find(function (d) { return d.id === nodeDataIn.id; });
  if (existing) {
    Object.assign(existing, nodeDataIn);
  } else {
    nodeData.push({
      id: nodeDataIn.id,
      label: nodeDataIn.label,
      type: nodeDataIn.type,
      observationCount: nodeDataIn.observationCount || 0,
      createdAt: nodeDataIn.createdAt,
      hidden: false,
    });
    hideEmptyState();
  }

  renderGraph();
  if (!isStaticLayout && simulation) simulation.alpha(0.3).restart();
  updateGraphStatsFromData();
}

function addEdge(edgeDataIn) {
  if (!svg) return;

  var existing = edgeData.find(function (d) { return d.id === edgeDataIn.id; });
  if (existing) return;

  var srcExists = nodeData.find(function (d) { return d.id === edgeDataIn.source; });
  var tgtExists = nodeData.find(function (d) { return d.id === edgeDataIn.target; });
  if (!srcExists || !tgtExists) return;

  edgeData.push({
    id: edgeDataIn.id,
    source: edgeDataIn.source,
    target: edgeDataIn.target,
    type: edgeDataIn.type,
    label: edgeDataIn.label || edgeDataIn.type,
  });

  renderGraph();
  if (!isStaticLayout && simulation) simulation.alpha(0.3).restart();
  updateGraphStatsFromData();
}

function removeElements(ids) {
  if (!svg) return;
  var idSet = new Set(ids);

  edgeData = edgeData.filter(function (d) { return !idSet.has(d.id); });
  nodeData = nodeData.filter(function (d) { return !idSet.has(d.id); });
  // Also remove edges connected to removed nodes
  edgeData = edgeData.filter(function (d) {
    var srcId = typeof d.source === 'object' ? d.source.id : d.source;
    var tgtId = typeof d.target === 'object' ? d.target.id : d.target;
    return !idSet.has(srcId) && !idSet.has(tgtId);
  });

  renderGraph();
  updateGraphStatsFromData();

  if (nodeData.length === 0) showEmptyState();
}

// ---------------------------------------------------------------------------
// Fit to view
// ---------------------------------------------------------------------------

function fitToView() {
  if (!svg || !svgG || !containerEl) return;

  var visibleNodes = nodeData.filter(function (d) { return !d.hidden; });
  if (visibleNodes.length === 0) return;

  var width = containerEl.clientWidth || 800;
  var height = containerEl.clientHeight || 600;

  var xExtent = d3.extent(visibleNodes, function (d) { return d.x; });
  var yExtent = d3.extent(visibleNodes, function (d) { return d.y; });

  if (xExtent[0] == null || yExtent[0] == null) return;

  var padding = 60;
  var graphWidth = (xExtent[1] - xExtent[0]) || 1;
  var graphHeight = (yExtent[1] - yExtent[0]) || 1;
  var scale = Math.min(
    (width - padding * 2) / graphWidth,
    (height - padding * 2) / graphHeight,
    2.0
  );
  scale = Math.max(scale, 0.1);

  var cx = (xExtent[0] + xExtent[1]) / 2;
  var cy = (yExtent[0] + yExtent[1]) / 2;

  var transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(scale)
    .translate(-cx, -cy);

  svg.transition().duration(500).call(zoomBehavior.transform, transform);
}

// ---------------------------------------------------------------------------
// Filter handling
// ---------------------------------------------------------------------------

function applyFilter(types) {
  if (!types) {
    nodeData.forEach(function (d) { d.hidden = false; });
  } else {
    var typeSet = new Set(types);
    nodeData.forEach(function (d) {
      d.hidden = !typeSet.has(d.type);
    });
  }
  renderGraph();
  updateGraphStatsFromData();
}

function filterByType(type) {
  if (activeEntityTypes.has(type)) {
    activeEntityTypes.delete(type);
  } else {
    activeEntityTypes.add(type);
  }
  applyActiveFilters();
}

function resetFilters() {
  Object.keys(ENTITY_STYLES).forEach(function (type) {
    activeEntityTypes.add(type);
  });
  activeTimeRange.from = null;
  activeTimeRange.to = null;
  applyActiveFilters();
}

function setActiveTypes(types) {
  activeEntityTypes.clear();
  if (!types) {
    Object.keys(ENTITY_STYLES).forEach(function (t) { activeEntityTypes.add(t); });
  } else {
    types.forEach(function (t) { activeEntityTypes.add(t); });
  }
  applyActiveFilters();
}

function applyActiveFilters() {
  var allActive = activeEntityTypes.size === Object.keys(ENTITY_STYLES).length;
  var hasTimeFilter = activeTimeRange.from || activeTimeRange.to;

  nodeData.forEach(function (d) {
    var typeOk = activeEntityTypes.has(d.type);
    var timeOk = true;
    if (hasTimeFilter && d.createdAt) {
      if (activeTimeRange.from && d.createdAt < activeTimeRange.from) timeOk = false;
      if (activeTimeRange.to && d.createdAt > activeTimeRange.to) timeOk = false;
    }
    d.hidden = !(typeOk && timeOk);
  });

  renderGraph();
  updateGraphStatsFromData();
  updateFilterCounts();

  // Fit visible elements
  setTimeout(function () {
    var hasVisible = nodeData.some(function (d) { return !d.hidden; });
    if (hasVisible) fitToView();
  }, 600);
}

function filterByTimeRange(from, to) {
  activeTimeRange.from = from || null;
  activeTimeRange.to = to || null;
  applyActiveFilters();
}

// ---------------------------------------------------------------------------
// Type counts
// ---------------------------------------------------------------------------

function getTypeCounts() {
  var counts = {};
  Object.keys(ENTITY_STYLES).forEach(function (type) {
    counts[type] = { total: 0, visible: 0 };
  });

  nodeData.forEach(function (d) {
    if (counts[d.type]) {
      counts[d.type].total++;
      if (!d.hidden) counts[d.type].visible++;
    }
  });

  return counts;
}

function updateFilterCounts() {
  var counts = getTypeCounts();
  Object.keys(counts).forEach(function (type) {
    var pill = document.querySelector('.filter-pill[data-type="' + type + '"]');
    if (pill) {
      var countEl = pill.querySelector('.count');
      if (countEl) countEl.textContent = counts[type].visible;
    }
  });

  var allPill = document.querySelector('.filter-pill[data-type="all"]');
  if (allPill) {
    var allCountEl = allPill.querySelector('.count');
    if (allCountEl) {
      var totalVisible = 0;
      Object.keys(counts).forEach(function (type) { totalVisible += counts[type].visible; });
      allCountEl.textContent = totalVisible;
    }
  }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function showEmptyState() {
  if (!containerEl) return;
  var existing = containerEl.querySelector('.graph-empty-state');
  if (existing) { existing.style.display = ''; return; }

  var msg = document.createElement('div');
  msg.className = 'graph-empty-state';
  msg.textContent = 'No graph data yet. Observations will appear here as they are processed.';
  containerEl.appendChild(msg);
}

function hideEmptyState() {
  if (!containerEl) return;
  var existing = containerEl.querySelector('.graph-empty-state');
  if (existing) existing.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Stats display
// ---------------------------------------------------------------------------

function updateGraphStats(nodeCount, edgeCount) {
  var el = document.getElementById('graph-stats');
  if (el) el.textContent = nodeCount + ' nodes, ' + edgeCount + ' edges';
}

function updateGraphStatsFromData() {
  var visibleNodes = nodeData.filter(function (d) { return !d.hidden; });
  var visibleNodeIds = new Set(visibleNodes.map(function (d) { return d.id; }));
  var visibleEdges = edgeData.filter(function (d) {
    var srcId = typeof d.source === 'object' ? d.source.id : d.source;
    var tgtId = typeof d.target === 'object' ? d.target.id : d.target;
    return visibleNodeIds.has(srcId) && visibleNodeIds.has(tgtId);
  });
  updateGraphStats(visibleNodes.length, visibleEdges.length);
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function buildTooltipContent(d) {
  var degree = d._degree || 0;

  // Gather connected node names by relationship type
  var connections = {};
  edgeData.forEach(function (e) {
    var srcId = typeof e.source === 'object' ? e.source.id : e.source;
    var tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    var linkedId = null;
    if (srcId === d.id) linkedId = tgtId;
    else if (tgtId === d.id) linkedId = srcId;
    if (!linkedId) return;

    var linked = nodeData.find(function (n) { return n.id === linkedId; });
    if (!linked) return;
    var relType = e.type || 'related_to';
    if (!connections[relType]) connections[relType] = [];
    connections[relType].push(linked.label || linkedId);
  });

  var html = '<div class="tooltip-header">'
    + '<span class="tooltip-type" style="color:' + (ENTITY_STYLES[d.type] ? ENTITY_STYLES[d.type].color : '#8b949e') + '">' + d.type + '</span>'
    + '</div>'
    + '<div class="tooltip-name">' + escapeHtml(d.label || '') + '</div>'
    + '<div class="tooltip-stat">' + degree + ' connection' + (degree !== 1 ? 's' : '') + '</div>';

  var relTypes = Object.keys(connections);
  if (relTypes.length > 0) {
    html += '<div class="tooltip-connections">';
    relTypes.forEach(function (rel) {
      var names = connections[rel];
      var display = names.slice(0, 3).map(escapeHtml).join(', ');
      if (names.length > 3) display += ' +' + (names.length - 3) + ' more';
      html += '<div class="tooltip-rel"><span class="tooltip-rel-type">' + rel.replace(/_/g, ' ') + ':</span> ' + display + '</div>';
    });
    html += '</div>';
  }

  return html;
}

function showTooltip(event, d) {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = buildTooltipContent(d);
  tooltipEl.classList.remove('hidden');
  positionTooltip(event.pageX, event.pageY);
}

function moveTooltip(event) {
  if (!tooltipEl || tooltipEl.classList.contains('hidden')) return;
  positionTooltip(event.pageX, event.pageY);
}

function positionTooltip(px, py) {
  var offset = 12;
  var x = px + offset;
  var y = py + offset;
  var rect = tooltipEl.getBoundingClientRect();
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  if (x + rect.width > vw - 8) x = px - rect.width - offset;
  if (y + rect.height > vh - 8) y = py - rect.height - offset;
  if (x < 8) x = 8;
  if (y < 8) y = 8;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Level-of-detail (LOD)
// ---------------------------------------------------------------------------

function updateLevelOfDetail() {
  var newLevel;
  if (currentZoom < 0.3) {
    newLevel = 2;
  } else if (currentZoom < 0.5) {
    newLevel = 1;
  } else {
    newLevel = 0;
  }

  if (newLevel === currentLodLevel) return;
  currentLodLevel = newLevel;

  if (nodeLabelsGroup) {
    nodeLabelsGroup.style('display', newLevel >= 1 ? 'none' : null);
  }
  if (edgeLabelsGroup) {
    edgeLabelsGroup.style('display', (newLevel >= 1 || !edgeLabelsVisible) ? 'none' : null);
  }
  if (edgesGroup) {
    edgesGroup.style('display', newLevel >= 2 ? 'none' : null);
  }
}

// ---------------------------------------------------------------------------
// Edge label toggle (with per-type dropdown)
// ---------------------------------------------------------------------------

function initEdgeLabelToggle() {
  var btn = document.getElementById('edge-labels-btn');
  if (!btn) return;

  btn.classList.toggle('active', edgeLabelsVisible);
  applyEdgeLabelVisibility();

  // Build dropdown
  var dropdown = document.createElement('div');
  dropdown.className = 'edge-labels-dropdown hidden';
  dropdown.id = 'edge-labels-dropdown';

  // "All" toggle row
  var allRow = document.createElement('div');
  allRow.className = 'edge-labels-dropdown-item edge-labels-all-toggle';
  var allCheck = document.createElement('input');
  allCheck.type = 'checkbox';
  allCheck.checked = edgeLabelsVisible;
  allCheck.id = 'edge-labels-all-check';
  var allLabel = document.createElement('label');
  allLabel.textContent = 'All labels';
  allLabel.setAttribute('for', 'edge-labels-all-check');
  allLabel.style.fontWeight = '600';
  allRow.appendChild(allCheck);
  allRow.appendChild(allLabel);
  dropdown.appendChild(allRow);

  var divider = document.createElement('div');
  divider.className = 'edge-labels-dropdown-divider';
  dropdown.appendChild(divider);

  // Per-type rows
  Object.keys(EDGE_TYPE_COLORS).forEach(function (type) {
    var row = document.createElement('div');
    row.className = 'edge-labels-dropdown-item';

    var dot = document.createElement('span');
    dot.className = 'edge-type-dot';
    dot.style.background = EDGE_TYPE_COLORS[type];
    row.appendChild(dot);

    var check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !hiddenEdgeLabelTypes.has(type);
    check.setAttribute('data-edge-type', type);
    check.id = 'edge-type-' + type;
    row.appendChild(check);

    var label = document.createElement('label');
    label.textContent = type;
    label.setAttribute('for', 'edge-type-' + type);
    row.appendChild(label);

    check.addEventListener('change', function () {
      if (check.checked) {
        hiddenEdgeLabelTypes.delete(type);
      } else {
        hiddenEdgeLabelTypes.add(type);
      }
      persistHiddenEdgeTypes();
      applyEdgeLabelVisibility();
      updateAllCheckState();
    });

    dropdown.appendChild(row);
  });

  // Insert dropdown after button
  btn.parentElement.style.position = 'relative';
  btn.insertAdjacentElement('afterend', dropdown);

  // Toggle dropdown on click
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    var isHidden = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden', !isHidden);
  });

  // All toggle handler
  allCheck.addEventListener('change', function () {
    edgeLabelsVisible = allCheck.checked;
    localStorage.setItem('laminark-edge-labels', edgeLabelsVisible ? 'true' : 'false');
    btn.classList.toggle('active', edgeLabelsVisible);
    applyEdgeLabelVisibility();
  });

  // Close on outside click
  document.addEventListener('click', function (e) {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  function updateAllCheckState() {
    var anyHidden = hiddenEdgeLabelTypes.size > 0;
    allCheck.checked = edgeLabelsVisible;
    allCheck.indeterminate = edgeLabelsVisible && anyHidden;
  }
}

function persistHiddenEdgeTypes() {
  localStorage.setItem('laminark-hidden-edge-types', JSON.stringify(Array.from(hiddenEdgeLabelTypes)));
}

function applyEdgeLabelVisibility() {
  if (!edgeLabelsGroup) return;
  // Hide entire group if master toggle off or LOD too low
  if (!edgeLabelsVisible || currentLodLevel >= 1) {
    edgeLabelsGroup.style('display', 'none');
    return;
  }
  edgeLabelsGroup.style('display', null);

  // Per-type visibility
  if (hiddenEdgeLabelTypes.size > 0) {
    edgeLabelsGroup.selectAll('.edge-label')
      .style('display', function (d) {
        return hiddenEdgeLabelTypes.has(d.type) ? 'none' : null;
      });
  } else {
    edgeLabelsGroup.selectAll('.edge-label').style('display', null);
  }
}

// ---------------------------------------------------------------------------
// Detail panel helpers
// ---------------------------------------------------------------------------

function hideDetailPanel() {
  var panel = document.getElementById('detail-panel');
  if (panel) panel.classList.add('hidden');
  selectedNodeId = null;
  if (nodesGroup) nodesGroup.selectAll('.node-group').classed('selected', false);
}

function selectAndCenterNode(nodeId) {
  if (!svg) return;
  var node = nodeData.find(function (d) { return d.id === nodeId; });
  if (!node || node.x == null) return;

  selectedNodeId = nodeId;
  if (nodesGroup) {
    nodesGroup.selectAll('.node-group').classed('selected', function (d) { return d.id === nodeId; });
  }

  // Center on node
  var width = containerEl ? containerEl.clientWidth : 800;
  var height = containerEl ? containerEl.clientHeight : 600;
  var transform = d3.zoomIdentity
    .translate(width / 2, height / 2)
    .scale(currentZoom || 1)
    .translate(-node.x, -node.y);
  svg.transition().duration(300).call(zoomBehavior.transform, transform);

  // Fetch and show details
  if (window.laminarkApp && window.laminarkApp.fetchNodeDetails) {
    window.laminarkApp.fetchNodeDetails(nodeId).then(function (details) {
      if (details && window.laminarkApp.showNodeDetails) {
        window.laminarkApp.showNodeDetails(details);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Search functions
// ---------------------------------------------------------------------------

function searchNodes(query) {
  if (!query) return [];
  var lowerQuery = query.toLowerCase();
  var results = [];

  nodeData.forEach(function (d) {
    var label = (d.label || '').toLowerCase();
    if (label.indexOf(lowerQuery) >= 0) {
      results.push({ id: d.id, label: d.label, type: d.type });
    }
  });

  results.sort(function (a, b) {
    var aLower = a.label.toLowerCase();
    var bLower = b.label.toLowerCase();
    if (aLower === lowerQuery && bLower !== lowerQuery) return -1;
    if (aLower !== lowerQuery && bLower === lowerQuery) return 1;
    if (aLower.startsWith(lowerQuery) && !bLower.startsWith(lowerQuery)) return -1;
    if (!aLower.startsWith(lowerQuery) && bLower.startsWith(lowerQuery)) return 1;
    return 0;
  });

  return results.slice(0, 20);
}

function highlightSearchMatches(matchIds) {
  if (!nodesGroup || !edgesGroup) return;
  var idSet = new Set(matchIds);

  nodesGroup.selectAll('.node-group')
    .classed('search-match', function (d) { return idSet.has(d.id); })
    .classed('search-dimmed', function (d) { return !idSet.has(d.id); });

  nodeLabelsGroup.selectAll('.node-label')
    .classed('search-dimmed', function (d) { return !idSet.has(d.id); });

  edgesGroup.selectAll('.edge')
    .classed('search-dimmed', function (d) {
      var srcId = typeof d.source === 'object' ? d.source.id : d.source;
      var tgtId = typeof d.target === 'object' ? d.target.id : d.target;
      return !(idSet.has(srcId) && idSet.has(tgtId));
    });

  edgeLabelsGroup.selectAll('.edge-label')
    .classed('search-dimmed', function (d) {
      var srcId = typeof d.source === 'object' ? d.source.id : d.source;
      var tgtId = typeof d.target === 'object' ? d.target.id : d.target;
      return !(idSet.has(srcId) && idSet.has(tgtId));
    });
}

function clearSearchHighlight() {
  if (!nodesGroup) return;
  nodesGroup.selectAll('.node-group').classed('search-match', false).classed('search-dimmed', false);
  nodeLabelsGroup.selectAll('.node-label').classed('search-dimmed', false);
  edgesGroup.selectAll('.edge').classed('search-dimmed', false);
  edgeLabelsGroup.selectAll('.edge-label').classed('search-dimmed', false);
}

function highlightCluster(nodeIds) {
  highlightSearchMatches(nodeIds);
}

// ---------------------------------------------------------------------------
// Performance stats overlay
// ---------------------------------------------------------------------------

function togglePerfOverlay() {
  perfOverlayVisible = !perfOverlayVisible;
  if (perfOverlayVisible) showPerfOverlay();
  else hidePerfOverlay();
}

function showPerfOverlay() {
  if (!containerEl) return;
  if (!perfOverlayEl) {
    perfOverlayEl = document.createElement('div');
    perfOverlayEl.className = 'perf-overlay';
    containerEl.appendChild(perfOverlayEl);
  }
  perfOverlayEl.style.display = '';
  perfLastFpsTime = performance.now();
  perfFrameCount = 0;
  updatePerfOverlay();
}

function hidePerfOverlay() {
  if (perfOverlayEl) perfOverlayEl.style.display = 'none';
  if (perfRafId) { cancelAnimationFrame(perfRafId); perfRafId = null; }
}

function updatePerfOverlay() {
  if (!perfOverlayVisible || !perfOverlayEl) return;

  perfFrameCount++;
  var now = performance.now();
  if (now - perfLastFpsTime >= 1000) {
    perfFps = Math.round((perfFrameCount * 1000) / (now - perfLastFpsTime));
    perfFrameCount = 0;
    perfLastFpsTime = now;
  }

  var total = nodeData.length;
  var visible = nodeData.filter(function (d) { return !d.hidden; }).length;
  var totalEdges = edgeData.length;
  var lodText = currentLodLevel === 0 ? 'Full' : currentLodLevel === 1 ? 'No labels' : 'Minimal';

  perfOverlayEl.textContent =
    'Nodes: ' + visible + '/' + total +
    ' | Edges: ' + totalEdges +
    ' | FPS: ' + perfFps +
    ' | Zoom: ' + currentZoom.toFixed(2) +
    ' | LOD: ' + lodText;

  perfRafId = requestAnimationFrame(updatePerfOverlay);
}

// ---------------------------------------------------------------------------
// Batch update optimization for SSE events
// ---------------------------------------------------------------------------

function queueBatchUpdate(update) {
  batchQueue.push(update);
  if (batchFlushTimer) clearTimeout(batchFlushTimer);
  batchFlushTimer = setTimeout(flushBatchUpdates, BATCH_DELAY_MS);
}

function flushBatchUpdates() {
  if (!svg || batchQueue.length === 0) return;

  var newNodes = 0;
  var newEdges = 0;

  batchQueue.forEach(function (update) {
    if (update.type === 'addNode') {
      var existing = nodeData.find(function (d) { return d.id === update.data.id; });
      if (existing) {
        Object.assign(existing, update.data);
      } else {
        nodeData.push({
          id: update.data.id,
          label: update.data.label,
          type: update.data.type,
          observationCount: update.data.observationCount || 0,
          createdAt: update.data.createdAt,
          hidden: false,
        });
        newNodes++;
      }
    } else if (update.type === 'addEdge') {
      var edgeExists = edgeData.find(function (d) { return d.id === update.data.id; });
      var srcExists = nodeData.find(function (d) { return d.id === update.data.source; });
      var tgtExists = nodeData.find(function (d) { return d.id === update.data.target; });
      if (!edgeExists && srcExists && tgtExists) {
        edgeData.push({
          id: update.data.id,
          source: update.data.source,
          target: update.data.target,
          type: update.data.type,
          label: update.data.label || update.data.type,
        });
        newEdges++;
      }
    }
  });

  batchQueue = [];
  batchFlushTimer = null;

  if (newNodes > 0 || newEdges > 0) {
    hideEmptyState();
    renderGraph();
    if (!isStaticLayout && simulation) simulation.alpha(0.3).restart();
    console.log('[laminark:graph] Batch update: added ' + newNodes + ' nodes, ' + newEdges + ' edges');
  }

  updateGraphStatsFromData();
}

// ---------------------------------------------------------------------------
// Focus mode (drill-down)
// ---------------------------------------------------------------------------

var _focusFetching = false;

async function enterFocusMode(nodeId, label) {
  if (!svg || _focusFetching) return;

  if (!isFocusMode) {
    cachedFullData = {
      nodes: nodeData.map(function (d) {
        var copy = Object.assign({}, d);
        delete copy.x; delete copy.y; delete copy.vx; delete copy.vy;
        delete copy.fx; delete copy.fy; delete copy.index;
        return copy;
      }),
      edges: edgeData.map(function (d) {
        return {
          id: d.id,
          source: typeof d.source === 'object' ? d.source.id : d.source,
          target: typeof d.target === 'object' ? d.target.id : d.target,
          type: d.type,
          label: d.label,
        };
      }),
    };
  }

  _focusFetching = true;
  var data;
  try {
    var res = await fetch('/api/node/' + encodeURIComponent(nodeId) + '/neighborhood?depth=1');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    console.error('[laminark:graph] Failed to fetch neighborhood:', err);
    _focusFetching = false;
    return;
  }

  if (!data.nodes || data.nodes.length === 0) { _focusFetching = false; return; }

  isFocusMode = true;
  // Prevent duplicate consecutive breadcrumb entries
  var top = focusStack.length > 0 ? focusStack[focusStack.length - 1] : null;
  if (!top || top.nodeId !== nodeId) {
    focusStack.push({ nodeId: nodeId, label: label });
  }

  nodeData = data.nodes.map(function (node) {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      observationCount: node.observationCount || 0,
      createdAt: node.createdAt,
      hidden: false,
    };
  });

  edgeData = data.edges.map(function (edge) {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      label: edge.type,
    };
  });

  renderGraph();
  setTimeout(function () { fitToView(); }, 600);

  _focusFetching = false;
  updateBreadcrumbs();
  updateGraphStatsFromData();
  console.log('[laminark:graph] Focus mode: centered on', label, '(' + data.nodes.length + ' nodes)');
}

function exitFocusMode() {
  if (!svg || !isFocusMode) return;

  isFocusMode = false;
  focusStack = [];

  if (cachedFullData) {
    nodeData = cachedFullData.nodes;
    edgeData = cachedFullData.edges;
    cachedFullData = null;
    renderGraph();
    setTimeout(function () { fitToView(); }, 600);
  } else {
    loadGraphData();
  }

  updateBreadcrumbs();
  updateGraphStatsFromData();
  console.log('[laminark:graph] Exited focus mode');
}

function navigateBreadcrumb(index) {
  if (index < 0) { exitFocusMode(); return; }
  var target = focusStack[index];
  if (!target) return;
  // Trim stack to just before the target — enterFocusMode will re-push it.
  // Keep isFocusMode true so enterFocusMode doesn't overwrite cachedFullData.
  focusStack = focusStack.slice(0, index);
  enterFocusMode(target.nodeId, target.label);
}

function updateBreadcrumbs() {
  var bar = document.getElementById('graph-breadcrumbs');
  if (!bar) return;

  if (!isFocusMode || focusStack.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  bar.innerHTML = '';

  var rootBtn = document.createElement('button');
  rootBtn.className = 'breadcrumb-item';
  rootBtn.textContent = 'Full Graph';
  rootBtn.addEventListener('click', function () { exitFocusMode(); });
  bar.appendChild(rootBtn);

  focusStack.forEach(function (item, idx) {
    var sep = document.createElement('span');
    sep.className = 'breadcrumb-separator';
    sep.textContent = '>';
    bar.appendChild(sep);

    var btn = document.createElement('button');
    btn.className = 'breadcrumb-item';
    if (idx === focusStack.length - 1) btn.classList.add('current');
    btn.textContent = item.label;
    btn.addEventListener('click', (function (i) {
      return function () {
        if (i < focusStack.length - 1) navigateBreadcrumb(i);
      };
    })(idx));
    bar.appendChild(btn);
  });
}

// ---------------------------------------------------------------------------
// Layout selector
// ---------------------------------------------------------------------------

function setLayout(layoutName) {
  var validLayouts = ['clustered', 'hierarchical', 'concentric', 'communities'];
  if (validLayouts.indexOf(layoutName) === -1) return;

  var previousLayout = currentLayout;
  currentLayout = layoutName;
  localStorage.setItem('laminark-layout', layoutName);

  var btns = document.querySelectorAll('.layout-btn');
  btns.forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-layout') === layoutName);
  });

  if (previousLayout === 'communities' && layoutName !== 'communities') {
    clearCommunityColors();
  }

  if (!isFocusMode && nodeData.length > 0) {
    if (layoutName === 'communities') {
      applyCommunitiesLayout();
    } else if (layoutName === 'hierarchical') {
      applyHierarchicalLayout();
    } else if (layoutName === 'concentric') {
      applyConcentricLayout();
    } else {
      applyClusteredLayout();
    }
  }
}

function applyClusteredLayout() {
  isStaticLayout = false;
  // Release any fixed positions from other layouts
  nodeData.forEach(function (d) { d.fx = null; d.fy = null; });
  renderGraph();
  if (simulation) simulation.alpha(1).restart();
  setTimeout(function () { fitToView(); }, 800);
}

function applyHierarchicalLayout() {
  isStaticLayout = true;
  if (simulation) simulation.stop();

  var visibleNodes = nodeData.filter(function (d) { return !d.hidden; });
  if (visibleNodes.length === 0) return;

  var width = containerEl ? containerEl.clientWidth : 800;
  var height = containerEl ? containerEl.clientHeight : 600;

  // Find root nodes (Project type or no incoming edges)
  var incomingSet = new Set();
  edgeData.forEach(function (e) {
    var tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    incomingSet.add(tgtId);
  });

  var roots = visibleNodes.filter(function (d) {
    return d.type === 'Project' || !incomingSet.has(d.id);
  });
  if (roots.length === 0) roots = [visibleNodes[0]];

  // BFS to assign depth layers
  var nodeDepth = {};
  var visited = new Set();
  var queue = [];
  roots.forEach(function (r) {
    nodeDepth[r.id] = 0;
    visited.add(r.id);
    queue.push(r.id);
  });

  // Build adjacency (both directions for better BFS coverage)
  var adj = {};
  edgeData.forEach(function (e) {
    var srcId = typeof e.source === 'object' ? e.source.id : e.source;
    var tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    if (!adj[srcId]) adj[srcId] = [];
    adj[srcId].push(tgtId);
    if (!adj[tgtId]) adj[tgtId] = [];
    adj[tgtId].push(srcId);
  });

  while (queue.length > 0) {
    var current = queue.shift();
    var neighbors = adj[current] || [];
    neighbors.forEach(function (n) {
      if (!visited.has(n)) {
        visited.add(n);
        nodeDepth[n] = (nodeDepth[current] || 0) + 1;
        queue.push(n);
      }
    });
  }

  // Assign depth 0 to unvisited (truly disconnected) nodes
  visibleNodes.forEach(function (d) {
    if (nodeDepth[d.id] == null) nodeDepth[d.id] = 0;
  });

  // Group by depth
  var layers = {};
  visibleNodes.forEach(function (d) {
    var depth = nodeDepth[d.id];
    if (!layers[depth]) layers[depth] = [];
    layers[depth].push(d);
  });

  var layerKeys = Object.keys(layers).map(Number).sort(function (a, b) { return a - b; });
  var nodeGap = 60;
  var rowGap = 50;
  var layerGap = 100;
  var maxRowWidth = Math.max(width * 1.5, 800);
  var cx = width / 2;
  var currentY = 80;

  layerKeys.forEach(function (depth) {
    var nodesInLayer = layers[depth];
    // Calculate columns per row to fit within maxRowWidth
    var cols = Math.max(1, Math.floor(maxRowWidth / nodeGap));
    var rows = Math.ceil(nodesInLayer.length / cols);
    var actualCols = Math.min(cols, nodesInLayer.length);
    var layerWidth = actualCols * nodeGap;
    var startX = cx - layerWidth / 2 + nodeGap / 2;

    nodesInLayer.forEach(function (d, i) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      d.x = startX + col * nodeGap;
      d.y = currentY + row * rowGap;
      d.fx = d.x;
      d.fy = d.y;
    });

    currentY += rows * rowGap + layerGap;
  });

  // Re-render with fixed positions
  renderGraph();
  setTimeout(function () { fitToView(); }, 200);
}

function applyConcentricLayout() {
  isStaticLayout = true;
  if (simulation) simulation.stop();

  var visibleNodes = nodeData.filter(function (d) { return !d.hidden; });
  if (visibleNodes.length === 0) return;

  var width = containerEl ? containerEl.clientWidth : 800;
  var height = containerEl ? containerEl.clientHeight : 600;
  var cx = width / 2;
  var cy = height / 2;

  var typePriority = { Project: 0, File: 1, Reference: 2, Decision: 3, Problem: 4, Solution: 4 };

  // Group by ring
  var rings = {};
  visibleNodes.forEach(function (d) {
    var ring = typePriority[d.type] != null ? typePriority[d.type] : 4;
    if (!rings[ring]) rings[ring] = [];
    rings[ring].push(d);
  });

  var ringKeys = Object.keys(rings).map(Number).sort(function (a, b) { return a - b; });
  // Dynamic ring spacing: ensure nodes don't overlap on each ring
  var baseSpacing = 100;

  ringKeys.forEach(function (ring, ringIndex) {
    var nodesInRing = rings[ring];
    // Ensure minimum arc spacing between nodes on each ring
    var minArcGap = 30;
    var minRadius = (nodesInRing.length * minArcGap) / (2 * Math.PI);
    var radius = Math.max((ringIndex + 1) * baseSpacing, minRadius);
    nodesInRing.forEach(function (d, i) {
      var angle = (2 * Math.PI * i) / nodesInRing.length;
      d.x = cx + radius * Math.cos(angle);
      d.y = cy + radius * Math.sin(angle);
      d.fx = d.x;
      d.fy = d.y;
    });
  });

  // Re-render with fixed positions
  renderGraph();
  setTimeout(function () { fitToView(); }, 200);
}

function applyCommunitiesLayout() {
  isStaticLayout = false;
  var params = new URLSearchParams();
  if (window.laminarkState && window.laminarkState.currentProject) {
    params.set('project', window.laminarkState.currentProject);
  }

  fetch('/api/graph/communities' + (params.toString() ? '?' + params.toString() : ''))
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.communities) {
        applyCommunityColors(data.communities);

        var width = containerEl ? containerEl.clientWidth : 800;
        var height = containerEl ? containerEl.clientHeight : 600;
        var cx = width / 2;
        var cy = height / 2;

        // Arrange community centers in a circle
        var communities = data.communities;
        var commRadius = Math.min(width, height) * 0.3;

        communities.forEach(function (comm, i) {
          var angle = (2 * Math.PI * i) / communities.length;
          var commCx = cx + commRadius * Math.cos(angle);
          var commCy = cy + commRadius * Math.sin(angle);
          comm.nodeIds.forEach(function (nodeId) {
            var node = nodeData.find(function (d) { return d.id === nodeId; });
            if (node) {
              // Set initial position near community center with some jitter
              node.x = commCx + (Math.random() - 0.5) * 60;
              node.y = commCy + (Math.random() - 0.5) * 60;
            }
          });
        });
      }

      // Reset fixed positions and re-render
      nodeData.forEach(function (d) { d.fx = null; d.fy = null; });
      renderGraph();
      setTimeout(function () { fitToView(); }, 800);
    })
    .catch(function (err) {
      console.error('[laminark:graph] Failed to fetch communities:', err);
      applyClusteredLayout();
    });
}

function initLayoutSelector() {
  var btns = document.querySelectorAll('.layout-btn');
  btns.forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-layout') === currentLayout);
    btn.addEventListener('click', function () {
      setLayout(btn.getAttribute('data-layout'));
    });
  });
}

// ---------------------------------------------------------------------------
// Community coloring
// ---------------------------------------------------------------------------

function applyCommunityColors(communities) {
  communityNodeMap = {};
  communityColorMap = {};
  communities.forEach(function (comm) {
    comm.nodeIds.forEach(function (nodeId) {
      communityNodeMap[nodeId] = comm.id;
      communityColorMap[nodeId] = comm.color;
    });
  });

  // Update node colors
  if (nodesGroup) {
    nodesGroup.selectAll('.node-group path.node-shape')
      .attr('fill', function (d) {
        if (communityColorMap[d.id]) return communityColorMap[d.id];
        return ENTITY_STYLES[d.type] ? ENTITY_STYLES[d.type].color : '#8b949e';
      });
  }
}

function clearCommunityColors() {
  communityNodeMap = {};
  communityColorMap = {};
  if (nodesGroup) {
    nodesGroup.selectAll('.node-group path.node-shape')
      .attr('fill', function (d) {
        return ENTITY_STYLES[d.type] ? ENTITY_STYLES[d.type].color : '#8b949e';
      });
  }
}

// ---------------------------------------------------------------------------
// Show linked nodes of type (context menu action)
// ---------------------------------------------------------------------------

async function showLinkedNodesOfType(nodeId, nodeLabel, filterType) {
  if (!svg || _focusFetching) return;

  if (!isFocusMode) {
    cachedFullData = {
      nodes: nodeData.map(function (d) {
        var copy = Object.assign({}, d);
        delete copy.x; delete copy.y; delete copy.vx; delete copy.vy;
        delete copy.fx; delete copy.fy; delete copy.index;
        return copy;
      }),
      edges: edgeData.map(function (d) {
        return {
          id: d.id,
          source: typeof d.source === 'object' ? d.source.id : d.source,
          target: typeof d.target === 'object' ? d.target.id : d.target,
          type: d.type,
          label: d.label,
        };
      }),
    };
  }

  var data;
  try {
    var res = await fetch('/api/node/' + encodeURIComponent(nodeId) + '/neighborhood?depth=1');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    console.error('[laminark:graph] Failed to fetch neighborhood:', err);
    return;
  }

  if (!data.nodes || data.nodes.length === 0) return;

  var keepIds = new Set();
  keepIds.add(nodeId);
  data.nodes.forEach(function (n) {
    if (n.id === nodeId || n.type === filterType) keepIds.add(n.id);
  });

  var filteredNodes = data.nodes.filter(function (n) { return keepIds.has(n.id); });
  if (filteredNodes.length <= 1) {
    console.log('[laminark:graph] No linked ' + filterType + ' nodes found');
    return;
  }

  isFocusMode = true;
  focusStack.push({ nodeId: nodeId, label: nodeLabel + ' \u2192 ' + filterType });

  nodeData = filteredNodes.map(function (node) {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      observationCount: node.observationCount || 0,
      createdAt: node.createdAt,
      hidden: false,
    };
  });

  edgeData = data.edges
    .filter(function (edge) { return keepIds.has(edge.source) && keepIds.has(edge.target); })
    .map(function (edge) {
      return { id: edge.id, source: edge.source, target: edge.target, type: edge.type, label: edge.type };
    });

  renderGraph();
  setTimeout(function () { fitToView(); }, 600);

  updateBreadcrumbs();
  updateGraphStatsFromData();
  console.log('[laminark:graph] Show linked: ' + filterType + ' from', nodeLabel,
    '(' + filteredNodes.length + ' nodes)');
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function initContextMenu() {
  if (!containerEl) return;

  contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'graph-context-menu hidden';
  containerEl.appendChild(contextMenuEl);

  document.addEventListener('mousedown', function (e) {
    if (contextMenuVisible && contextMenuEl && !contextMenuEl.contains(e.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && contextMenuVisible) hideContextMenu();
  });
}

function showContextMenu(x, y, items) {
  if (!contextMenuEl) return;

  var html = '';
  items.forEach(function (item) {
    if (item.type === 'header') {
      html += '<div class="context-menu-header">' + escapeHtml(item.label) + '</div>';
    } else if (item.type === 'divider') {
      html += '<div class="context-menu-divider"></div>';
    } else if (item.type === 'item') {
      var dot = item.color
        ? '<span class="type-dot" style="background:' + item.color + '"></span>'
        : '';
      html += '<div class="context-menu-item" data-action="' + escapeHtml(item.action) + '">'
        + dot + escapeHtml(item.label) + '</div>';
    }
  });
  contextMenuEl.innerHTML = html;

  contextMenuEl.onclick = function (e) {
    var target = e.target.closest('.context-menu-item');
    if (target) {
      var action = target.getAttribute('data-action');
      var savedTarget = contextMenuTargetNode;
      hideContextMenu();
      contextMenuTargetNode = savedTarget;
      handleContextMenuAction(action);
      contextMenuTargetNode = null;
    }
  };

  contextMenuEl.classList.remove('hidden');
  contextMenuVisible = true;

  var rect = contextMenuEl.getBoundingClientRect();
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  if (x + rect.width > vw) x = vw - rect.width - 8;
  if (y + rect.height > vh) y = vh - rect.height - 8;
  if (x < 0) x = 8;
  if (y < 0) y = 8;

  contextMenuEl.style.left = x + 'px';
  contextMenuEl.style.top = y + 'px';
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function hideContextMenu() {
  if (contextMenuEl) contextMenuEl.classList.add('hidden');
  contextMenuVisible = false;
  contextMenuTargetNode = null;
}

function handleContextMenuAction(action) {
  if (!action) return;

  if (action.startsWith('filter-type:')) {
    var type = action.split(':')[1];
    setActiveTypes([type]);
    syncFilterPills();
  } else if (action.startsWith('show-linked:')) {
    var filterType = action.split(':')[1];
    if (contextMenuTargetNode) {
      showLinkedNodesOfType(contextMenuTargetNode.id, contextMenuTargetNode.label, filterType);
    }
  } else if (action === 'focus') {
    if (contextMenuTargetNode) {
      enterFocusMode(contextMenuTargetNode.id, contextMenuTargetNode.label);
    }
  } else if (action === 'relayout') {
    setLayout(currentLayout);
  } else if (action === 'reset-filters') {
    resetFilters();
    syncFilterPills();
  } else if (action === 'fit') {
    fitToView();
  }
}

function syncFilterPills() {
  var allTypes = Object.keys(ENTITY_STYLES);
  var allActive = activeEntityTypes.size === allTypes.length;

  allTypes.forEach(function (type) {
    var pill = document.querySelector('.filter-pill[data-type="' + type + '"]');
    if (pill) pill.classList.toggle('active', activeEntityTypes.has(type));
  });

  var allPill = document.querySelector('.filter-pill[data-type="all"]');
  if (allPill) allPill.classList.toggle('active', allActive);
}

// Initialize layout selector when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLayoutSelector);
} else {
  initLayoutSelector();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

window.laminarkGraph = {
  initGraph: initGraph,
  loadGraphData: loadGraphData,
  addNode: addNode,
  addEdge: addEdge,
  removeElements: removeElements,
  fitToView: fitToView,
  applyFilter: applyFilter,
  filterByType: filterByType,
  filterByTimeRange: filterByTimeRange,
  resetFilters: resetFilters,
  setActiveTypes: setActiveTypes,
  getTypeCounts: getTypeCounts,
  updateFilterCounts: updateFilterCounts,
  hideDetailPanel: hideDetailPanel,
  selectAndCenterNode: selectAndCenterNode,
  queueBatchUpdate: queueBatchUpdate,
  togglePerfOverlay: togglePerfOverlay,
  enterFocusMode: enterFocusMode,
  exitFocusMode: exitFocusMode,
  setLayout: setLayout,
  isFocusMode: function () { return isFocusMode; },
  ENTITY_STYLES: ENTITY_STYLES,
  getCy: function () { return null; }, // Compatibility stub (no longer Cytoscape)
  searchNodes: searchNodes,
  highlightSearchMatches: highlightSearchMatches,
  clearSearchHighlight: clearSearchHighlight,
  highlightCluster: highlightCluster,
  applyCommunityColors: applyCommunityColors,
  clearCommunityColors: clearCommunityColors,
  showLinkedNodesOfType: showLinkedNodesOfType,
  hideContextMenu: hideContextMenu,
  toggleEdgeLabels: function (type) {
    if (type) {
      if (hiddenEdgeLabelTypes.has(type)) hiddenEdgeLabelTypes.delete(type);
      else hiddenEdgeLabelTypes.add(type);
      persistHiddenEdgeTypes();
    } else {
      edgeLabelsVisible = !edgeLabelsVisible;
      localStorage.setItem('laminark-edge-labels', edgeLabelsVisible ? 'true' : 'false');
      var btn = document.getElementById('edge-labels-btn');
      if (btn) btn.classList.toggle('active', edgeLabelsVisible);
    }
    applyEdgeLabelVisibility();
  },
};
