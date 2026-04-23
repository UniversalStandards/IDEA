/**
 * src/api/dashboard.ts
 * Returns the self-contained HTML for the real-time monitoring dashboard.
 * Served at GET /admin/dashboard (no auth guard on the page itself;
 * the page prompts for a JWT which is then sent to the SSE endpoints).
 */

export function buildDashboardHtml(baseUrl: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Hub — Monitoring Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0d1117;
      --surface:   #161b22;
      --border:    #30363d;
      --text:      #e6edf3;
      --muted:     #8b949e;
      --accent:    #58a6ff;
      --green:     #3fb950;
      --yellow:    #d29922;
      --red:       #f85149;
      --orange:    #f0883e;
      --font:      'Segoe UI', system-ui, -apple-system, sans-serif;
      --mono:      'Cascadia Code', 'Fira Mono', 'Menlo', monospace;
    }

    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; min-height: 100vh; }

    /* ── Header ── */
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 20px; background: var(--surface); border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 100;
    }
    header h1 { font-size: 16px; font-weight: 600; color: var(--accent); display: flex; align-items: center; gap: 8px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
    .status-dot.connected { background: var(--green); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

    /* ── Auth banner ── */
    #auth-banner {
      background: var(--surface); border: 1px solid var(--yellow); border-radius: 6px;
      margin: 20px; padding: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    }
    #auth-banner label { color: var(--yellow); font-weight: 600; }
    #auth-banner input {
      flex: 1; min-width: 300px; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-family: var(--mono); font-size: 12px;
    }
    button {
      background: var(--accent); color: #fff; border: none; border-radius: 4px;
      padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 600;
    }
    button:hover { opacity: .85; }
    button.secondary { background: var(--surface); border: 1px solid var(--border); color: var(--text); }

    /* ── Grid layout ── */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; padding: 16px; }
    .grid-wide { grid-column: 1 / -1; }

    /* ── Card ── */
    .card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    }
    .card-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13px;
    }
    .card-header .badge {
      background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
      padding: 2px 8px; font-size: 11px; color: var(--muted);
    }
    .card-body { padding: 14px 16px; }

    /* ── Metric tiles ── */
    .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .metric-tile {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 12px; text-align: center;
    }
    .metric-tile .val { font-size: 24px; font-weight: 700; color: var(--accent); line-height: 1.1; }
    .metric-tile .label { font-size: 11px; color: var(--muted); margin-top: 4px; }

    /* ── Mini chart ── */
    canvas.sparkline { display: block; width: 100%; height: 60px; }

    /* ── Log stream ── */
    .log-controls { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    .log-controls select, .log-controls input {
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 4px; padding: 4px 8px; font-size: 12px;
    }
    .log-controls input { flex: 1; min-width: 180px; }
    #log-container {
      height: 320px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border);
      border-radius: 4px; font-family: var(--mono); font-size: 11px; line-height: 1.6;
      padding: 8px;
    }
    .log-line { padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,.04); white-space: pre-wrap; word-break: break-all; }
    .log-line.error   { color: var(--red); }
    .log-line.warn    { color: var(--yellow); }
    .log-line.info    { color: var(--text); }
    .log-line.debug   { color: var(--muted); }
    .log-line.verbose { color: var(--muted); }
    .log-line.search-match { background: rgba(88,166,255,.12); }

    /* ── Provider health ── */
    .provider-list { display: flex; flex-direction: column; gap: 8px; }
    .provider-row {
      display: flex; align-items: center; gap: 10px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px;
    }
    .health-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .health-dot.green  { background: var(--green); }
    .health-dot.yellow { background: var(--yellow); }
    .health-dot.red    { background: var(--red); }
    .health-dot.gray   { background: var(--muted); }
    .provider-name { flex: 1; font-weight: 600; }
    .provider-meta { font-size: 11px; color: var(--muted); }
    .provider-actions { display: flex; gap: 6px; }
    .provider-actions button { padding: 3px 8px; font-size: 11px; }

    /* ── Events feed ── */
    #events-container {
      height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
    }
    .event-item {
      background: var(--bg); border-left: 3px solid var(--border); border-radius: 0 4px 4px 0;
      padding: 8px 10px; font-size: 12px;
    }
    .event-item.started  { border-left-color: var(--accent); }
    .event-item.complete { border-left-color: var(--green); }
    .event-item.failed   { border-left-color: var(--red); }
    .event-item.cancelled{ border-left-color: var(--yellow); }
    .event-item .ev-time { font-size: 10px; color: var(--muted); float: right; }
    .event-item .ev-type { font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: .05em; color: var(--muted); }
    .event-item .ev-msg  { margin-top: 2px; }

    /* ── Empty state ── */
    .empty { text-align: center; color: var(--muted); padding: 24px; font-size: 13px; }

    /* ── Connection status bar ── */
    #conn-bar {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: var(--surface); border-top: 1px solid var(--border);
      display: flex; gap: 16px; padding: 6px 20px; font-size: 11px; color: var(--muted);
      z-index: 200;
    }
    #conn-bar span { display: flex; align-items: center; gap: 4px; }
    #conn-bar .status-dot { width: 6px; height: 6px; }
  </style>
