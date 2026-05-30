/* clone-any-site — interactive editor (rewritten clean). ZERO deps, vanilla JS. Loopback-only.
 * Plugs into edit-map.js via window.__CloneEditor.
 *
 * Fixes the old corrupted editor.js:
 *  - text edits STICK (anchor resolve + MutationObserver re-apply in the kernel) and PROPAGATE to every
 *    same-content slot (groupId) so changing a word changes it everywhere.
 *  - media swap PRESERVES srcset (rebuilds from fit-slot output, never blind-removes) and correctly
 *    handles <img>, background, inline <svg>, icon/logo, and <video>+poster (no more 'SesVG' no-op).
 *  - drop-anywhere + paste-from-clipboard + paste-a-URL, plus a visible status on a degraded upload.
 *
 * Content-only: NEVER touches structure/layout/CSS (isolation contract).
 */
(function () {
  'use strict';
  function start(CE) {
    var originals = new Map(); // number -> { text?, src?, srcset?, sizes?, poster?, bg?, html? }

    function withApplying(fn) { window.__clApplying = true; try { return fn(); } finally { window.__clApplying = false; } }

    function directText(el) {
      var s = '';
      for (var i = 0; i < el.childNodes.length; i++) { if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue; }
      return s.replace(/\s+/g, ' ').trim();
    }
    function setDirectText(el, value) {
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = value; return; }
      }
      el.insertBefore(document.createTextNode(value), el.firstChild);
    }

    function snapshot(slot, el) {
      if (originals.has(slot.number)) return;
      var o = {};
      if (slot.type === 'text') o.text = slot.directOnly ? directText(el) : el.textContent;
      else if (slot.type === 'img' || slot.type === 'icon') { o.src = el.getAttribute('src'); o.srcset = el.getAttribute('srcset'); o.sizes = el.getAttribute('sizes'); }
      else if (slot.type === 'video') { o.poster = el.getAttribute('poster'); o.src = el.getAttribute('src'); o.html = el.innerHTML; }
      else if (slot.type === 'bg') o.bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
      else if (slot.type === 'svg') o.html = el.outerHTML;
      originals.set(slot.number, o);
    }

    function applyText(slot, el, value) {
      withApplying(function () { if (slot.directOnly) setDirectText(el, value); else el.textContent = value; });
    }
    function applyAsset(slot, el, repl) {
      var ref = '/' + String(repl.assetRef || '').replace(/^\//, '');
      withApplying(function () {
        if (slot.type === 'bg') { el.style.backgroundImage = 'url("' + ref + '")'; }
        else if (slot.type === 'video') { el.setAttribute('src', ref); if (repl.poster) el.setAttribute('poster', '/' + String(repl.poster).replace(/^\//, '')); try { el.load(); } catch (e) {} }
        else { // img / icon / logo / svg-as-img
          el.setAttribute('src', ref);
          if (repl.srcset) el.setAttribute('srcset', repl.srcset); // REBUILD — never blind-strip
          else el.removeAttribute('srcset');
        }
      });
    }

    // the reapplier the kernel's MutationObserver + before/after use
    CE.registerReapplier(function (slot, el) {
      if (!CE.showAfter) return;            // 'Before' view: leave original in place
      var r = slot.replacement; if (!r) return;
      if (r.kind === 'text') applyText(slot, el, r.value);
      else if (r.assetRef) applyAsset(slot, el, r);
    });

    // ---------- propagation: change-all-N when a slot is in a group ----------
    function propagateText(slot, value) {
      var group = slot.groupId && CE.entriesByGroup.get(slot.groupId);
      if (group && group.length > 1) {
        group.forEach(function (e) { applyText(e.slot, e.el, value); });   // optimistic DOM on every instance
        return CE.api.group({ groupId: slot.groupId, op: 'replace-text', value: value });
      }
      return CE.api.slot({ number: slot.number, op: 'replace-text', value: value });
    }

    // ---------- TEXT: inline edit (sticks + propagates) ----------
    function editText(slot, el) {
      if (el.getAttribute('contenteditable') === 'true') return;
      snapshot(slot, el);
      el.setAttribute('contenteditable', 'true');
      el.classList.add('cl-editing');
      el.focus();
      try { var rg = document.createRange(); rg.selectNodeContents(el); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); } catch (e) {}
      function commit(save) {
        el.removeAttribute('contenteditable'); el.classList.remove('cl-editing');
        el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur);
        var o = originals.get(slot.number) || {};
        if (!save) { withApplying(function () { if (slot.directOnly) setDirectText(el, o.text != null ? o.text : directText(el)); else el.textContent = o.text != null ? o.text : el.textContent; }); return; }
        var val = slot.directOnly ? directText(el) : el.textContent;
        if (slot.directOnly) withApplying(function () { setDirectText(el, val); }); // strip stray markup
        var groupN = (slot.groupId && CE.entriesByGroup.get(slot.groupId) || [slot]).length;
        propagateText(slot, val)
          .then(function () { CE.refreshManifest(); CE.ui.setStatus('#' + slot.number + ' saved' + (groupN > 1 ? ' (×' + groupN + ')' : '')); CE.emit('storeChange', { number: slot.number }); })
          .catch(function (e) { CE.ui.setStatus('save failed: ' + e.message); });
      }
      function onKey(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); } else if (ev.key === 'Escape') { commit(false); } }
      function onBlur() { commit(true); }
      el.addEventListener('keydown', onKey); el.addEventListener('blur', onBlur);
    }

    // ---------- MEDIA: drop / paste / url / file ----------
    function editMedia(slot, el) {
      snapshot(slot, el);
      var pop = CE.ui.pop;
      var accept = slot.type === 'video' ? 'video/*' : (slot.type === 'svg' ? 'image/svg+xml,image/*' : 'image/*');
      pop.innerHTML =
        '<h4>#' + slot.number + ' — replace ' + slot.type + '</h4>' +
        '<div id="cl-drop">Drop a file, paste, or click<br><small>keeps the exact slot size + responsiveness</small><input type="file" accept="' + accept + '" style="display:none"></div>' +
        '<div class="cl-urlrow"><input type="url" id="cl-url" placeholder="…or paste an image/video URL"><button data-act="url">use URL</button></div>' +
        '<div class="cl-err"></div>' +
        '<div class="cl-actions"><button class="cl-ghost" data-act="cancel">cancel</button><button data-act="keep">keep original</button></div>';
      var rect = el.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - 320)) + 'px';
      pop.style.top = Math.max(8, Math.min(rect.top + 20, innerHeight - 240)) + 'px';
      pop.classList.add('cl-open');
      var drop = pop.querySelector('#cl-drop');
      var input = pop.querySelector('input[type=file]');
      var urlInput = pop.querySelector('#cl-url');
      var err = pop.querySelector('.cl-err');
      drop.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0]); });
      ['dragenter', 'dragover'].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('cl-hot'); }); });
      ['dragleave', 'drop'].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('cl-hot'); }); });
      drop.addEventListener('drop', function (ev) { var f = ev.dataTransfer.files[0]; if (f) handleFile(f); });
      pop.addEventListener('paste', function (ev) {
        var items = ev.clipboardData && ev.clipboardData.files; if (items && items[0]) { handleFile(items[0]); return; }
        var txt = ev.clipboardData && ev.clipboardData.getData('text'); if (txt && /^https?:\/\//.test(txt)) { urlInput.value = txt; fromUrl(txt); }
      });
      pop.querySelector('[data-act="url"]').addEventListener('click', function () { if (urlInput.value) fromUrl(urlInput.value); });
      pop.querySelector('[data-act="cancel"]').addEventListener('click', closePop);
      pop.querySelector('[data-act="keep"]').addEventListener('click', function () { CE.api.slot({ number: slot.number, op: 'keep' }).then(function () { CE.refreshManifest(); CE.emit('storeChange', {}); }); closePop(); });

      function fromUrl(u) {
        err.style.display = 'none'; drop.innerHTML = 'fetching …';
        fetch(u).then(function (r) { return r.blob(); }).then(function (b) { handleFile(new File([b], (u.split('/').pop() || 'asset'), { type: b.type })); })
          .catch(function (e) { showErr('URL fetch failed: ' + e.message); });
      }
      function handleFile(file) {
        err.style.display = 'none';
        drop.innerHTML = 'uploading ' + file.name + ' …';
        var reader = new FileReader();
        reader.onload = function () {
          var b64 = String(reader.result).split(',')[1];
          CE.api.upload({ number: slot.number, filename: file.name, mime: file.type, dataBase64: b64 })
            .then(function (res) {
              if (res.degraded) CE.ui.setStatus('⚠ ' + slot.type + ' not resized (install sharp/ffmpeg) — using native file');
              var payload = { number: slot.number, op: 'replace-asset', assetRef: res.assetRef, srcset: srcsetFrom(res), srcsetHtml: res.srcsetHtml, poster: posterFrom(res) };
              return CE.api.slot(payload).then(function () { return res; });
            })
            .then(function (res) {
              applyAsset(slot, el, { assetRef: res.assetRef, srcset: srcsetFrom(res), poster: posterFrom(res) });
              CE.refreshManifest(); CE.scheduleLayout(); CE.ui.setStatus('#' + slot.number + ' swapped' + (res.degraded ? ' (degraded)' : ''));
              CE.emit('storeChange', { number: slot.number });
              closePop();
            })
            .catch(function (e) { showErr('upload failed: ' + e.message); });
        };
        reader.readAsDataURL(file);
      }
      function showErr(m) { err.textContent = m; err.style.display = 'block'; drop.innerHTML = 'Drop a file, paste, or click<br><small>try again</small>'; }
    }
    function srcsetFrom(res) {
      if (res.srcset) return res.srcset;
      if (Array.isArray(res.variants) && res.variants.length) return res.variants.map(function (v) { return '/' + String(v.ref || v).replace(/^\//, '') + (v.w ? ' ' + v.w + 'w' : ''); }).join(', ');
      return '';
    }
    function posterFrom(res) { if (res.poster) return res.poster; var g = (res.generated || []).find(function (x) { return /poster/i.test(x); }); return g || ''; }

    function closePop() { CE.ui.pop.classList.remove('cl-open'); CE.ui.pop.innerHTML = ''; }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

    // ---------- before/after ----------
    CE.on('beforeAfter', function (after) {
      CE.entries.forEach(function (entry) {
        var slot = entry.slot, el = entry.el, o = originals.get(slot.number);
        if (!slot.replacement && !o) return;
        if (after) { if (slot.replacement) CE.reapply(slot, el); }
        else if (o) withApplying(function () {
          if (o.text != null) { if (slot.directOnly) setDirectText(el, o.text); else el.textContent = o.text; }
          else if (o.src != null && slot.type !== 'video') { el.setAttribute('src', o.src); if (o.srcset) el.setAttribute('srcset', o.srcset); else el.removeAttribute('srcset'); if (o.sizes) el.setAttribute('sizes', o.sizes); }
          else if (o.bg != null) el.style.backgroundImage = o.bg;
          else if (o.poster != null) { el.setAttribute('poster', o.poster); if (o.src) el.setAttribute('src', o.src); }
        });
      });
    });

    // ---------- wire dblclick onto each badged element ----------
    CE.registerInteractor(function (ctx) {
      var slot = ctx.slot, el = ctx.el;
      el.addEventListener('dblclick', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        CE.selectSlot(slot.number);
        if (slot.type === 'text') editText(slot, el);
        else if (CE.TYPE_SWAPPABLE_MEDIA[slot.type]) editMedia(slot, el);
      });
      el.style.cursor = el.style.cursor || 'pointer';
      el.setAttribute('title', '#' + slot.number + ' — double-click to ' + (slot.type === 'text' ? 'edit text' : 'replace ' + slot.type) + (slot.groupId ? ' (changes all matching)' : ''));
    });

    // expose so panel.js + palette.js can drive the same flows
    CE.editText = editText; CE.editMedia = editMedia; CE.originals = originals;

    // On (re)load, paint every saved replacement onto the live DOM so edits STICK across reloads.
    try { CE.reapplyAll(); } catch (e) {}

    console.log('[clone] interactive editor armed — text sticks + propagates, media srcset-safe');
  }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
