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

    console.log('[clone] CMS panel ready — search · filter · find-replace · themes');
  }
  function press(root, sel, active) { root.querySelectorAll(sel).forEach(function (b) { b.setAttribute('aria-pressed', b === active ? 'true' : 'false'); }); }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
