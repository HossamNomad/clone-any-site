/* clone-any-site — coach.js. ZERO deps, vanilla JS. Loopback-only.
 * The "make it obvious" onboarding layer (fixes "je clique Edit, rien ne se passe").
 *   - A dismissible welcome card on first Edit load: how to start, in one glance.
 *   - A persistent "?" button in the toolbar to reopen it any time.
 *   - "Hints" (default ON in Edit): a faint dashed outline on EVERY editable element so the page visibly
 *     announces what you can touch, without hunting with the mouse.
 *   - "◍ Highlight" toggle (button + Space): flashes a strong outline on every editable element at once —
 *     this is what the old "Audit" mode was trying to be, done right.
 * Both effects style the REAL elements ([data-cl-for]) via a <body> class, so there's no cascade fight with
 * the overlay's own badge rules. Publishing is always the user's decision: nothing here blocks anything.
 */
(function () {
  'use strict';

  function injectStyle() {
    if (document.getElementById('cl-coach-style')) return;
    var s = document.createElement('style'); s.id = 'cl-coach-style';
    s.textContent = [
      // welcome card
      // pointer-events:none so the card NEVER blocks clicking/double-clicking the content under it
      // (only its own buttons re-enable pointer events). A welcome card must not get in the way of editing.
      '#cl-coach{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:2147483550;',
      'pointer-events:none;width:min(440px,calc(100vw - 24px));background:rgba(19,19,22,.97);',
      'backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.14);border-radius:14px;',
      'box-shadow:0 18px 50px rgba(0,0,0,.55);color:#e6e7ea;',
      'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13.5px;padding:14px 16px}',
      '#cl-coach button{pointer-events:auto}',
      '#cl-coach .cl-coach-h{display:flex;align-items:center;justify-content:space-between;font-size:15px;margin-bottom:8px}',
      '#cl-coach .cl-coach-h strong{font-weight:700}',
      '#cl-coach .cl-coach-x{background:transparent;border:0;color:#a1a1aa;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}',
      '#cl-coach .cl-coach-x:hover{color:#fff}',
      '#cl-coach .cl-coach-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}',
      '#cl-coach .cl-coach-list li{padding-left:18px;position:relative;line-height:1.4;color:#d4d4d8}',
      '#cl-coach .cl-coach-list li:before{content:"\\2192";position:absolute;left:0;color:#c8a24b;font-weight:700}',
      '#cl-coach .cl-coach-list b{color:#fff;font-weight:650}',
      '#cl-coach .cl-coach-foot{margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1);',
      'display:flex;align-items:center;justify-content:space-between;gap:10px;color:#9ca3af;font-size:12px}',
      '#cl-coach .cl-coach-go{background:#c8a24b;color:#1a1306;border:0;border-radius:8px;padding:7px 14px;font-weight:650;cursor:pointer}',
      '#cl-coach .cl-coach-go:hover{background:#d8b65e}',
      // persistent "editable" hints on the REAL elements (faint, never shifts layout — outline only)
      'body.cl-hints-on [data-cl-for]{outline:1px dashed rgba(200,162,75,.45);outline-offset:2px;cursor:context-menu;transition:outline-color .12s ease}',
      'body.cl-hints-on [data-cl-for]:hover{outline-color:rgba(200,162,75,.95)}',
      // "highlight all editable" — strong, unmissable, on every editable element at once
      'body.cl-hl-on [data-cl-for]{outline:2px solid rgba(56,189,248,.95) !important;outline-offset:1px !important;background:rgba(56,189,248,.08) !important}',
      // toolbar button pressed state (matches existing .cl-tb look)
      '#cl-hl-btn[aria-pressed="true"],#cl-hints-btn[aria-pressed="true"]{background:#f4f4f5;color:#18181b;font-weight:600}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function start(CE) {
    injectStyle();
    var ui = CE.ui;
    var site = (location.host || 'this site');
    var KEY = 'cl-coach-dismissed:' + ((CE.config && CE.config.repurposeDir) || location.pathname);

    // ---------- persistent hints (default ON, only in Edit mode) ----------
    var hintsOn = true;
    function applyHints() { document.body.classList.toggle('cl-hints-on', hintsOn && CE.mode === 'edit'); }
    CE.on('modeChange', applyHints);

    // ---------- highlight-all (old "Audit", done right) ----------
    var highlightOn = false;
    function setHighlight(on) {
      highlightOn = !!on;
      document.body.classList.toggle('cl-hl-on', highlightOn && CE.mode === 'edit');
      markPressed('cl-hl-btn', highlightOn);
    }
    function toggleHighlight() { setHighlight(!highlightOn); }
    CE.on('modeChange', function () { if (CE.mode !== 'edit') { document.body.classList.remove('cl-hl-on'); } else if (highlightOn) document.body.classList.add('cl-hl-on'); });

    // ---------- toolbar buttons: ◍ Highlight · ✎ Hints · ? Help ----------
    function injectToolbarButtons() {
      var tb = ui.toolbar; if (!tb || document.getElementById('cl-help-btn')) return;
      var grp = document.createElement('div'); grp.className = 'cl-group';
      grp.appendChild(mkBtn('cl-hl-btn', '◍ Highlight', 'Show everything you can edit (Space)', toggleHighlight));
      grp.appendChild(mkBtn('cl-hints-btn', '✎ Hints', 'Faint marks on every editable element', function () { hintsOn = !hintsOn; applyHints(); markPressed('cl-hints-btn', hintsOn); }));
      grp.appendChild(mkBtn('cl-help-btn', '? Help', 'How to edit this page', openCard));
      tb.appendChild(grp);
      markPressed('cl-hints-btn', hintsOn);
    }
    function mkBtn(id, label, title, fn) {
      var b = document.createElement('button'); b.className = 'cl-tb'; b.id = id; b.textContent = label; b.title = title;
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      return b;
    }
    function markPressed(id, on) { var b = document.getElementById(id); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); }

    // ---------- welcome card ----------
    var card = null;
    function openCard() {
      if (card) { card.style.display = 'block'; return; }
      card = document.createElement('div'); card.id = 'cl-coach';
      card.innerHTML =
        '<div class="cl-coach-h"><strong>You’re editing ' + esc(site) + '</strong>' +
        '<button class="cl-coach-x" title="close" aria-label="close">×</button></div>' +
        '<ul class="cl-coach-list">' +
          '<li><b>Double-click any text</b> to rewrite it.</li>' +
          '<li><b>Click any image</b> → Replace.</li>' +
          '<li><b>Press Space</b> (or ◍ Highlight) to see everything you can edit.</li>' +
          '<li><b>Open Slots</b> (right panel) to hide or reorder sections.</li>' +
          '<li>Right-click anything for more · ⌘Z to undo.</li>' +
        '</ul>' +
        '<div class="cl-coach-foot"><span>You decide when to publish — nothing here blocks you.</span>' +
        '<button class="cl-coach-go">Got it</button></div>';
      ui.root.appendChild(card);
      card.querySelector('.cl-coach-x').addEventListener('click', dismiss);
      card.querySelector('.cl-coach-go').addEventListener('click', dismiss);
    }
    function dismiss() { if (card) card.style.display = 'none'; try { localStorage.setItem(KEY, '1'); } catch (e) {} }

    // ---------- keys: Space toggles highlight (when not typing) ----------
    document.addEventListener('keydown', function (e) {
      if (CE.isTyping && CE.isTyping(e)) return;
      if ((e.key === ' ' || e.code === 'Space') && CE.mode === 'edit') { e.preventDefault(); toggleHighlight(); }
    }, true);

    // ---------- boot ----------
    injectToolbarButtons();
    applyHints();
    var dismissed = false; try { dismissed = localStorage.getItem(KEY) === '1'; } catch (e) {}
    if (!dismissed) openCard();

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    CE.coach = { open: openCard, highlight: setHighlight, hints: function (on) { hintsOn = !!on; applyHints(); markPressed('cl-hints-btn', hintsOn); } };
    console.log('[clone] coach.js ready — welcome card, hints, highlight-all');
  }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
