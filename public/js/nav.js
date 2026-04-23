/**
 * public/js/nav.js
 * Marketing-page navigation: hamburger menu + slide-out drawer.
 * No dependencies — plain ES5-compatible JS.
 */
(function () {
  'use strict';

  var burger = document.getElementById('nav-burger');
  var drawer = document.getElementById('nav-drawer');
  var drawerClose = document.getElementById('nav-drawer-close');
  var drawerBackdrop = document.getElementById('nav-drawer-backdrop');

  if (!burger || !drawer) { return; }

  function openDrawer() {
    drawer.classList.add('is-open');
    burger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    // Focus the close button for accessibility
    if (drawerClose) { drawerClose.focus(); }
  }

  function closeDrawer() {
    drawer.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    burger.focus();
  }

  burger.addEventListener('click', function () {
    var isOpen = drawer.classList.contains('is-open');
    if (isOpen) { closeDrawer(); } else { openDrawer(); }
  });

  if (drawerClose) {
    drawerClose.addEventListener('click', closeDrawer);
  }

  if (drawerBackdrop) {
    drawerBackdrop.addEventListener('click', closeDrawer);
  }

  // Close on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
      closeDrawer();
    }
  });

  // Close drawer when a nav link is clicked (smooth page nav on same page)
  var drawerLinks = drawer.querySelectorAll('a');
  for (var i = 0; i < drawerLinks.length; i++) {
    drawerLinks[i].addEventListener('click', function () {
      // Small delay so the navigation starts before closing
      setTimeout(closeDrawer, 80);
    });
  }

  // Docs sidebar drawer (docs.html)
  var sidebarToggle = document.getElementById('docs-sidebar-toggle');
  var sidebarDrawer = document.getElementById('docs-sidebar-drawer');
  var sidebarBackdrop = document.getElementById('docs-sidebar-backdrop');

  if (sidebarToggle && sidebarDrawer) {
    sidebarToggle.addEventListener('click', function () {
      sidebarDrawer.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    });

    if (sidebarBackdrop) {
      sidebarBackdrop.addEventListener('click', function () {
        sidebarDrawer.classList.remove('is-open');
        document.body.style.overflow = '';
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sidebarDrawer.classList.contains('is-open')) {
        sidebarDrawer.classList.remove('is-open');
        document.body.style.overflow = '';
        sidebarToggle.focus();
      }
    });

    // Close when a sidebar link is clicked on mobile
    var sidebarLinks = sidebarDrawer.querySelectorAll('a');
    for (var j = 0; j < sidebarLinks.length; j++) {
      sidebarLinks[j].addEventListener('click', function () {
        setTimeout(function () {
          sidebarDrawer.classList.remove('is-open');
          document.body.style.overflow = '';
        }, 80);
      });
    }
  }

  // Active link highlight based on current URL hash/path
  var currentPath = window.location.pathname.split('/').pop() || 'index.html';
  var allNavLinks = document.querySelectorAll('.topnav__links a, .drawer__nav a');
  for (var k = 0; k < allNavLinks.length; k++) {
    var href = allNavLinks[k].getAttribute('href') || '';
    if (href && (href === currentPath || currentPath.indexOf(href.replace('.html','')) !== -1)) {
      allNavLinks[k].classList.add('active');
    }
  }
}());
