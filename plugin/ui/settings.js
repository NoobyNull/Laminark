/**
 * Laminark Settings tab — database statistics, config sections, and reset operations.
 */

(function () {
  var currentStats = null;

  // Preset-to-multiplier mapping
  var PRESET_MULTIPLIERS = { sensitive: 1.0, balanced: 1.5, relaxed: 2.5 };

  function getProjectHash() {
    return window.laminarkState.currentProject || null;
  }

  // =========================================================================
  // Stats
  // =========================================================================

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

  // =========================================================================
  // Reset
  // =========================================================================

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
          showSuccessMessage('Successfully reset ' + type + ' data.');
          await refreshStats();
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

  function showSuccessMessage(text) {
    var msg = document.getElementById('settings-success');
    if (!msg) return;
    msg.textContent = text;
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

  // =========================================================================
  // Config helpers
  // =========================================================================

  function bindSlider(sliderId, valueId) {
    var slider = document.getElementById(sliderId);
    var label = document.getElementById(valueId);
    if (!slider || !label) return;
    slider.addEventListener('input', function () {
      label.textContent = parseFloat(slider.value).toFixed(2);
    });
  }

  function updateStatusBadge(badgeId, enabled) {
    var badge = document.getElementById(badgeId);
    if (!badge) return;
    badge.textContent = enabled ? 'Enabled' : 'Disabled';
    badge.className = 'config-section-status ' + (enabled ? 'enabled' : 'disabled');
  }

  function setFieldsDisabled(containerId, disabled) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (disabled) {
      el.classList.add('disabled-fields');
    } else {
      el.classList.remove('disabled-fields');
    }
  }

  // =========================================================================
  // Topic Detection Config
  // =========================================================================

  function populateTopicDetection(config) {
    var enabled = document.getElementById('td-enabled');
    if (enabled) enabled.checked = config.enabled;
    updateStatusBadge('td-status', config.enabled);
    setFieldsDisabled('td-fields', !config.enabled);

    // Preset radio
    var presetBtns = document.querySelectorAll('#td-preset .config-radio');
    presetBtns.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-value') === config.sensitivityPreset);
    });

    var multiplier = document.getElementById('td-multiplier');
    if (multiplier) multiplier.value = config.sensitivityMultiplier;

    var manualEnabled = document.getElementById('td-manual-enabled');
    var manualValue = document.getElementById('td-manual-value');
    if (manualEnabled) manualEnabled.checked = config.manualThreshold !== null;
    if (manualValue) {
      manualValue.disabled = config.manualThreshold === null;
      manualValue.value = config.manualThreshold !== null ? config.manualThreshold : 0.3;
    }

    var ewma = document.getElementById('td-ewma');
    var ewmaVal = document.getElementById('td-ewma-val');
    if (ewma) ewma.value = config.ewmaAlpha;
    if (ewmaVal) ewmaVal.textContent = config.ewmaAlpha.toFixed(2);

    var boundsMin = document.getElementById('td-bounds-min');
    var boundsMax = document.getElementById('td-bounds-max');
    if (boundsMin) boundsMin.value = config.thresholdBounds.min;
    if (boundsMax) boundsMax.value = config.thresholdBounds.max;
  }

  function gatherTopicDetection() {
    var manualEnabled = document.getElementById('td-manual-enabled');
    var manualValue = document.getElementById('td-manual-value');
    var activePreset = document.querySelector('#td-preset .config-radio.active');

    return {
      enabled: document.getElementById('td-enabled').checked,
      sensitivityPreset: activePreset ? activePreset.getAttribute('data-value') : 'balanced',
      sensitivityMultiplier: parseFloat(document.getElementById('td-multiplier').value) || 1.5,
      manualThreshold: manualEnabled && manualEnabled.checked ? (parseFloat(manualValue.value) || 0.3) : null,
      ewmaAlpha: parseFloat(document.getElementById('td-ewma').value) || 0.3,
      thresholdBounds: {
        min: parseFloat(document.getElementById('td-bounds-min').value) || 0.15,
        max: parseFloat(document.getElementById('td-bounds-max').value) || 0.6,
      },
    };
  }

  async function loadTopicDetectionConfig() {
    try {
      var res = await fetch('/api/admin/config/topic-detection');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateTopicDetection(config);
    } catch (err) {
      console.error('[laminark] Failed to load topic detection config:', err);
    }
  }

  async function saveTopicDetectionConfig(data) {
    try {
      var res = await fetch('/api/admin/config/topic-detection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateTopicDetection(config);
      return config;
    } catch (err) {
      console.error('[laminark] Failed to save topic detection config:', err);
      return null;
    }
  }

  function initTopicDetection() {
    // Collapsible section
    var header = document.querySelector('[data-config-toggle="topic-detection"]');
    if (header) {
      header.addEventListener('click', function () {
        document.getElementById('topic-detection-section').classList.toggle('collapsed');
      });
    }

    // Enabled toggle
    var enabled = document.getElementById('td-enabled');
    if (enabled) {
      enabled.addEventListener('change', function () {
        updateStatusBadge('td-status', enabled.checked);
        setFieldsDisabled('td-fields', !enabled.checked);
      });
    }

    // Preset buttons
    var presetBtns = document.querySelectorAll('#td-preset .config-radio');
    presetBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        presetBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var preset = btn.getAttribute('data-value');
        var multiplier = document.getElementById('td-multiplier');
        if (multiplier && PRESET_MULTIPLIERS[preset] !== undefined) {
          multiplier.value = PRESET_MULTIPLIERS[preset];
        }
      });
    });

    // Manual threshold toggle
    var manualEnabled = document.getElementById('td-manual-enabled');
    var manualValue = document.getElementById('td-manual-value');
    if (manualEnabled && manualValue) {
      manualEnabled.addEventListener('change', function () {
        manualValue.disabled = !manualEnabled.checked;
      });
    }

    // EWMA slider
    bindSlider('td-ewma', 'td-ewma-val');

    // Save button
    var saveBtn = document.getElementById('td-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var data = gatherTopicDetection();
        var result = await saveTopicDetectionConfig(data);
        if (result) showSuccessMessage('Topic detection settings saved.');
      });
    }

    // Reset to defaults
    var defaultsBtn = document.getElementById('td-defaults');
    if (defaultsBtn) {
      var tdResetTimer = null;
      defaultsBtn.addEventListener('click', async function () {
        if (defaultsBtn.classList.contains('confirming')) {
          clearTimeout(tdResetTimer);
          defaultsBtn.classList.remove('confirming');
          defaultsBtn.textContent = 'Reset to Defaults';
          var result = await saveTopicDetectionConfig({ __reset: true });
          if (result) showSuccessMessage('Topic detection reset to defaults.');
        } else {
          defaultsBtn.classList.add('confirming');
          defaultsBtn.textContent = 'Confirm?';
          tdResetTimer = setTimeout(function () {
            defaultsBtn.classList.remove('confirming');
            defaultsBtn.textContent = 'Reset to Defaults';
          }, 3000);
        }
      });
    }

    loadTopicDetectionConfig();
  }

  // =========================================================================
  // Graph Extraction Config
  // =========================================================================

  function populateGraphExtraction(config) {
    var enabled = document.getElementById('ge-enabled');
    if (enabled) enabled.checked = config.enabled;
    updateStatusBadge('ge-status', config.enabled);
    setFieldsDisabled('ge-fields', !config.enabled);

    // Temporal decay
    setVal('ge-halflife', config.temporalDecay.halfLifeDays);
    setSlider('ge-minfloor', 'ge-minfloor-val', config.temporalDecay.minFloor);
    setSlider('ge-delthresh', 'ge-delthresh-val', config.temporalDecay.deletionThreshold);
    setVal('ge-maxage', config.temporalDecay.maxAgeDays);

    // Fuzzy dedup
    setVal('ge-levenshtein', config.fuzzyDedup.maxLevenshteinDistance);
    setSlider('ge-jaccard', 'ge-jaccard-val', config.fuzzyDedup.jaccardThreshold);

    // Quality gate
    setVal('ge-maxfiles', config.qualityGate.maxFilesPerObservation);
    setSlider('ge-filenonchange', 'ge-filenonchange-val', config.qualityGate.fileNonChangeMultiplier);
    setVal('ge-minname', config.qualityGate.minNameLength);
    setVal('ge-maxname', config.qualityGate.maxNameLength);

    // Type confidence thresholds
    var thresholds = config.qualityGate.typeConfidenceThresholds || {};
    var grid = document.getElementById('ge-thresholds');
    if (grid) {
      var rows = grid.querySelectorAll('.config-threshold-row');
      rows.forEach(function (row) {
        var slider = row.querySelector('.config-slider');
        var label = row.querySelector('.config-slider-value');
        var type = slider.getAttribute('data-type');
        if (type && thresholds[type] !== undefined) {
          slider.value = thresholds[type];
          if (label) label.textContent = thresholds[type].toFixed(2);
        }
      });
    }

    // Relationship detector
    setSlider('ge-minedge', 'ge-minedge-val', config.relationshipDetector.minEdgeConfidence);

    // Signal classifier
    setVal('ge-mincontent', config.signalClassifier.minContentLength);
  }

  function setVal(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  function setSlider(sliderId, labelId, value) {
    var slider = document.getElementById(sliderId);
    var label = document.getElementById(labelId);
    if (slider) slider.value = value;
    if (label) label.textContent = parseFloat(value).toFixed(2);
  }

  function gatherGraphExtraction() {
    var thresholds = {};
    var grid = document.getElementById('ge-thresholds');
    if (grid) {
      var sliders = grid.querySelectorAll('.config-slider');
      sliders.forEach(function (slider) {
        var type = slider.getAttribute('data-type');
        if (type) thresholds[type] = parseFloat(slider.value);
      });
    }

    return {
      enabled: document.getElementById('ge-enabled').checked,
      temporalDecay: {
        halfLifeDays: parseInt(document.getElementById('ge-halflife').value, 10) || 30,
        minFloor: parseFloat(document.getElementById('ge-minfloor').value) || 0.05,
        deletionThreshold: parseFloat(document.getElementById('ge-delthresh').value) || 0.08,
        maxAgeDays: parseInt(document.getElementById('ge-maxage').value, 10) || 180,
      },
      fuzzyDedup: {
        maxLevenshteinDistance: parseInt(document.getElementById('ge-levenshtein').value, 10) || 2,
        jaccardThreshold: parseFloat(document.getElementById('ge-jaccard').value) || 0.7,
      },
      qualityGate: {
        maxFilesPerObservation: parseInt(document.getElementById('ge-maxfiles').value, 10) || 5,
        typeConfidenceThresholds: thresholds,
        fileNonChangeMultiplier: parseFloat(document.getElementById('ge-filenonchange').value) || 0.74,
        minNameLength: parseInt(document.getElementById('ge-minname').value, 10) || 3,
        maxNameLength: parseInt(document.getElementById('ge-maxname').value, 10) || 200,
      },
      relationshipDetector: {
        minEdgeConfidence: parseFloat(document.getElementById('ge-minedge').value) || 0.45,
      },
      signalClassifier: {
        minContentLength: parseInt(document.getElementById('ge-mincontent').value, 10) || 30,
      },
    };
  }

  async function loadGraphExtractionConfig() {
    try {
      var res = await fetch('/api/admin/config/graph-extraction');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateGraphExtraction(config);
    } catch (err) {
      console.error('[laminark] Failed to load graph extraction config:', err);
    }
  }

  async function saveGraphExtractionConfig(data) {
    try {
      var res = await fetch('/api/admin/config/graph-extraction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateGraphExtraction(config);
      return config;
    } catch (err) {
      console.error('[laminark] Failed to save graph extraction config:', err);
      return null;
    }
  }

  function initGraphExtraction() {
    // Collapsible section
    var header = document.querySelector('[data-config-toggle="graph-extraction"]');
    if (header) {
      header.addEventListener('click', function () {
        document.getElementById('graph-extraction-section').classList.toggle('collapsed');
      });
    }

    // Enabled toggle
    var enabled = document.getElementById('ge-enabled');
    if (enabled) {
      enabled.addEventListener('change', function () {
        updateStatusBadge('ge-status', enabled.checked);
        setFieldsDisabled('ge-fields', !enabled.checked);
      });
    }

    // Bind all sliders
    bindSlider('ge-minfloor', 'ge-minfloor-val');
    bindSlider('ge-delthresh', 'ge-delthresh-val');
    bindSlider('ge-jaccard', 'ge-jaccard-val');
    bindSlider('ge-filenonchange', 'ge-filenonchange-val');
    bindSlider('ge-minedge', 'ge-minedge-val');

    // Threshold grid sliders
    var grid = document.getElementById('ge-thresholds');
    if (grid) {
      var rows = grid.querySelectorAll('.config-threshold-row');
      rows.forEach(function (row) {
        var slider = row.querySelector('.config-slider');
        var label = row.querySelector('.config-slider-value');
        if (slider && label) {
          slider.addEventListener('input', function () {
            label.textContent = parseFloat(slider.value).toFixed(2);
          });
        }
      });
    }

    // Save button
    var saveBtn = document.getElementById('ge-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var data = gatherGraphExtraction();
        var result = await saveGraphExtractionConfig(data);
        if (result) showSuccessMessage('Graph extraction settings saved.');
      });
    }

    // Reset to defaults
    var defaultsBtn = document.getElementById('ge-defaults');
    if (defaultsBtn) {
      var geResetTimer = null;
      defaultsBtn.addEventListener('click', async function () {
        if (defaultsBtn.classList.contains('confirming')) {
          clearTimeout(geResetTimer);
          defaultsBtn.classList.remove('confirming');
          defaultsBtn.textContent = 'Reset to Defaults';
          var result = await saveGraphExtractionConfig({ __reset: true });
          if (result) showSuccessMessage('Graph extraction reset to defaults.');
        } else {
          defaultsBtn.classList.add('confirming');
          defaultsBtn.textContent = 'Confirm?';
          geResetTimer = setTimeout(function () {
            defaultsBtn.classList.remove('confirming');
            defaultsBtn.textContent = 'Reset to Defaults';
          }, 3000);
        }
      });
    }

    loadGraphExtractionConfig();
  }

  // =========================================================================
  // Init
  // =========================================================================

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

    // Show current project name in danger zone scope label
    updateResetScopeProjectName();
    var projectSelector = document.getElementById('project-selector');
    if (projectSelector) {
      projectSelector.addEventListener('change', updateResetScopeProjectName);
    }

    // Config sections
    initTopicDetection();
    initGraphExtraction();
  }

  function updateResetScopeProjectName() {
    var el = document.getElementById('reset-scope-project-name');
    if (!el) return;
    var select = document.getElementById('project-selector');
    if (select && select.selectedOptions && select.selectedOptions[0]) {
      el.textContent = select.selectedOptions[0].textContent;
    } else if (window.laminarkState && window.laminarkState.currentProject) {
      el.textContent = window.laminarkState.currentProject.substring(0, 8) + '...';
    } else {
      el.textContent = 'unknown';
    }
  }

  window.laminarkSettings = {
    initSettings: initSettings,
    refreshStats: refreshStats,
  };
})();
