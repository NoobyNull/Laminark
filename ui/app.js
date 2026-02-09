/**
 * Laminark client-side application.
 *
 * Handles tab navigation, SSE connection with auto-reconnect,
 * REST API data fetching, and initial state loading.
 */

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

window.laminarkState = {
  graph: null,
  timeline: null,
  graphInitialized: false,
  timelineInitialized: false,
};

// ---------------------------------------------------------------------------
// REST API helpers
// ---------------------------------------------------------------------------

/**
 * Fetches graph data (nodes + edges) from the REST API.
 * @param {Object} [filters] - Optional filters
 * @param {string} [filters.type] - Comma-separated entity types
 * @param {string} [filters.since] - ISO8601 timestamp
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
async function fetchGraphData(filters) {
  const params = new URLSearchParams();
  if (filters?.type) params.set('type', filters.type);
  if (filters?.since) params.set('since', filters.since);

  const url = '/api/graph' + (params.toString() ? '?' + params.toString() : '');

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[laminark] Failed to fetch graph data:', err);
    return { nodes: [], edges: [] };
  }
}

/**
 * Fetches timeline data (sessions, observations, topic shifts).
 * @param {Object} [range] - Optional time range
 * @param {string} [range.from] - ISO8601 start
 * @param {string} [range.to] - ISO8601 end
 * @param {number} [range.limit] - Max observations
 * @returns {Promise<{sessions: Array, observations: Array, topicShifts: Array}>}
 */
async function fetchTimelineData(range) {
  const params = new URLSearchParams();
  if (range?.from) params.set('from', range.from);
  if (range?.to) params.set('to', range.to);
  if (range?.limit) params.set('limit', String(range.limit));

  const url = '/api/timeline' + (params.toString() ? '?' + params.toString() : '');

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[laminark] Failed to fetch timeline data:', err);
    return { sessions: [], observations: [], topicShifts: [] };
  }
}

/**
 * Fetches detailed info for a single graph node.
 * @param {string} id - Node ID
 * @returns {Promise<{entity: Object, observations: Array, relationships: Array}|null>}
 */
