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
// SSE connection with auto-reconnect
// ---------------------------------------------------------------------------

let eventSource = null;
let reconnectDelay = 3000;
const MAX_RECONNECT_DELAY = 30000;

function updateSSEStatus(status) {
  const indicator = document.getElementById('sse-status');
  if (indicator) {
    indicator.className = 'status-indicator ' + status;
    indicator.title = 'SSE: ' + status;
  }
}

function connectSSE() {
  updateSSEStatus('connecting');

  eventSource = new EventSource('/api/sse');

  eventSource.addEventListener('connected', function (e) {
    console.log('[laminark] SSE connected:', JSON.parse(e.data));
    updateSSEStatus('connected');
    reconnectDelay = 3000; // Reset backoff on successful connection
  });

  eventSource.addEventListener('heartbeat', function (_e) {
    // Heartbeat received -- connection is alive
    updateSSEStatus('connected');
  });

  eventSource.addEventListener('new_observation', function (e) {
    const data = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('laminark:new_observation', { detail: data }));
  });

  eventSource.addEventListener('entity_updated', function (e) {
    const data = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('laminark:entity_updated', { detail: data }));
  });

  eventSource.addEventListener('topic_shift', function (e) {
    const data = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('laminark:topic_shift', { detail: data }));
  });

  eventSource.addEventListener('session_start', function (e) {
    const data = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('laminark:session_start', { detail: data }));
  });

  eventSource.addEventListener('session_end', function (e) {
    const data = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('laminark:session_end', { detail: data }));
  });

  eventSource.onerror = function () {
    console.warn('[laminark] SSE connection error, reconnecting in', reconnectDelay, 'ms');
    updateSSEStatus('disconnected');
    eventSource.close();
    eventSource = null;

    setTimeout(function () {
      connectSSE();
      // Exponential backoff
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, reconnectDelay);
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

      // Show/hide filter bar (only for graph view)
      if (filterBar) {
        filterBar.style.display = targetView === 'graph-view' ? '' : 'none';
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
        // "All" is exclusive -- deactivate others
        pills.forEach(function (p) { p.classList.remove('active'); });
        pill.classList.add('active');
      } else {
        // Toggle this filter
        const allPill = document.querySelector('.filter-pill[data-type="all"]');
        if (allPill) allPill.classList.remove('active');
        pill.classList.toggle('active');

        // If nothing selected, re-activate "All"
        const anyActive = document.querySelector('.filter-pill.active:not([data-type="all"])');
        if (!anyActive && allPill) {
          allPill.classList.add('active');
        }
      }

      // Dispatch filter change event
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
  const panel = document.getElementById('detail-panel');
  const closeBtn = document.getElementById('detail-close');

  if (closeBtn && panel) {
    closeBtn.addEventListener('click', function () {
      panel.classList.add('hidden');
    });
  }
}

function showNodeDetails(nodeData) {
  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const body = document.getElementById('detail-body');

  if (!panel || !title || !body) return;

  title.textContent = nodeData.entity.label;

  let html = '';

  // Entity info
  html += '<div class="detail-section">';
  html += '<div class="detail-section-title">Entity</div>';
  html += '<div class="detail-field"><span class="field-label">Type:</span> ';
  html += '<span class="type-badge" data-type="' + nodeData.entity.type + '">' + nodeData.entity.type + '</span></div>';
  html += '<div class="detail-field"><span class="field-label">Created:</span> <span class="field-value">' + nodeData.entity.createdAt + '</span></div>';
  html += '</div>';

  // Observations
  if (nodeData.observations && nodeData.observations.length > 0) {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Observations (' + nodeData.observations.length + ')</div>';
    nodeData.observations.forEach(function (obs) {
      const text = obs.text.length > 200 ? obs.text.substring(0, 200) + '...' : obs.text;
      html += '<div class="detail-observation">' + escapeHtml(text) + '</div>';
    });
    html += '</div>';
  }

  // Relationships
  if (nodeData.relationships && nodeData.relationships.length > 0) {
    html += '<div class="detail-section">';
    html += '<div class="detail-section-title">Relationships (' + nodeData.relationships.length + ')</div>';
    nodeData.relationships.forEach(function (rel) {
      const arrow = rel.direction === 'outgoing' ? ' \u2192 ' : ' \u2190 ';
      html += '<div class="detail-relationship">';
      html += '<span class="rel-type">' + escapeHtml(rel.type) + '</span>';
      html += arrow;
      html += '<span class="rel-target">' + escapeHtml(rel.targetLabel) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  if (!nodeData.observations?.length && !nodeData.relationships?.length) {
    html = '<p class="empty-state">No details available for this node.</p>';
  }

  body.innerHTML = html;
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

  // Initialize and load the knowledge graph
  if (window.laminarkGraph) {
    window.laminarkGraph.initGraph('cy');
    await window.laminarkGraph.loadGraphData();
  }

  // Render timeline
  renderTimeline(timelineData);

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

  // Filter change handler for graph
  document.addEventListener('laminark:filter_change', function (e) {
    if (!window.laminarkGraph) return;
    var types = e.detail ? e.detail.types : null;
    window.laminarkGraph.applyFilter(types);
  });
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
