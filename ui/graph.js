/**
 * Laminark Knowledge Graph Visualization
 *
 * Renders the knowledge graph as an interactive Cytoscape.js force-directed
 * layout. Entities appear as colored/shaped nodes by type. Relationships
 * render as labeled directed edges. Viewport culling hides off-screen nodes
 * for smooth performance at 500+ nodes. Level-of-detail reduces visual
 * complexity at low zoom levels.
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
  Project:  { color: '#58a6ff', shape: 'round-rectangle' },
  File:     { color: '#7ee787', shape: 'rectangle' },
  Decision: { color: '#d2a8ff', shape: 'diamond' },
  Problem:  { color: '#f85149', shape: 'triangle' },
  Solution: { color: '#3fb950', shape: 'star' },
  Tool:     { color: '#f0883e', shape: 'hexagon' },
  Person:   { color: '#79c0ff', shape: 'ellipse' },
};

// ---------------------------------------------------------------------------
// Layout settings
// ---------------------------------------------------------------------------

const COSE_DEFAULTS = {
  name: 'cose',
  animate: true,
  animationDuration: 500,
  nodeRepulsion: function () { return 400000; },
  idealEdgeLength: function () { return 100; },
  gravity: 0.25,
  numIter: 1000,
  nodeDimensionsIncludeLabels: true,
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let cy = null;
var activeEntityTypes = new Set(Object.keys(ENTITY_STYLES)); // All types active initially

// Viewport culling state
var cullingEnabled = true;
var isLayoutAnimating = false;

// Level-of-detail state
var currentLodLevel = 0; // 0 = full, 1 = no labels (zoom < 0.5), 2 = no edges (zoom < 0.3)

// Performance stats overlay state
var perfOverlayVisible = false;
var perfOverlayEl = null;
var perfFrameCount = 0;
var perfLastFpsTime = 0;
var perfFps = 0;
var perfRafId = null;

// Batch update queue for SSE events
var batchQueue = [];
var batchFlushTimer = null;
var BATCH_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// initGraph
// ---------------------------------------------------------------------------

/**
 * Creates a Cytoscape instance targeting the given container.
 * @param {string} containerId - DOM element ID for the graph container
 * @returns {object} The Cytoscape instance
 */
function initGraph(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error('[laminark:graph] Container not found:', containerId);
    return null;
  }

  cy = cytoscape({
    container: container,
    style: buildCytoscapeStyles(),
    layout: { name: 'preset' }, // No layout until data loads
    boxSelectionEnabled: false,
    panningEnabled: true,
    userPanningEnabled: true,
    zoomingEnabled: true,
    userZoomingEnabled: true,
    minZoom: 0.1,
    maxZoom: 3.0,
    autoungrabify: false, // Allow node dragging
  });

  // Node click handler -- show detail panel and highlight selected node
  cy.on('tap', 'node', async function (evt) {
    var node = evt.target;
    var nodeId = node.data('id');

    // Highlight the selected node
    cy.$(':selected').unselect();
    node.select();

    if (window.laminarkApp && window.laminarkApp.fetchNodeDetails) {
      var details = await window.laminarkApp.fetchNodeDetails(nodeId);
      if (details && window.laminarkApp.showNodeDetails) {
        window.laminarkApp.showNodeDetails(details);
      }
    }
  });

  // Click on background closes detail panel and deselects all
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      hideDetailPanel();
    }
  });

  // Viewport culling: hide off-screen nodes for performance
  var debouncedCull = debounce(cullOffscreen, 100);
  cy.on('viewport', debouncedCull);
  cy.on('pan', debouncedCull);
  cy.on('zoom', debouncedCull);

  // Level-of-detail: simplify rendering at low zoom levels
  var debouncedLod = debounce(updateLevelOfDetail, 100);
  cy.on('zoom', debouncedLod);

  // Track layout animation state to disable culling during animation
  cy.on('layoutstart', function () { isLayoutAnimating = true; });
  cy.on('layoutstop', function () {
    isLayoutAnimating = false;
    cullOffscreen(); // Re-cull after layout settles
  });

  // Performance stats keyboard shortcut: Ctrl+Shift+P
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      togglePerfOverlay();
    }
  });

  console.log('[laminark:graph] Cytoscape initialized with viewport culling and LOD');
  return cy;
}

