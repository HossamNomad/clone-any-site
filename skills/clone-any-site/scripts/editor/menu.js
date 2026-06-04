/* clone-any-site — menu.js (v2). ZERO deps, vanilla JS. Loopback-only.
 * Right-click context menu over any editable element (Hossam explicitly asked for this).
 * Type-aware items; reuses CE.editText / editMedia / keepSlot / resetSlot and the hit-test stack.
 * Exposes CE.openMenu so the contextual toolbar's ⋯ button can open the same menu.
 */
(function () {
  'use strict';
  function start(CE) {
    var menu = document.createElement('div'); menu.id = 'cl-menu'; menu.style.display = 'none';
    CE.ui.root.appendChild(menu);

    function isEditMode() { return CE.mode === 'edit' || CE.mode === 'audit'; }
    function changedOf(slot) { var e = CE.entries.get(slot.number); return !!(e && e.slot && e.slot.replacement); }
    function valueOf(slot) { var e = CE.entries.get(slot.number); var s = e && e.slot; return s && ((s.replacement && s.replacement.value) || s.currentValue) || ''; }

    document.addEventListener('contextmenu', function (e) {
      if (!isEditMode()) return;
      if (e.target.closest && e.target.closest('#cl-menu')) return;
      var hit = CE.hitTest(e.clientX, e.clientY); if (!hit) return;
      e.preventDefault();
      (CE.selectEntry ? CE.selectEntry(hit) : CE.selectSlot(hit.slot.number));
      openMenu(hit.slot, hit.el, e.clientX, e.clientY);
    }, true);

    function openMenu(slot, el, x, y) {
      el = el || CE.resolveEl(slot);
      var entry = CE.entries.get(slot.number);   // the live slot record (NOT a parameter named `e`)
      var es = entry && entry.slot;
      var grp = slot.groupId && CE.entriesByGroup.get(slot.groupId);
      var changed = changedOf(slot);
      var items = [];
      if (slot.type === 'text') {
        items.push(item('Edit text', function () { CE.editText(slot, el); }));
        // link target edit (slot.href is populated for direct <a> AND for labels wrapped in an ancestor <a>)
        var curHref = (es && es.replacement && es.replacement.href) || (es && es.href) || slot.href;
        var isLink = (slot.href != null) || (es && es.href != null) || (el && (el.tagName === 'A' || (el.closest && el.closest('a[href]'))));
        if (isLink) items.push(item('Edit link…', function () { editLink(slot, curHref); }));
        items.push(item('Copy text', function () { copy(valueOf(slot)); }));
        items.push(item('Paste text', function () { paste(slot); }));
      } else {
        items.push(item('Replace ' + slot.type + '…', function () { CE.editMedia(slot, el); }));
        if ((slot.type === 'img' || slot.type === 'icon') && CE.setAlt) {
          items.push(item('Edit alt text…', function () { editAlt(slot, el); }));
        }
      }
      if (grp && grp.length > 1) items.push(item('Change everywhere (×' + grp.length + ')', function () { slot.type === 'text' ? CE.editText(slot, el) : CE.editMedia(slot, el); }));
      items.push(sep());
      items.push(item('Keep original', function () { CE.keepSlot(slot); }));
      items.push(item('Reset to original', changed ? function () { CE.resetSlot(slot); } : null));
      items.push(sep());
      items.push(item('Pick element under…', function () { pickUnder(x, y); }));
      items.push(item('Select in panel', function () { CE.ui.panel.classList.add('cl-open'); CE.selectSlot(slot.number, true); }));
      if (slot.type === 'text') { items.push(sep()); items.push(item('✨ Rewrite with AI', function () { aiRewrite(slot); })); }
      render(items, x, y);
    }
    CE.openMenu = openMenu;

    function pickUnder(x, y) {
      var stack = CE.hitStack(x, y);
      if (!stack.length) { CE.ui.toast('nothing editable here'); return; }
      var items = stack.map(function (h) { return item('#' + h.slot.number + ' · ' + h.slot.type + ' — ' + shortVal(h.slot), function () { (CE.selectEntry ? CE.selectEntry(h) : CE.selectSlot(h.slot.number)); }); });
      render(items, x, y);
    }
    function shortVal(slot) { var v = valueOf(slot) || (slot.currentValueRef || ''); return String(v).slice(0, 28); }

    function editLink(slot, cur) {
      if (!CE.setHref) return;
      var v = window.prompt('Link target (href) for #' + slot.number + ':', cur || '');
      if (v != null) CE.setHref(slot, v);
    }
    function editAlt(slot, el) {
      if (!CE.setAlt) return;
      var img = el && (el.tagName === 'IMG' ? el : (el.querySelector && el.querySelector('img')));
      var cur = (slot.altReplacement != null) ? slot.altReplacement : (img ? img.getAttribute('alt') : '');
      var v = window.prompt('Alt text (accessibility + SEO) for #' + slot.number + ':', cur || '');
      if (v != null) CE.setAlt(slot, v);
    }
    // AI copy rewrite — fetch brand-voice variants, let the user pick one in the popover; apply via the
    // undoable text path. Offline-safe: a 503 (no key) shows a clear toast and changes nothing.
    function aiRewrite(slot) {
      if (!CE.setText) return;
      var e = CE.entries.get(slot.number); var cur = (e && e.slot && ((e.slot.replacement && e.slot.replacement.value) || e.slot.currentValue)) || valueOf(slot);
      if (!cur) { CE.ui.toast('nothing to rewrite'); return; }
      var pop = CE.ui.pop;
      pop.innerHTML = '<h4>#' + slot.number + ' — rewrite with AI</h4><div class="cl-ai-status">thinking…</div><div class="cl-ai-variants"></div><div class="cl-actions"><button class="cl-ghost" data-act="cancel">cancel</button></div>';
      pop.classList.add('cl-open');
      pop.querySelector('[data-act="cancel"]').addEventListener('click', function () { pop.classList.remove('cl-open'); pop.innerHTML = ''; });
      CE.api.aiRewrite({ text: cur, n: 3 }).then(function (r) {
        var box = pop.querySelector('.cl-ai-variants'); var st = pop.querySelector('.cl-ai-status');
        var vs = (r && r.variants) || [];
        if (!vs.length) { st.textContent = 'no variants'; return; }
        st.textContent = 'pick one' + (r.source === 'fake' ? ' (demo)' : '');
        box.innerHTML = vs.map(function (v, i) { return '<button class="cl-ai-v" data-i="' + i + '">' + escAttr(v) + '</button>'; }).join('');
        box.querySelectorAll('.cl-ai-v').forEach(function (b) { b.addEventListener('click', function () { CE.setText(slot, vs[+b.getAttribute('data-i')]); pop.classList.remove('cl-open'); pop.innerHTML = ''; }); });
      }).catch(function (err) {
        var st = pop.querySelector('.cl-ai-status'); var msg = (err && err.message) || String(err);
        if (st) st.textContent = /503/.test(msg) ? 'AI not configured — set ANTHROPIC_API_KEY' : ('AI error: ' + msg.slice(0, 120));
        CE.ui.toast(/503/.test(msg) ? 'AI not configured (ANTHROPIC_API_KEY)' : 'AI error', 'error');
      });
    }
    function escAttr(s) { return String(s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }
    function copy(text) { try { navigator.clipboard.writeText(text).then(function () { CE.ui.toast('copied'); }, function () { CE.ui.toast('copy failed', 'error'); }); } catch (e) { CE.ui.toast('copy unavailable', 'error'); } }
    function paste(slot) {
      // route through CE.setText so directOnly children survive + grouped instances propagate (no textContent nuke)
      try { navigator.clipboard.readText().then(function (t) { if (t != null && CE.setText) CE.setText(slot, t); }, function () { CE.ui.toast('paste failed', 'error'); }); }
      catch (e) { CE.ui.toast('paste unavailable', 'error'); }
    }

    // ---------- render ----------
    function item(label, fn, badge) { return { label: label, fn: fn, badge: badge }; }
    function sep() { return { sep: true }; }
    function render(items, x, y) {
      menu.innerHTML = '';
      items.forEach(function (it) {
        if (it.sep) { var d = document.createElement('div'); d.className = 'cl-menu-sep'; menu.appendChild(d); return; }
        var row = document.createElement('button');
        row.className = 'cl-menu-i' + (it.fn ? '' : ' cl-dis') + (it.badge ? ' cl-menu-' + it.badge : '');
        row.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.badge ? '<small>' + it.badge + '</small>' : '');
        if (it.fn) row.addEventListener('click', function (ev) { ev.stopPropagation(); close(); it.fn(); });
        menu.appendChild(row);
      });
      menu.style.display = 'block';
      var mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 220;
      menu.style.left = Math.max(6, Math.min(x, innerWidth - mw - 6)) + 'px';
      menu.style.top = Math.max(6, Math.min(y, innerHeight - mh - 6)) + 'px';
    }
    function close() { menu.style.display = 'none'; }
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    document.addEventListener('click', function (e) { if (menu.style.display === 'block' && !(e.target.closest && e.target.closest('#cl-menu'))) close(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    console.log('[clone] menu.js ready — right-click context menu');
  }
  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