async function fetchNodeDetails(id) {
  try {
    const res = await fetch(`/api/node/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[laminark] Failed to fetch node details:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSE connection with auto-reconnect and heartbeat watchdog
// ---------------------------------------------------------------------------

let eventSource = null;
let reconnectDelay = 3000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_TIMEOUT_MS = 60000; // 60s with no heartbeat triggers reconnect
let lastEventTime = 0;
let heartbeatWatchdog = null;

function updateSSEStatus(status) {
  var indicator = document.getElementById('sse-status');
  if (indicator) {
    indicator.className = 'status-indicator ' + status;
    updateSSETooltip(indicator, status);
  }
}

function updateSSETooltip(indicator, status) {
  var base = 'SSE: ' + status;
  if (lastEventTime > 0) {
    var ago = Math.round((Date.now() - lastEventTime) / 1000);
    var agoText = ago < 60 ? ago + 's ago' : Math.round(ago / 60) + 'min ago';
    indicator.title = base + ' (last event: ' + agoText + ')';
  } else {
    indicator.title = base;
  }
}

function recordEventReceived() {
  lastEventTime = Date.now();
  resetHeartbeatWatchdog();
}

function resetHeartbeatWatchdog() {
  if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
  heartbeatWatchdog = setTimeout(function () {
    console.warn('[laminark] No heartbeat for ' + (HEARTBEAT_TIMEOUT_MS / 1000) + 's, forcing SSE reconnect');
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    updateSSEStatus('disconnected');
    reconnectWithCatchup();
  }, HEARTBEAT_TIMEOUT_MS);
}

/**
 * Reconnect SSE and fetch fresh data from REST API to catch up on missed events.
 */
function reconnectWithCatchup() {
  setTimeout(function () {
    console.log('[laminark] Reconnecting SSE with data catch-up');
    connectSSE();

    // Belt-and-suspenders: fetch fresh data from REST API to catch up
    if (window.laminarkGraph && window.laminarkState.graphInitialized) {
      var filters = getActiveFilters();
      window.laminarkGraph.loadGraphData(filters ? { type: filters.join(',') } : undefined);
    }
    if (window.laminarkTimeline && window.laminarkState.timelineInitialized) {
      window.laminarkTimeline.loadTimelineData();
    }

    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

function connectSSE() {
  updateSSEStatus('connecting');

  eventSource = new EventSource('/api/sse');

  eventSource.addEventListener('connected', function (e) {
    console.log('[laminark] SSE connected:', JSON.parse(e.data));
    updateSSEStatus('connected');
    reconnectDelay = 3000; // Reset backoff on successful connection
    recordEventReceived();
  });

  eventSource.addEventListener('heartbeat', function (_e) {
    // Heartbeat received -- connection is alive
    updateSSEStatus('connected');
    recordEventReceived();
  });

  eventSource.addEventListener('new_observation', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    document.dispatchEvent(new CustomEvent('laminark:new_observation', { detail: data }));
  });

  eventSource.addEventListener('entity_updated', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    document.dispatchEvent(new CustomEvent('laminark:entity_updated', { detail: data }));
  });

  eventSource.addEventListener('topic_shift', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    document.dispatchEvent(new CustomEvent('laminark:topic_shift', { detail: data }));
  });

  eventSource.addEventListener('session_start', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    document.dispatchEvent(new CustomEvent('laminark:session_start', { detail: data }));
  });

  eventSource.addEventListener('session_end', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    document.dispatchEvent(new CustomEvent('laminark:session_end', { detail: data }));
  });

  eventSource.onerror = function () {
    console.warn('[laminark] SSE connection error, reconnecting in', reconnectDelay, 'ms');
    updateSSEStatus('disconnected');
    eventSource.close();
    eventSource = null;

    if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
    reconnectWithCatchup();
  };
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

function initNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  const views = document.querySelectorAll('.view-container');
  const filterBar = document.getElementById('filter-bar');

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      const targetView = tab.getAttribute('data-view');

      // Update active tab
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');

      // Show target view, hide others
      views.forEach(function (v) {
        v.classList.toggle('active', v.id === targetView);
      });

      // Show/hide filter bar and time range bar (only for graph view)
      if (filterBar) {
        filterBar.style.display = targetView === 'graph-view' ? '' : 'none';
      }
      var timeRangeBar = document.getElementById('time-range-bar');
      if (timeRangeBar) {
        timeRangeBar.style.display = targetView === 'graph-view' ? '' : 'none';
      }

      // Lazy initialization: only init each view when first activated
      if (targetView === 'timeline-view' && !window.laminarkState.timelineInitialized) {
        if (window.laminarkTimeline) {
          window.laminarkTimeline.initTimeline('timeline-view');
          window.laminarkTimeline.loadTimelineData();
          window.laminarkState.timelineInitialized = true;
        }
      } else if (targetView === 'graph-view' && !window.laminarkState.graphInitialized) {
        if (window.laminarkGraph) {
          window.laminarkGraph.initGraph('cy');
          window.laminarkGraph.loadGraphData();
          window.laminarkState.graphInitialized = true;
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function initFilters() {
  const pills = document.querySelectorAll('.filter-pill');

  pills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      const type = pill.getAttribute('data-type');

      if (type === 'all') {
        // "All" is exclusive -- activate all type pills
        pills.forEach(function (p) {
          p.classList.add('active');
        });

        // Reset graph filters
        if (window.laminarkGraph && window.laminarkGraph.resetFilters) {
          window.laminarkGraph.resetFilters();
        }
      } else {
        // Toggle this filter pill
        pill.classList.toggle('active');

        // Check if all type pills are now active
        const typePills = document.querySelectorAll('.filter-pill:not([data-type="all"])');
        const allActive = Array.from(typePills).every(function (p) { return p.classList.contains('active'); });
        const noneActive = !Array.from(typePills).some(function (p) { return p.classList.contains('active'); });
        const allPill = document.querySelector('.filter-pill[data-type="all"]');

        if (allActive || noneActive) {
          // All selected or none selected -- reset to "All"
          pills.forEach(function (p) { p.classList.add('active'); });
          if (window.laminarkGraph && window.laminarkGraph.resetFilters) {
            window.laminarkGraph.resetFilters();
          }
          return;
        }

        // Update "All" pill state
        if (allPill) allPill.classList.remove('active');

        // Use graph.js filterByType for toggle behavior
        if (window.laminarkGraph && window.laminarkGraph.filterByType) {
          window.laminarkGraph.filterByType(type);
        }
      }

      // Dispatch filter change event for any other listeners
      const activeTypes = getActiveFilters();
      document.dispatchEvent(new CustomEvent('laminark:filter_change', { detail: { types: activeTypes } }));
    });
  });
}

function getActiveFilters() {
  const allPill = document.querySelector('.filter-pill[data-type="all"].active');
  if (allPill) return null; // No filter -- show all

  const active = document.querySelectorAll('.filter-pill.active');
  return Array.from(active).map(function (p) { return p.getAttribute('data-type'); });
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function initDetailPanel() {
  const closeBtn = document.getElementById('detail-close');

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      if (window.laminarkGraph && window.laminarkGraph.hideDetailPanel) {
        window.laminarkGraph.hideDetailPanel();
      } else {
        var panel = document.getElementById('detail-panel');
        if (panel) panel.classList.add('hidden');
      }
    });
  }
}

function showNodeDetails(nodeData) {
  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');

  if (!panel || !title || !body) return;

  title.textContent = nodeData.entity.label;

  // Build detail panel content using DOM elements for safety
  body.innerHTML = '';

  // Entity info section
  var entitySection = document.createElement('div');
  entitySection.className = 'detail-section';

  var entityTitle = document.createElement('div');
  entityTitle.className = 'detail-section-title';
  entityTitle.textContent = 'Entity';
  entitySection.appendChild(entityTitle);

  // Type field with colored badge
  var typeField = document.createElement('div');
  typeField.className = 'detail-field';
  var typeLabel = document.createElement('span');
  typeLabel.className = 'field-label';
  typeLabel.textContent = 'Type: ';
  var typeBadge = document.createElement('span');
  typeBadge.className = 'type-badge';
  typeBadge.setAttribute('data-type', nodeData.entity.type);
  typeBadge.textContent = nodeData.entity.type;
  typeField.appendChild(typeLabel);
  typeField.appendChild(typeBadge);
  entitySection.appendChild(typeField);

  // Created date
  var createdField = document.createElement('div');
  createdField.className = 'detail-field';
  var createdLabel = document.createElement('span');
  createdLabel.className = 'field-label';
  createdLabel.textContent = 'Created: ';
  var createdValue = document.createElement('span');
  createdValue.className = 'field-value';
  createdValue.textContent = formatTime(nodeData.entity.createdAt);
  createdField.appendChild(createdLabel);
  createdField.appendChild(createdValue);
  entitySection.appendChild(createdField);

  body.appendChild(entitySection);

  // Observations section -- scrollable list sorted most recent first
  if (nodeData.observations && nodeData.observations.length > 0) {
    var obsSection = document.createElement('div');
    obsSection.className = 'detail-section';

    var obsTitle = document.createElement('div');
    obsTitle.className = 'detail-section-title';
    obsTitle.textContent = 'Observations (' + nodeData.observations.length + ')';
    obsSection.appendChild(obsTitle);

    var obsList = document.createElement('div');
    obsList.className = 'observation-list-panel';

    nodeData.observations.forEach(function (obs) {
      var item = document.createElement('div');
      item.className = 'observation-item';

      var timestamp = document.createElement('span');
      timestamp.className = 'obs-timestamp';
      timestamp.textContent = formatTime(obs.createdAt);
      item.appendChild(timestamp);

      var text = document.createElement('span');
      text.className = 'obs-text-content';
      text.textContent = obs.text.length > 200 ? obs.text.substring(0, 200) + '...' : obs.text;
      item.appendChild(text);

      obsList.appendChild(item);
    });

    obsSection.appendChild(obsList);
    body.appendChild(obsSection);
  }

  // Relationships section -- each clickable to navigate to that node
  if (nodeData.relationships && nodeData.relationships.length > 0) {
    var relSection = document.createElement('div');
    relSection.className = 'detail-section';

    var relTitle = document.createElement('div');
    relTitle.className = 'detail-section-title';
    relTitle.textContent = 'Relationships (' + nodeData.relationships.length + ')';
    relSection.appendChild(relTitle);

    nodeData.relationships.forEach(function (rel) {
      var item = document.createElement('div');
      item.className = 'relationship-item';
      item.setAttribute('data-target-id', rel.targetId);
      item.style.cursor = 'pointer';

      var relType = document.createElement('span');
      relType.className = 'rel-type';
      relType.textContent = rel.type;
      item.appendChild(relType);

      var arrow = document.createElement('span');
      arrow.className = 'rel-arrow';
      arrow.textContent = rel.direction === 'outgoing' ? ' \u2192 ' : ' \u2190 ';
      item.appendChild(arrow);

      var target = document.createElement('span');
      target.className = 'rel-target';
      target.textContent = rel.targetLabel;
      item.appendChild(target);

      // Click to navigate to the related node in the graph
      item.addEventListener('click', function () {
        if (window.laminarkGraph && window.laminarkGraph.selectAndCenterNode) {
          window.laminarkGraph.selectAndCenterNode(rel.targetId);
        }
      });

      relSection.appendChild(item);
    });

    body.appendChild(relSection);
  }

  if (!nodeData.observations?.length && !nodeData.relationships?.length) {
    var emptyMsg = document.createElement('p');
    emptyMsg.className = 'empty-state';
    emptyMsg.textContent = 'No details available for this node.';
    body.appendChild(emptyMsg);
  }

  panel.classList.remove('hidden');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async function () {
  console.log('[laminark] Initializing application');

  initNavigation();
  initFilters();
  initDetailPanel();
  connectSSE();

  // Fetch initial data
  const [graphData, timelineData] = await Promise.all([
    fetchGraphData(),
    fetchTimelineData(),
  ]);

  window.laminarkState.graph = graphData;
  window.laminarkState.timeline = timelineData;

  console.log('[laminark] Initial data loaded:', {
    nodes: graphData.nodes.length,
    edges: graphData.edges.length,
    sessions: timelineData.sessions.length,
    observations: timelineData.observations.length,
  });

  // Initialize the knowledge graph (active by default)
  if (window.laminarkGraph) {
    window.laminarkGraph.initGraph('cy');
    await window.laminarkGraph.loadGraphData();
    window.laminarkState.graphInitialized = true;
  }

  // Initialize timeline module (lazy -- waits for tab click, or pre-init if timeline tab is active)
  var activeTab = document.querySelector('.nav-tab.active');
  if (activeTab && activeTab.getAttribute('data-view') === 'timeline-view') {
    if (window.laminarkTimeline) {
      window.laminarkTimeline.initTimeline('timeline-view');
      window.laminarkTimeline.loadTimelineData();
      window.laminarkState.timelineInitialized = true;
    }
  }

  // Listen for SSE-dispatched events for graph updates
  document.addEventListener('laminark:entity_updated', function (e) {
    if (!window.laminarkGraph) return;
    var data = e.detail;
    if (data && data.id) {
      window.laminarkGraph.addNode({
        id: data.id,
        label: data.label || data.name,
        type: data.type,
        observationCount: data.observationCount || 0,
        createdAt: data.createdAt,
      });
    }
  });

  document.addEventListener('laminark:new_observation', function () {
    // Refresh observation counts by reloading graph data
    if (window.laminarkGraph) {
      var filters = getActiveFilters();
      window.laminarkGraph.loadGraphData(filters ? { type: filters.join(',') } : undefined);
    }
  });

  // Filter change handler for graph (legacy listener)
  document.addEventListener('laminark:filter_change', function () {
    // Filter changes now handled directly in initFilters via graph.filterByType/resetFilters
    // This listener remains for any external consumers
  });

  // After initial graph load, update filter pill counts
  setTimeout(function () {
    if (window.laminarkGraph && window.laminarkGraph.updateFilterCounts) {
      window.laminarkGraph.updateFilterCounts();
    }
  }, 1000);
});

// ---------------------------------------------------------------------------
// Timeline rendering
// ---------------------------------------------------------------------------

function renderTimeline(data) {
  const container = document.getElementById('timeline-content');
  if (!container) return;

  if (!data.sessions.length && !data.observations.length) {
    container.innerHTML = '<p class="empty-state">No timeline data yet. Observations will appear here as they are captured.</p>';
    return;
  }

  let html = '';

  // Group observations by session
  const sessionMap = new Map();
  data.sessions.forEach(function (s) { sessionMap.set(s.id, s); });

  // Observations without sessions
  const ungrouped = data.observations.filter(function (o) { return !o.sessionId; });

  // Build session groups
  if (data.sessions.length > 0) {
    data.sessions.forEach(function (session) {
      const sessionObs = data.observations.filter(function (o) { return o.sessionId === session.id; });
      const shifts = data.topicShifts.filter(function (ts) {
        return ts.timestamp >= session.startedAt && (!session.endedAt || ts.timestamp <= session.endedAt);
      });

      html += '<div class="timeline-session">';
      html += '<div class="timeline-session-header">';
      html += '<span class="session-time">' + formatTime(session.startedAt) + '</span>';
      html += '<span class="session-summary">' + escapeHtml(session.summary || 'Session ' + session.id.substring(0, 8)) + '</span>';
      html += '</div>';

      // Interleave observations and topic shifts by time
      const items = [];
      sessionObs.forEach(function (o) { items.push({ time: o.createdAt, type: 'obs', data: o }); });
      shifts.forEach(function (s) { items.push({ time: s.timestamp, type: 'shift', data: s }); });
      items.sort(function (a, b) { return a.time.localeCompare(b.time); });

      items.forEach(function (item) {
        if (item.type === 'obs') {
          const text = item.data.text.length > 300 ? item.data.text.substring(0, 300) + '...' : item.data.text;
          html += '<div class="timeline-observation">';
          html += '<span class="obs-time">' + formatTime(item.data.createdAt) + '</span>';
          html += '<span class="obs-text">' + escapeHtml(text) + '</span>';
          html += '</div>';
        } else {
          html += '<div class="timeline-topic-shift">';
          html += '\u21BB Topic shift detected';
          if (item.data.confidence != null) {
            html += ' (confidence: ' + (item.data.confidence * 100).toFixed(0) + '%)';
          }
          html += '</div>';
        }
      });

      html += '</div>';
    });
  }

  // Ungrouped observations
  if (ungrouped.length > 0) {
    html += '<div class="timeline-session">';
    html += '<div class="timeline-session-header">';
    html += '<span class="session-summary">Ungrouped observations</span>';
    html += '</div>';
    ungrouped.forEach(function (obs) {
      const text = obs.text.length > 300 ? obs.text.substring(0, 300) + '...' : obs.text;
      html += '<div class="timeline-observation">';
      html += '<span class="obs-time">' + formatTime(obs.createdAt) + '</span>';
      html += '<span class="obs-text">' + escapeHtml(text) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  container.innerHTML = html;
}

function formatTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleString();
  } catch {
    return isoString;
  }
}

// Export helpers for potential use by graph/timeline modules
window.laminarkApp = {
  fetchGraphData: fetchGraphData,
  fetchTimelineData: fetchTimelineData,
  fetchNodeDetails: fetchNodeDetails,
  showNodeDetails: showNodeDetails,
  getActiveFilters: getActiveFilters,
};
