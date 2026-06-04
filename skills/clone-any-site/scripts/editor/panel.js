/* clone-any-site — CMS side panel (search · filter · find-replace · themes). ZERO deps.
 * Augments the kernel's #cl-panel: a tools header above the slot list (which edit-map renders, filtered
 * via CE.setPanelFilter). Find-replace runs as ONE /__clone/batch op.
 */
(function () {
  'use strict';
  function start(CE) {
    var panel = CE.ui.panel;
    var q = '', typeFilter = 'all', statusFilter = 'all';

    var head = document.createElement('div');
    head.id = 'cl-panel-tools';
    head.innerHTML =
      '<input id="cl-search" placeholder="search slots… (text, #, type)">' +
      '<div class="cl-chips">' +
        ['all', 'text', 'img', 'bg', 'video', 'svg', 'icon'].map(function (t) { return '<button class="cl-chip" data-type="' + t + '"' + (t === 'all' ? ' aria-pressed="true"' : '') + '>' + t + '</button>'; }).join('') +
      '</div>' +
      '<div class="cl-chips">' +
        ['all', 'changed', 'blocking', 'grouped'].map(function (t) { return '<button class="cl-chip cl-status" data-status="' + t + '"' + (t === 'all' ? ' aria-pressed="true"' : '') + '>' + t + '</button>'; }).join('') +
      '</div>' +
      '<div class="cl-fr"><input id="cl-find" placeholder="find text…"><input id="cl-rep" placeholder="replace with…"><button id="cl-fr-go">replace all</button><span id="cl-fr-n"></span></div>' +
      '<div class="cl-themes" id="cl-themes"></div>';
    var hdr = panel.querySelector('header');
    if (hdr && hdr.nextSibling) panel.insertBefore(head, hdr.nextSibling); else panel.insertBefore(head, panel.firstChild);

    function applyFilter() {
      CE.setPanelFilter(function (s) {
        if (typeFilter !== 'all' && s.type !== typeFilter) return false;
        if (statusFilter === 'changed' && !(s.replacement || s.keep)) return false;
        if (statusFilter === 'blocking' && !(s.provenance === 'original' && !s.keep && !s.replacement && s.role === 'content')) return false;
        if (statusFilter === 'grouped' && !s.groupId) return false;
        if (q) {
          var hay = ('#' + s.number + ' ' + s.type + ' ' + (s.currentValue || '') + ' ' + (s.replacement && s.replacement.value || '')).toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
    }

    head.querySelector('#cl-search').addEventListener('input', function (e) { q = e.target.value.toLowerCase().trim(); applyFilter(); });
    head.querySelectorAll('.cl-chip:not(.cl-status)').forEach(function (b) { b.addEventListener('click', function () { typeFilter = b.dataset.type; press(head, '.cl-chip:not(.cl-status)', b); applyFilter(); }); });
    head.querySelectorAll('.cl-status').forEach(function (b) { b.addEventListener('click', function () { statusFilter = b.dataset.status; press(head, '.cl-status', b); applyFilter(); }); });

    head.querySelector('#cl-fr-go').addEventListener('click', function () { findReplace(head.querySelector('#cl-find').value, head.querySelector('#cl-rep').value); });

    function findReplace(find, rep) {
      if (!find) return;
      var ops = [];
      CE.manifest.slots.forEach(function (s) {
        if (s.type !== 'text') return;
        var cur = (s.replacement && s.replacement.value != null) ? s.replacement.value : (s.currentValue || '');
        if (cur.indexOf(find) !== -1) ops.push({ number: s.number, op: 'replace-text', value: cur.split(find).join(rep) });
      });
      var nEl = head.querySelector('#cl-fr-n');
      if (!ops.length) { nEl.textContent = '0 matches'; return; }
      CE.api.batch({ ops: ops, label: 'find-replace' }).then(function () {
        ops.forEach(function (o) { var e = CE.entries.get(o.number); if (e) CE.reapply(Object.assign({}, e.slot, { replacement: { kind: 'text', value: o.value } }), e.el); });
        return CE.refreshManifest();
      }).then(function () { nEl.textContent = ops.length + ' replaced'; CE.emit('storeChange', {}); });
    }
    CE.findReplace = findReplace;

    function renderThemes() {
      var box = head.querySelector('#cl-themes');
      var list = (CE.themes && CE.themes.list()) || [];
      box.innerHTML = '<span class="cl-th-label">theme</span>' + list.map(function (t) { return '<button class="cl-th" data-id="' + t.id + '" style="--sw:' + (t.accent || '#888') + '">' + t.label + '</button>'; }).join('') + '<button class="cl-th cl-th-clear">none</button>';
      box.querySelectorAll('.cl-th[data-id]').forEach(function (b) { b.addEventListener('click', function () { CE.themes.apply(b.dataset.id); }); });
      var c = box.querySelector('.cl-th-clear'); if (c) c.addEventListener('click', function () { CE.themes && CE.themes.clear(); });
    }
    CE.on('themesReady', renderThemes);
    if (CE.themes && CE.themes.list().length) renderThemes();
    CE.on('manifest', applyFilter);

    // ---- SEO section: rewrite the head so the shipped page carries YOUR title/description, not the clone's ----
    var seoBox = document.createElement('div');
    seoBox.id = 'cl-seo';
    head.appendChild(seoBox);
    function seoVal(k) { var s = (CE.manifest && CE.manifest.meta && CE.manifest.meta.seo) || {}; var rep = s.replacement || {}, org = s.original || {}; return (rep[k] != null ? rep[k] : (org[k] || '')); }
    function renderSeo() {
      seoBox.innerHTML =
        '<div class="cl-seo-h">SEO · head</div>' +
        '<input id="cl-seo-title" placeholder="page title (the clone ships the original’s)" />' +
        '<textarea id="cl-seo-desc" rows="2" placeholder="meta description"></textarea>' +
        '<input id="cl-seo-canon" placeholder="canonical URL (your domain)" />' +
        '<button id="cl-seo-save">save SEO</button><span id="cl-seo-n"></span>';
      seoBox.querySelector('#cl-seo-title').value = seoVal('title');
      seoBox.querySelector('#cl-seo-desc').value = seoVal('description');
      seoBox.querySelector('#cl-seo-canon').value = seoVal('canonical');
      seoBox.querySelector('#cl-seo-save').addEventListener('click', function () {
        var seo = {
          title: seoBox.querySelector('#cl-seo-title').value,
          description: seoBox.querySelector('#cl-seo-desc').value,
          canonical: seoBox.querySelector('#cl-seo-canon').value,
        };
        CE.api.seo({ seo: seo }).then(function () { return CE.refreshManifest(); })
          .then(function () { var n = seoBox.querySelector('#cl-seo-n'); if (n) n.textContent = 'saved'; CE.ui.toast('SEO head updated'); CE.emit('storeChange', {}); })
          .catch(function (e) { CE.ui.toast('SEO save failed: ' + e.message, 'error'); });
      });
    }
    // ---- Sections: hide/show whole sections (drop a block you don't need) — reversible, manifest-only ----
    var secBox = document.createElement('div');
    secBox.id = 'cl-sections';
    head.appendChild(secBox);
    var dragRow = null;
    function renderSections() {
      if (!CE.setSectionHidden) return;
      var secs = (CE.manifest && CE.manifest.slots || []).filter(function (s) { return s.type === 'section'; });
      if (!secs.length) { secBox.innerHTML = ''; return; }
      // list in current (possibly reordered) order: by section.order, then natural number
      secs = secs.slice().sort(function (a, b) {
        var ao = (a.section && typeof a.section.order === 'number') ? a.section.order : null;
        var bo = (b.section && typeof b.section.order === 'number') ? b.section.order : null;
        if (ao == null && bo == null) return a.number - b.number;
        if (ao == null) return 1; if (bo == null) return -1;
        return ao - bo;
      });
      var canReorder = !!CE.setSectionOrderBatch;
      secBox.innerHTML = '<div class="cl-sec-h">sections — ' + (canReorder ? 'drag to reorder · ' : '') + 'hide/show</div>' + secs.map(function (s) {
        var hidden = !!(s.section && s.section.hidden);
        var label = (s.currentValue || s.mirrorLocator && s.mirrorLocator.cssPath || ('#' + s.number)).toString().slice(0, 28);
        return '<div class="cl-sec-row" data-n="' + s.number + '"' + (canReorder ? ' draggable="true"' : '') + '>' +
          (canReorder ? '<span class="cl-sec-drag" title="drag to reorder">⠿</span>' : '') +
          '<input type="checkbox" data-n="' + s.number + '"' + (hidden ? '' : ' checked') + '>' +
          '<span class="cl-sec-lbl">#' + s.number + ' ' + escapeHtml(label) + '</span></div>';
      }).join('');
      secBox.querySelectorAll('input[data-n]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var n = +cb.getAttribute('data-n');
          var slot = CE.manifest.slots.find(function (s) { return s.number === n; });
          if (slot) CE.setSectionHidden(slot, !cb.checked);   // unchecked = hidden
        });
      });
      if (canReorder) wireSectionDrag();
    }
    function wireSectionDrag() {
      secBox.querySelectorAll('.cl-sec-row[draggable]').forEach(function (row) {
        row.addEventListener('dragstart', function (e) { dragRow = row; row.classList.add('cl-sec-dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.getAttribute('data-n')); } catch (x) {} });
        row.addEventListener('dragend', function () { row.classList.remove('cl-sec-dragging'); var moved = dragRow; dragRow = null; if (moved) commitSectionOrder(); });
        row.addEventListener('dragover', function (e) {
          e.preventDefault(); if (!dragRow || dragRow === row) return;
          var r = row.getBoundingClientRect(); var after = e.clientY > r.top + r.height / 2;
          row.parentNode.insertBefore(dragRow, after ? row.nextSibling : row);
        });
      });
    }
    function commitSectionOrder() {
      var nums = Array.prototype.map.call(secBox.querySelectorAll('.cl-sec-row'), function (r) { return +r.getAttribute('data-n'); });
      if (CE.setSectionOrderBatch && nums.length) CE.setSectionOrderBatch(nums);
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    renderSections();
    CE.on('manifest', function () { if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#cl-sections')) return; renderSections(); });
    CE.renderSections = renderSections;

    renderSeo();
    // NOTE: do NOT auto-repaint on 'manifest' — the SEO fields are user-owned once rendered; repainting on an
    // unrelated edit would wipe in-progress (unsaved) typing. Saved values already equal what's in the fields.
    CE.renderSeo = renderSeo;

    console.log('[clone] CMS panel ready — search · filter · find-replace · themes · SEO');
  }
  function press(root, sel, active) { root.querySelectorAll(sel).forEach(function (b) { b.setAttribute('aria-pressed', b === active ? 'true' : 'false'); }); }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
