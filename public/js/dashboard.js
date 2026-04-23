/**
 * public/js/dashboard.js
 * Admin dashboard interactivity:
 *   - Mobile sidebar toggle
 *   - Bottom navigation active state
 *   - Chart rendering (SVG sparkline)
 *   - Responsive table ↔ card view (handled by CSS breakpoints)
 */
(function () {
  'use strict';

  /* ── Mobile sidebar toggle ─────────────────────────────────────────────── */
  var menuBtn = document.getElementById('dash-menu-btn');
  var sidebar = document.getElementById('dash-sidebar');
  var overlay = document.getElementById('dash-overlay');

  function openSidebar() {
    if (!sidebar) { return; }
    sidebar.classList.add('dash-sidebar--mobile-open');
    if (overlay) { overlay.classList.add('is-visible'); }
    document.body.style.overflow = 'hidden';
    if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'true'); }
  }

  function closeSidebar() {
    if (!sidebar) { return; }
    sidebar.classList.remove('dash-sidebar--mobile-open');
    if (overlay) { overlay.classList.remove('is-visible'); }
    document.body.style.overflow = '';
    if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'false'); }
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      var isOpen = sidebar && sidebar.classList.contains('dash-sidebar--mobile-open');
      if (isOpen) { closeSidebar(); } else { openSidebar(); }
    });
  }

  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSidebar(); }
  });

  // Close sidebar when a nav link is clicked on mobile
  if (sidebar) {
    var sidebarLinks = sidebar.querySelectorAll('a');
    for (var i = 0; i < sidebarLinks.length; i++) {
      sidebarLinks[i].addEventListener('click', function () {
        if (window.innerWidth < 768) { setTimeout(closeSidebar, 80); }
      });
    }
  }

  /* ── Bottom nav active state ───────────────────────────────────────────── */
  var bottomNavItems = document.querySelectorAll('.bottom-nav__item');
  for (var b = 0; b < bottomNavItems.length; b++) {
    bottomNavItems[b].addEventListener('click', function () {
      for (var n = 0; n < bottomNavItems.length; n++) {
        bottomNavItems[n].classList.remove('active');
      }
      this.classList.add('active');
    });
  }

  /* ── SVG sparkline chart ───────────────────────────────────────────────── */
  function renderSparkline(svgId, data, color, fillColor) {
    var svg = document.getElementById(svgId);
    if (!svg) { return; }

    // Parse viewBox from attribute string to avoid relying on .baseVal which
    // may not be available when the element was just created.
    var vbAttr = svg.getAttribute('viewBox') || '0 0 600 120';
    var vbParts = vbAttr.split(/\s+/);
    var W = parseFloat(vbParts[2]) || 600;
    var H = parseFloat(vbParts[3]) || 120;
    var pad = 8;

    var min = Math.min.apply(null, data);
    var max = Math.max.apply(null, data);
    var range = max - min || 1;

    var points = data.map(function (v, i) {
      var x = pad + (i / (data.length - 1)) * (W - pad * 2);
      var y = H - pad - ((v - min) / range) * (H - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });

    // Area fill
    var areaPoints = points.slice();
    var lastX = (pad + (W - pad * 2)).toFixed(1);
    var firstX = pad.toFixed(1);
    areaPoints.push(lastX + ',' + (H - pad));
    areaPoints.push(firstX + ',' + (H - pad));

    var area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', areaPoints.join(' '));
    area.setAttribute('fill', fillColor);
    area.setAttribute('opacity', '0.35');
    svg.appendChild(area);

    // Line
    var polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', points.join(' '));
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', color);
    polyline.setAttribute('stroke-width', '2.5');
    polyline.setAttribute('stroke-linejoin', 'round');
    polyline.setAttribute('stroke-linecap', 'round');
    svg.appendChild(polyline);

    // Endpoint dot
    var lastPoint = points[points.length - 1].split(',');
    var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', lastPoint[0]);
    dot.setAttribute('cy', lastPoint[1]);
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);
  }

  // Request volume chart
  renderSparkline(
    'chart-requests',
    [42, 55, 38, 70, 65, 80, 72, 91, 85, 110, 98, 125, 118, 140, 132, 155, 148, 170, 162, 180],
    '#4f46e5',
    '#4f46e5'
  );

  // Latency chart
  renderSparkline(
    'chart-latency',
    [120, 135, 110, 145, 130, 155, 140, 128, 142, 118, 135, 125, 148, 132, 120, 138, 112, 145, 125, 118],
    '#10b981',
    '#10b981'
  );

  /* ── Provider status indicator animation ──────────────────────────────── */
  var pulseEls = document.querySelectorAll('.status-pulse');
  for (var p = 0; p < pulseEls.length; p++) {
    (function (el) {
      var delay = Math.random() * 2;
      el.style.animationDelay = delay.toFixed(2) + 's';
    }(pulseEls[p]));
  }

  /* ── Auto-refresh stats (simulated) ───────────────────────────────────── */
  function updateUptime() {
    var el = document.getElementById('dash-uptime');
    if (!el) { return; }
    var seconds = parseInt(el.getAttribute('data-seconds') || '0', 10) + 1;
    el.setAttribute('data-seconds', String(seconds));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    el.textContent =
      (h > 0 ? h + 'h ' : '') +
      (m > 0 ? m + 'm ' : '') +
      s + 's';
  }
  setInterval(updateUptime, 1000);

}());
