/* clone-any-site — command palette (Cmd/Ctrl-K) + mobile FAB. ZERO deps.
 * Fuzzy command registry over the editor: jump to #N, edit text, replace media, find-replace, apply theme,
 * before/after, breakpoint, publish readiness, open panel.
 */
(function () {
  'use strict';
  function start(CE) {
    var cmds = [];
    function register(c) { cmds.push(c); }

    var bg = document.createElement('div'); bg.id = 'cl-pal-bg';
    var box = document.createElement('div'); box.id = 'cl-pal';
    box.innerHTML = '<input id="cl-pal-in" placeholder="type a command or #slot number…" autocomplete="off"><ul id="cl-pal-list"></ul>';
    bg.appendChild(box); document.body.appendChild(bg);
    var input = box.querySelector('#cl-pal-in'); var list = box.querySelector('#cl-pal-list');
    var sel = 0, shown = [];

    var fab = document.createElement('button'); fab.id = 'cl-fab'; fab.textContent = '⌘'; fab.title = 'Commands (Ctrl/Cmd-K)';
    document.body.appendChild(fab);
    fab.addEventListener('click', open);

    function open() { bg.classList.add('cl-open'); input.value = ''; render(''); input.focus(); }
    function close() { bg.classList.remove('cl-open'); }
    function toggle() { bg.classList.contains('cl-open') ? close() : open(); }

    function score(q, s) {
      q = q.toLowerCase(); s = s.toLowerCase(); var i = 0, j = 0, hits = 0;
      while (i < q.length && j < s.length) { if (q[i] === s[j]) { hits++; i++; } j++; }
      return i === q.length ? hits - (s.length - hits) * 0.01 : -1;
    }
    function render(q) {
      var items = [];
      var numMatch = q.match(/^#?(\d+)$/);
      if (numMatch) { items.push({ title: 'Jump to slot #' + numMatch[1], run: function () { CE.selectSlot(+numMatch[1], true); } }); }
      cmds.forEach(function (c) { var sc = q ? score(q, c.title) : 0; if (sc >= 0) items.push(Object.assign({ _s: sc }, c)); });
      items.sort(function (a, b) { return (b._s || 0) - (a._s || 0); });
      shown = items.slice(0, 40); sel = 0; paint();
    }
    function paint() {
      list.innerHTML = shown.map(function (c, i) { return '<li class="' + (i === sel ? 'cl-sel' : '') + '">' + esc(c.title) + (c.hint ? '<small>' + esc(c.hint) + '</small>' : '') + '</li>'; }).join('');
      Array.prototype.forEach.call(list.children, function (li, i) { li.addEventListener('click', function () { run(i); }); });
    }
    function run(i) { var c = shown[i]; if (!c) return; close(); try { c.run(); } catch (e) { CE.ui.setStatus('cmd failed: ' + e.message); } }
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

    input.addEventListener('input', function () { render(input.value.trim()); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
      else if (e.key === 'Enter') { run(sel); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); }
    });
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });

    window.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); toggle(); }
      else if ((e.metaKey || e.ctrlKey) && k === 'f' && !isTyping(e)) { e.preventDefault(); openFindReplace(); }
    }, true);
    function isTyping(e) { var t = e.target; return t && (t.isContentEditable || /input|textarea/i.test(t.tagName)); }
    function openFindReplace() { CE.ui.panel.classList.add('cl-open'); var f = document.getElementById('cl-find'); if (f) f.focus(); }

    register({ title: 'Open Slots panel', hint: 'search · filter · find-replace', run: function () { CE.ui.panel.classList.toggle('cl-open'); } });
    register({ title: 'Find & replace…', run: openFindReplace });
    register({ title: 'Toggle Before / After', run: function () { CE.setBeforeAfter(!CE.showAfter); } });
    register({ title: 'Mode: Map (badges)', run: function () { CE.setMode('map'); } });
    register({ title: 'Mode: Manual (interact)', run: function () { CE.setMode('live'); } });
    ['all', '390', '768', '1440'].forEach(function (bp) { register({ title: 'Breakpoint: ' + bp, run: function () { CE.setBp(bp); } }); });
    register({ title: 'Publish readiness', hint: 'how many slots block publish', run: function () {
      var n = CE.recomputeCounter();
      var blockers = CE.manifest.slots.filter(function (s) { return s.provenance === 'original' && !s.keep && !s.replacement && s.role === 'content'; }).map(function (s) { return s.number; });
      CE.ui.setStatus(n === 0 ? 'Ready to publish ✓' : (n + ' block publish: #' + blockers.slice(0, 12).join(' #')));
    } });
    function addThemeCmds() { (CE.themes ? CE.themes.list() : []).forEach(function (t) { register({ title: 'Apply theme: ' + t.label, run: function () { CE.themes.apply(t.id); } }); }); register({ title: 'Clear theme', run: function () { CE.themes && CE.themes.clear(); } }); }
    if (CE.themes && CE.themes.list().length) addThemeCmds(); else CE.on('themesReady', addThemeCmds);

    console.log('[clone] command palette ready — Ctrl/Cmd-K');
  }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