</head>
<body>

<header>
  <h1>
    <span class="status-dot" id="global-dot"></span>
    MCP Hub &mdash; Monitoring Dashboard
  </h1>
  <div style="display:flex;gap:10px;align-items:center;">
    <span style="color:var(--muted);font-size:12px;" id="last-update">No data yet</span>
    <button class="secondary" id="btn-reconnect">Reconnect</button>
    <button class="secondary" id="btn-logout" style="display:none">Log out</button>
  </div>
</header>

<div id="auth-banner">
  <label>JWT Token:</label>
  <input type="password" id="token-input" placeholder="Paste your admin JWT token here&hellip;" autocomplete="off">
  <button id="btn-connect">Connect</button>
</div>

<div class="grid" id="dashboard" style="display:none">

  <!-- Metrics Overview -->
  <div class="card grid-wide">
    <div class="card-header">
      Live Metrics
      <span class="badge" id="metrics-age">—</span>
    </div>
    <div class="card-body">
      <div class="metrics-grid">
        <div class="metric-tile"><div class="val" id="m-req-rate">—</div><div class="label">Requests / min</div></div>
        <div class="metric-tile"><div class="val" id="m-err-rate" style="color:var(--red)">—</div><div class="label">Errors / min</div></div>
        <div class="metric-tile"><div class="val" id="m-conns">—</div><div class="label">Handled total</div></div>
        <div class="metric-tile"><div class="val" id="m-heap-used">—</div><div class="label">Heap used (MB)</div></div>
        <div class="metric-tile"><div class="val" id="m-heap-total">—</div><div class="label">Heap total (MB)</div></div>
        <div class="metric-tile"><div class="val" id="m-rss">—</div><div class="label">RSS (MB)</div></div>
      </div>
      <div style="margin-top:14px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">Request rate history (last 60 samples)</div>
        <canvas id="req-chart" class="sparkline"></canvas>
      </div>
    </div>
  </div>

  <!-- Live Log Stream -->
  <div class="card grid-wide">
    <div class="card-header">
      Live Log Stream
      <div style="display:flex;gap:8px;align-items:center;">
        <label style="display:flex;align-items:center;gap:4px;font-weight:normal;font-size:12px;cursor:pointer">
          <input type="checkbox" id="log-autoscroll" checked> Auto-scroll
        </label>
        <button class="secondary" id="btn-clear-log" style="padding:3px 8px;font-size:11px">Clear</button>
        <span class="badge" id="log-count">0 lines</span>
      </div>
    </div>
    <div class="card-body">
      <div class="log-controls">
        <select id="log-level-filter">
          <option value="">All levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
          <option value="verbose">verbose</option>
        </select>
        <input type="text" id="log-module-filter" placeholder="Module filter…">
        <input type="text" id="log-search" placeholder="Search log content…">
        <button class="secondary" id="btn-filter-apply" style="padding:4px 10px;font-size:12px">Apply</button>
      </div>
      <div id="log-container"><div class="empty">Waiting for log entries&hellip;</div></div>
    </div>
  </div>

  <!-- Provider Health Board -->
  <div class="card">
    <div class="card-header">
      Provider Health Board
      <span class="badge" id="provider-count">—</span>
    </div>
    <div class="card-body">
      <div class="provider-list" id="provider-list">
        <div class="empty">Loading providers&hellip;</div>
      </div>
    </div>
  </div>

  <!-- Workflow Activity Feed -->
  <div class="card">
    <div class="card-header">
      Workflow Activity Feed
      <button class="secondary" id="btn-clear-events" style="padding:3px 8px;font-size:11px">Clear</button>
    </div>
    <div class="card-body">
      <div id="events-container"><div class="empty">Waiting for workflow events&hellip;</div></div>
    </div>
  </div>

