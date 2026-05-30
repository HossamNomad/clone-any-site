/* clone-any-site — 1-click Pulsia themes. ZERO deps. Applies a palette/font token set at RUNTIME via a
 * single injected <style id="cl-theme"> (CSS custom-property overrides + a safe accent allowlist — never
 * layout/position), so structure + animations stay 100% intact. Persists to manifest.meta.theme.
 */
(function () {
  'use strict';
  function start(CE) {
    var THEMES = [];
    var current = (CE.config && CE.config.theme && CE.config.theme.id) || null;

    function load() {
      return fetch('/__clone/editor/themes.json').then(function (r) { return r.json(); }).then(function (t) { THEMES = t || []; }).catch(function () { THEMES = []; });
    }
    function styleEl() {
      var s = document.getElementById('cl-theme');
      if (!s) { s = document.createElement('style'); s.id = 'cl-theme'; document.head.appendChild(s); }
      return s;
    }
    function discoverAccentVars() {
      var found = [];
      try {
        for (var i = 0; i < document.styleSheets.length; i++) {
          var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
          if (!rules) continue;
          for (var r = 0; r < rules.length; r++) {
            var st = rules[r].style; if (!st) continue;
            for (var k = 0; k < st.length; k++) { var p = st[k]; if (p.indexOf('--') === 0 && /accent|primary|brand/i.test(p)) found.push(p); }
          }
        }
      } catch (e) {}
      return Array.from(new Set(found));
    }
    function cssFor(theme) {
      var t = theme.tokens || {};
      var lines = [':root{'];
      Object.keys(t).forEach(function (k) { if (k.indexOf('--') === 0) lines.push(k + ':' + t[k] + ';'); });
      discoverAccentVars().forEach(function (v) { lines.push(v + ':' + (theme.accent || t['--cl-accent']) + ' !important;'); });
      lines.push('}');
      lines.push('a, .btn, button, [class*="cta"], [class*="accent"]{color:' + (theme.accent || t['--cl-accent']) + ';}');
      if (theme.fonts) {
        if (theme.fonts.body) lines.push('body{font-family:' + theme.fonts.body + ' !important;}');
        if (theme.fonts.heading) lines.push('h1,h2,h3,.h1,.h2,.h3{font-family:' + theme.fonts.heading + ' !important;}');
      }
      return lines.join('\n');
    }
    function apply(id) {
      var theme = THEMES.find(function (t) { return t.id === id; });
      if (!theme) return Promise.reject(new Error('no theme ' + id));
      styleEl().textContent = cssFor(theme); current = id; CE.emit('themeChanged', id);
      return CE.api.theme({ themeId: id, tokens: theme.tokens, fonts: theme.fonts }).catch(function () {});
    }
    function clear() { styleEl().textContent = ''; current = null; CE.emit('themeChanged', null); return CE.api.theme({ themeId: null }).catch(function () {}); }

    CE.themes = { list: function () { return THEMES; }, apply: apply, clear: clear, get current() { return current; } };
    load().then(function () { if (current) apply(current); CE.emit('themesReady', THEMES); });
  }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
