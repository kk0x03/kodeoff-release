/* 渐进增强：轮盘预览、移动导航、FAQ。无 JS 时内容和锚点保持可用。 */
(function () {
  'use strict';
  var d = document;
  function initRadial() {
    var wheel = d.querySelector('.radial-wheel');
    var labels = Array.from(d.querySelectorAll('.radial-label'));
    var status = d.querySelector('.demo-status-text');
    if (!wheel || !status || !labels.length) return;
    function select(button) {
      wheel.style.setProperty('--selected-angle', (Number(button.dataset.index) * 360 / labels.length) + 'deg');
      labels.forEach(function (item) {
        var selected = item === button;
        item.classList.toggle('is-target', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      status.textContent = button.dataset.detail;
    }
    labels.forEach(function (button) {
      button.addEventListener('pointerenter', function (event) {
        if (event.pointerType !== 'touch') select(button);
      });
      button.addEventListener('focus', function () { select(button); });
      button.addEventListener('click', function () { select(button); });
    });
  }
  function initNav() {
    var head = d.querySelector('.site-head');
    var toggle = d.querySelector('.menu-toggle');
    if (!head || !toggle) return;
    function setOpen(open) {
      head.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '收起导航' : '展开导航');
      toggle.textContent = open ? '收起' : '菜单';
    }
    toggle.addEventListener('click', function () { setOpen(!head.classList.contains('menu-open')); });
    head.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });
    d.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && head.classList.contains('menu-open')) {
        setOpen(false);
        toggle.focus();
      }
    });
    var links = Array.from(d.querySelectorAll('.nav-links a'));
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (a) {
            var active = a.hash === '#' + entry.target.id;
            a.classList.toggle('is-active', active);
            if (active) a.setAttribute('aria-current', 'location');
            else a.removeAttribute('aria-current');
          });
        });
      }, { rootMargin: '-15% 0px -65% 0px' });
      links.forEach(function (a) { var target = d.querySelector(a.hash); if (target) io.observe(target); });
    }
  }
  function initFaq() {
    var items = Array.from(d.querySelectorAll('.faq details'));
    items.forEach(function (item) {
      item.addEventListener('toggle', function () {
        if (item.open) items.forEach(function (other) { if (other !== item) other.open = false; });
      });
    });
  }
  function init() {
    d.documentElement.classList.add('js');
    initRadial();
    initNav();
    initFaq();
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
  else init();
})();
