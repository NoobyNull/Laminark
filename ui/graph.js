/**
 * Laminark Knowledge Graph Visualization
 *
 * Renders the knowledge graph as an interactive Cytoscape.js force-directed
 * layout. Entities appear as colored/shaped nodes by type. Relationships
 * render as labeled directed edges.
 *
 * @module graph
 */

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

  // Node click handler -- show detail panel
  cy.on('tap', 'node', async function (evt) {
    var node = evt.target;
    var nodeId = node.data('id');
    if (window.laminarkApp && window.laminarkApp.fetchNodeDetails) {
      var details = await window.laminarkApp.fetchNodeDetails(nodeId);
      if (details && window.laminarkApp.showNodeDetails) {
        window.laminarkApp.showNodeDetails(details);
      }
    }
  });

  // Click on background closes detail panel
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      var panel = document.getElementById('detail-panel');
      if (panel) panel.classList.add('hidden');
    }
  });

  console.log('[laminark:graph] Cytoscape initialized');
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
  ENTITY_STYLES: ENTITY_STYLES,
  getCy: function () { return cy; },
};
