/* clone-any-site — edit-map overlay engine (Wave 2). ZERO deps, vanilla JS.
 * Loopback-only. Injected by serve.mjs --edit. Renders numbered badges over the live mirror,
 * a slot table, the "N slots block publish" counter, mode + breakpoint + before/after toggles.
 * Exposes window.__CloneEditor so editor.js (Wave 3) can attach double-click / drag-drop interactions.
 *
 * Performance contract (clone-interfaces.md section 3): badge positions recomputed via ResizeObserver +
 * rAF-debounced scroll; only on-screen badges are drawn (IntersectionObserver); no sync layout in handlers.
 */
(function () {
  'use strict';
  if (window.__CloneEditor) return; // singleton
  var CFG = window.__CLONE_EDIT || {};
  var TYPE_SWAPPABLE_MEDIA = { img: 1, bg: 1, svg: 1, video: 1, icon: 1 };

  // ---------- tiny event bus ----------
  var bus = {};
  function on(ev, cb) { (bus[ev] = bus[ev] || []).push(cb); }
  function emit(ev, d) { (bus[ev] || []).forEach(function (cb) { try { cb(d); } catch (e) { console.warn('[clone]', e); } }); }

  // ---------- api (loopback endpoints) ----------
  function j(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t); });
      return r.json();
    });
  }
  var api = {
    getManifest: function () { return j('GET', '/__clone/manifest'); },
    getState: function () { return j('GET', '/__clone/state'); },
    slot: function (payload) { return j('POST', '/__clone/slot', payload); },
    group: function (payload) { return j('POST', '/__clone/group', payload); },
    batch: function (payload) { return j('POST', '/__clone/batch', payload); },
    theme: function (payload) { return j('POST', '/__clone/theme', payload); },
    upload: function (payload) { return j('POST', '/__clone/upload', payload); },
  };

  // ---------- state ----------
  var manifest = null;
  var entries = new Map();   // number -> { slot, el, badge, visible }
  var entriesByGroup = new Map(); // groupId -> [entry, ...]  (same-content propagation)
  var reappliers = [];       // editor.js registers fn(slot, el) to repaint a slot's DOM from its replacement
  var curBp = 'all';         // 'all' | '390' | '768' | '1440'
  var mode = 'map';          // 'map' (badges + inspect) | 'live' (interact, badges dimmed)
  var showAfter = true;      // before/after: true = show replacements
  var interactors = [];      // editor.js hooks: fn({slot, el, badge, api, ui, bus:{on,emit}})
  var rafPending = false;

  // ---------- dom shell ----------
  var root = document.createElement('div');
  root.id = 'cl-overlay';
  root.className = 'cl-map';
  var ring = el('div', { id: 'cl-ring' });
  var pop = el('div', { id: 'cl-pop' });
  var panel = buildPanel();
  var toolbar = buildToolbar();
  var watermark = document.getElementById('cl-watermark') || el('div', { id: 'cl-watermark' });
  if (!watermark.textContent) watermark.textContent = 'LOOPBACK PREVIEW — NOT SHIPPABLE';
  root.appendChild(ring); root.appendChild(pop);

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }
    if (html != null) n.innerHTML = html;
    return n;
  }

  // ---------- toolbar ----------
  function buildToolbar() {
    var tb = el('div', { id: 'cl-toolbar' });
    var modeG = el('div', { class: 'cl-group' });
    modeG.appendChild(tbBtn('cl-mode-map', 'Map', true, function () { setMode('map'); }));
    modeG.appendChild(tbBtn('cl-mode-live', 'Manual', false, function () { setMode('live'); }));
    var bpG = el('div', { class: 'cl-group' });
    ['all', '390', '768', '1440'].forEach(function (bp) {
      bpG.appendChild(tbBtn('cl-bp-' + bp, bp === 'all' ? 'All' : bp, bp === 'all', function () { setBp(bp); }));
    });
    var baBtn = tbBtn('cl-ba', 'After', true, function () { setBeforeAfter(!showAfter); });
    var panelBtn = tbBtn('cl-panel-btn', 'Slots', false, function () { panel.classList.toggle('cl-open'); });
    var counter = el('div', { id: 'cl-counter' }); counter.innerHTML = '<span class="cl-dot"></span><span id="cl-count-n">…</span> block publish';
    tb.appendChild(modeG); tb.appendChild(bpG); tb.appendChild(baBtn); tb.appendChild(panelBtn); tb.appendChild(counter);
    tb._baBtn = baBtn; tb._counter = counter;
    return tb;
  }
  function tbBtn(id, label, pressed, fn) {
    var b = el('button', { class: 'cl-tb', id: id }); b.textContent = label;
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    b.addEventListener('click', fn);
    return b;
  }
  function pressGroup(prefix, activeId) {
    toolbar.querySelectorAll('button[id^="' + prefix + '"]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.id === activeId ? 'true' : 'false');
    });
  }

  // ---------- panel (slot table fallback + keep buttons) ----------
  function buildPanel() {
    var p = el('div', { id: 'cl-panel' });
    var head = el('div'); head.innerHTML = '<header><h3>Slots</h3><button class="cl-keep" id="cl-panel-close">close</button></header>';
    var list = el('div', { class: 'cl-list', id: 'cl-list' });
    p.appendChild(head); p.appendChild(list);
    p._list = list;
    setTimeout(function () { var c = document.getElementById('cl-panel-close'); if (c) c.addEventListener('click', function () { p.classList.remove('cl-open'); }); }, 0);
    return p;
  }
  var panelFilter = null; // optional fn(slot) -> bool, set by panel.js
  function setPanelFilter(fn) { panelFilter = fn; renderPanel(); }
  function renderPanel() {
    var list = panel._list; list.innerHTML = '';
    manifest.slots.filter(function (s) { return panelFilter ? panelFilter(s) : true; }).forEach(function (s) {
      var row = el('div', { class: 'cl-row' });
      var flags = (s.flags || []).map(function (f) { return '<span class="cl-flag">' + f.split(':')[0] + '</span>'; }).join('');
      var prov = s.provenance === 'original' ? '' : '<span class="cl-flag" style="background:rgba(74,222,128,.2);color:#86efac">' + s.provenance + '</span>';
      var roleTag = s.role === 'chrome' ? '<span class="cl-flag cl-chrome">chrome</span>' : '';
      var val = s.replacement ? (s.replacement.value || s.replacement.assetRef || '(asset)') : (s.currentValue || s.currentValueRef || '');
      row.innerHTML = '<span class="cl-n">#' + s.number + '</span>' +
        '<div class="cl-meta"><small>' + s.type + ' ' + roleTag + ' ' + prov + ' ' + flags + '</small>' +
        '<span class="cl-val">' + escapeHtml(String(val).slice(0, 80)) + '</span></div>';
      var keepBtn = el('button', { class: 'cl-keep' });
      keepBtn.textContent = s.keep ? 'kept' : 'keep';
      keepBtn.addEventListener('click', function () { doKeep(s.number, !s.keep); });
      row.appendChild(keepBtn);
      row.addEventListener('mouseenter', function () { var e = entries.get(s.number); if (e && e.el) moveRing(e.el); });
      row.addEventListener('click', function () { selectSlot(s.number, true); });
      list.appendChild(row);
    });
  }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  // ---------- locate live element for a slot ----------
  // Precedence: data-cl-id anchor (survives DOM-order churn / React re-render) → cssPath+nth → bbox hit-test.
  function resolveEl(slot) {
    var loc = slot.mirrorLocator || {};
    var id = slot.clId || loc.clId;
    if (id) {
      var anchored = document.querySelector('[data-cl-id="' + cssEsc(id) + '"]');
      if (anchored) return anchored;
    }
    try {
      if (loc.cssPath) {
        var nodes = document.querySelectorAll(loc.cssPath);
        var node = nodes[(loc.nth | 0)] || nodes[0];
        if (node) { if (id) node.setAttribute('data-cl-id', id); return node; } // self-heal: stamp the anchor
      }
    } catch (e) { /* bad selector — fall through */ }
    // bbox fallback: hit-test the recorded center (desktop bbox)
    var bb = loc.bbox && (loc.bbox['1440'] || loc.bbox['768'] || loc.bbox['390']);
    if (bb) {
      var cx = bb[0] + bb[2] / 2 - window.scrollX, cy = bb[1] + bb[3] / 2 - window.scrollY;
      var hit = document.elementFromPoint(cx, cy);
      if (hit && hit.id !== 'cl-overlay' && !hit.closest('#cl-overlay')) return hit;
    }
    return null;
  }

  // repaint a slot's live DOM from its current replacement (delegates to editor.js reappliers)
  function reapply(slot, el) {
    var entry = entries.get(slot.number);
    var node = el || (entry && entry.el);
    if (!node) return;
    reappliers.forEach(function (fn) { try { fn(slot, node); } catch (e) { console.warn('[clone] reapply', e); } });
  }
  function reapplyAll() { entries.forEach(function (e) { if (e.slot.replacement) reapply(e.slot, e.el); }); }

  // ---------- badges ----------
  function buildBadges() {
    entries.clear(); entriesByGroup.clear();
    var io = new IntersectionObserver(function (recs) {
      recs.forEach(function (r) {
        var num = +r.target.getAttribute('data-cl-for');
        var e = entries.get(num); if (!e) return;
        e.visible = r.isIntersecting;
        e.badge.style.display = (r.isIntersecting && badgeAllowed(e.slot)) ? '' : 'none';
      });
      scheduleLayout();
    }, { rootMargin: '120px' });

    manifest.slots.forEach(function (slot) {
      if (slot.role === 'chrome') return;           // chrome hidden from VIEW (still in panel + counter)
      var elx = resolveEl(slot);
      if (!elx) return;
      var badge = el('div', { class: 'cl-badge', 'data-prov': slot.provenance, 'data-cl-for': String(slot.number) });
      badge.innerHTML = '<span class="cl-num">' + slot.number + '</span><span class="cl-type">' + slot.type + '</span>';
      badge.addEventListener('click', function (ev) { ev.stopPropagation(); selectSlot(slot.number, true); });
      root.appendChild(badge);
      var entry = { slot: slot, el: elx, badge: badge, visible: true };
      entries.set(slot.number, entry);
      if (slot.groupId) { if (!entriesByGroup.has(slot.groupId)) entriesByGroup.set(slot.groupId, []); entriesByGroup.get(slot.groupId).push(entry); }
      elx.setAttribute('data-cl-for', String(slot.number));
      if (slot.clId || (slot.mirrorLocator && slot.mirrorLocator.clId)) elx.setAttribute('data-cl-id', slot.clId || slot.mirrorLocator.clId);
      io.observe(elx);
      // let editor.js (Wave 3) attach dblclick / drag-drop interactions
      interactors.forEach(function (fn) { try { fn(Object.assign({ api: api, ui: ui, bus: { on: on, emit: emit } }, entry)); } catch (e) { console.warn(e); } });
    });
    scheduleLayout();
  }
  function badgeAllowed(slot) {
    if (curBp === 'all') return true;
    var bb = slot.mirrorLocator && slot.mirrorLocator.bbox;
    return !bb || !!bb[curBp]; // if we know per-bp presence, respect it; else always show
  }
  function scheduleLayout() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      entries.forEach(function (e) {
        if (e.badge.style.display === 'none') return;
        var r = e.el.getBoundingClientRect();
        e.badge.style.transform = 'translate(' + Math.round(r.left) + 'px,' + Math.round(r.top) + 'px)';
      });
    });
  }
  function moveRing(elx) {
    if (!elx) { ring.style.opacity = 0; return; }
    var r = elx.getBoundingClientRect();
    ring.style.left = r.left + 'px'; ring.style.top = r.top + 'px';
    ring.style.width = r.width + 'px'; ring.style.height = r.height + 'px'; ring.style.opacity = 1;
  }

  // ---------- actions ----------
  function selectSlot(num, scroll) {
    var e = entries.get(num);
    document.querySelectorAll('.cl-badge.cl-sel').forEach(function (b) { b.classList.remove('cl-sel'); });
    if (e) {
      e.badge.classList.add('cl-sel'); moveRing(e.el);
      if (scroll && (e.el.getBoundingClientRect().top < 0 || e.el.getBoundingClientRect().top > innerHeight)) e.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      emit('select', e);
    }
  }
  function doKeep(num, keep) {
    api.slot({ number: num, op: keep ? 'keep' : 'unkeep' }).then(function () { return refreshManifest(); });
  }
  function setMode(m) { mode = m; root.classList.toggle('cl-live', m === 'live'); pressGroup('cl-mode-', 'cl-mode-' + m); emit('modeChange', m); }
  function setBp(bp) { curBp = bp; pressGroup('cl-bp-', 'cl-bp-' + bp); entries.forEach(function (e) { e.badge.style.display = (e.visible && badgeAllowed(e.slot)) ? '' : 'none'; }); scheduleLayout(); emit('breakpointChange', bp); }
  function setBeforeAfter(after) { showAfter = after; toolbar._baBtn.textContent = after ? 'After' : 'Before'; toolbar._baBtn.setAttribute('aria-pressed', after ? 'true' : 'false'); emit('beforeAfter', after); }

  function recomputeCounter() {
    var n = manifest.slots.filter(function (s) { return s.provenance === 'original' && !s.keep && !s.replacement; }).length;
    var label = document.getElementById('cl-count-n'); if (label) label.textContent = n;
    toolbar._counter.classList.toggle('cl-clear', n === 0);
    if (n === 0) toolbar._counter.lastChild.textContent = ' ready to publish';
    return n;
  }

  function refreshManifest() {
    return api.getManifest().then(function (m) {
      manifest = m;
      // refresh badge provenance + values without full rebuild
      manifest.slots.forEach(function (s) { var e = entries.get(s.number); if (e) { e.slot = s; e.badge.setAttribute('data-prov', s.provenance); } });
      renderPanel(); recomputeCounter(); emit('manifest', manifest);
    });
  }

  // ---------- ui handle for editor.js ----------
  var ui = {
    root: root, ring: ring, pop: pop, panel: panel, toolbar: toolbar,
    moveRing: moveRing, selectSlot: selectSlot, el: el, escapeHtml: escapeHtml,
    setStatus: function (msg) { /* lightweight status into watermark area title */ watermark.title = msg || ''; },
  };

  // ---------- public API ----------
  window.__CloneEditor = {
    get manifest() { return manifest; }, get mode() { return mode; }, get breakpoint() { return curBp; }, get showAfter() { return showAfter; },
    get config() { return CFG; },
    entries: entries, entriesByGroup: entriesByGroup, api: api, ui: ui, on: on, emit: emit,
    resolveEl: resolveEl, refreshManifest: refreshManifest, recomputeCounter: recomputeCounter,
    selectSlot: selectSlot, scheduleLayout: scheduleLayout, cssEsc: cssEsc,
    reapply: reapply, reapplyAll: reapplyAll, renderPanel: function () { renderPanel(); }, setPanelFilter: setPanelFilter,
    setMode: setMode, setBp: setBp, setBeforeAfter: setBeforeAfter,
    registerInteractor: function (fn) { interactors.push(fn); if (manifest) entries.forEach(function (e) { fn(Object.assign({ api: api, ui: ui, bus: { on: on, emit: emit } }, e)); }); },
    registerReapplier: function (fn) { reappliers.push(fn); },
    TYPE_SWAPPABLE_MEDIA: TYPE_SWAPPABLE_MEDIA,
  };

  // ---------- boot ----------
  function boot() {
    document.body.appendChild(root);
    document.body.appendChild(toolbar);
    document.body.appendChild(panel);
    document.body.appendChild(watermark);
    api.getManifest().then(function (m) {
      manifest = m;
      buildBadges(); renderPanel(); recomputeCounter();
      window.addEventListener('scroll', scheduleLayout, { passive: true });
      window.addEventListener('resize', scheduleLayout, { passive: true });
      var ro = new ResizeObserver(scheduleLayout); ro.observe(document.documentElement);

      // Survive React re-renders: when the DOM mutates, re-resolve anchors + re-apply user edits that got
      // blown away. rAF-batched; a window.__clApplying guard (set by editor.js) prevents echoing our own writes.
      var moPending = false;
      var mo = new MutationObserver(function () {
        if (window.__clApplying || moPending) return;
        moPending = true;
        requestAnimationFrame(function () {
          moPending = false;
          var relaid = false;
          entries.forEach(function (e) {
            var live = resolveEl(e.slot);            // re-resolves + self-heals the anchor
            if (live && live !== e.el) { e.el = live; relaid = true; }
            if (e.slot.replacement && e.el) reapply(e.slot, e.el);  // re-paint if React reverted it
          });
          if (relaid) scheduleLayout();
        });
      });
      try { mo.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (e) {}

      emit('ready', window.__CloneEditor);
      console.log('[clone] edit-map ready —', entries.size, 'badged slots,', manifest.slots.length, 'total');
    }).catch(function (e) {
      console.error('[clone] edit-map failed to load manifest:', e);
      var warn = el('div', { id: 'cl-counter' }); warn.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483600;background:#7f1d1d;color:#fff;padding:8px 14px;border-radius:8px';
      warn.textContent = 'clone edit-map: no manifest (run extract-manifest first)';
      document.body.appendChild(warn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
