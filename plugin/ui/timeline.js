/**
 * Laminark Timeline View
 *
 * Renders a chronological vertical timeline of sessions with observations
 * inside them. Topic shift points appear as dividers between observation
 * groups. Supports expand/collapse, infinite scroll, and SSE live updates.
 *
 * @module timeline
 */

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let timelineContainer = null;
let currentOffset = 0;
let isLoadingMore = false;
let hasMoreData = true;
const PAGE_SIZE = 50;
const DEFAULT_EXPANDED_COUNT = 3;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the timeline view on a given container element.
 * Sets up the intersection observer for lazy rendering and scroll listeners.
 * @param {string} containerId - ID of the container element
 */
function initTimeline(containerId) {
  timelineContainer = document.getElementById(containerId);
  if (!timelineContainer) {
    console.warn('[laminark:timeline] Container not found:', containerId);
    return;
  }

  // Ensure the container has the timeline structure
  if (!timelineContainer.querySelector('.timeline-container')) {
    var wrapper = document.createElement('div');
    wrapper.className = 'timeline-container';

    var spine = document.createElement('div');
    spine.className = 'timeline-spine';
    wrapper.appendChild(spine);

    var sessions = document.createElement('div');
    sessions.className = 'timeline-sessions';
    wrapper.appendChild(sessions);

    var sentinel = document.createElement('div');
    sentinel.className = 'timeline-sentinel';
    wrapper.appendChild(sentinel);

    timelineContainer.innerHTML = '';
    timelineContainer.appendChild(wrapper);
  }

  // Set up infinite scroll via IntersectionObserver on the sentinel
  var sentinel = timelineContainer.querySelector('.timeline-sentinel');
  if (sentinel && typeof IntersectionObserver !== 'undefined') {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !isLoadingMore && hasMoreData) {
          loadOlderSessions();
        }
      });
    }, { root: timelineContainer, rootMargin: '200px' });
    observer.observe(sentinel);
  }

  // Wire up SSE event listeners
  wireSSEListeners();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Load timeline data from the API and render it.
 * @param {Object} [range] - Optional time range filters
 * @param {string} [range.from] - ISO8601 start
 * @param {string} [range.to] - ISO8601 end
 */
async function loadTimelineData(range) {
  currentOffset = 0;
  hasMoreData = true;

  var data = await fetchTimelineFromAPI(range, 0);

  var sessionsContainer = timelineContainer
    ? timelineContainer.querySelector('.timeline-sessions')
    : null;
  if (!sessionsContainer) return;

  // Clear any existing content
  sessionsContainer.innerHTML = '';

  if (!data.sessions.length && !data.observations.length) {
    showTimelineEmptyState(sessionsContainer);
    return;
  }

  renderTimelineData(data, sessionsContainer);
  currentOffset = data.sessions.length;

  // If we got fewer sessions than the page size, no more to load
  if (data.sessions.length < PAGE_SIZE) {
    hasMoreData = false;
  }
}

/**
 * Fetch timeline data from the REST API.
 * @param {Object} [range] - Optional time range
 * @param {number} offset - Pagination offset
 * @returns {Promise<{sessions: Array, observations: Array, topicShifts: Array}>}
 */