// ---------------------------------------------------------------------------
// buildCytoscapeStyles
// ---------------------------------------------------------------------------

function buildCytoscapeStyles() {
  var styles = [
    // Base node style
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '11px',
        'color': '#c9d1d9',
        'text-outline-width': 2,
        'text-outline-color': '#0d1117',
        'width': 'mapData(observationCount, 0, 50, 30, 80)',
        'height': 'mapData(observationCount, 0, 50, 30, 80)',
      },
    },
  ];

  // Per-type node styles
  Object.keys(ENTITY_STYLES).forEach(function (type) {
    styles.push({
      selector: 'node[type="' + type + '"]',
      style: {
        'background-color': ENTITY_STYLES[type].color,
        'shape': ENTITY_STYLES[type].shape,
      },
    });
  });

  // Edge style
  styles.push({
    selector: 'edge',
    style: {
      'label': 'data(type)',
      'font-size': '9px',
      'color': '#8b949e',
      'text-rotation': 'autorotate',
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#30363d',
      'line-color': '#30363d',
      'width': 1.5,
      'opacity': 0.7,
    },
  });

  // Selection styles
  styles.push({
    selector: 'node:selected',
    style: {
      'border-width': 3,
      'border-color': '#f0883e',
    },
  });

  styles.push({
    selector: 'edge:selected',
    style: {
      'line-color': '#f0883e',
      'width': 3,
    },
  });

  // Culled elements (hidden via viewport culling)
  styles.push({
    selector: '.culled',
    style: {
      'display': 'none',
    },
  });

  return styles;
}

// ---------------------------------------------------------------------------
// loadGraphData
// ---------------------------------------------------------------------------

/**
 * Fetches graph data from the API and renders it in Cytoscape.
 * @param {Object} [filters] - Optional filters (type, since)
 * @returns {Promise<{nodeCount: number, edgeCount: number}>}
 */
async function loadGraphData(filters) {
  if (!cy) {
    console.error('[laminark:graph] Cytoscape not initialized');
    return { nodeCount: 0, edgeCount: 0 };
  }

  var data;
  if (window.laminarkApp && window.laminarkApp.fetchGraphData) {
    data = await window.laminarkApp.fetchGraphData(filters);
  } else {
    // Direct fetch fallback
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

  // Handle empty data
  if (!data.nodes.length && !data.edges.length) {
    showEmptyState();
    return { nodeCount: 0, edgeCount: 0 };
  }

  hideEmptyState();

  // Transform API data into Cytoscape elements
  var elements = [];

  data.nodes.forEach(function (node) {
    elements.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.label,
        type: node.type,
        observationCount: node.observationCount || 0,
        createdAt: node.createdAt,
      },
    });
  });

  data.edges.forEach(function (edge) {
    elements.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label || edge.type,
      },
    });
  });

  // Clear and add elements
  cy.elements().remove();
  cy.add(elements);

  // Run force-directed layout
  cy.layout(Object.assign({}, COSE_DEFAULTS)).run();

  // Fit to view after layout settles
  cy.one('layoutstop', function () {
    cy.fit(undefined, 50);
  });

  var counts = { nodeCount: data.nodes.length, edgeCount: data.edges.length };
  updateGraphStats(counts.nodeCount, counts.edgeCount);

  console.log('[laminark:graph] Loaded', counts.nodeCount, 'nodes,', counts.edgeCount, 'edges');
  return counts;
}

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

/**
 * Adds or updates a node in the graph.
 * @param {Object} nodeData - Node data: { id, label, type, observationCount, createdAt }
 */
function addNode(nodeData) {
  if (!cy) return;

  var existing = cy.getElementById(nodeData.id);
  if (existing.length > 0) {
    // Update existing node data
    existing.data(nodeData);
  } else {
    // Add new node
    cy.add({
      group: 'nodes',
      data: {
        id: nodeData.id,
        label: nodeData.label,
        type: nodeData.type,
        observationCount: nodeData.observationCount || 0,
        createdAt: nodeData.createdAt,
      },
    });

    // Run local layout on new node and its neighborhood
    var newNode = cy.getElementById(nodeData.id);
    var neighborhood = newNode.neighborhood().add(newNode);
    neighborhood.layout(Object.assign({}, COSE_DEFAULTS, {
      animate: true,
      animationDuration: 300,
      fit: false,
    })).run();

    hideEmptyState();
  }

  updateGraphStatsFromCy();
}

