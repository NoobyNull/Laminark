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
    var projectName = '';
    if (scope === 'current') {
      var select = document.getElementById('project-selector');
      if (select && select.selectedOptions && select.selectedOptions[0]) {
        projectName = select.selectedOptions[0].textContent;
      }
    }
    var scopeLabel = scope === 'current' ? 'project "' + (projectName || 'unknown') + '"' : 'ALL projects';

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
  // Cross-Project Access Config
  // =========================================================================

  var caReadable = []; // current readable project hashes

  async function loadCrossAccessConfig() {
    var project = getProjectHash();
    if (!project) return;
    try {
      var res = await fetch('/api/admin/config/cross-access?project=' + encodeURIComponent(project));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      caReadable = config.readableProjects || [];
      populateCrossAccessLists();
    } catch (err) {
      console.error('[laminark] Failed to load cross-access config:', err);
    }
  }

  function getAllProjects() {
    var select = document.getElementById('project-selector');
    if (!select) return [];
    var projects = [];
    for (var i = 0; i < select.options.length; i++) {
      projects.push({
        hash: select.options[i].value,
        name: select.options[i].textContent,
      });
    }
    return projects;
  }

  function populateCrossAccessLists() {
    var currentProject = getProjectHash();
    var allProjects = getAllProjects();
    var availableList = document.getElementById('ca-available');
    var readableList = document.getElementById('ca-readable');
    if (!availableList || !readableList) return;

    availableList.innerHTML = '';
    readableList.innerHTML = '';

    var readableSet = new Set(caReadable);

    allProjects.forEach(function (p) {
      if (p.hash === currentProject) return; // skip self
      if (readableSet.has(p.hash)) {
        readableList.appendChild(createCrossAccessItem(p, 'remove'));
      } else {
        availableList.appendChild(createCrossAccessItem(p, 'add'));
      }
    });

    // Update status badge
    var badge = document.getElementById('ca-status');
    if (badge) {
      var count = caReadable.length;
      badge.textContent = count + ' project' + (count !== 1 ? 's' : '');
      badge.className = 'config-section-status ' + (count > 0 ? 'enabled' : 'disabled');
    }
  }

  function createCrossAccessItem(project, action) {
    var li = document.createElement('li');
    li.className = 'cross-access-item';
    li.setAttribute('data-hash', project.hash);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'cross-access-item-name';
    nameSpan.textContent = project.name;
    nameSpan.title = project.hash;
    li.appendChild(nameSpan);

    var btn = document.createElement('button');
    if (action === 'add') {
      btn.className = 'cross-access-add-btn';
      btn.innerHTML = '&#9654;'; // right arrow
      btn.title = 'Add to readable projects';
      btn.addEventListener('click', function () {
        caReadable.push(project.hash);
        populateCrossAccessLists();
      });
    } else {
      btn.className = 'cross-access-remove-btn';
      btn.innerHTML = '&times;';
      btn.title = 'Remove from readable projects';
      btn.addEventListener('click', function () {
        caReadable = caReadable.filter(function (h) { return h !== project.hash; });
        populateCrossAccessLists();
      });
    }
    li.appendChild(btn);

    return li;
  }

  async function saveCrossAccessConfig() {
    var project = getProjectHash();
    if (!project) return null;
    try {
      var res = await fetch('/api/admin/config/cross-access?project=' + encodeURIComponent(project), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readableProjects: caReadable }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      caReadable = config.readableProjects || [];
      populateCrossAccessLists();
      return config;
    } catch (err) {
      console.error('[laminark] Failed to save cross-access config:', err);
      return null;
    }
  }

  function initCrossAccess() {
    // Save button
    var saveBtn = document.getElementById('ca-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var result = await saveCrossAccessConfig();
        if (result) showSuccessMessage('Cross-project access settings saved.');
      });
    }

    // Reset to defaults
    var defaultsBtn = document.getElementById('ca-defaults');
    if (defaultsBtn) {
      var caResetTimer = null;
      defaultsBtn.addEventListener('click', async function () {
        if (defaultsBtn.classList.contains('confirming')) {
          clearTimeout(caResetTimer);
          defaultsBtn.classList.remove('confirming');
          defaultsBtn.textContent = 'Reset to Defaults';
          var project = getProjectHash();
          if (!project) return;
          try {
            var res = await fetch('/api/admin/config/cross-access?project=' + encodeURIComponent(project), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ __reset: true }),
            });
            if (res.ok) {
              var config = await res.json();
              caReadable = config.readableProjects || [];
              populateCrossAccessLists();
              showSuccessMessage('Cross-project access reset to defaults.');
            }
          } catch (err) {
            console.error('[laminark] Failed to reset cross-access config:', err);
          }
        } else {
          defaultsBtn.classList.add('confirming');
          defaultsBtn.textContent = 'Confirm?';
          caResetTimer = setTimeout(function () {
            defaultsBtn.classList.remove('confirming');
            defaultsBtn.textContent = 'Reset to Defaults';
          }, 3000);
        }
      });
    }

    loadCrossAccessConfig();

    // Reload when project changes
    var projectSelector = document.getElementById('project-selector');
    if (projectSelector) {
      projectSelector.addEventListener('change', function () {
        loadCrossAccessConfig();
      });
    }
  }

  // =========================================================================
  // Database Hygiene
  // =========================================================================

  var lastHygieneReport = null;

  function getSelectedTier() {
    var activeBtn = document.querySelector('#hy-tier .config-radio.active');
    return activeBtn ? activeBtn.getAttribute('data-value') : 'high';
  }

  async function runHygieneScan() {
    var project = getProjectHash();
    if (!project) return;

    var tier = getSelectedTier();
    var params = new URLSearchParams({ project: project, tier: tier, limit: '100' });

    var badge = document.getElementById('hy-status');
    if (badge) { badge.textContent = 'Scanning...'; badge.className = 'config-section-status disabled'; }

    try {
      var res = await fetch('/api/admin/hygiene?' + params.toString());
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var report = await res.json();
      lastHygieneReport = report;
      renderHygieneReport(report, tier);
    } catch (err) {
      console.error('[laminark] Hygiene scan failed:', err);
      if (badge) { badge.textContent = 'Error'; badge.className = 'config-section-status disabled'; }
    }
  }

  function renderHygieneReport(report, tier) {
    var badge = document.getElementById('hy-status');
    var total = report.summary.high + report.summary.medium;
    if (badge) {
      badge.textContent = total + ' candidate' + (total !== 1 ? 's' : '');
      badge.className = 'config-section-status ' + (total > 0 ? 'enabled' : 'disabled');
    }

    var results = document.getElementById('hy-results');
    if (results) results.classList.remove('hidden');

    // Summary
    var summary = document.getElementById('hy-summary');
    if (summary) {
      summary.innerHTML =
        '<div class="hygiene-summary-row">' +
          '<span class="hygiene-stat"><strong>' + report.totalObservations.toLocaleString() + '</strong> analyzed</span>' +
          '<span class="hygiene-stat hy-high"><strong>' + report.summary.high + '</strong> high</span>' +
          '<span class="hygiene-stat hy-medium"><strong>' + report.summary.medium + '</strong> medium</span>' +
          '<span class="hygiene-stat"><strong>' + report.summary.orphanNodeCount + '</strong> orphan nodes</span>' +
        '</div>';
    }

    // Table
    var tbody = document.getElementById('hy-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (report.candidates.length === 0) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:center;opacity:0.5;">No candidates at this tier</td>';
      tbody.appendChild(tr);
      return;
    }

    report.candidates.forEach(function (c) {
      var signals = [];
      if (c.signals.orphaned) signals.push('orphaned');
      if (c.signals.islandNode) signals.push('island');
      if (c.signals.noiseClassified) signals.push('noise');
      if (c.signals.shortContent) signals.push('short');
      if (c.signals.autoCaptured) signals.push('auto');
      if (c.signals.stale) signals.push('stale');

      var tr = document.createElement('tr');
      tr.className = c.tier === 'high' ? 'hy-row-high' : c.tier === 'medium' ? 'hy-row-medium' : '';
      tr.innerHTML =
        '<td class="mono">' + c.shortId + '</td>' +
        '<td>' + c.kind + '</td>' +
        '<td>' + c.source + '</td>' +
        '<td>' + c.confidence.toFixed(2) + '</td>' +
        '<td class="hygiene-signals">' + signals.map(function (s) { return '<span class="hy-signal">' + s + '</span>'; }).join(' ') + '</td>' +
        '<td class="hygiene-preview">' + escapeHtml(c.contentPreview) + '</td>';
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function runHygienePurge() {
    var project = getProjectHash();
    if (!project) return;

    var tier = getSelectedTier();
    var purgeBtn = document.getElementById('hy-purge');

    if (purgeBtn && !purgeBtn.classList.contains('confirming')) {
      purgeBtn.classList.add('confirming');
      purgeBtn.textContent = 'Confirm Purge?';
      setTimeout(function () {
        if (purgeBtn.classList.contains('confirming')) {
          purgeBtn.classList.remove('confirming');
          purgeBtn.textContent = 'Purge Selected Tier';
        }
      }, 3000);
      return;
    }

    if (purgeBtn) {
      purgeBtn.classList.remove('confirming');
      purgeBtn.textContent = 'Purging...';
      purgeBtn.disabled = true;
    }

    try {
      var res = await fetch('/api/admin/hygiene/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: tier }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var result = await res.json();

      showSuccessMessage(
        'Purged ' + result.observationsPurged + ' observations, ' +
        result.orphanNodesRemoved + ' orphan nodes removed.'
      );

      // Refresh stats and re-scan
      await refreshStats();
      await runHygieneScan();
    } catch (err) {
      console.error('[laminark] Hygiene purge failed:', err);
    }

    if (purgeBtn) {
      purgeBtn.disabled = false;
      purgeBtn.textContent = 'Purge Selected Tier';
    }
  }

  function initHygiene() {
    // Tier radio buttons
    var tierBtns = document.querySelectorAll('#hy-tier .config-radio');
    tierBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        tierBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });

    // Scan button
    var scanBtn = document.getElementById('hy-scan');
    if (scanBtn) {
      scanBtn.addEventListener('click', runHygieneScan);
    }

    // Purge button
    var purgeBtn = document.getElementById('hy-purge');
    if (purgeBtn) {
      purgeBtn.addEventListener('click', runHygienePurge);
    }
  }

  // =========================================================================
  // Hygiene Config
  // =========================================================================

  var HC_WEIGHT_KEYS = ['orphaned', 'islandNode', 'noiseClassified', 'shortContent', 'autoCaptured', 'stale'];

  function populateHygieneConfig(config) {
    HC_WEIGHT_KEYS.forEach(function (key) {
      var slider = document.getElementById('hc-w-' + key);
      var label = document.getElementById('hc-w-' + key + '-val');
      if (slider) slider.value = config.signalWeights[key];
      if (label) label.textContent = config.signalWeights[key].toFixed(2);
    });

    setSlider('hc-t-high', 'hc-t-high-val', config.tierThresholds.high);
    setSlider('hc-t-medium', 'hc-t-medium-val', config.tierThresholds.medium);
    setVal('hc-short-threshold', config.shortContentThreshold);
  }

  function gatherHygieneConfig() {
    var weights = {};
    HC_WEIGHT_KEYS.forEach(function (key) {
      var slider = document.getElementById('hc-w-' + key);
      weights[key] = slider ? parseFloat(slider.value) : 0;
    });

    return {
      signalWeights: weights,
      tierThresholds: {
        high: parseFloat(document.getElementById('hc-t-high').value) || 0.70,
        medium: parseFloat(document.getElementById('hc-t-medium').value) || 0.50,
      },
      shortContentThreshold: parseInt(document.getElementById('hc-short-threshold').value, 10) || 50,
    };
  }

  async function loadHygieneConfig() {
    try {
      var res = await fetch('/api/admin/config/hygiene');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateHygieneConfig(config);
    } catch (err) {
      console.error('[laminark] Failed to load hygiene config:', err);
    }
  }

  async function saveHygieneConfig(data) {
    try {
      var res = await fetch('/api/admin/config/hygiene', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateHygieneConfig(config);
      return config;
    } catch (err) {
      console.error('[laminark] Failed to save hygiene config:', err);
      return null;
    }
  }

  async function runFindAnalysis() {
    var project = getProjectHash();
    if (!project) return;

    var findBtn = document.getElementById('hc-find');
    if (findBtn) { findBtn.textContent = 'Analyzing...'; findBtn.disabled = true; }

    try {
      var res = await fetch('/api/admin/hygiene/find?project=' + encodeURIComponent(project));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var report = await res.json();
      renderFindResults(report);
    } catch (err) {
      console.error('[laminark] Find analysis failed:', err);
    }

    if (findBtn) { findBtn.textContent = 'Find'; findBtn.disabled = false; }
  }

  function renderFindResults(report) {
    var container = document.getElementById('hc-find-results');
    if (container) container.classList.remove('hidden');

    // Summary
    var summary = document.getElementById('hc-find-summary');
    if (summary) {
      var signals = report.bySignal;
      summary.innerHTML =
        '<div class="hygiene-summary-row">' +
          '<span class="hygiene-stat"><strong>' + report.total.toLocaleString() + '</strong> total</span>' +
          '<span class="hygiene-stat"><strong>' + signals.orphaned + '</strong> orphaned</span>' +
          '<span class="hygiene-stat"><strong>' + signals.islandNode + '</strong> island</span>' +
          '<span class="hygiene-stat"><strong>' + signals.noiseClassified + '</strong> noise</span>' +
          '<span class="hygiene-stat"><strong>' + signals.shortContent + '</strong> short</span>' +
          '<span class="hygiene-stat"><strong>' + signals.autoCaptured + '</strong> auto</span>' +
          '<span class="hygiene-stat"><strong>' + signals.stale + '</strong> stale</span>' +
        '</div>';
    }

    // Histogram
    var histogram = document.getElementById('hc-find-histogram');
    if (histogram) {
      var maxCount = 0;
      report.distribution.forEach(function (d) { if (d.count > maxCount) maxCount = d.count; });

      var html = '<div class="hygiene-histogram">';
      report.distribution.forEach(function (d) {
        var pct = maxCount > 0 ? (d.count / maxCount * 100) : 0;
        html += '<div class="hygiene-histogram-bar-wrap">' +
          '<div class="hygiene-histogram-bar" style="height:' + Math.max(pct, 2) + '%;" title="' + d.range + ': ' + d.count + '"></div>' +
          '<div class="hygiene-histogram-label">' + d.range.split('-')[0] + '</div>' +
          '</div>';
      });
      html += '</div>';
      histogram.innerHTML = html;
    }

    // Island nodes
    var islands = document.getElementById('hc-find-islands');
    if (islands && report.islandNodes) {
      var isl = report.islandNodes;
      var cap = isl.capturedAtCurrentThresholds;
      islands.innerHTML =
        '<div class="hygiene-summary-row">' +
          '<span class="hygiene-stat"><strong>' + isl.total + '</strong> island obs</span>' +
          '<span class="hygiene-stat">conf: ' + isl.minConfidence.toFixed(2) + ' &ndash; ' + isl.maxConfidence.toFixed(2) + '</span>' +
          '<span class="hygiene-stat">median: <strong>' + isl.medianConfidence.toFixed(2) + '</strong></span>' +
          '<span class="hygiene-stat hy-high">high: <strong>' + cap.high + '</strong></span>' +
          '<span class="hygiene-stat hy-medium">medium+: <strong>' + cap.medium + '</strong></span>' +
          '<span class="hygiene-stat">all: <strong>' + cap.all + '</strong></span>' +
        '</div>';
    }
  }

  function initHygieneConfig() {
    // Bind sliders
    HC_WEIGHT_KEYS.forEach(function (key) {
      bindSlider('hc-w-' + key, 'hc-w-' + key + '-val');
    });
    bindSlider('hc-t-high', 'hc-t-high-val');
    bindSlider('hc-t-medium', 'hc-t-medium-val');

    // Save button
    var saveBtn = document.getElementById('hc-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var data = gatherHygieneConfig();
        var result = await saveHygieneConfig(data);
        if (result) showSuccessMessage('Hygiene settings saved.');
      });
    }

    // Reset to defaults
    var defaultsBtn = document.getElementById('hc-defaults');
    if (defaultsBtn) {
      var hcResetTimer = null;
      defaultsBtn.addEventListener('click', async function () {
        if (defaultsBtn.classList.contains('confirming')) {
          clearTimeout(hcResetTimer);
          defaultsBtn.classList.remove('confirming');
          defaultsBtn.textContent = 'Reset to Defaults';
          var result = await saveHygieneConfig({ __reset: true });
          if (result) showSuccessMessage('Hygiene settings reset to defaults.');
        } else {
          defaultsBtn.classList.add('confirming');
          defaultsBtn.textContent = 'Confirm?';
          hcResetTimer = setTimeout(function () {
            defaultsBtn.classList.remove('confirming');
            defaultsBtn.textContent = 'Reset to Defaults';
          }, 3000);
        }
      });
    }

    // Find button
    var findBtn = document.getElementById('hc-find');
    if (findBtn) {
      findBtn.addEventListener('click', runFindAnalysis);
    }

    loadHygieneConfig();
  }

  // =========================================================================
  // Tool Response Verbosity Config
  // =========================================================================

  var LEVEL_LABELS = { 1: 'Minimal', 2: 'Standard', 3: 'Verbose' };

  function populateToolVerbosity(config) {
    var levelBtns = document.querySelectorAll('#tv-level .config-radio');
    levelBtns.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-value') === String(config.level));
    });
    var badge = document.getElementById('tv-status');
    if (badge) {
      badge.textContent = LEVEL_LABELS[config.level] || 'Standard';
      badge.className = 'config-section-status enabled';
    }
  }

  async function loadToolVerbosityConfig() {
    try {
      var res = await fetch('/api/admin/config/tool-verbosity');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateToolVerbosity(config);
    } catch (err) {
      console.error('[laminark] Failed to load tool verbosity config:', err);
    }
  }

  async function saveToolVerbosityConfig(data) {
    try {
      var res = await fetch('/api/admin/config/tool-verbosity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var config = await res.json();
      populateToolVerbosity(config);
      return config;
    } catch (err) {
      console.error('[laminark] Failed to save tool verbosity config:', err);
      return null;
    }
  }

  function initToolVerbosity() {
    // Level radio buttons
    var levelBtns = document.querySelectorAll('#tv-level .config-radio');
    levelBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        levelBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });

    // Save button
    var saveBtn = document.getElementById('tv-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        var activeBtn = document.querySelector('#tv-level .config-radio.active');
        var level = activeBtn ? parseInt(activeBtn.getAttribute('data-value'), 10) : 2;
        var result = await saveToolVerbosityConfig({ level: level });
        if (result) showSuccessMessage('Tool verbosity settings saved.');
      });
    }

    // Reset to defaults
    var defaultsBtn = document.getElementById('tv-defaults');
    if (defaultsBtn) {
      var tvResetTimer = null;
      defaultsBtn.addEventListener('click', async function () {
        if (defaultsBtn.classList.contains('confirming')) {
          clearTimeout(tvResetTimer);
          defaultsBtn.classList.remove('confirming');
          defaultsBtn.textContent = 'Reset to Defaults';
          var result = await saveToolVerbosityConfig({ __reset: true });
          if (result) showSuccessMessage('Tool verbosity reset to defaults.');
        } else {
          defaultsBtn.classList.add('confirming');
          defaultsBtn.textContent = 'Confirm?';
          tvResetTimer = setTimeout(function () {
            defaultsBtn.classList.remove('confirming');
            defaultsBtn.textContent = 'Reset to Defaults';
          }, 3000);
        }
      });
    }

    loadToolVerbosityConfig();
  }

  // =========================================================================
  // System Info
  // =========================================================================

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatUptime(seconds) {
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function makeStatCard(id, value, label) {
    var el = document.createElement('div');
    el.className = 'stat-card';
    if (id) el.id = id;

    var valueEl = document.createElement('div');
    valueEl.className = 'stat-value';
    valueEl.textContent = value;

    var labelEl = document.createElement('div');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;

    el.appendChild(valueEl);
    el.appendChild(labelEl);
    return el;
  }

  async function fetchSystemInfo() {
    try {
      var res = await fetch('/api/admin/system');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      console.error('[laminark] Failed to fetch system info:', err);
      return null;
    }
  }

  function renderSystemInfo(info) {
    if (!info) return;

    // System Info grid
    var sysGrid = document.getElementById('system-info-grid');
    if (sysGrid) {
      sysGrid.innerHTML = '';
      sysGrid.appendChild(makeStatCard(null, info.laminarkVersion, 'Laminark'));
      sysGrid.appendChild(makeStatCard(null, info.nodeVersion, 'Node.js'));
      sysGrid.appendChild(makeStatCard(null, info.platform + ' ' + info.arch, 'Platform'));
      sysGrid.appendChild(makeStatCard(null, formatUptime(info.uptimeSeconds), 'Uptime'));
    }

    // Database Storage grid
    var dbGrid = document.getElementById('db-storage-grid');
    if (dbGrid) {
      dbGrid.innerHTML = '';
      dbGrid.appendChild(makeStatCard(null, formatBytes(info.database.sizeBytes), 'DB Size'));
      dbGrid.appendChild(makeStatCard(null, formatBytes(info.database.walSizeBytes), 'WAL Size'));
      dbGrid.appendChild(makeStatCard(null, info.database.pageCount.toLocaleString(), 'Page Count'));
      dbGrid.appendChild(makeStatCard(null, formatBytes(info.database.pageSize), 'Page Size'));
    }

    // Process Memory grid
    var memGrid = document.getElementById('process-memory-grid');
    if (memGrid) {
      memGrid.innerHTML = '';
      memGrid.appendChild(makeStatCard(null, formatBytes(info.memory.rssBytes), 'RSS'));
      memGrid.appendChild(makeStatCard(null, formatBytes(info.memory.heapUsedBytes), 'Heap Used'));
      memGrid.appendChild(makeStatCard(null, formatBytes(info.memory.heapTotalBytes), 'Heap Total'));
    }
  }

  async function refreshSystemInfo() {
    var info = await fetchSystemInfo();
    renderSystemInfo(info);
  }

  // =========================================================================
  // Sidebar Navigation
  // =========================================================================

  function initSettingsSidebar() {
    var items = document.querySelectorAll('.settings-sidebar-item');
    var panels = document.querySelectorAll('.settings-panel');

    function activateTab(tabName) {
      items.forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-settings-tab') === tabName);
      });
      panels.forEach(function (panel) {
        panel.classList.toggle('active', panel.getAttribute('data-settings-panel') === tabName);
      });
      try { localStorage.setItem('laminark-settings-tab', tabName); } catch (e) {}
    }

    items.forEach(function (item) {
      item.addEventListener('click', function () {
        activateTab(item.getAttribute('data-settings-tab'));
      });
    });

    // Restore last-selected tab
    var saved = null;
    try { saved = localStorage.getItem('laminark-settings-tab'); } catch (e) {}
    if (saved && document.querySelector('[data-settings-panel="' + saved + '"]')) {
      activateTab(saved);
    }
  }

  // =========================================================================
  // Init
  // =========================================================================

  function initSettings() {
    initSettingsSidebar();
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

    // System info (fetched once, not re-fetched on project change)
    refreshSystemInfo();

    // Config sections
    initHygiene();
    initHygieneConfig();
    initToolVerbosity();
    initTopicDetection();
    initGraphExtraction();
    initCrossAccess();
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
