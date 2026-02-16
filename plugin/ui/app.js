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
  toolsInitialized: false,
  currentProject: null,
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
  if (filters?.until) params.set('until', filters.until);
  if (window.laminarkState.currentProject) params.set('project', window.laminarkState.currentProject);

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
  if (window.laminarkState.currentProject) params.set('project', window.laminarkState.currentProject);

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

/**
 * Fetches available projects from the REST API.
 * @returns {Promise<{projects: Array, defaultProject: string|null}>}
 */
async function fetchProjects() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('[laminark] Failed to fetch projects:', err);
    return { projects: [], defaultProject: null };
  }
}

/**
 * Fetches recent debug paths from the REST API.
 * @returns {Promise<{paths: Array}>}
 */
async function fetchPaths() {
  try {
    const params = new URLSearchParams();
    if (window.laminarkState.currentProject) params.set('project', window.laminarkState.currentProject);
    const res = await fetch('/api/paths' + (params.toString() ? '?' + params.toString() : ''));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    console.error('[laminark] Failed to fetch paths:', err);
    return { paths: [] };
  }
}

/**
 * Fetches detail for a single debug path including waypoints.
 * @param {string} pathId - Path ID
 * @returns {Promise<{path: Object, waypoints: Array}|null>}
 */
async function fetchPathDetail(pathId) {
  try {
    const res = await fetch('/api/paths/' + encodeURIComponent(pathId));
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[laminark] Failed to fetch path detail:', err);
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

  // Helper: dispatch SSE events that belong to the currently selected project.
  // Events with a mismatched projectHash are dropped; events without projectHash
  // are allowed through (server may not always tag them, e.g. older builds).
  function dispatchIfCurrentProject(eventName, data) {
    if (data.projectHash && data.projectHash !== window.laminarkState.currentProject) return;
    document.dispatchEvent(new CustomEvent(eventName, { detail: data }));
  }

  eventSource.addEventListener('new_observation', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    dispatchIfCurrentProject('laminark:new_observation', data);
  });

  eventSource.addEventListener('entity_updated', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    dispatchIfCurrentProject('laminark:entity_updated', data);
  });

  eventSource.addEventListener('topic_shift', function (e) {
    var data = JSON.parse(e.data);
    recordEventReceived();
    dispatchIfCurrentProject('laminark:topic_shift', data);
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
// Project selector
// ---------------------------------------------------------------------------

async function initProjectSelector() {
  var select = document.getElementById('project-selector');
  if (!select) return;

  var data = await fetchProjects();
  var projects = data.projects || [];
  var defaultProject = data.defaultProject;

  select.innerHTML = '';

  if (projects.length === 0) {
    var opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No projects';
    select.appendChild(opt);
    return;
  }

  projects.forEach(function (p) {
    var opt = document.createElement('option');
    opt.value = p.hash;
    opt.textContent = p.displayName;
    if (p.hash === defaultProject) opt.selected = true;
    select.appendChild(opt);
  });

  // Set initial current project
  window.laminarkState.currentProject = select.value || defaultProject;

  select.addEventListener('change', function () {
    window.laminarkState.currentProject = select.value;
    // Clear any pending batch updates from the previous project
    if (window.laminarkGraph && window.laminarkGraph.clearBatchQueue) {
      window.laminarkGraph.clearBatchQueue();
    }
    // Reload all data for the new project
    if (window.laminarkGraph && window.laminarkState.graphInitialized) {
      window.laminarkGraph.loadGraphData();
    }
    if (window.laminarkTimeline && window.laminarkState.timelineInitialized) {
      window.laminarkTimeline.loadTimelineData();
    }
  });
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
      var isGraph = targetView === 'graph-view';
      var mainContent = document.getElementById('main-content');
      if (filterBar) {
        filterBar.style.display = isGraph ? '' : 'none';
      }
      var timeRangeBar = document.getElementById('time-range-bar');
      if (timeRangeBar) {
        timeRangeBar.style.display = isGraph ? '' : 'none';
      }
      if (mainContent) {
        mainContent.classList.toggle('no-bars', !isGraph);
      }

      // Refresh stats when switching to settings tab
      if (targetView === 'settings-view' && window.laminarkSettings) {
        window.laminarkSettings.refreshStats();
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
      } else if (targetView === 'tools-view' && !window.laminarkState.toolsInitialized) {
        if (window.laminarkTools) {
          window.laminarkTools.initTools('tools-view');
          window.laminarkState.toolsInitialized = true;
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
        var typePills = document.querySelectorAll('.filter-pill:not([data-type="all"])');
        var allCurrentlyActive = Array.from(typePills).every(function (p) { return p.classList.contains('active'); });

        if (allCurrentlyActive) {
          // Toggle off -- deactivate all pills
          pills.forEach(function (p) {
            p.classList.remove('active');
          });
          if (window.laminarkGraph && window.laminarkGraph.setActiveTypes) {
            window.laminarkGraph.setActiveTypes([]);
          }
        } else {
          // Toggle on -- activate all type pills
          pills.forEach(function (p) {
            p.classList.add('active');
          });
          if (window.laminarkGraph && window.laminarkGraph.resetFilters) {
            window.laminarkGraph.resetFilters();
          }
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
// Time range controls
// ---------------------------------------------------------------------------

function initTimeRange() {
  var presetBtns = document.querySelectorAll('.time-preset');
  var timeFromInput = document.getElementById('time-from');
  var timeToInput = document.getElementById('time-to');
  var applyBtn = document.getElementById('time-apply');

  presetBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var preset = btn.getAttribute('data-preset');

      // Update active state
      presetBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');

      // Calculate from/to dates based on preset
      var now = new Date();
      var from = null;
      var to = null;

      if (preset === 'hour') {
        from = new Date(now.getTime() - 60 * 60 * 1000);
        to = now;
      } else if (preset === 'today') {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        to = now;
      } else if (preset === 'week') {
        // Start of this week (Monday)
        var day = now.getDay();
        var diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
        to = now;
      } else if (preset === 'month') {
        from = new Date(now.getFullYear(), now.getMonth(), 1);
        to = now;
      }
      // preset === 'all' => from = null, to = null

      // Update the date inputs to reflect the preset
      if (timeFromInput && timeToInput) {
        timeFromInput.value = from ? toDatetimeLocalString(from) : '';
        timeToInput.value = to ? toDatetimeLocalString(to) : '';
      }

      // Apply client-side time range filter (instant for presets)
      if (window.laminarkGraph && window.laminarkGraph.filterByTimeRange) {
        window.laminarkGraph.filterByTimeRange(
          from ? from.toISOString() : null,
          to ? to.toISOString() : null
        );
      }
    });
  });

  // Custom date range -- apply button
  if (applyBtn) {
    applyBtn.addEventListener('click', function () {
      // Deactivate preset buttons
      presetBtns.forEach(function (b) { b.classList.remove('active'); });

      var fromVal = timeFromInput ? timeFromInput.value : '';
      var toVal = timeToInput ? timeToInput.value : '';

      var from = fromVal ? new Date(fromVal).toISOString() : null;
      var to = toVal ? new Date(toVal).toISOString() : null;

      // For custom date ranges, re-fetch from API for server-side filtering
      if (window.laminarkGraph) {
        var filters = {};
        if (from) filters.since = from;
        if (to) filters.until = to;

        // Re-fetch graph data with server-side filtering
        window.laminarkGraph.loadGraphData(filters).then(function () {
          // Then also apply client-side time range for combined filtering
          if (window.laminarkGraph.filterByTimeRange) {
            window.laminarkGraph.filterByTimeRange(from, to);
          }
        });
      }
    });
  }
}

/**
 * Converts a Date to a datetime-local input value string.
 * @param {Date} date
 * @returns {string}
 */
function toDatetimeLocalString(date) {
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function initDetailPanel() {
  const closeBtn = document.getElementById('detail-close');
  const focusBtn = document.getElementById('detail-focus');

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

  if (focusBtn) {
    focusBtn.addEventListener('click', function () {
      var nodeId = focusBtn.getAttribute('data-node-id');
      var nodeLabel = focusBtn.getAttribute('data-node-label');
      if (nodeId && window.laminarkGraph && window.laminarkGraph.enterFocusMode) {
        window.laminarkGraph.enterFocusMode(nodeId, nodeLabel || nodeId);
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

  // Update focus button with current node info
  var focusBtn = document.getElementById('detail-focus');
  if (focusBtn) {
    focusBtn.setAttribute('data-node-id', nodeData.entity.id);
    focusBtn.setAttribute('data-node-label', nodeData.entity.label);
  }

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

function showPathDetails(pathData) {
  var panel = document.getElementById('path-detail-panel');
  var title = document.getElementById('path-detail-title');
  var body = document.getElementById('path-detail-body');

  if (!panel || !title || !body) return;

  var path = pathData.path;
  var waypoints = pathData.waypoints || [];

  title.textContent = 'Debug Path';
  body.innerHTML = '';

  // Status + trigger section
  var infoSection = document.createElement('div');
  infoSection.className = 'path-info-section';

  var statusBadge = document.createElement('span');
  statusBadge.className = 'path-status-badge ' + path.status;
  statusBadge.textContent = path.status;
  infoSection.appendChild(statusBadge);

  var triggerLabel = document.createElement('div');
  triggerLabel.className = 'path-info-label';
  triggerLabel.style.marginTop = '8px';
  triggerLabel.textContent = 'Trigger';
  infoSection.appendChild(triggerLabel);

  var triggerValue = document.createElement('div');
  triggerValue.className = 'path-info-value';
  triggerValue.textContent = path.trigger_summary || 'Unknown trigger';
  infoSection.appendChild(triggerValue);

  // Started at
  var startedLabel = document.createElement('div');
  startedLabel.className = 'path-info-label';
  startedLabel.style.marginTop = '6px';
  startedLabel.textContent = 'Started';
  infoSection.appendChild(startedLabel);

  var startedValue = document.createElement('div');
  startedValue.className = 'path-info-value';
  startedValue.textContent = formatTime(path.started_at);
  infoSection.appendChild(startedValue);

  // Resolved at (if resolved)
  if (path.resolved_at) {
    var resolvedLabel = document.createElement('div');
    resolvedLabel.className = 'path-info-label';
    resolvedLabel.style.marginTop = '6px';
    resolvedLabel.textContent = 'Resolved';
    infoSection.appendChild(resolvedLabel);

    var resolvedValue = document.createElement('div');
    resolvedValue.className = 'path-info-value';
    resolvedValue.textContent = formatTime(path.resolved_at);
    infoSection.appendChild(resolvedValue);
  }

  // Resolution summary
  if (path.resolution_summary) {
    var resLabel = document.createElement('div');
    resLabel.className = 'path-info-label';
    resLabel.style.marginTop = '6px';
    resLabel.textContent = 'Resolution';
    infoSection.appendChild(resLabel);

    var resValue = document.createElement('div');
    resValue.className = 'path-info-value';
    resValue.textContent = path.resolution_summary;
    infoSection.appendChild(resValue);
  }

  body.appendChild(infoSection);

  // KISS Summary (if present)
  if (path.kiss_summary) {
    var kiss;
    try {
      kiss = typeof path.kiss_summary === 'string' ? JSON.parse(path.kiss_summary) : path.kiss_summary;
    } catch (e) { kiss = null; }

    if (kiss) {
      var kissSection = document.createElement('div');
      kissSection.className = 'kiss-summary-section';

      var kissTitle = document.createElement('div');
      kissTitle.className = 'kiss-summary-title';
      kissTitle.textContent = 'KISS Summary';
      kissSection.appendChild(kissTitle);

      var kissFields = [
        { label: 'Problem', value: kiss.problem },
        { label: 'Cause', value: kiss.cause },
        { label: 'Fix', value: kiss.fix },
        { label: 'Prevention', value: kiss.prevention },
      ];

      kissFields.forEach(function(field) {
        if (!field.value) return;
        var fieldDiv = document.createElement('div');
        fieldDiv.className = 'kiss-summary-field';

        var fieldLabel = document.createElement('div');
        fieldLabel.className = 'kiss-summary-field-label';
        fieldLabel.textContent = field.label;
        fieldDiv.appendChild(fieldLabel);

        var fieldValue = document.createElement('div');
        fieldValue.className = 'kiss-summary-field-value';
        fieldValue.textContent = field.value;
        fieldDiv.appendChild(fieldValue);

        kissSection.appendChild(fieldDiv);
      });

      body.appendChild(kissSection);
    }
  }

  // Waypoint timeline
  if (waypoints.length > 0) {
    var wpSectionTitle = document.createElement('div');
    wpSectionTitle.className = 'waypoint-section-title';
    wpSectionTitle.textContent = 'Waypoints (' + waypoints.length + ')';
    body.appendChild(wpSectionTitle);

    var timeline = document.createElement('div');
    timeline.className = 'waypoint-timeline';

    waypoints.forEach(function(wp) {
      var item = document.createElement('div');
      item.className = 'waypoint-item';
      item.setAttribute('data-type', wp.waypoint_type);

      var header = document.createElement('div');
      header.className = 'waypoint-header';

      var seq = document.createElement('span');
      seq.className = 'waypoint-seq';
      seq.textContent = '#' + wp.sequence_order;
      header.appendChild(seq);

      var typeLabel = document.createElement('span');
      typeLabel.className = 'waypoint-type-label';
      var WAYPOINT_COLORS = {
        error: '#f85149', attempt: '#d29922', failure: '#f0883e',
        success: '#3fb950', pivot: '#a371f7', revert: '#79c0ff',
        discovery: '#58a6ff', resolution: '#3fb950'
      };
      typeLabel.style.color = WAYPOINT_COLORS[wp.waypoint_type] || '#8b949e';
      typeLabel.textContent = wp.waypoint_type;
      header.appendChild(typeLabel);

      var time = document.createElement('span');
      time.className = 'waypoint-time';
      time.textContent = formatTime(wp.created_at);
      header.appendChild(time);

      item.appendChild(header);

      if (wp.summary) {
        var summary = document.createElement('div');
        summary.className = 'waypoint-summary';
        summary.textContent = wp.summary;
        item.appendChild(summary);
      }

      timeline.appendChild(item);
    });

    body.appendChild(timeline);
  } else {
    var emptyMsg = document.createElement('p');
    emptyMsg.className = 'empty-state';
    emptyMsg.textContent = 'No waypoints recorded yet.';
    body.appendChild(emptyMsg);
  }

  // Hide the node detail panel if it's open (avoid two panels)
  var nodePanel = document.getElementById('detail-panel');
  if (nodePanel) nodePanel.classList.add('hidden');

  panel.classList.remove('hidden');
}

function initPathDetailPanel() {
  var closeBtn = document.getElementById('path-detail-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      var panel = document.getElementById('path-detail-panel');
      if (panel) panel.classList.add('hidden');
    });
  }

  // Listen for path detail events from graph overlay clicks
  document.addEventListener('laminark:show_path_detail', function(e) {
    if (e.detail) {
      showPathDetails(e.detail);
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Graph Search
// ---------------------------------------------------------------------------

function initSearch() {
  var searchInput = document.getElementById('graph-search');
  var dropdown = document.getElementById('search-results');
  if (!searchInput || !dropdown) return;

  var debounceTimer = null;
  var activeIndex = -1;
  var currentResults = [];

  function renderDropdown(results) {
    currentResults = results;
    activeIndex = -1;

    if (results.length === 0 && searchInput.value.trim().length > 0) {
      dropdown.innerHTML = '<div class="search-no-results">No matches found</div>';
      dropdown.classList.remove('hidden');
      return;
    }

    if (results.length === 0) {
      dropdown.classList.add('hidden');
      return;
    }

    dropdown.innerHTML = '';
    results.forEach(function (r, idx) {
      var item = document.createElement('div');
      item.className = 'search-result-item';
      item.setAttribute('data-index', idx);

      var dot = document.createElement('span');
      dot.className = 'search-result-dot';
      var style = (window.laminarkGraph && window.laminarkGraph.ENTITY_STYLES[r.type]) || { color: '#8b949e' };
      dot.style.background = style.color;
      item.appendChild(dot);

      var labelWrap = document.createElement('div');
      labelWrap.style.flex = '1';
      labelWrap.style.minWidth = '0';

      var label = document.createElement('div');
      label.className = 'search-result-label';
      label.textContent = r.label;
      labelWrap.appendChild(label);

      if (r.snippet) {
        var snippet = document.createElement('div');
        snippet.className = 'search-result-snippet';
        snippet.textContent = r.snippet;
        labelWrap.appendChild(snippet);
      }

      item.appendChild(labelWrap);

      var typeBadge = document.createElement('span');
      typeBadge.className = 'search-result-type';
      typeBadge.textContent = r.type;
      item.appendChild(typeBadge);

      if (r.matchSource) {
        var src = document.createElement('span');
        src.className = 'search-result-source';
        src.textContent = r.matchSource;
        item.appendChild(src);
      }

      item.addEventListener('click', function () {
        selectResult(r);
      });

      dropdown.appendChild(item);
    });

    dropdown.classList.remove('hidden');
  }

  function selectResult(r) {
    dropdown.classList.add('hidden');
    searchInput.value = r.label;

    if (window.laminarkGraph) {
      window.laminarkGraph.selectAndCenterNode(r.id);
      window.laminarkGraph.highlightSearchMatches([r.id]);
    }
  }

  function clearSearch() {
    searchInput.value = '';
    dropdown.classList.add('hidden');
    currentResults = [];
    activeIndex = -1;
    if (window.laminarkGraph) {
      window.laminarkGraph.clearSearchHighlight();
    }
  }

  // Debounced client-side search on keyup
  searchInput.addEventListener('input', function () {
    var query = searchInput.value.trim();

    if (debounceTimer) clearTimeout(debounceTimer);

    if (!query) {
      clearSearch();
      return;
    }

    debounceTimer = setTimeout(function () {
      // Client-side search on loaded Cytoscape data
      var results = [];
      if (window.laminarkGraph && window.laminarkGraph.searchNodes) {
        var clientResults = window.laminarkGraph.searchNodes(query);
        results = clientResults.map(function (r) {
          return {
            id: r.id,
            label: r.label,
            type: r.type,
            matchSource: null,
            snippet: null,
          };
        });
      }

      // Highlight matching nodes in graph
      if (results.length > 0 && window.laminarkGraph) {
        window.laminarkGraph.highlightSearchMatches(results.map(function (r) { return r.id; }));
      }

      renderDropdown(results);
    }, 250);
  });

  // Enter triggers server-side search
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var query = searchInput.value.trim();
      if (!query) return;

      var params = new URLSearchParams({ q: query, limit: '20' });
      if (window.laminarkState.currentProject) {
        params.set('project', window.laminarkState.currentProject);
      }

      fetch('/api/graph/search?' + params.toString())
        .then(function (res) { return res.json(); })
        .then(function (data) {
          renderDropdown(data.results || []);

          // Highlight all matching nodes in graph
          if (data.results && data.results.length > 0 && window.laminarkGraph) {
            window.laminarkGraph.highlightSearchMatches(
              data.results.map(function (r) { return r.id; })
            );
          }
        })
        .catch(function (err) {
          console.error('[laminark] Search failed:', err);
        });
    } else if (e.key === 'Escape') {
      clearSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentResults.length > 0) {
        activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
        updateActiveItem();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentResults.length > 0) {
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActiveItem();
      }
    }

    // Enter on active dropdown item
    if (e.key === 'Enter' && activeIndex >= 0 && currentResults[activeIndex]) {
      selectResult(currentResults[activeIndex]);
    }
  });

  function updateActiveItem() {
    var items = dropdown.querySelectorAll('.search-result-item');
    items.forEach(function (item, idx) {
      item.classList.toggle('active', idx === activeIndex);
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// Graph Analysis Panel
// ---------------------------------------------------------------------------

var analysisOpen = false;

function initAnalysis() {
  var btn = document.getElementById('analysis-btn');
  var panel = document.getElementById('analysis-panel');
  var closeBtn = document.getElementById('analysis-close');
  if (!btn || !panel) return;

  btn.addEventListener('click', function () {
    analysisOpen = !analysisOpen;
    btn.classList.toggle('active', analysisOpen);
    if (analysisOpen) {
      panel.classList.remove('hidden');
      loadAnalysis();
    } else {
      panel.classList.add('hidden');
      // Clear any cluster highlights
      if (window.laminarkGraph) {
        window.laminarkGraph.clearSearchHighlight();
      }
    }
    // Let CSS transition finish, then refit graph to new width
    setTimeout(function () {
      if (window.laminarkGraph) window.laminarkGraph.fitToView();
    }, 350);
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      analysisOpen = false;
      panel.classList.add('hidden');
      btn.classList.remove('active');
      if (window.laminarkGraph) {
        window.laminarkGraph.clearSearchHighlight();
      }
      setTimeout(function () {
        if (window.laminarkGraph) window.laminarkGraph.fitToView();
      }, 350);
    });
  }
}

function loadAnalysis() {
  var body = document.getElementById('analysis-body');
  if (!body) return;

  body.innerHTML = '<p class="empty-state">Loading analysis...</p>';

  var params = new URLSearchParams();
  if (window.laminarkState.currentProject) {
    params.set('project', window.laminarkState.currentProject);
  }

  fetch('/api/graph/analysis' + (params.toString() ? '?' + params.toString() : ''))
    .then(function (res) { return res.json(); })
    .then(function (data) {
      renderAnalysis(body, data);
    })
    .catch(function (err) {
      console.error('[laminark] Analysis failed:', err);
      body.innerHTML = '<p class="empty-state">Failed to load analysis</p>';
    });
}

function renderAnalysis(container, data) {
  container.innerHTML = '';

  var entityStyles = (window.laminarkGraph && window.laminarkGraph.ENTITY_STYLES) || {};

  // Recent activity
  if (data.recentActivity) {
    var actSection = document.createElement('div');
    actSection.className = 'analysis-section';

    var actTitle = document.createElement('div');
    actTitle.className = 'analysis-section-title';
    actTitle.textContent = 'Recent Activity';
    actSection.appendChild(actTitle);

    var rows = [
      { label: 'Last 24 hours', value: data.recentActivity.lastDay },
      { label: 'Last 7 days', value: data.recentActivity.lastWeek },
    ];

    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'analysis-stat-row';
      var lbl = document.createElement('span');
      lbl.className = 'analysis-stat-label';
      lbl.textContent = r.label;
      var val = document.createElement('span');
      val.className = 'analysis-stat-value';
      val.textContent = r.value + ' new entities';
      row.appendChild(lbl);
      row.appendChild(val);
      actSection.appendChild(row);
    });

    container.appendChild(actSection);
  }

  // Entity type distribution
  if (data.entityTypes && data.entityTypes.length > 0) {
    var etSection = document.createElement('div');
    etSection.className = 'analysis-section';

    var etTitle = document.createElement('div');
    etTitle.className = 'analysis-section-title';
    etTitle.textContent = 'Entity Types';
    etSection.appendChild(etTitle);

    var maxCount = data.entityTypes[0].count;

    data.entityTypes.forEach(function (et) {
      var row = document.createElement('div');
      row.className = 'analysis-bar-row';

      var label = document.createElement('span');
      label.className = 'analysis-bar-label';
      label.textContent = et.type;
      row.appendChild(label);

      var track = document.createElement('div');
      track.className = 'analysis-bar-track';
      var fill = document.createElement('div');
      fill.className = 'analysis-bar-fill';
      fill.style.width = Math.round((et.count / maxCount) * 100) + '%';
      fill.style.background = (entityStyles[et.type] || { color: '#8b949e' }).color;
      track.appendChild(fill);
      row.appendChild(track);

      var count = document.createElement('span');
      count.className = 'analysis-bar-count';
      count.textContent = et.count;
      row.appendChild(count);

      etSection.appendChild(row);
    });

    container.appendChild(etSection);
  }

  // Relationship type distribution
  if (data.relationshipTypes && data.relationshipTypes.length > 0) {
    var rtSection = document.createElement('div');
    rtSection.className = 'analysis-section';

    var rtTitle = document.createElement('div');
    rtTitle.className = 'analysis-section-title';
    rtTitle.textContent = 'Relationship Types';
    rtSection.appendChild(rtTitle);

    var maxRel = data.relationshipTypes[0].count;

    data.relationshipTypes.forEach(function (rt) {
      var row = document.createElement('div');
      row.className = 'analysis-bar-row';

      var label = document.createElement('span');
      label.className = 'analysis-bar-label';
      label.textContent = rt.type;
      row.appendChild(label);

      var track = document.createElement('div');
      track.className = 'analysis-bar-track';
      var fill = document.createElement('div');
      fill.className = 'analysis-bar-fill';
      fill.style.width = Math.round((rt.count / maxRel) * 100) + '%';
      fill.style.background = '#8b949e';
      track.appendChild(fill);
      row.appendChild(track);

      var count = document.createElement('span');
      count.className = 'analysis-bar-count';
      count.textContent = rt.count;
      row.appendChild(count);

      rtSection.appendChild(row);
    });

    container.appendChild(rtSection);
  }

  // Top 10 entities by degree
  if (data.topEntities && data.topEntities.length > 0) {
    var teSection = document.createElement('div');
    teSection.className = 'analysis-section';

    var teTitle = document.createElement('div');
    teTitle.className = 'analysis-section-title';
    teTitle.textContent = 'Most Connected Entities';
    teSection.appendChild(teTitle);

    data.topEntities.forEach(function (ent) {
      var item = document.createElement('div');
      item.className = 'analysis-entity-item';

      var dot = document.createElement('span');
      dot.className = 'analysis-entity-dot';
      dot.style.background = (entityStyles[ent.type] || { color: '#8b949e' }).color;
      item.appendChild(dot);

      var name = document.createElement('span');
      name.className = 'analysis-entity-name';
      name.textContent = ent.label;
      item.appendChild(name);

      var degree = document.createElement('span');
      degree.className = 'analysis-entity-degree';
      degree.textContent = ent.degree + ' links';
      item.appendChild(degree);

      item.addEventListener('click', function () {
        if (window.laminarkGraph) {
          window.laminarkGraph.selectAndCenterNode(ent.id);
        }
      });

      teSection.appendChild(item);
    });

    container.appendChild(teSection);
  }

  // Connected components / clusters
  if (data.components && data.components.length > 0) {
    var ccSection = document.createElement('div');
    ccSection.className = 'analysis-section';

    var ccTitle = document.createElement('div');
    ccTitle.className = 'analysis-section-title';
    ccTitle.textContent = 'Clusters (' + data.components.length + ')';
    ccSection.appendChild(ccTitle);

    data.components.forEach(function (comp) {
      var card = document.createElement('div');
      card.className = 'analysis-cluster-card';

      var label = document.createElement('div');
      label.className = 'analysis-cluster-label';
      label.textContent = comp.label;
      card.appendChild(label);

      var meta = document.createElement('div');
      meta.className = 'analysis-cluster-meta';
      meta.textContent = comp.nodeCount + ' nodes, ' + comp.edgeCount + ' edges';
      card.appendChild(meta);

      card.addEventListener('click', function () {
        if (window.laminarkGraph) {
          window.laminarkGraph.highlightCluster(comp.nodeIds);
        }
      });

      ccSection.appendChild(card);
    });

    container.appendChild(ccSection);
  }

  if (!data.entityTypes?.length && !data.topEntities?.length) {
    var empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No graph data to analyze yet.';
    container.appendChild(empty);
  }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async function () {
  console.log('[laminark] Initializing application');

  await initProjectSelector();
  initNavigation();
  initFilters();
  initTimeRange();
  initDetailPanel();
  initPathDetailPanel();
  initSearch();
  initAnalysis();
  connectSSE();

  // Initialize activity feed
  if (window.laminarkActivity) {
    window.laminarkActivity.initActivityFeed();
  }

  // Initialize settings
  if (window.laminarkSettings) {
    window.laminarkSettings.initSettings();
  }

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

  // Listen for SSE-dispatched events for graph updates (batched for performance)
  document.addEventListener('laminark:entity_updated', function (e) {
    if (!window.laminarkGraph) return;
    var data = e.detail;
    // Only add entities belonging to the currently selected project
    if (data && data.id && data.projectHash && data.projectHash === window.laminarkState.currentProject) {
      window.laminarkGraph.queueBatchUpdate({
        type: 'addNode',
        data: {
          id: data.id,
          label: data.label || data.name,
          type: data.type,
          observationCount: data.observationCount || 0,
          createdAt: data.createdAt,
        },
      });
    }
  });

  document.addEventListener('laminark:new_observation', function () {
    // Refresh observation counts by reloading graph data (already project-filtered at SSE dispatch)
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
  fetchProjects: fetchProjects,
  fetchPaths: fetchPaths,
  fetchPathDetail: fetchPathDetail,
  showNodeDetails: showNodeDetails,
  showPathDetails: showPathDetails,
  getActiveFilters: getActiveFilters,
};