/**
 * Adds an edge to the graph.
 * @param {Object} edgeData - Edge data: { id, source, target, type }
 */
function addEdge(edgeData) {
  if (!cy) return;

  var existing = cy.getElementById(edgeData.id);
  if (existing.length > 0) return; // Already exists

  // Only add if both endpoints exist
  if (cy.getElementById(edgeData.source).length === 0) return;
  if (cy.getElementById(edgeData.target).length === 0) return;

  cy.add({
    group: 'edges',
    data: {
      id: edgeData.id,
      source: edgeData.source,
      target: edgeData.target,
      type: edgeData.type,
      label: edgeData.label || edgeData.type,
    },
  });

  updateGraphStatsFromCy();
}

/**
 * Removes elements by their IDs.
 * @param {string[]} ids - Array of element IDs to remove
 */
function removeElements(ids) {
  if (!cy) return;

  ids.forEach(function (id) {
    var ele = cy.getElementById(id);
    if (ele.length > 0) {
      ele.remove();
    }
  });

  updateGraphStatsFromCy();

  // Show empty state if graph is now empty
  if (cy.nodes().length === 0) {
    showEmptyState();
  }
}

// ---------------------------------------------------------------------------
// Fit to view
// ---------------------------------------------------------------------------

/**
 * Fits the graph view to show all elements with padding.
 */
function fitToView() {
  if (!cy) return;
  cy.fit(undefined, 50);
}

// ---------------------------------------------------------------------------
// Filter handling
// ---------------------------------------------------------------------------

/**
 * Applies type filters to the graph -- hides nodes not matching the filter.
 * @param {string[]|null} types - Array of type names, or null for "show all"
 */