</div>

<div id="conn-bar">
  <span><span class="status-dot" id="dot-metrics"></span> Metrics</span>
  <span><span class="status-dot" id="dot-logs"></span> Logs</span>
  <span><span class="status-dot" id="dot-events"></span> Events</span>
</div>

<script>
(function () {
  'use strict';

  const BASE_URL = ${JSON.stringify(baseUrl)};

  // ── State ─────────────────────────────────────────────────
  let token = localStorage.getItem('mcp_admin_token') || '';
  let sseMetrics = null, sseLogs = null, sseEvents = null;

  // Chart history (up to 60 samples)
  const reqHistory = [];
  const MAX_HISTORY = 60;

  // Log buffer (up to 2000 lines)
  const logBuffer = [];
  const MAX_LOGS = 2000;
  let logFilterLevel = '';
  let logFilterModule = '';
  let logSearch = '';
  let logLineCount = 0;
  let totalReq = 0, prevReq = 0;
  let totalErr = 0, prevErr = 0;

  // ── UI helpers ────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  function dot(id, cls) {
    const el = $(id);
    if (el) { el.className = 'status-dot ' + cls; }
  }
  function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }
  function now() { return new Date().toLocaleTimeString(); }

  // ── Auth ─────────────────────────────────────────────────
  if (token) showDashboard();

  $('btn-connect').onclick = function () {
    token = $('token-input').value.trim();
    if (!token) { alert('Please enter a token.'); return; }
    localStorage.setItem('mcp_admin_token', token);
    showDashboard();
    connect();
  };

  $('btn-logout').onclick = function () {
    token = '';
    localStorage.removeItem('mcp_admin_token');
    disconnectAll();
    $('dashboard').style.display = 'none';
    $('auth-banner').style.display = 'flex';
    $('btn-logout').style.display = 'none';
    $('global-dot').className = 'status-dot';
  };

  $('btn-reconnect').onclick = function () {
    if (token) { disconnectAll(); setTimeout(connect, 300); }
  };

  function showDashboard() {
    $('auth-banner').style.display = 'none';
    $('dashboard').style.display = 'grid';
    $('btn-logout').style.display = '';
    if (token) { $('token-input').value = token; connect(); }
    loadProviders();
  }

  // ── SSE connections ──────────────────────────────────────
  function sseUrl(path) {
    return BASE_URL + path + '?token=' + encodeURIComponent(token);
  }

  function connect() {
    connectMetrics();
    connectLogs();
    connectEvents();
  }

  function disconnectAll() {
    [sseMetrics, sseLogs, sseEvents].forEach(s => { if (s) { try { s.close(); } catch(_) {} } });
    sseMetrics = sseLogs = sseEvents = null;
    dot('dot-metrics', ''); dot('dot-logs', ''); dot('dot-events', '');
    dot('global-dot', '');
  }

  function connectMetrics() {
    if (sseMetrics) sseMetrics.close();
    dot('dot-metrics', 'yellow');
    sseMetrics = new EventSource(sseUrl('/admin/metrics/stream'));
    sseMetrics.onopen = function () { dot('dot-metrics', 'connected'); updateGlobalDot(); };
    sseMetrics.onmessage = function (e) { handleMetrics(JSON.parse(e.data)); };
    sseMetrics.onerror = function () {
      dot('dot-metrics', 'red'); updateGlobalDot();
      setTimeout(connectMetrics, 5000);
    };
  }

  function connectLogs() {
    if (sseLogs) sseLogs.close();
    dot('dot-logs', 'yellow');
    sseLogs = new EventSource(sseUrl('/admin/logs/stream'));
    sseLogs.onopen = function () { dot('dot-logs', 'connected'); updateGlobalDot(); };
    sseLogs.onmessage = function (e) { handleLog(JSON.parse(e.data)); };
    sseLogs.onerror = function () {
      dot('dot-logs', 'red'); updateGlobalDot();
      setTimeout(connectLogs, 5000);
    };
  }

  function connectEvents() {
    if (sseEvents) sseEvents.close();
    dot('dot-events', 'yellow');
    sseEvents = new EventSource(sseUrl('/admin/events/stream'));
    sseEvents.onopen = function () { dot('dot-events', 'connected'); updateGlobalDot(); };
    sseEvents.onmessage = function (e) { handleEvent(JSON.parse(e.data)); };
    sseEvents.onerror = function () {
      dot('dot-events', 'red'); updateGlobalDot();
      setTimeout(connectEvents, 5000);
    };
  }

  function updateGlobalDot() {
    const dots = [$('dot-metrics'), $('dot-logs'), $('dot-events')];
    const classes = dots.map(d => d ? d.className : '');
    if (classes.every(c => c.includes('connected'))) {
      $('global-dot').className = 'status-dot connected';
    } else if (classes.some(c => c.includes('red'))) {
      $('global-dot').className = 'status-dot'; // gray
    } else {
      $('global-dot').className = 'status-dot'; // gray
    }
  }

  // ── Metrics handler ───────────────────────────────────────
  function handleMetrics(snap) {
    $('last-update').textContent = 'Updated ' + now();
    $('metrics-age').textContent = snap.timestamp ? new Date(snap.timestamp).toLocaleTimeString() : '—';

    // Find metric values from snapshot
    const counters = snap.counters || [];
    const gauges   = snap.gauges || [];

    const reqTotal = sumCounters(counters, 'requests_handled_total');
    const errTotal = sumCounters(counters, 'requests_handled_total', { success: 'false' });

    // Req/min delta (5s intervals → multiply by 12)
    const reqDelta  = Math.max(0, reqTotal - totalReq);
    const errDelta  = Math.max(0, errTotal - totalErr);
    prevReq = reqDelta * 12; prevErr = errDelta * 12;
    totalReq = reqTotal; totalErr = errTotal;

    $('m-req-rate').textContent = prevReq;
    $('m-err-rate').textContent = prevErr;
    $('m-conns').textContent    = reqTotal;

    // Memory
    const mem = snap.memory || {};
    $('m-heap-used').textContent  = mb(mem.heapUsed  || 0);
    $('m-heap-total').textContent = mb(mem.heapTotal || 0);
    $('m-rss').textContent        = mb(mem.rss       || 0);

    // Chart
    reqHistory.push(prevReq);
    if (reqHistory.length > MAX_HISTORY) reqHistory.shift();
    drawSparkline($('req-chart'), reqHistory, '#58a6ff');
  }

  function sumCounters(counters, name, labels) {
    return counters
      .filter(c => c.name === name && (!labels || Object.entries(labels).every(([k,v]) => String(c.labels[k]) === v)))
      .reduce((s, c) => s + c.value, 0);
  }

  // ── Sparkline chart ───────────────────────────────────────
  function drawSparkline(canvas, data, color) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth * dpr;
    const h = canvas.offsetHeight * dpr;
    canvas.width  = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx || data.length < 2) return;

    const max = Math.max(...data, 1);
    const step = w / (data.length - 1);

    ctx.clearRect(0, 0, w, h);

    // Fill
    ctx.beginPath();
    ctx.moveTo(0, h);
    data.forEach((v, i) => ctx.lineTo(i * step, h - (v / max) * h * .9));
    ctx.lineTo((data.length - 1) * step, h);
    ctx.closePath();
    ctx.fillStyle = color + '22';
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * step, y = h - (v / max) * h * .9;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
  }

  // ── Log handler ───────────────────────────────────────────
  function handleLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    if (passesFilter(entry)) { appendLogLine(entry); }
  }

  function passesFilter(entry) {
    if (logFilterLevel && entry.level !== logFilterLevel) return false;
    if (logFilterModule && !(entry.module || '').toLowerCase().includes(logFilterModule.toLowerCase())) return false;
    if (logSearch) {
      const haystack = (entry.message || '') + JSON.stringify(entry);
      if (!haystack.toLowerCase().includes(logSearch.toLowerCase())) return false;
    }
    return true;
  }

  function appendLogLine(entry) {
    const container = $('log-container');
    // Remove empty state placeholder
    const empty = container.querySelector('.empty');
    if (empty) empty.remove();

    const line = document.createElement('div');
    line.className = 'log-line ' + (entry.level || 'info');
    if (logSearch && logSearch.length > 0) line.classList.add('search-match');

    const ts  = entry.timestamp ? entry.timestamp.replace('T', ' ').replace('Z', '') : '';
    const mod = entry.module ? '[' + entry.module + '] ' : '';
    line.textContent = ts + ' ' + (entry.level || '').toUpperCase().padEnd(7) + mod + (entry.message || '');
    container.appendChild(line);

    logLineCount++;
    $('log-count').textContent = logLineCount + ' lines';

    // Keep DOM bounded at MAX_LOGS
    while (container.children.length > MAX_LOGS) container.removeChild(container.firstChild);

    if ($('log-autoscroll').checked) container.scrollTop = container.scrollHeight;
  }

  function rebuildLogView() {
    const container = $('log-container');
    container.innerHTML = '';
    logLineCount = 0;
    const filtered = logBuffer.filter(passesFilter);
    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty">No entries match the current filter.</div>';
    } else {
      filtered.forEach(appendLogLine);
    }
  }

  $('btn-clear-log').onclick = function () {
    logBuffer.length = 0; logLineCount = 0;
    $('log-container').innerHTML = '<div class="empty">Log cleared.</div>';
    $('log-count').textContent = '0 lines';
  };

  $('btn-filter-apply').onclick = function () {
    logFilterLevel  = $('log-level-filter').value;
    logFilterModule = $('log-module-filter').value;
    logSearch       = $('log-search').value;
    rebuildLogView();
  };

  $('log-search').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') $('btn-filter-apply').click();
  });

  // ── Provider health ───────────────────────────────────────
  function loadProviders() {
    if (!token) return;
    fetch(BASE_URL + '/status/providers')
      .then(r => r.json())
      .then(data => renderProviders(data.providers || []))
      .catch(() => {});
  }

  function renderProviders(providers) {
    const list = $('provider-list');
    if (!providers.length) {
      list.innerHTML = '<div class="empty">No providers configured.</div>';
      return;
    }
    $('provider-count').textContent = providers.length + ' providers';
    // Build provider rows using DOM APIs to avoid XSS from provider IDs / names
    list.innerHTML = '';
    providers.forEach(function(p) {
      const cls   = p.healthy === true ? 'green' : p.healthy === false ? 'red' : 'gray';
      const label = p.healthy === true ? 'Healthy' : p.healthy === false ? 'Unhealthy' : 'Unknown';

      const row = document.createElement('div');
      row.className = 'provider-row';

      const dot = document.createElement('div');
      dot.className = 'health-dot ' + cls;

      const name = document.createElement('div');
      name.className = 'provider-name';
      name.textContent = p.name || p.id || '';

      const meta = document.createElement('div');
      meta.className = 'provider-meta';
      meta.textContent = (p.baseUrl || '') + ' \u2022 ' + label;

      const actions = document.createElement('div');
      actions.className = 'provider-actions';

      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = 'Check';
      // Use closure over p.id to avoid any injection
      btn.addEventListener('click', function() {
        btn.disabled = true; btn.textContent = '…';
        fetch(BASE_URL + '/status/providers')
          .then(function(r) { return r.json(); })
          .then(function(data) { renderProviders(data.providers || []); })
          .catch(function() { btn.disabled = false; btn.textContent = 'Check'; });
      });

      actions.appendChild(btn);
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Refresh providers every 30s
  setInterval(loadProviders, 30_000);

  // ── Workflow events ───────────────────────────────────────
  function handleEvent(ev) {
    const container = $('events-container');
    const empty = container.querySelector('.empty');
    if (empty) empty.remove();

    const type = (ev.type || ev.event || '').toLowerCase();
    let cls = '';
    if (type.includes('start')) cls = 'started';
    else if (type.includes('complet') || type.includes('success')) cls = 'complete';
    else if (type.includes('fail') || type.includes('error')) cls = 'failed';
    else if (type.includes('cancel')) cls = 'cancelled';

    const item = document.createElement('div');
    item.className = 'event-item ' + cls;
    item.innerHTML =
      '<span class="ev-time">' + now() + '</span>' +
      '<div class="ev-type">' + escHtml(type) + '</div>' +
      '<div class="ev-msg">' + escHtml(ev.message || ev.workflowId || JSON.stringify(ev)) + '</div>';

    container.insertBefore(item, container.firstChild);
    while (container.children.length > 200) container.removeChild(container.lastChild);
  }

  $('btn-clear-events').onclick = function () {
    $('events-container').innerHTML = '<div class="empty">Feed cleared.</div>';
  };

  // ── Utility ───────────────────────────────────────────────
  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Re-draw charts on resize
  window.addEventListener('resize', function () {
    drawSparkline($('req-chart'), reqHistory, '#58a6ff');
  });

})();
</script>
</body>
</html>`;
}
