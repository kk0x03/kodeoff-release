/* 按系统推荐下载 + 版本自动发现（/downloads/SHA256SUMS）。渐进增强：无 JS/失败/未知系统回退页面原状。 */
(function () {
  'use strict';
  var d = typeof document !== 'undefined' ? document : null;
  var FALLBACK_VERSION = '0.1.9';
  var DETECT_TEXT = { macos: '已检测到 macOS：推荐下载 macOS 版', windows: '已检测到 Windows：推荐下载 Windows 版' };

  function detectOS(ua, touch) {
    ua = String(ua || '');
    if (/Windows (NT|Phone|CE)/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return (touch || 0) > 1 ? 'generic' : 'macos';
    if (/Android/i.test(ua)) return 'generic';
    if (/Linux|CrOS|X11/i.test(ua)) return 'linux';
    return 'generic';
  }
  function compareVersions(a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
  }
  function highestVersion(text) { /* SHA256SUMS 行尾文件名 Kodeoff-<版本>-…，取最高 */
    var re = /Kodeoff-(\d+(?:\.\d+)+)-/g, best = null, m;
    while ((m = re.exec(String(text || ''))) !== null) {
      if (best === null || compareVersions(m[1], best) > 0) best = m[1];
    }
    return best;
  }
  function applyVersion(v) {
    if (!v || !d) return;
    Array.prototype.forEach.call(d.querySelectorAll('.hero-note, #download .download-lede, .footer-version'), function (el) {
      el.textContent = el.textContent.replace(/v\d+(?:\.\d+)+/g, 'v' + v);
    });
    Array.prototype.forEach.call(d.querySelectorAll('#download a[href*="/releases/download/"]'), function (a) {
      a.setAttribute('href', a.getAttribute('href')
        .replace(/\/releases\/download\/v\d+(?:\.\d+)+\//, '/releases/download/v' + v + '/')
        .replace(/Kodeoff-\d+(?:\.\d+)+-/, 'Kodeoff-' + v + '-'));
    });
  }
  function recommendDownload(os) {
    if (!d) return;
    var lede = d.querySelector('#download .download-lede');
    var mac = d.querySelector('#download a[href*="-macOS.dmg"]');
    var win = d.querySelector('#download a[href*="windows-x64"]');
    var target = os === 'macos' ? mac : os === 'windows' ? win : null;
    var other = os === 'macos' ? win : mac;
    if (!target || !other) return;
    target.classList.add('btn-primary');
    target.classList.remove('btn-secondary');
    other.classList.add('btn-secondary');
    other.classList.remove('btn-primary');
    if (!target.querySelector('.btn-badge')) {
      var badge = d.createElement('span');
      badge.className = 'btn-badge';
      badge.textContent = '为你的系统推荐';
      target.appendChild(badge);
    }
    if (lede && DETECT_TEXT[os]) lede.textContent += ' ' + DETECT_TEXT[os];
  }
  function discoverVersion() {
    if (!d || typeof window.fetch !== 'function') return;
    window.fetch('/downloads/SHA256SUMS', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      applyVersion(highestVersion(text) || FALLBACK_VERSION);
    }).catch(function () { applyVersion(FALLBACK_VERSION); });
  }
  function init() {
    recommendDownload(detectOS(navigator.userAgent, navigator.maxTouchPoints));
    discoverVersion();
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FALLBACK_VERSION: FALLBACK_VERSION, detectOS: detectOS, compareVersions: compareVersions, highestVersion: highestVersion, applyVersion: applyVersion, recommendDownload: recommendDownload };
    return;
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
  else init();
})();
