/**
 * Laminark Activity Feed Module
 *
 * Listens to SSE-dispatched CustomEvents and renders a live activity feed.
 * Max 100 items in memory, newest first. Supports clear and slide-in animation.
 */

(function () {
  var MAX_ITEMS = 100;
  var items = [];
  var feedEl = null;

  var EVENT_CONFIG = {
    'laminark:new_observation': {
      icon: '\u{1F4DD}',
      label: 'Observation',
      cssClass: 'activity-observation',
      format: function (d) {
        return d.text || (d.id ? 'Observation ' + d.id.substring(0, 8) : 'New observation');
      },
    },
    'laminark:entity_updated': {
      icon: '\u{1F9E9}',
      label: 'Entity',
      cssClass: 'activity-entity',
      format: function (d) {
        return (d.label || d.name || d.id || 'Unknown') + (d.type ? ' (' + d.type + ')' : '');
      },
    },
    'laminark:topic_shift': {
      icon: '\u{1F500}',
      label: 'Topic Shift',
      cssClass: 'activity-topic-shift',
      format: function (d) {
        var msg = 'Topic shift detected';
        if (d.confidence != null) msg += ' (' + (d.confidence * 100).toFixed(0) + '% confidence)';
        return msg;
      },
    },
    'laminark:session_start': {
      icon: '\u{25B6}\uFE0F',
      label: 'Session Start',
      cssClass: 'activity-session-start',
      format: function (d) {
        return 'Session started' + (d.id ? ': ' + d.id.substring(0, 8) : '');
      },
    },
    'laminark:session_end': {
      icon: '\u{23F9}\uFE0F',
      label: 'Session End',
      cssClass: 'activity-session-end',
      format: function (d) {
        return 'Session ended' + (d.id ? ': ' + d.id.substring(0, 8) : '');
      },
    },
  };

  function relativeTime(isoString) {
    if (!isoString) return 'just now';
    try {
      var diff = Date.now() - new Date(isoString).getTime();
      if (diff < 0) diff = 0;
      var secs = Math.floor(diff / 1000);
      if (secs < 60) return secs + 's ago';
      var mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    } catch (_e) {
      return 'just now';
    }
  }

  function createItemEl(item) {
    var el = document.createElement('div');
    el.className = 'activity-item ' + item.cssClass + ' activity-slide-in';

    var iconSpan = document.createElement('span');
    iconSpan.className = 'activity-icon';
    iconSpan.textContent = item.icon;
    el.appendChild(iconSpan);

    var body = document.createElement('div');
    body.className = 'activity-body';

    var title = document.createElement('div');
    title.className = 'activity-title';
    title.textContent = item.label;
    body.appendChild(title);

    var desc = document.createElement('div');
    desc.className = 'activity-desc';
    desc.textContent = item.description;
    body.appendChild(desc);

    el.appendChild(body);

    var time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = relativeTime(item.timestamp);
    el.appendChild(time);

    return el;
  }

  function renderFeed() {
    if (!feedEl) return;

    if (items.length === 0) {
      feedEl.innerHTML = '<p class="empty-state">Waiting for live events...</p>';
      return;
    }

    feedEl.innerHTML = '';
    items.forEach(function (item) {
      feedEl.appendChild(createItemEl(item));
    });
  }

  function addItem(eventName, detail) {
    var config = EVENT_CONFIG[eventName];
    if (!config) return;

    var item = {
      icon: config.icon,
      label: config.label,
      cssClass: config.cssClass,
      description: config.format(detail || {}),
      timestamp: detail.createdAt || detail.timestamp || new Date().toISOString(),
    };

    items.unshift(item);
    if (items.length > MAX_ITEMS) {
      items = items.slice(0, MAX_ITEMS);
    }

    // If feed is visible, prepend DOM element directly for performance
    if (feedEl) {
      // Remove empty state if present
      var empty = feedEl.querySelector('.empty-state');
      if (empty) empty.remove();

      var el = createItemEl(item);
      if (feedEl.firstChild) {
        feedEl.insertBefore(el, feedEl.firstChild);
      } else {
        feedEl.appendChild(el);
      }

      // Trim excess DOM nodes
      while (feedEl.children.length > MAX_ITEMS) {
        feedEl.removeChild(feedEl.lastChild);
      }
    }
  }

  function clearFeed() {
    items = [];
    renderFeed();
  }

  function initActivityFeed() {
    feedEl = document.getElementById('activity-feed');

    var clearBtn = document.getElementById('activity-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearFeed);
    }

    // Listen to all SSE event types
    Object.keys(EVENT_CONFIG).forEach(function (eventName) {
      document.addEventListener(eventName, function (e) {
        addItem(eventName, e.detail || {});
      });
    });

    renderFeed();
  }

  window.laminarkActivity = {
    initActivityFeed: initActivityFeed,
    clearFeed: clearFeed,
  };
})();