function applyFilter(types) {
  if (!cy) return;

  if (!types) {
    // Show all
    cy.elements().style('display', 'element');
  } else {
    cy.nodes().forEach(function (node) {
      var nodeType = node.data('type');
      if (types.indexOf(nodeType) >= 0) {
        node.style('display', 'element');
      } else {
        node.style('display', 'none');
      }
    });

    // Hide edges where either endpoint is hidden
    cy.edges().forEach(function (edge) {
      var src = edge.source();
      var tgt = edge.target();
      if (src.style('display') === 'none' || tgt.style('display') === 'none') {
        edge.style('display', 'none');
      } else {
        edge.style('display', 'element');
      }
    });
  }

  updateGraphStatsFromCy();
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function showEmptyState() {
  var container = cy ? cy.container() : null;
  if (!container) return;

  var existing = container.querySelector('.graph-empty-state');
  if (existing) {
    existing.style.display = '';
    return;
  }

  var msg = document.createElement('div');
  msg.className = 'graph-empty-state';
  msg.textContent = 'No graph data yet. Observations will appear here as they are processed.';
  container.appendChild(msg);
}

function hideEmptyState() {
  var container = cy ? cy.container() : null;
  if (!container) return;

  var existing = container.querySelector('.graph-empty-state');
  if (existing) {
    existing.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Stats display
// ---------------------------------------------------------------------------

function updateGraphStats(nodeCount, edgeCount) {
  var el = document.getElementById('graph-stats');
  if (el) {
    el.textContent = nodeCount + ' nodes, ' + edgeCount + ' edges';
  }
}

function updateGraphStatsFromCy() {
  if (!cy) return;
  var visibleNodes = cy.nodes().filter(function (n) { return n.style('display') !== 'none'; });
  var visibleEdges = cy.edges().filter(function (e) { return e.style('display') !== 'none'; });
  updateGraphStats(visibleNodes.length, visibleEdges.length);
}

// ---------------------------------------------------------------------------
// Detail panel helpers
// ---------------------------------------------------------------------------

/**
 * Hides the detail panel and deselects all nodes.
 */
function hideDetailPanel() {
  var panel = document.getElementById('detail-panel');
  if (panel) panel.classList.add('hidden');
  if (cy) cy.$(':selected').unselect();
}

/**
 * Selects a node by ID and centers the graph on it.
 * Used when clicking relationship links in the detail panel.
 * @param {string} nodeId - The ID of the node to select and center
 */
function selectAndCenterNode(nodeId) {
  if (!cy) return;
  var node = cy.getElementById(nodeId);
  if (node.length === 0) return;

  cy.$(':selected').unselect();
  node.select();
  cy.animate({
    center: { eles: node },
    duration: 300,
  });

  // Also fetch and show details for the navigated node
  if (window.laminarkApp && window.laminarkApp.fetchNodeDetails) {
    window.laminarkApp.fetchNodeDetails(nodeId).then(function (details) {
      if (details && window.laminarkApp.showNodeDetails) {
        window.laminarkApp.showNodeDetails(details);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Entity type filtering with state tracking
// ---------------------------------------------------------------------------

/**
 * Toggles an entity type filter on/off.
 * @param {string} type - Entity type to toggle
 */
function filterByType(type) {
  if (activeEntityTypes.has(type)) {
    activeEntityTypes.delete(type);
  } else {
    activeEntityTypes.add(type);
  }
  applyActiveFilters();
}

/**
 * Resets all entity type filters to active (show all).
 */
function resetFilters() {
  Object.keys(ENTITY_STYLES).forEach(function (type) {
    activeEntityTypes.add(type);
  });
  applyActiveFilters();
}

/**
 * Sets which entity types are active (replaces the current set).
 * @param {string[]|null} types - Array of active types, or null for all
 */
function setActiveTypes(types) {
  activeEntityTypes.clear();
  if (!types) {
    Object.keys(ENTITY_STYLES).forEach(function (t) { activeEntityTypes.add(t); });
  } else {
    types.forEach(function (t) { activeEntityTypes.add(t); });
  }
  applyActiveFilters();
}

/**
 * Applies the current activeEntityTypes + time range filter to the graph.
 */
function applyActiveFilters() {
  if (!cy) return;

  var allActive = activeEntityTypes.size === Object.keys(ENTITY_STYLES).length;

  if (allActive && !activeTimeRange.from && !activeTimeRange.to) {
    // Show all
    cy.elements().style('display', 'element');
  } else {
    cy.nodes().forEach(function (node) {
      var nodeType = node.data('type');
      var typeOk = activeEntityTypes.has(nodeType);

      // Time range check
      var timeOk = true;
      if (activeTimeRange.from || activeTimeRange.to) {
        var createdAt = node.data('createdAt');
        if (createdAt) {
          if (activeTimeRange.from && createdAt < activeTimeRange.from) timeOk = false;
          if (activeTimeRange.to && createdAt > activeTimeRange.to) timeOk = false;
        }
      }

      if (typeOk && timeOk) {
        node.style('display', 'element');
      } else {
        node.style('display', 'none');
      }
    });

    // Hide edges where either endpoint is hidden
    cy.edges().forEach(function (edge) {
      var src = edge.source();
      var tgt = edge.target();
      if (src.style('display') === 'none' || tgt.style('display') === 'none') {
        edge.style('display', 'none');
      } else {
        edge.style('display', 'element');
      }
    });
  }

  updateGraphStatsFromCy();
  updateFilterCounts();

  // Fit visible elements
  var visible = cy.elements(':visible');
  if (visible.length > 0) {
    cy.fit(visible, 50);
  }
}

/**
 * Returns a count of nodes per entity type (total and visible).
 * @returns {Object} Map of type -> { total: number, visible: number }
 */
function getTypeCounts() {
  var counts = {};
  Object.keys(ENTITY_STYLES).forEach(function (type) {
    counts[type] = { total: 0, visible: 0 };
  });

  if (!cy) return counts;

  cy.nodes().forEach(function (node) {
    var type = node.data('type');
    if (counts[type]) {
      counts[type].total++;
      if (node.style('display') !== 'none') {
        counts[type].visible++;
      }
    }
  });

  return counts;
}

/**
 * Updates the count badges on filter pill buttons.
 */
function updateFilterCounts() {
  var counts = getTypeCounts();
  Object.keys(counts).forEach(function (type) {
    var pill = document.querySelector('.filter-pill[data-type="' + type + '"]');
    if (pill) {
      var countEl = pill.querySelector('.count');
      if (countEl) {
        countEl.textContent = counts[type].visible;
      }
    }
  });

  // Update "All" pill count with total visible
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
// Time range state
// ---------------------------------------------------------------------------

var activeTimeRange = { from: null, to: null };

/**
 * Sets a time range filter. Nodes outside this range are hidden.
 * @param {string|null} from - ISO8601 start, or null for no lower bound
 * @param {string|null} to - ISO8601 end, or null for no upper bound
 */
function filterByTimeRange(from, to) {
  activeTimeRange.from = from || null;
  activeTimeRange.to = to || null;
  applyActiveFilters();
}

// ---------------------------------------------------------------------------
// Viewport culling
// ---------------------------------------------------------------------------

/**
 * Hides elements that are outside the visible viewport plus a buffer zone.
 * Respects filter state: nodes hidden by filters stay hidden regardless.
 */
function cullOffscreen() {
  if (!cy || !cullingEnabled || isLayoutAnimating) return;

  var ext = cy.extent();
  var bufferX = ext.w * 0.2;
  var bufferY = ext.h * 0.2;
  var viewRect = {
    x1: ext.x1 - bufferX,
    y1: ext.y1 - bufferY,
    x2: ext.x2 + bufferX,
    y2: ext.y2 + bufferY,
  };

  cy.nodes().forEach(function (node) {
    // Skip nodes hidden by entity type or time range filters
    if (node.style('display') === 'none' && !node.hasClass('culled')) return;

    var pos = node.position();
    var inView = pos.x >= viewRect.x1 && pos.x <= viewRect.x2 &&
                 pos.y >= viewRect.y1 && pos.y <= viewRect.y2;

    if (inView) {
      node.removeClass('culled');
    } else {
      node.addClass('culled');
    }
  });

  // Cull edges where BOTH endpoints are culled
  cy.edges().forEach(function (edge) {
    var src = edge.source();
    var tgt = edge.target();
    if (src.hasClass('culled') && tgt.hasClass('culled')) {
      edge.addClass('culled');
    } else {
      edge.removeClass('culled');
    }
  });
}

// ---------------------------------------------------------------------------
// Level-of-detail (LOD)
// ---------------------------------------------------------------------------

/**
 * Adjusts visual detail based on zoom level:
 * - zoom >= 0.5: full detail (labels + edges + shapes)
 * - zoom < 0.5: hide labels for cleaner view
 * - zoom < 0.3: hide edges entirely, show only nodes as simple circles
 */
function updateLevelOfDetail() {
  if (!cy) return;

  var zoom = cy.zoom();
  var newLevel;

  if (zoom < 0.3) {
    newLevel = 2; // Minimal: no labels, no edges
  } else if (zoom < 0.5) {
    newLevel = 1; // Reduced: no labels
  } else {
    newLevel = 0; // Full detail
  }

  if (newLevel === currentLodLevel) return;
  currentLodLevel = newLevel;

  if (newLevel === 0) {
    // Full detail: restore labels and edges
    cy.style()
      .selector('node').style('label', 'data(label)').update();
    cy.style()
      .selector('edge').style('label', 'data(type)').style('display', 'element').update();
    console.log('[laminark:graph] LOD: full detail');
  } else if (newLevel === 1) {
    // Reduced: hide labels but keep edges
    cy.style()
      .selector('node').style('label', '').update();
    cy.style()
      .selector('edge').style('label', '').style('display', 'element').update();
    console.log('[laminark:graph] LOD: no labels (zoom < 0.5)');
  } else {
    // Minimal: hide labels and edges, simplify node shapes
    cy.style()
      .selector('node').style('label', '').update();
    cy.style()
      .selector('edge').style('display', 'none').update();
    console.log('[laminark:graph] LOD: minimal (zoom < 0.3)');
  }
}

// ---------------------------------------------------------------------------
// Performance stats overlay
// ---------------------------------------------------------------------------

/**
 * Toggles the performance overlay showing visible/total nodes, FPS, and culling status.
 * Keyboard shortcut: Ctrl+Shift+P
 */
function togglePerfOverlay() {
  perfOverlayVisible = !perfOverlayVisible;

  if (perfOverlayVisible) {
    showPerfOverlay();
  } else {
    hidePerfOverlay();
  }
}

function showPerfOverlay() {
  if (!cy) return;
  var container = cy.container();
  if (!container) return;

  if (!perfOverlayEl) {
    perfOverlayEl = document.createElement('div');
    perfOverlayEl.className = 'perf-overlay';
    container.appendChild(perfOverlayEl);
  }

  perfOverlayEl.style.display = '';
  perfLastFpsTime = performance.now();
  perfFrameCount = 0;
  updatePerfOverlay();
}

function hidePerfOverlay() {
  if (perfOverlayEl) {
    perfOverlayEl.style.display = 'none';
  }
  if (perfRafId) {
    cancelAnimationFrame(perfRafId);
    perfRafId = null;
  }
}

function updatePerfOverlay() {
  if (!perfOverlayVisible || !cy || !perfOverlayEl) return;

  perfFrameCount++;
  var now = performance.now();
  var elapsed = now - perfLastFpsTime;

  if (elapsed >= 1000) {
    perfFps = Math.round((perfFrameCount * 1000) / elapsed);
    perfFrameCount = 0;
    perfLastFpsTime = now;
  }

  var totalNodes = cy.nodes().length;
  var culledNodes = cy.nodes('.culled').length;
  var visibleNodes = totalNodes - culledNodes;
  var totalEdges = cy.edges().length;
  var zoom = cy.zoom().toFixed(2);
  var lodText = currentLodLevel === 0 ? 'Full' : currentLodLevel === 1 ? 'No labels' : 'Minimal';

  perfOverlayEl.textContent =
    'Nodes: ' + visibleNodes + '/' + totalNodes +
    ' | Culled: ' + culledNodes +
    ' | Edges: ' + totalEdges +
    ' | FPS: ' + perfFps +
    ' | Zoom: ' + zoom +
    ' | LOD: ' + lodText;

  perfRafId = requestAnimationFrame(updatePerfOverlay);
}

// ---------------------------------------------------------------------------
// Batch update optimization for SSE events
// ---------------------------------------------------------------------------

/**
 * Queues a graph update from an SSE event. Events are collected for
 * BATCH_DELAY_MS and then flushed together with a single layout run.
 * @param {Object} update - { type: 'addNode'|'addEdge', data: Object }
 */
function queueBatchUpdate(update) {
  batchQueue.push(update);

  if (batchFlushTimer) clearTimeout(batchFlushTimer);
  batchFlushTimer = setTimeout(flushBatchUpdates, BATCH_DELAY_MS);
}

/**
 * Flushes all queued graph updates, applying them in batch with a
 * single layout run to prevent layout thrashing.
 */
function flushBatchUpdates() {
  if (!cy || batchQueue.length === 0) return;

  var nodes = [];
  var edges = [];

  batchQueue.forEach(function (update) {
    if (update.type === 'addNode') {
      var existing = cy.getElementById(update.data.id);
      if (existing.length > 0) {
        existing.data(update.data);
      } else {
        nodes.push({
          group: 'nodes',
          data: {
            id: update.data.id,
            label: update.data.label,
            type: update.data.type,
            observationCount: update.data.observationCount || 0,
            createdAt: update.data.createdAt,
          },
        });
      }
    } else if (update.type === 'addEdge') {
      if (cy.getElementById(update.data.id).length === 0 &&
          cy.getElementById(update.data.source).length > 0 &&
          cy.getElementById(update.data.target).length > 0) {
        edges.push({
          group: 'edges',
          data: {
            id: update.data.id,
            source: update.data.source,
            target: update.data.target,
            type: update.data.type,
            label: update.data.label || update.data.type,
          },
        });
      }
    }
  });

  batchQueue = [];
  batchFlushTimer = null;

  // Add all new elements at once
  var newEles = nodes.concat(edges);
  if (newEles.length > 0) {
    cy.add(newEles);

    // Run a single local layout for new nodes
    if (nodes.length > 0) {
      var newNodeCollection = cy.collection();
      nodes.forEach(function (n) {
        var el = cy.getElementById(n.data.id);
        if (el.length > 0) newNodeCollection = newNodeCollection.add(el);
      });
      var neighborhood = newNodeCollection.neighborhood().add(newNodeCollection);
      neighborhood.layout(Object.assign({}, COSE_DEFAULTS, {
        animate: true,
        animationDuration: 300,
        fit: false,
      })).run();
    }

    hideEmptyState();
    console.log('[laminark:graph] Batch update: added ' + nodes.length + ' nodes, ' + edges.length + ' edges');
  }

  updateGraphStatsFromCy();
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
  ENTITY_STYLES: ENTITY_STYLES,
  getCy: function () { return cy; },
};
