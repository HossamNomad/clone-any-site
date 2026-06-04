/* clone-any-site — select.js (v2). ZERO deps, vanilla JS. Loopback-only.
 * Select-first interaction (the "feels like Webflow / v0" layer):
 *   - hover any editable element → outline ring + a "#N · type" label (clean mode, no badge noise)
 *   - single-click selects (and floats a contextual toolbar); double-click edits
 *   - elements hidden under overlay anchors / gradient divs are still reachable (hitTest pierces the stack;
 *     Alt+click cycles the occlusion stack)
 *   - contextual floating toolbar anchored to the selection with the 2-4 actions for that slot type
 * Calls into editor.js (CE.editText / editMedia / keepSlot / resetSlot) and menu.js (CE.openMenu).
 */
(function () {
  'use strict';
  function start(CE) {
    var ui = CE.ui;
    var ctx = document.createElement('div'); ctx.id = 'cl-ctx'; ctx.style.display = 'none';
    ui.root.appendChild(ctx);
    var curEntry = null, altKey = null, altIndex = 0;

    function isEditMode() { return CE.mode === 'edit' || CE.mode === 'audit'; }
    function overChrome(el) { return !!(el && el.closest && el.closest('#cl-overlay') && !el.closest('.cl-badge')); }
    // don't track the hover ring while a popover or context menu is open (it would sit under them)
    function popoverOpen() {
      var pop = document.getElementById('cl-pop'); if (pop && pop.classList.contains('cl-open')) return true;
      var menu = document.getElementById('cl-menu'); if (menu && menu.style.display === 'block') return true;
      return false;
    }

    // ---------- hover: ring + label ----------
    var hoverRaf = false, hx = 0, hy = 0;
    document.addEventListener('mousemove', function (e) {
      if (!isEditMode()) return;
      hx = e.clientX; hy = e.clientY;
      if (hoverRaf) return; hoverRaf = true;
      requestAnimationFrame(function () {
        hoverRaf = false;
        if (popoverOpen()) return;                                       // a dialog is up — leave the ring be
        if (overChrome(document.elementFromPoint(hx, hy))) return;       // don't fight our own chrome
        var hit = CE.hitTest(hx, hy);
        if (hit) {
          if (!curEntry || hit.slot.number !== curEntry.slot.number) {
            ui.moveRing(hit.el);
            var n = hit.slot.groupId && (CE.entriesByGroup.get(hit.slot.groupId) || []).length;
            ui.showRingLabel(hit.el, '#' + hit.slot.number + ' · ' + hit.slot.type + (n > 1 ? ' · ×' + n : ''));
          }
        } else if (!curEntry) { ui.moveRing(null); ui.showRingLabel(null); }
      });
    }, true);

    // ---------- single-click selects (capture so we beat the site's own handlers) ----------
    document.addEventListener('click', function (e) {
      if (!isEditMode()) return;
      if (overChrome(e.target)) return;                 // clicks on toolbar/panel/ctx/menu work normally
      var hit = e.altKey ? cycleStack(e.clientX, e.clientY) : (altKey = null, CE.hitTest(e.clientX, e.clientY));
      if (hit) { e.preventDefault(); e.stopPropagation(); selectEntry(hit); }
    }, true);

    // ---------- double-click edits ----------
    document.addEventListener('dblclick', function (e) {
      if (!isEditMode()) return;
      if (overChrome(e.target)) return;
      var hit = CE.hitTest(e.clientX, e.clientY); if (!hit) return;
      e.preventDefault(); e.stopPropagation();
      selectEntry(hit); openEdit(hit.slot);
    }, true);

    function openEdit(slot) {
      var el = CE.resolveEl(slot);
      if (slot.type === 'text') CE.editText(slot, el);
      else if (CE.TYPE_SWAPPABLE_MEDIA[slot.type]) CE.editMedia(slot, el);
    }
    function cycleStack(x, y) {
      var key = Math.round(x) + 'x' + Math.round(y), stack = CE.hitStack(x, y);
      if (!stack.length) return null;
      if (altKey !== key) { altKey = key; altIndex = 0; } else altIndex = (altIndex + 1) % stack.length;
      return stack[altIndex];
    }
    function selectEntry(hit) { curEntry = hit; CE.selectSlot(hit.slot.number); positionCtx(hit); }

    CE.on('select', function (entry) { curEntry = entry; positionCtx(entry); });
    window.addEventListener('scroll', function () { if (curEntry) positionCtx(curEntry); }, { passive: true });
    window.addEventListener('resize', function () { if (curEntry) positionCtx(curEntry); }, { passive: true });
    CE.on('modeChange', function (m) { if (m === 'live') { hideCtx(); ui.moveRing(null); ui.showRingLabel(null); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideCtx(); });

    // ---------- contextual floating toolbar ----------
    function hideCtx() { ctx.style.display = 'none'; }
    function positionCtx(hit) {
      var slot = hit.slot, el = hit.el || CE.resolveEl(slot);
      if (!el || !isEditMode()) { hideCtx(); return; }
      renderCtx(slot, el);
      var r = el.getBoundingClientRect();
      ctx.style.display = 'flex';
      var cw = ctx.offsetWidth || 240, ch = ctx.offsetHeight || 34;
      var top = r.top - ch - 8; if (top < 52) top = r.bottom + 8;
      ctx.style.left = Math.max(8, Math.min(r.left, innerWidth - cw - 8)) + 'px';
      ctx.style.top = Math.max(52, Math.min(top, innerHeight - ch - 8)) + 'px';
    }
    function renderCtx(slot, el) {
      var e = CE.entries.get(slot.number);
      var changed = !!(e && e.slot && e.slot.replacement);
      var grp = slot.groupId && CE.entriesByGroup.get(slot.groupId);
      ctx.innerHTML = '';
      ctx.appendChild(btn(slot.type === 'text' ? 'Edit text' : 'Replace ' + slot.type, 'cl-ctx-primary', function () { openEdit(slot); }));
      if (grp && grp.length > 1) ctx.appendChild(tag('×' + grp.length));
      ctx.appendChild(btn('Keep', '', function () { CE.keepSlot(slot); }));
      ctx.appendChild(btn('Reset', changed ? '' : 'cl-dis', function () { if (changed) CE.resetSlot(slot); }));
      ctx.appendChild(btn('⋯', 'cl-ctx-more', function (ev) { if (CE.openMenu) CE.openMenu(slot, CE.resolveEl(slot) || el, ev.clientX, ev.clientY); }));
    }
    function btn(label, cls, fn) { var b = document.createElement('button'); b.className = 'cl-ctx-b ' + (cls || ''); b.textContent = label; b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(ev); }); return b; }
    function tag(t) { var s = document.createElement('span'); s.className = 'cl-ctx-tag'; s.textContent = t; return s; }

    CE.selectEntry = selectEntry;
    console.log('[clone] select.js ready — hover ring, click-select, alt-cycle occlusion, contextual toolbar');
  }
  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
