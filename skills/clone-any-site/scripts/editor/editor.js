/* clone-any-site — interactive editor (Wave 3). ZERO deps, vanilla JS. Loopback-only.
 * Plugs into edit-map.js via window.__CloneEditor.registerInteractor.
 *
 * Headline UX (user-promoted to v1):
 *  - double-click a TEXT slot  -> inline contentEditable -> POST /__clone/slot {op:replace-text}
 *  - double-click an IMAGE/illustration/photo/video/svg slot -> drop-zone popover (file picker + drag-drop)
 *       -> POST /__clone/upload (base64) -> fit-slot -> POST /__clone/slot {op:replace-asset} -> live swap
 *  - manual mode (toolbar "Manual"): page stays fully interactive; double-click still edits. Content-only —
 *    NEVER touches structure/layout/CSS (isolation contract).
 *  - before/after toggle: swaps each slot between your replacement and the original, in place.
 */
(function () {
  'use strict';
  function start(CE) {
    var originals = new Map(); // number -> { text?, src?, srcset?, bg?, poster? }

    function snapshot(slot, el) {
      if (originals.has(slot.number)) return;
      var o = {};
      if (slot.type === 'text') o.text = el.textContent;
      else if (slot.type === 'img' || slot.type === 'icon') { o.src = el.getAttribute('src'); o.srcset = el.getAttribute('srcset'); }
      else if (slot.type === 'video') { o.poster = el.getAttribute('poster'); o.html = el.innerHTML; }
      else if (slot.type === 'bg') o.bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
      else if (slot.type === 'svg') o.html = el.outerHTML;
      originals.set(slot.number, o);
    }

    function applyAsset(slot, el, ref) {
      if (slot.type === 'bg') el.style.backgroundImage = 'url("' + ref + '")';
      else if (slot.type === 'video') { el.setAttribute('src', ref); try { el.load(); } catch (e) {} }
      else { el.setAttribute('src', ref); el.removeAttribute('srcset'); } // swapped asset = single source
    }

    // ---------- TEXT: inline edit ----------
    function editText(slot, el) {
      if (el.getAttribute('contenteditable') === 'true') return;
      snapshot(slot, el);
      el.setAttribute('contenteditable', 'true');
      el.classList.add('cl-editing');
      el.focus();
      try { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
      function commit(save) {
        el.removeAttribute('contenteditable'); el.classList.remove('cl-editing');
        el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur);
        if (!save) { el.textContent = (originals.get(slot.number) || {}).text != null ? originals.get(slot.number).text : el.textContent; return; }
        var val = el.textContent;
        CE.api.slot({ number: slot.number, op: 'replace-text', value: val })
          .then(function () { CE.refreshManifest(); CE.ui.setStatus('#' + slot.number + ' text saved'); })
          .catch(function (e) { CE.ui.setStatus('save failed: ' + e.message); });
      }
      function onKey(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); } else if (ev.key === 'Escape') { commit(false); } }
      function onBlur() { commit(true); }
      el.addEventListener('keydown', onKey); el.addEventListener('blur', onBlur);
    }

    // ---------- MEDIA: drop-zone popover ----------
    function editMedia(slot, el) {
      snapshot(slot, el);
      var pop = CE.ui.pop;
      var accept = slot.type === 'video' ? 'video/*' : (slot.type === 'svg' ? 'image/svg+xml,image/*' : 'image/*');
      pop.innerHTML =
        '<h4>#' + slot.number + ' — replace ' + slot.type + '</h4>' +
        '<div id="cl-drop">Drop a file here<br><small>or click to choose</small><input type="file" accept="' + accept + '" style="display:none"></div>' +
        '<div class="cl-err"></div>' +
        '<div class="cl-actions"><button class="cl-ghost" data-act="cancel">cancel</button><button data-act="keep">keep original</button></div>';
      var rect = el.getBoundingClientRect();
      pop.style.left = Math.min(rect.left, innerWidth - 300) + 'px';
      pop.style.top = Math.min(rect.top + 20, innerHeight - 200) + 'px';
      pop.classList.add('cl-open');
      var drop = pop.querySelector('#cl-drop');
      var input = pop.querySelector('input');
      var err = pop.querySelector('.cl-err');
      drop.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0]); });
      ['dragenter', 'dragover'].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('cl-hot'); }); });
      ['dragleave', 'drop'].forEach(function (e) { drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('cl-hot'); }); });
      drop.addEventListener('drop', function (ev) { var f = ev.dataTransfer.files[0]; if (f) handleFile(f); });
      pop.querySelector('[data-act="cancel"]').addEventListener('click', closePop);
      pop.querySelector('[data-act="keep"]').addEventListener('click', function () { CE.api.slot({ number: slot.number, op: 'keep' }).then(function () { CE.refreshManifest(); }); closePop(); });

      function handleFile(file) {
        err.style.display = 'none';
        drop.innerHTML = 'uploading ' + file.name + ' …';
        var reader = new FileReader();
        reader.onload = function () {
          var b64 = String(reader.result).split(',')[1];
          CE.api.upload({ number: slot.number, filename: file.name, mime: file.type, dataBase64: b64 })
            .then(function (res) {
              return CE.api.slot({ number: slot.number, op: 'replace-asset', assetRef: res.assetRef }).then(function () { return res; });
            })
            .then(function (res) {
              applyAsset(slot, el, res.assetRef);
              CE.refreshManifest(); CE.scheduleLayout(); CE.ui.setStatus('#' + slot.number + ' asset swapped');
              closePop();
            })
            .catch(function (e) { err.textContent = 'upload failed: ' + e.message; err.style.display = 'block'; drop.innerHTML = 'Drop a file here<br><small>or click to choose</small>'; });
        };
        reader.readAsDataURL(file);
      }
    }
    function closePop() { CE.ui.pop.classList.remove('cl-open'); CE.ui.pop.innerHTML = ''; }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

    // ---------- before/after ----------
    CE.on('beforeAfter', function (after) {
      CE.entries.forEach(function (entry) {
        var slot = entry.slot, el = entry.el, o = originals.get(slot.number);
        if (!slot.replacement && !o) return;
        if (after) { // show replacement
          if (slot.replacement) {
            if (slot.type === 'text') el.textContent = slot.replacement.value;
            else if (slot.replacement.assetRef) applyAsset(slot, el, slot.replacement.assetRef);
          }
        } else if (o) { // show original
          if (o.text != null) el.textContent = o.text;
          else if (o.src != null) { el.setAttribute('src', o.src); if (o.srcset) el.setAttribute('srcset', o.srcset); }
          else if (o.bg != null) el.style.backgroundImage = o.bg;
          else if (o.poster != null) el.setAttribute('poster', o.poster);
        }
      });
    });

    // ---------- wire interactions onto each badged element ----------
    CE.registerInteractor(function (ctx) {
      var slot = ctx.slot, el = ctx.el;
      el.addEventListener('dblclick', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        CE.selectSlot(slot.number);
        if (slot.type === 'text') editText(slot, el);
        else if (CE.TYPE_SWAPPABLE_MEDIA[slot.type]) editMedia(slot, el);
      });
      // affordance: show it's editable
      el.style.cursor = el.style.cursor || 'pointer';
      el.setAttribute('title', '#' + slot.number + ' — double-click to ' + (slot.type === 'text' ? 'edit text' : 'replace ' + slot.type));
    });

    console.log('[clone] interactive editor armed (double-click to edit · drag-drop to import)');
  }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