async function fetchTimelineFromAPI(range, offset) {
  var params = new URLSearchParams();
  if (range && range.from) params.set('from', range.from);
  if (range && range.to) params.set('to', range.to);
  params.set('limit', String(PAGE_SIZE * 10)); // observations limit
  if (offset > 0) params.set('offset', String(offset));
  if (window.laminarkState && window.laminarkState.currentProject) params.set('project', window.laminarkState.currentProject);

  var url = '/api/timeline?' + params.toString();

  try {
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (err) {
    console.error('[laminark:timeline] Failed to fetch data:', err);
    return { sessions: [], observations: [], topicShifts: [] };
  }
}

/**
 * Load older sessions for infinite scroll.
 */
async function loadOlderSessions() {
  if (isLoadingMore || !hasMoreData) return;
  isLoadingMore = true;

  var data = await fetchTimelineFromAPI(null, currentOffset);

  if (data.sessions.length === 0) {
    hasMoreData = false;
    isLoadingMore = false;
    return;
  }

  var sessionsContainer = timelineContainer
    ? timelineContainer.querySelector('.timeline-sessions')
    : null;
  if (!sessionsContainer) {
    isLoadingMore = false;
    return;
  }

  renderTimelineData(data, sessionsContainer, true);
  currentOffset += data.sessions.length;

  if (data.sessions.length < PAGE_SIZE) {
    hasMoreData = false;
  }

  isLoadingMore = false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render timeline data into the sessions container.
 * @param {Object} data - API response with sessions, observations, topicShifts
 * @param {HTMLElement} container - The .timeline-sessions container
 * @param {boolean} [append] - If true, append to existing content (infinite scroll)
 */
function renderTimelineData(data, container, append) {
  // Group observations by session
  var obsBySession = new Map();
  data.observations.forEach(function (obs) {
    var sid = obs.sessionId || '__ungrouped__';
    if (!obsBySession.has(sid)) obsBySession.set(sid, []);
    obsBySession.get(sid).push(obs);
  });

  // Group topic shifts by session timestamp range
  var shiftsBySession = new Map();
  data.sessions.forEach(function (session) {
    var sessionShifts = data.topicShifts.filter(function (ts) {
      return ts.timestamp >= session.startedAt &&
        (!session.endedAt || ts.timestamp <= session.endedAt);
    });
    if (sessionShifts.length > 0) {
      shiftsBySession.set(session.id, sessionShifts);
    }
  });

  // Determine which sessions should start expanded
  var existingCards = container.querySelectorAll('.session-card');
  var existingCount = existingCards.length;

  var fragment = document.createDocumentFragment();

  // Render sessions in order (already reverse chronological from API)
  data.sessions.forEach(function (session, index) {
    var sessionObs = obsBySession.get(session.id) || [];
    var sessionShifts = shiftsBySession.get(session.id) || [];

    // Sort observations chronologically within session
    sessionObs.sort(function (a, b) {
      return a.createdAt.localeCompare(b.createdAt);
    });

    // Expand the first 3 sessions on initial load
    var shouldExpand = !append && (index + existingCount) < DEFAULT_EXPANDED_COUNT;

    var card = createSessionCard(session, sessionObs, sessionShifts, shouldExpand);
    fragment.appendChild(card);
  });

  // Handle ungrouped observations
  var ungrouped = obsBySession.get('__ungrouped__');
  if (ungrouped && ungrouped.length > 0 && !append) {
    var ungroupedSession = {
      id: '__ungrouped__',
      startedAt: null,
      endedAt: null,
      summary: 'Ungrouped observations',
      observationCount: ungrouped.length,
    };
    var ungroupedCard = createSessionCard(ungroupedSession, ungrouped, [], false);
    fragment.appendChild(ungroupedCard);
  }

  container.appendChild(fragment);
}

/**
 * Create a session card element with observations and topic shifts.
 * @param {Object} session - Session data
 * @param {Array} observations - Observations in this session
 * @param {Array} shifts - Topic shifts in this session
 * @param {boolean} expanded - Whether the card starts expanded
 * @returns {HTMLElement}
 */
function createSessionCard(session, observations, shifts, expanded) {
  var card = document.createElement('div');
  card.className = 'session-card' + (expanded ? '' : ' collapsed');
  card.setAttribute('data-session-id', session.id);

  // Header
  var header = document.createElement('div');
  header.className = 'session-header';

  var headerLeft = document.createElement('div');
  headerLeft.className = 'session-header-left';

  var toggleIcon = document.createElement('span');
  toggleIcon.className = 'toggle-icon';
  toggleIcon.textContent = '\u25BC'; // down arrow
  headerLeft.appendChild(toggleIcon);

  var title = document.createElement('h3');
  title.textContent = session.startedAt
    ? formatSessionDate(session.startedAt)
    : (session.summary || 'Session');
  headerLeft.appendChild(title);

  header.appendChild(headerLeft);

  var headerRight = document.createElement('div');
  headerRight.className = 'session-meta';

  // Duration
  if (session.startedAt && session.endedAt) {
    var durationSpan = document.createElement('span');
    durationSpan.className = 'session-duration';
    durationSpan.textContent = formatDuration(session.startedAt, session.endedAt);
    headerRight.appendChild(durationSpan);
  }

  // Observation count badge
  var countBadge = document.createElement('span');
  countBadge.className = 'session-badge';
  var obsCount = session.observationCount != null ? session.observationCount : observations.length;
  countBadge.textContent = obsCount + ' obs';
  headerRight.appendChild(countBadge);

  // Active badge if session has no end time
  if (session.startedAt && !session.endedAt && session.id !== '__ungrouped__') {
    var activeBadge = document.createElement('span');
    activeBadge.className = 'session-badge active';
    activeBadge.textContent = 'Active';
    headerRight.appendChild(activeBadge);
  }

  header.appendChild(headerRight);
  card.appendChild(header);

  // Summary (if available)
  if (session.summary && session.id !== '__ungrouped__') {
    var summaryDiv = document.createElement('div');
    summaryDiv.className = 'session-summary';
    summaryDiv.textContent = session.summary;
    card.appendChild(summaryDiv);
  }

  // Observation list
  var obsList = document.createElement('div');
  obsList.className = 'observation-list';

  // Interleave observations and topic shifts chronologically
  var items = [];
  observations.forEach(function (obs) {
    items.push({ time: obs.createdAt, kind: 'obs', data: obs });
  });
  shifts.forEach(function (shift) {
    items.push({ time: shift.timestamp, kind: 'shift', data: shift });
  });
  items.sort(function (a, b) { return a.time.localeCompare(b.time); });

  items.forEach(function (item) {
    if (item.kind === 'obs') {
      obsList.appendChild(createObservationEntry(item.data));
    } else {
      obsList.appendChild(createTopicShiftMarker(item.data));
    }
  });

  card.appendChild(obsList);

  // Click header to toggle expand/collapse
  header.addEventListener('click', function () {
    card.classList.toggle('collapsed');
  });

  return card;
}

/**
 * Create an observation entry element.
 * @param {Object} obs - Observation data
 * @returns {HTMLElement}
 */
function createObservationEntry(obs) {
  var entry = document.createElement('div');
  entry.className = 'observation-entry';

  var timeSpan = document.createElement('span');
  timeSpan.className = 'obs-time';
  timeSpan.textContent = formatTimeShort(obs.createdAt);
  entry.appendChild(timeSpan);

  var typeDot = document.createElement('span');
  typeDot.className = 'obs-type-dot';
  typeDot.setAttribute('data-type', obs.type || 'default');
  entry.appendChild(typeDot);

  var textSpan = document.createElement('span');
  textSpan.className = 'obs-text';
  // Truncate to 120 chars with ellipsis
  var text = obs.text || '';
  textSpan.textContent = text.length > 120 ? text.substring(0, 120) + '...' : text;
  entry.appendChild(textSpan);

  return entry;
}

/**
 * Create a topic shift marker element.
 * @param {Object} shift - Topic shift data
 * @returns {HTMLElement}
 */
function createTopicShiftMarker(shift) {
  var marker = document.createElement('div');
  marker.className = 'topic-shift-marker';

  var label = document.createElement('span');
  label.className = 'shift-label';
  label.textContent = 'Topic shifted';
  marker.appendChild(label);

  // Confidence indicator dot
  if (shift.confidence != null) {
    var dot = document.createElement('span');
    dot.className = 'confidence-dot';
    // green for high (>= 0.7), yellow for medium
    dot.style.backgroundColor = shift.confidence >= 0.7 ? '#3fb950' : '#d29922';
    dot.title = 'Confidence: ' + (shift.confidence * 100).toFixed(0) + '%';
    marker.appendChild(dot);
  }

  return marker;
}

/**
 * Show the empty state message.
 * @param {HTMLElement} container
 */
function showTimelineEmptyState(container) {
  var msg = document.createElement('p');
  msg.className = 'empty-state';
  msg.textContent = 'No sessions recorded yet. Timeline will populate as you use Claude.';
  container.appendChild(msg);
}

// ---------------------------------------------------------------------------
// Scroll helpers
// ---------------------------------------------------------------------------

/**
 * Scroll to a specific session card by session ID.
 * @param {string} sessionId
 */
function scrollToSession(sessionId) {
  if (!timelineContainer) return;
  var card = timelineContainer.querySelector('[data-session-id="' + sessionId + '"]');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Expand it if collapsed
    card.classList.remove('collapsed');
  }
}

/**
 * Scroll to the most recent (topmost) session.
 */
function scrollToToday() {
  if (!timelineContainer) return;
  var firstCard = timelineContainer.querySelector('.session-card');
  if (firstCard) {
    firstCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    firstCard.classList.remove('collapsed');
  } else {
    timelineContainer.scrollTop = 0;
  }
}

// ---------------------------------------------------------------------------
// SSE live updates
// ---------------------------------------------------------------------------

function wireSSEListeners() {
  // New observation: prepend to the correct session card
  document.addEventListener('laminark:new_observation', function (e) {
    var obs = e.detail;
    if (!timelineContainer) return;

    var sessionId = obs.sessionId;
    if (!sessionId) return;

    var card = timelineContainer.querySelector('[data-session-id="' + sessionId + '"]');

    if (card) {
      // Add observation to existing session card
      var obsList = card.querySelector('.observation-list');
      if (obsList) {
        obsList.appendChild(createObservationEntry(obs));
      }
      // Update badge count
      var badge = card.querySelector('.session-badge:not(.active)');
      if (badge) {
        var current = parseInt(badge.textContent, 10) || 0;
        badge.textContent = (current + 1) + ' obs';
      }
    } else {
      // Create new session card at the top
      var sessionsContainer = timelineContainer.querySelector('.timeline-sessions');
      if (sessionsContainer) {
        var newSession = {
          id: sessionId,
          startedAt: obs.createdAt,
          endedAt: null,
          summary: null,
          observationCount: 1,
        };
        var newCard = createSessionCard(newSession, [obs], [], true);
        sessionsContainer.insertBefore(newCard, sessionsContainer.firstChild);
      }
    }
  });

  // Session start: create new empty session card at top
  document.addEventListener('laminark:session_start', function (e) {
    var session = e.detail;
    if (!timelineContainer) return;

    var sessionsContainer = timelineContainer.querySelector('.timeline-sessions');
    if (!sessionsContainer) return;

    // Check if card already exists
    var existing = timelineContainer.querySelector('[data-session-id="' + session.id + '"]');
    if (existing) return;

    var newSession = {
      id: session.id,
      startedAt: session.startedAt || new Date().toISOString(),
      endedAt: null,
      summary: null,
      observationCount: 0,
    };
    var card = createSessionCard(newSession, [], [], true);
    sessionsContainer.insertBefore(card, sessionsContainer.firstChild);
  });

  // Session end: update session card header
  document.addEventListener('laminark:session_end', function (e) {
    var session = e.detail;
    if (!timelineContainer) return;

    var card = timelineContainer.querySelector('[data-session-id="' + session.id + '"]');
    if (!card) return;

    // Update duration in meta
    var metaDiv = card.querySelector('.session-meta');
    if (metaDiv && session.startedAt && session.endedAt) {
      var durationSpan = metaDiv.querySelector('.session-duration');
      if (!durationSpan) {
        durationSpan = document.createElement('span');
        durationSpan.className = 'session-duration';
        metaDiv.insertBefore(durationSpan, metaDiv.firstChild);
      }
      durationSpan.textContent = formatDuration(session.startedAt, session.endedAt);
    }

    // Remove "Active" badge
    var activeBadge = card.querySelector('.session-badge.active');
    if (activeBadge) {
      activeBadge.remove();
    }
  });

  // Topic shift: insert marker in active session
  document.addEventListener('laminark:topic_shift', function (e) {
    var shift = e.detail;
    if (!timelineContainer) return;

    // Find the active session card (one without end time -- has active badge)
    var activeCard = timelineContainer.querySelector('.session-badge.active');
    var card = activeCard ? activeCard.closest('.session-card') : null;

    // Fallback: use session ID if provided
    if (!card && shift.sessionId) {
      card = timelineContainer.querySelector('[data-session-id="' + shift.sessionId + '"]');
    }

    if (!card) return;

    var obsList = card.querySelector('.observation-list');
    if (obsList) {
      obsList.appendChild(createTopicShiftMarker(shift));
    }
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a date for session headers: "Mon Jan 15, 2:30 PM"
 * @param {string} isoString
 * @returns {string}
 */
function formatSessionDate(isoString) {
  try {
    var d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }) + ', ' + d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch (e) {
    return isoString;
  }
}

/**
 * Format time for observation entries: "2:31 PM"
 * @param {string} isoString
 * @returns {string}
 */
function formatTimeShort(isoString) {
  try {
    var d = new Date(isoString);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch (e) {
    return isoString || '';
  }
}

/**
 * Format duration between two ISO timestamps: "45 min", "2h 15min", etc.
 * @param {string} startIso
 * @param {string} endIso
 * @returns {string}
 */
function formatDuration(startIso, endIso) {
  try {
    var start = new Date(startIso).getTime();
    var end = new Date(endIso).getTime();
    var diffMs = end - start;
    if (diffMs < 0) return '';

    var minutes = Math.round(diffMs / 60000);
    if (minutes < 60) return minutes + ' min';

    var hours = Math.floor(minutes / 60);
    var mins = minutes % 60;
    return hours + 'h' + (mins > 0 ? ' ' + mins + 'min' : '');
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Jump to Today button handler
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  var jumpBtn = document.querySelector('.jump-today-btn');
  if (jumpBtn) {
    jumpBtn.addEventListener('click', function () {
      scrollToToday();
    });
  }
});

// ---------------------------------------------------------------------------
// Export for use by app.js
// ---------------------------------------------------------------------------

window.laminarkTimeline = {
  initTimeline: initTimeline,
  loadTimelineData: loadTimelineData,
  scrollToSession: scrollToSession,
  scrollToToday: scrollToToday,
};
