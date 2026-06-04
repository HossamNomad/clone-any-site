/* clone-any-site — edit-map overlay engine (Wave 2). ZERO deps, vanilla JS.
 * Loopback-only. Injected by serve.mjs --edit. Renders numbered badges over the live mirror,
 * a slot table, an informational "N still original" counter (never blocks publishing), mode + breakpoint + before/after toggles.
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
    seo: function (payload) { return j('POST', '/__clone/seo', payload); },
    library: function () { return j('GET', '/__clone/library'); },
    libraryApply: function (payload) { return j('POST', '/__clone/library-apply', payload); },
    aiRewrite: function (payload) { return j('POST', '/__clone/ai-rewrite', payload); },
  };

  // ---------- state ----------
  var manifest = null;
  var entries = new Map();   // number -> { slot, el, badge, visible }
  var entriesByGroup = new Map(); // groupId -> [entry, ...]  (same-content propagation)
  var reappliers = [];       // editor.js registers fn(slot, el) to repaint a slot's DOM from its replacement
  var curBp = 'all';         // 'all' | '390' | '768' | '1440'
  var mode = 'edit';         // 'edit' (clean select-first, default) | 'audit' (all badges) | 'live' (Browse pass-through)
  var showAfter = true;      // before/after: true = show replacements
  var interactors = [];      // editor.js hooks: fn({slot, el, badge, api, ui, bus:{on,emit}})
  var rafPending = false;

  // ---------- dom shell ----------
  var root = document.createElement('div');
  root.id = 'cl-overlay';
  root.className = 'cl-edit';
  var ring = el('div', { id: 'cl-ring' });
  var ringLabel = el('div', { id: 'cl-ring-label' });
  var pop = el('div', { id: 'cl-pop' });
  var toastEl = el('div', { id: 'cl-toast' });
  var panel = buildPanel();
  var toolbar = buildToolbar();
  // No shippability watermark and no publish-blocking — publishing is always the user's own decision.
  root.appendChild(ring); root.appendChild(ringLabel); root.appendChild(pop); root.appendChild(toastEl);

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
    // Two honest modes: Edit = live + editable (default) · Preview = exactly what a visitor sees.
    // ("Show everything editable" is the coach's ◍ Highlight toggle / Space, not a separate mode.)
    modeG.appendChild(tbBtn('cl-mode-edit', 'Edit', true, function () { setMode('edit'); }));
    modeG.appendChild(tbBtn('cl-mode-live', 'Preview', false, function () { setMode('live'); }));
    var bpG = el('div', { class: 'cl-group' });
    ['all', '390', '768', '1440'].forEach(function (bp) {
      bpG.appendChild(tbBtn('cl-bp-' + bp, bp === 'all' ? 'All' : bp, bp === 'all', function () { setBp(bp); }));
    });
    var baBtn = tbBtn('cl-ba', 'After', true, function () { setBeforeAfter(!showAfter); });
    var panelBtn = tbBtn('cl-panel-btn', 'Slots', false, function () { panel.classList.toggle('cl-open'); });
    var saving = el('div', { id: 'cl-saving' }); saving.style.display = 'none';
    var counter = el('div', { id: 'cl-counter' }); counter.title = 'How many elements still show the original site’s content. Informational only — you decide when to publish.'; counter.innerHTML = '<span class="cl-dot"></span><span id="cl-count-n">…</span> <span id="cl-count-label">still original</span>';
    tb.appendChild(modeG); tb.appendChild(bpG); tb.appendChild(baBtn); tb.appendChild(panelBtn); tb.appendChild(saving); tb.appendChild(counter);
    tb._baBtn = baBtn; tb._counter = counter; tb._saving = saving;
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
  // repaint on (re)load: slots with a content replacement, alt-only override, or a hidden section (so they survive reload)
  function reapplyAll() { entries.forEach(function (e) { if (e.slot.replacement || e.slot.altReplacement != null || (e.slot.section && e.slot.section.hidden)) reapply(e.slot, e.el); }); }

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
      // keep the selection ring + label glued to the selected element on scroll/resize (they use fixed/
      // client-rect coords, so without this they drift to stale positions when the page scrolls).
      if (selected && selected.el && document.contains(selected.el)) { moveRing(selected.el); showRingLabel(selected.el, selLabelOf(selected)); }
    });
  }
  function selLabelOf(e) { var n = e.slot.groupId && (entriesByGroup.get(e.slot.groupId) || []).length; return '#' + e.slot.number + ' · ' + e.slot.type + (n > 1 ? ' · ×' + n : ''); }
  function moveRing(elx) {
    if (!elx) { ring.style.opacity = 0; if (ringLabel) ringLabel.style.opacity = 0; return; }
    var r = elx.getBoundingClientRect();
    ring.style.left = r.left + 'px'; ring.style.top = r.top + 'px';
    ring.style.width = r.width + 'px'; ring.style.height = r.height + 'px'; ring.style.opacity = 1;
  }
  // position the hover/selection label chip ("#N · type") just above the ring; pass null to hide
  function showRingLabel(elx, text) {
    if (!ringLabel) return;
    if (!elx) { ringLabel.style.opacity = 0; return; }
    var r = elx.getBoundingClientRect();
    ringLabel.textContent = text || '';
    var top = r.top - 22; if (top < 2) top = r.top + 4;
    ringLabel.style.left = Math.max(2, r.left) + 'px';
    ringLabel.style.top = top + 'px';
    ringLabel.style.opacity = 1;
  }

  // ---------- actions ----------
  var selected = null;   // the currently-selected entry (ring/label follow it on scroll)
  function selectSlot(num, scroll) {
    var e = entries.get(num);
    document.querySelectorAll('.cl-badge.cl-sel').forEach(function (b) { b.classList.remove('cl-sel'); });
    if (e) {
      selected = e;
      e.badge.classList.add('cl-sel'); moveRing(e.el); showRingLabel(e.el, selLabelOf(e));
      if (scroll && (e.el.getBoundingClientRect().top < 0 || e.el.getBoundingClientRect().top > innerHeight)) e.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      emit('select', e);
    }
  }
  function doKeep(num, keep) {
    api.slot({ number: num, op: keep ? 'keep' : 'unkeep' }).then(function () { return refreshManifest(); });
  }
  function setMode(m) {
    mode = m;
    root.classList.toggle('cl-edit', m === 'edit');     // clean select-first (default)
    root.classList.toggle('cl-audit', m === 'audit');   // all numbered badges on for a review pass
    root.classList.toggle('cl-live', m === 'live');     // Browse: pass-through, badges dimmed to dots
    pressGroup('cl-mode-', 'cl-mode-' + m);
    emit('modeChange', m);
  }
  function setBp(bp) { curBp = bp; pressGroup('cl-bp-', 'cl-bp-' + bp); entries.forEach(function (e) { e.badge.style.display = (e.visible && badgeAllowed(e.slot)) ? '' : 'none'; }); scheduleLayout(); emit('breakpointChange', bp); }
  function setBeforeAfter(after) { showAfter = after; toolbar._baBtn.textContent = after ? 'After' : 'Before'; toolbar._baBtn.setAttribute('aria-pressed', after ? 'true' : 'false'); emit('beforeAfter', after); }

  function recomputeCounter() {
    // INFORMATIONAL ONLY — never blocks publishing. Counts elements still showing the original's content
    // so you can see how much you've made your own. Whether/when to publish is always your call.
    var n = manifest.slots.filter(function (s) { return s.provenance === 'original' && !s.keep && !s.replacement; }).length;
    var label = document.getElementById('cl-count-n'); if (label) label.textContent = n;
    var lab = document.getElementById('cl-count-label'); if (lab) lab.textContent = n === 0 ? 'all yours ✓' : 'still original';
    toolbar._counter.classList.toggle('cl-clear', n === 0);
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

  // ---------- visible feedback: toast + autosave chip (replaces the old invisible watermark.title) ----------
  var toastTimer = null;
  function showToast(msg, kind) {
    if (!msg) return;
    toastEl.textContent = msg;
    toastEl.className = 'cl-show' + (kind ? ' cl-' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, kind === 'error' ? 4200 : 2200);
  }
  var savingHideTimer = null;
  function setSaving(state) {
    var s = toolbar._saving; if (!s) return;
    if (savingHideTimer) { clearTimeout(savingHideTimer); savingHideTimer = null; }
    if (!state) { s.style.display = 'none'; return; }
    s.style.display = '';
    if (state === 'saving') { s.textContent = 'Saving…'; s.className = 'cl-saving-busy'; }
    else if (state === 'saved') { s.textContent = 'Saved ✓'; s.className = 'cl-saving-ok'; savingHideTimer = setTimeout(function () { s.style.display = 'none'; }, 1500); }
    else if (state === 'error') { s.textContent = 'Save failed'; s.className = 'cl-saving-err'; }
  }

  // ---------- ui handle for editor.js ----------
  var ui = {
    root: root, ring: ring, ringLabel: ringLabel, pop: pop, panel: panel, toolbar: toolbar, toastEl: toastEl,
    moveRing: moveRing, showRingLabel: showRingLabel, selectSlot: selectSlot, el: el, escapeHtml: escapeHtml,
    toast: showToast, saving: setSaving,
    // back-compat: existing callers used ui.setStatus(msg) (was an invisible tooltip) — now a real toast
    setStatus: function (msg) { showToast(msg, /fail|error|⚠/i.test(String(msg || '')) ? 'error' : ''); },
  };

  // ---------- command history (undo / redo) ----------
  // command = { label, do:()=>Promise, undo:()=>Promise, coalesceKey? }. Cheap: the server already exposes the
  // inverse (the `clear` op) and replacement is idempotent; pre-state comes from editor.js's `originals` snapshot.
  var undoStack = [], redoStack = [];
  var history = {
    push: function (cmd) {
      var last = undoStack[undoStack.length - 1];
      if (cmd.coalesceKey && last && last.coalesceKey === cmd.coalesceKey && (Date.now() - (last._t || 0)) < 900) {
        last.do = cmd.do; last._t = Date.now();           // merge rapid same-target edits, keep original undo
      } else {
        cmd._t = Date.now(); undoStack.push(cmd); if (undoStack.length > 120) undoStack.shift();
      }
      redoStack.length = 0; emit('history', { undo: undoStack.length, redo: redoStack.length });
    },
    run: function (cmd) { return Promise.resolve(cmd.do()).then(function (r) { history.push(cmd); return r; }); },
    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },
    undo: function () {
      var c = undoStack.pop(); if (!c) { showToast('Nothing to undo'); return Promise.resolve(false); }
      c.coalesceKey = null;   // once undone, it must never absorb a later same-target edit (would silently drop a step)
      return Promise.resolve(c.undo()).then(function () { redoStack.push(c); showToast('Undo: ' + (c.label || 'change')); emit('history', { undo: undoStack.length, redo: redoStack.length }); return true; })
        .catch(function (e) { undoStack.push(c); showToast('Undo failed: ' + e.message, 'error'); });
    },
    redo: function () {
      var c = redoStack.pop(); if (!c) { showToast('Nothing to redo'); return Promise.resolve(false); }
      return Promise.resolve(c.do()).then(function () { undoStack.push(c); showToast('Redo: ' + (c.label || 'change')); emit('history', { undo: undoStack.length, redo: redoStack.length }); return true; })
        .catch(function (e) { redoStack.push(c); showToast('Redo failed: ' + e.message, 'error'); });
    },
  };
  function isTyping(e) { var t = e && e.target; return !!(t && (t.isContentEditable || /input|textarea|select/i.test(t.tagName || ''))); }
  window.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'z' && !isTyping(e)) { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); }
    else if ((e.metaKey || e.ctrlKey) && k === 'y' && !isTyping(e)) { e.preventDefault(); history.redo(); }
  }, true);

  // ---------- hit-test: find the best editable entry at a point, piercing overlays (anchors/gradients) ----------
  function typeOk(slot, opts) { return !(opts && opts.types && opts.types.indexOf(slot.type) === -1); }
  function hitTest(x, y, opts) {
    opts = opts || {};
    var stack = (document.elementsFromPoint && document.elementsFromPoint(x, y)) || [];
    var candidates = [];
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (node.id === 'cl-overlay' || (node.closest && node.closest('#cl-overlay'))) {
        var b = node.closest && node.closest('.cl-badge[data-cl-for]');   // clicking the number badge selects its slot
        if (b) { var be = entries.get(+b.getAttribute('data-cl-for')); if (be && typeOk(be.slot, opts)) return { entry: be, el: be.el, slot: be.slot }; }
        continue;                                                          // otherwise skip our own chrome
      }
      var host = node.closest && node.closest('[data-cl-for]');
      if (host) {
        var e = entries.get(+host.getAttribute('data-cl-for'));
        if (e && typeOk(e.slot, opts)) { var r = host.getBoundingClientRect(); candidates.push({ entry: e, el: e.el, slot: e.slot, depth: i, area: r.width * r.height }); }
      }
    }
    // smallest area first (most specific); on an exact-area tie prefer the TOPMOST (lowest depth = visually on top)
    if (candidates.length) { candidates.sort(function (a, b) { return a.area - b.area || a.depth - b.depth; }); return candidates[0]; }
    // containment fallback for bg slots whose hit target is a non-anchored overlay child
    var best = null;
    entries.forEach(function (e) {
      if (e.slot.type !== 'bg' || !typeOk(e.slot, opts)) return;
      var r = e.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { var area = r.width * r.height; if (!best || area < best.area) best = { entry: e, el: e.el, slot: e.slot, area: area }; }
    });
    return best;
  }
  // full occlusion stack at a point (for alt-cycle / "pick element under…")
  function hitStack(x, y) {
    var stack = (document.elementsFromPoint && document.elementsFromPoint(x, y)) || [];
    var out = [], seen = {};
    for (var i = 0; i < stack.length; i++) {
      var host = stack[i].closest && stack[i].closest('[data-cl-for]');
      if (!host) continue;
      var n = +host.getAttribute('data-cl-for'); if (seen[n]) continue; seen[n] = 1;
      var e = entries.get(n); if (e) out.push({ entry: e, el: e.el, slot: e.slot });
    }
    return out;
  }

  // ---------- public API ----------
  window.__CloneEditor = {
    get manifest() { return manifest; }, get mode() { return mode; }, get breakpoint() { return curBp; }, get showAfter() { return showAfter; },
    get config() { return CFG; },
    entries: entries, entriesByGroup: entriesByGroup, api: api, ui: ui, on: on, emit: emit,
    resolveEl: resolveEl, refreshManifest: refreshManifest, recomputeCounter: recomputeCounter,
    selectSlot: selectSlot, scheduleLayout: scheduleLayout, cssEsc: cssEsc,
    reapply: reapply, reapplyAll: reapplyAll, renderPanel: function () { renderPanel(); }, setPanelFilter: setPanelFilter,
    setMode: setMode, setBp: setBp, setBeforeAfter: setBeforeAfter,
    history: history, hitTest: hitTest, hitStack: hitStack, isTyping: isTyping,
    registerInteractor: function (fn) { interactors.push(fn); if (manifest) entries.forEach(function (e) { fn(Object.assign({ api: api, ui: ui, bus: { on: on, emit: emit } }, e)); }); },
    registerReapplier: function (fn) { reappliers.push(fn); },
    TYPE_SWAPPABLE_MEDIA: TYPE_SWAPPABLE_MEDIA,
  };

  // ---------- boot ----------
  function boot() {
    document.body.appendChild(root);
    document.body.appendChild(toolbar);
    document.body.appendChild(panel);
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
            // NEVER touch the element the user is actively typing into — re-resolving or re-painting it would
            // overwrite the in-progress (uncommitted) text with the last saved value and jump the caret.
            if (e.el && e.el.getAttribute && e.el.getAttribute('contenteditable') === 'true') return;
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
