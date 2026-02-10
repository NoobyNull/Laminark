/**
 * Laminark Settings tab — database statistics and reset operations.
 */

(function () {
  var currentStats = null;

  function getProjectHash() {
    return window.laminarkState.currentProject || null;
  }

  async function fetchStats(projectHash) {
    var params = new URLSearchParams();
    if (projectHash) params.set('project', projectHash);
    var url = '/api/admin/stats' + (params.toString() ? '?' + params.toString() : '');
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      console.error('[laminark] Failed to fetch stats:', err);
      return null;
    }
  }

  function renderStats(stats) {
    currentStats = stats;
    var grid = document.getElementById('db-stats-grid');
    if (!grid || !stats) return;

    var cards = [
      { label: 'Observations', value: stats.observations, id: 'stat-observations' },
      { label: 'Embeddings', value: stats.observationEmbeddings, id: 'stat-embeddings' },
      { label: 'Staleness Flags', value: stats.stalenessFlags || 0, id: 'stat-staleness' },
      { label: 'Graph Nodes', value: stats.graphNodes, id: 'stat-nodes' },
      { label: 'Graph Edges', value: stats.graphEdges, id: 'stat-edges' },
      { label: 'Sessions', value: stats.sessions, id: 'stat-sessions' },
      { label: 'Context Stashes', value: stats.contextStashes, id: 'stat-stashes' },
      { label: 'Shift Decisions', value: stats.shiftDecisions, id: 'stat-shifts' },
      { label: 'Notifications', value: stats.pendingNotifications || 0, id: 'stat-notifications' },
      { label: 'Projects', value: stats.projects, id: 'stat-projects' },
    ];

    grid.innerHTML = '';
    cards.forEach(function (card) {
      var el = document.createElement('div');
      el.className = 'stat-card';
      el.id = card.id;

      var valueEl = document.createElement('div');
      valueEl.className = 'stat-value';
      valueEl.textContent = card.value.toLocaleString();

      var labelEl = document.createElement('div');
      labelEl.className = 'stat-label';
      labelEl.textContent = card.label;

      el.appendChild(valueEl);
      el.appendChild(labelEl);
      grid.appendChild(el);
    });
  }

  async function resetData(type, scope) {
    var projectHash = scope === 'current' ? getProjectHash() : undefined;
    try {
      var res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, scope: scope, projectHash: projectHash }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      console.error('[laminark] Reset failed:', err);
      return null;
    }
  }

  function getResetDescription(type) {
    switch (type) {
      case 'observations':
        return 'This will permanently delete all observations, full-text search indexes, and vector embeddings.';
      case 'graph':
        return 'This will permanently delete all knowledge graph nodes and edges.';
      case 'sessions':
        return 'This will permanently delete all sessions, context stashes, threshold history, and shift decisions.';
      case 'all':
        return 'This will permanently delete ALL data: observations, graph, sessions, and intelligence data.';
      default:
        return '';
    }
  }

  function getAffectedCount(type) {
    if (!currentStats) return 0;
    var s = currentStats;
    switch (type) {
      case 'observations':
        return s.observations + s.observationEmbeddings + (s.stalenessFlags || 0);
      case 'graph':
        return s.graphNodes + s.graphEdges;
      case 'sessions':
        return s.sessions + s.contextStashes + s.shiftDecisions + s.thresholdHistory + (s.pendingNotifications || 0);
      case 'all':
        return s.observations + s.observationEmbeddings + (s.stalenessFlags || 0) +
          s.graphNodes + s.graphEdges +
          s.sessions + s.contextStashes +
          s.shiftDecisions + s.thresholdHistory + (s.pendingNotifications || 0) +
          s.projects;
      default:
        return 0;
    }
  }

  function showConfirmDialog(type) {
    var overlay = document.getElementById('confirm-overlay');
    if (!overlay) return;

    var scope = getSelectedScope();
    var count = getAffectedCount(type);
    var scopeLabel = scope === 'current' ? 'current project' : 'ALL projects';

    var title = document.getElementById('confirm-title');
    var desc = document.getElementById('confirm-desc');
    var countEl = document.getElementById('confirm-count');
    var input = document.getElementById('confirm-input');
    var confirmBtn = document.getElementById('confirm-btn');

    if (title) title.textContent = 'Reset ' + type;
    if (desc) desc.textContent = getResetDescription(type) + ' Scope: ' + scopeLabel + '.';
    if (countEl) countEl.textContent = count.toLocaleString() + ' rows will be deleted';
    if (input) {
      input.value = '';
      input.placeholder = 'Type DELETE to confirm';
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.onclick = async function () {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Resetting...';
        var result = await resetData(type, scope);
        hideConfirmDialog();
        if (result && result.ok) {
          showSuccessMessage(type);
          await refreshStats();
          // Reload graph/timeline data if they're initialized
          if (window.laminarkGraph && window.laminarkState.graphInitialized) {
            window.laminarkGraph.loadGraphData();
          }
          if (window.laminarkTimeline && window.laminarkState.timelineInitialized) {
            window.laminarkTimeline.loadTimelineData();
          }
        }
        confirmBtn.textContent = 'Reset';
      };
    }

    if (input && confirmBtn) {
      input.oninput = function () {
        confirmBtn.disabled = input.value !== 'DELETE';
      };
    }

    overlay.classList.remove('hidden');
    if (input) input.focus();
  }

  function hideConfirmDialog() {
    var overlay = document.getElementById('confirm-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function showSuccessMessage(type) {
    var msg = document.getElementById('settings-success');
    if (!msg) return;
    msg.textContent = 'Successfully reset ' + type + ' data.';
    msg.classList.remove('hidden');
    setTimeout(function () {
      msg.classList.add('hidden');
    }, 4000);
  }

  function getSelectedScope() {
    var radio = document.querySelector('input[name="reset-scope"]:checked');
    return radio ? radio.value : 'current';
  }

  async function refreshStats() {
    var scope = getSelectedScope();
    var projectHash = scope === 'current' ? getProjectHash() : null;
    var stats = await fetchStats(projectHash);
    if (stats) renderStats(stats);
  }

  function initSettings() {
    // Reset action buttons
    var resetBtns = document.querySelectorAll('.reset-action-btn');
    resetBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-reset-type');
        if (type) showConfirmDialog(type);
      });
    });

    // Cancel button in confirm dialog
    var cancelBtn = document.getElementById('confirm-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', hideConfirmDialog);
    }

    // Close on overlay click
    var overlay = document.getElementById('confirm-overlay');
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) hideConfirmDialog();
      });
    }

    // Escape key closes dialog
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideConfirmDialog();
    });

    // Scope radio change refreshes stats
    var radios = document.querySelectorAll('input[name="reset-scope"]');
    radios.forEach(function (radio) {
      radio.addEventListener('change', refreshStats);
    });
  }

  window.laminarkSettings = {
    initSettings: initSettings,
    refreshStats: refreshStats,
  };
})();
