import { INSTALLER_JS } from './installer-js';

/**
 * The dashboard's only script. Everything it does is an enhancement: pages
 * are complete HTML without it. Served from /assets/app.js (same origin).
 */
export const APP_JS =
  INSTALLER_JS +
  `(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  function relative(iso) {
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function refreshTimes() {
    var nodes = document.querySelectorAll('time[data-rel]');
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute('datetime');
      if (iso) nodes[i].textContent = relative(iso);
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('[data-copy]') : null;
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.getAttribute('data-copy')).then(function () {
      var original = button.getAttribute('aria-label');
      button.setAttribute('aria-label', 'Copied');
      button.setAttribute('title', 'Copied');
      button.classList.add('text-ok');
      setTimeout(function () {
        button.setAttribute('aria-label', original);
        button.setAttribute('title', original);
        button.classList.remove('text-ok');
      }, 1500);
    });
  });

  var live = document.getElementById('live');
  var status = document.querySelector('[data-live-status]');
  var toggle = document.querySelector('[data-live-toggle]');
  var toggleLabel = document.querySelector('[data-live-toggle-label]');
  var paused = false;
  var failed = false;
  var updatedAt = status ? new Date(status.getAttribute('data-live-at')).getTime() : Date.now();
  var INTERVAL = 10000;

  function paint() {
    if (!status) return;
    if (paused) { status.textContent = 'Auto-refresh paused'; return; }
    if (failed) { status.textContent = 'Could not refresh, retrying'; return; }
    var s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
    status.textContent = s < 5 ? 'Updated just now' : 'Updated ' + s + ' s ago';
  }

  function refresh() {
    if (!live || paused || document.hidden) return;
    fetch(live.getAttribute('data-live-src'), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (res) {
        if (res.redirected || !res.ok) throw new Error('refresh failed');
        return res.text();
      })
      .then(function (html) {
        live.innerHTML = html;
        document.dispatchEvent(new Event('fleet:updated'));
        updatedAt = Date.now();
        failed = false;
        refreshTimes();
        paint();
      })
      .catch(function () { failed = true; paint(); });
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      paused = !paused;
      toggle.setAttribute('aria-pressed', String(paused));
      if (toggleLabel) toggleLabel.textContent = paused ? 'Resume' : 'Pause';
      if (!paused) refresh();
      paint();
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - updatedAt >= INTERVAL) refresh();
  });

  setInterval(refresh, INTERVAL);
  setInterval(function () { refreshTimes(); paint(); }, 1000);
  refreshTimes();
})();
`;
