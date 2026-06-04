/* clone-any-site — interactive editor (v2). ZERO deps, vanilla JS. Loopback-only.
 * Plugs into edit-map.js via window.__CloneEditor (the kernel: store + api + ring + toast + history + hitTest).
 *
 * v2 fixes Hossam's real complaints:
 *  - IMAGE IMPORT NO LONGER GOES BLACK. applyAsset is now SHAPE-AWARE: a <picture>'s sibling <source>s are
 *    rebuilt from fit-slot's authoritative srcsetHtml (the old code only set <img src> so the stale <source>
 *    kept winning → black). <video><source>, inline <svg>, css-bg and css-gradient each get the right path.
 *  - NO-BLACK GUARANTEE: an interactive swap is decoded OFFSCREEN (new Image()+decode()) BEFORE the DOM is
 *    touched; on failure the original stays and a real error toast shows. (Reload/reapply paints directly —
 *    it's restoring already-validated state.)
 *  - VISIBLE FEEDBACK: every action routes through ui.toast / ui.saving (no more invisible tooltip status).
 *  - UNDO/REDO: text + media + keep/reset are wrapped as history commands (Cmd-Z / Cmd-Shift-Z).
 *  - Text still STICKS across reload + PROPAGATES to every same-content (groupId) instance.
 *
 * Content-only: NEVER touches structure/layout/CSS (isolation contract). Selection / hover / context menu live
 * in select.js + menu.js, which call CE.editText / CE.editMedia / CE.keepSlot / CE.resetSlot exposed here.
 */
(function () {
  'use strict';

  // ---------- pure helpers (no CE needed) ----------
  function normUrl(r) { return '/' + String(r == null ? '' : r).replace(/^\//, ''); }
  function parseHtml(html) { if (!html) return null; var t = document.createElement('template'); t.innerHTML = String(html); return t.content.firstElementChild; }
  function clearStaleImg(img) { img.removeAttribute('data-src'); img.removeAttribute('data-srcset'); }
  function widthOf(p) { var m = /[._-](\d{2,4})w?\.(?:webp|avif|jpe?g|png)$/i.exec(String(p)) || /\.(\d{2,4})\./.exec(String(p)); return m ? +m[1] : 0; }
  function srcsetFromGenerated(gen) {
    // A flat `<img srcset>` has no per-source type negotiation, so mixing avif+webp as equal width candidates
    // is malformed (the browser would pick by width alone). Pick ONE raster format — prefer webp, else the
    // first available — and emit width descriptors only. (The <picture> path uses srcsetHtml for art-direction.)
    if (!Array.isArray(gen) || !gen.length) return '';
    var raster = gen.filter(function (g) { return /\.(webp|avif|jpe?g|png)$/i.test(String(g && g.ref || g)); });
    if (!raster.length) return '';
    var webp = raster.filter(function (g) { return /\.webp$/i.test(String(g && g.ref || g)); });
    var pick = webp.length ? webp : (function () { var ext = (/\.([a-z0-9]+)$/i.exec(String(raster[0] && raster[0].ref || raster[0])) || [])[1]; return raster.filter(function (g) { return new RegExp('\\.' + ext + '$', 'i').test(String(g && g.ref || g)); }); })();
    return pick.map(function (g) { var ref = normUrl(g && g.ref || g); var w = (g && g.w) || widthOf(g && g.ref || g); return ref + (w ? ' ' + w + 'w' : ''); }).join(', ');
  }
  function slotSizes(slot) { return slot && slot.srcsetSpec && slot.srcsetSpec.sizes; }
  function splitTopLevel(s) { var out = [], depth = 0, cur = ''; for (var i = 0; i < s.length; i++) { var c = s[i]; if (c === '(') depth++; else if (c === ')') depth--; if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur); return out; }
  function replaceFirstUrlLayer(css, newUrl) {
    if (!css || css === 'none') return newUrl;
    var parts = splitTopLevel(css), done = false;
    var out = parts.map(function (p) { if (!done && /url\(/i.test(p)) { done = true; return p.replace(/url\([^)]*\)/i, newUrl); } return p; });
    return done ? out.join(',') : newUrl;
  }
  function makeImg(ref) { var i = document.createElement('img'); i.setAttribute('src', ref); i.setAttribute('alt', ''); return i; }
  function copyBox(from, to) { var r = from.getBoundingClientRect(); if (r.width) to.style.width = Math.round(r.width) + 'px'; if (r.height) to.style.height = Math.round(r.height) + 'px'; }
  function posterFrom(res) { var n = parseHtml(res.srcsetHtml); if (n) { var v = n.tagName === 'VIDEO' ? n : n.querySelector('video'); if (v && v.getAttribute('poster')) return v.getAttribute('poster'); } return res.poster || ''; }
  function fallbackUrlFrom(repl) { var n = parseHtml(repl.srcsetHtml); if (n) { var img = n.tagName === 'IMG' ? n : n.querySelector('img'); if (img && img.getAttribute('src')) return normUrl(img.getAttribute('src')); } return normUrl(repl.assetRef); }
  function capSources(parent) { return Array.prototype.map.call(parent.querySelectorAll('source'), function (s) { return { srcset: s.getAttribute('srcset'), type: s.getAttribute('type'), media: s.getAttribute('media'), sizes: s.getAttribute('sizes'), src: s.getAttribute('src') }; }); }
  function mkSource(spec) { var s = document.createElement('source'); ['srcset', 'type', 'media', 'sizes', 'src'].forEach(function (k) { if (spec[k]) s.setAttribute(k, spec[k]); }); return s; }

  function start(CE) {
    var originals = new Map(); // number -> snapshot of pristine content

    function withApplying(fn) { window.__clApplying = true; try { return fn(); } finally { window.__clApplying = false; } }

    function directText(el) { var s = ''; for (var i = 0; i < el.childNodes.length; i++) { if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue; } return s.replace(/\s+/g, ' ').trim(); }
    function setDirectText(el, value) {
      for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = value; return; } }
      el.insertBefore(document.createTextNode(value), el.firstChild);
    }

    function entryRebind(slot, newEl) {
      var e = CE.entries.get(slot.number); if (e) e.el = newEl;
      var grp = slot.groupId && CE.entriesByGroup.get(slot.groupId);
      if (grp) grp.forEach(function (x) { if (x.slot.number === slot.number) x.el = newEl; });
    }
    function elFor(slot) { return CE.resolveEl(slot) || (CE.entries.get(slot.number) || {}).el; }
    // the element whose href a link edit targets: the slot's own <a>, else the nearest ancestor <a> — preferring
    // one that actually HAS an href (matches extract-manifest's closest('a[href]') so editor/build/extract all
    // agree; otherwise a hrefless inner <a> could capture the edit while the visible outer <a> keeps the original).
    function hrefTarget(el) { if (!el) return null; if (el.tagName === 'A') return el; return (el.closest && (el.closest('a[href]') || el.closest('a'))) || el; }

    // ---------- snapshot the pristine state (once per slot, before the first edit) ----------
    function snapshot(slot, el) {
      if (originals.has(slot.number)) return;
      var o = {};
      if (slot.type === 'text') {
        o.text = slot.directOnly ? directText(el) : el.textContent;
        var ht = hrefTarget(el);
        // record the anchor's href (null if it had none) so undo of a link edit can REMOVE an added href,
        // not just overwrite it. Only for anchor-bearing slots; plain text leaves o.href undefined.
        if (ht && ht.tagName === 'A') o.href = ht.hasAttribute('href') ? ht.getAttribute('href') : null;
      }
      else if (slot.type === 'svg') o.svgHTML = el.outerHTML;
      else if (slot.type === 'bg') o.bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
      else if (slot.type === 'video') { o.videoSources = capSources(el); o.poster = el.getAttribute('poster'); o.src = el.getAttribute('src'); }
      else { // img / icon
        var pic = el.parentElement;
        if (pic && pic.tagName === 'PICTURE') o.pictureSources = capSources(pic);
        o.src = el.getAttribute('src'); o.srcset = el.getAttribute('srcset'); o.sizes = el.getAttribute('sizes');
        var im0 = (el.tagName === 'IMG') ? el : (el.querySelector && el.querySelector('img'));
        if (im0) o.alt = im0.getAttribute('alt');   // capture original alt so reset can restore it live
      }
      originals.set(slot.number, o);
    }

    // ---------- TEXT paint ----------
    function applyText(slot, el, value) { withApplying(function () { if (slot.directOnly) setDirectText(el, value); else el.textContent = value; }); }

    // ---------- shape-aware ASSET paint (the black-screen fix) ----------
    function applyAsset(slot, el, repl) {
      var ref = normUrl(repl.assetRef);
      var node = parseHtml(repl.srcsetHtml);
      var gen = repl.generated || [];
      var sub = slot.subtype || (slot.srcsetSpec && slot.srcsetSpec.kind) || '';
      withApplying(function () {
        if (slot.type === 'bg') return applyBg(el, ref);
        if (slot.type === 'video') return applyVideo(el, ref, node, repl);
        if (slot.type === 'svg' || sub === 'inline-svg' || (el.tagName && el.tagName.toLowerCase() === 'svg')) return applySvg(slot, el, ref, node);
        var pic = el.parentElement;
        if (sub === 'picture' || (pic && pic.tagName === 'PICTURE')) return applyPicture(el, ref, node);
        return applyPlainImg(slot, el, ref, node, repl, gen);
      });
    }
    function applyPlainImg(slot, el, ref, node, repl, gen) {
      clearStaleImg(el); el.removeAttribute('srcset');
      var ss = (node && node.tagName === 'IMG' && node.getAttribute('srcset')) || repl.srcset || srcsetFromGenerated(gen) || '';
      if (ss) { el.setAttribute('srcset', ss); el.setAttribute('sizes', (node && node.getAttribute('sizes')) || slotSizes(slot) || '100vw'); }
      else el.removeAttribute('sizes');
      el.setAttribute('src', ref);
      el.setAttribute('loading', 'eager'); el.setAttribute('decoding', 'sync');
    }
    function applyPicture(el, ref, node) {
      var pic = el.parentElement;
      if (!pic || pic.tagName !== 'PICTURE') { return applyPlainImg({}, el, ref, node, {}, []); }
      // remove EVERY stale <source> (these were winning over the new <img> → the black bug)
      Array.prototype.slice.call(pic.querySelectorAll('source')).forEach(function (s) { s.remove(); });
      if (node && node.tagName === 'PICTURE') {
        Array.prototype.forEach.call(node.querySelectorAll('source'), function (s) { pic.insertBefore(s.cloneNode(true), el); });
        var fImg = node.querySelector('img');
        el.removeAttribute('srcset'); el.removeAttribute('sizes');
        el.setAttribute('src', fImg ? normUrl(fImg.getAttribute('src')) : ref);
      } else { el.removeAttribute('srcset'); el.removeAttribute('sizes'); el.setAttribute('src', ref); }
      clearStaleImg(el); el.setAttribute('loading', 'eager'); el.setAttribute('decoding', 'sync');
    }
    function applyVideo(el, ref, node, repl) {
      Array.prototype.slice.call(el.querySelectorAll('source')).forEach(function (s) { s.remove(); });
      el.removeAttribute('src');
      if (node && node.tagName === 'VIDEO') {
        Array.prototype.forEach.call(node.querySelectorAll('source'), function (s) { el.appendChild(s.cloneNode(true)); });
        var p = node.getAttribute('poster'); if (p) el.setAttribute('poster', normUrl(p));
      } else { el.setAttribute('src', ref); }
      if (repl.poster) el.setAttribute('poster', normUrl(repl.poster));
      try { el.load(); } catch (e) {}
    }
    function applySvg(slot, el, ref, node) {
      var img = (node && node.tagName === 'IMG') ? node.cloneNode(true) : makeImg(ref);
      if (!img.getAttribute('src')) img.setAttribute('src', ref);
      var cls = el.getAttribute('class'); if (cls) img.setAttribute('class', cls);
      var st = el.getAttribute('style'); if (st) img.setAttribute('style', st);
      copyBox(el, img);
      var id = el.getAttribute('data-cl-id'); if (id) img.setAttribute('data-cl-id', id);
      var f = el.getAttribute('data-cl-for'); if (f) img.setAttribute('data-cl-for', f);
      el.replaceWith(img); entryRebind(slot, img);
    }
    function applyBg(el, ref) {
      var prev = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
      el.style.backgroundImage = replaceFirstUrlLayer(prev, 'url("' + ref + '")');
    }

    // ---------- restore the pristine state from snapshot (revert / Before / undo-to-original) ----------
    function restoreOriginal(slot, el) {
      var o = originals.get(slot.number); if (!o || !el) return;
      withApplying(function () {
        if (o.href !== undefined) { var ht = hrefTarget(el); if (ht) { if (o.href != null) ht.setAttribute('href', o.href); else ht.removeAttribute('href'); } }  // restore original link target (on the wrapping anchor)
        if (o.text != null) { if (slot.directOnly) setDirectText(el, o.text); else el.textContent = o.text; }
        else if (o.svgHTML != null) { var n = parseHtml(o.svgHTML); if (n) { el.replaceWith(n); entryRebind(slot, n); } }
        else if (o.pictureSources != null) { restorePicture(el, o); }
        else if (o.videoSources != null) { restoreVideo(el, o); }
        else if (slot.type === 'section') { el.style.display = ''; }   // un-hide a section on reset/Before (falls back to stylesheet)
        else if (o.bg != null) { el.style.backgroundImage = o.bg; }
        else if (o.src != null || o.srcset != null) { // a responsive <img> may have ONLY srcset (no src) — still restore it
          if (o.src != null) el.setAttribute('src', o.src); else el.removeAttribute('src'); // clear the swapped src if the original had none
          if (o.srcset) el.setAttribute('srcset', o.srcset); else el.removeAttribute('srcset');
          if (o.sizes) el.setAttribute('sizes', o.sizes); else el.removeAttribute('sizes');
        }
        // restore original alt (reset undoes an alt edit live, not just in the manifest)
        if (o.alt !== undefined) { var im = (el.tagName === 'IMG') ? el : (el.querySelector && el.querySelector('img')); if (im) { if (o.alt != null) im.setAttribute('alt', o.alt); else im.removeAttribute('alt'); } }
      });
    }
    function restorePicture(el, o) {
      var pic = el.parentElement; if (!pic) return;
      Array.prototype.slice.call(pic.querySelectorAll('source')).forEach(function (s) { s.remove(); });
      o.pictureSources.forEach(function (spec) { pic.insertBefore(mkSource(spec), el); });
      if (o.src) el.setAttribute('src', o.src); else el.removeAttribute('src'); // clear stale swapped fallback src if the original had none
      if (o.srcset) el.setAttribute('srcset', o.srcset); else el.removeAttribute('srcset');
      if (o.sizes) el.setAttribute('sizes', o.sizes); else el.removeAttribute('sizes');
    }
    function restoreVideo(el, o) {
      Array.prototype.slice.call(el.querySelectorAll('source')).forEach(function (s) { s.remove(); });
      o.videoSources.forEach(function (spec) { el.appendChild(mkSource(spec)); });
      if (o.poster) el.setAttribute('poster', o.poster); else el.removeAttribute('poster');
      if (o.src) el.setAttribute('src', o.src); else el.removeAttribute('src');
      try { el.load(); } catch (e) {}
    }

    // ---------- NO-BLACK: decode offscreen BEFORE swapping (interactive path only) ----------
    function preflight(slot, repl) {
      if (slot.type === 'video') return probeVideo(repl);
      var url = fallbackUrlFrom(repl);
      return new Promise(function (res, rej) {
        var probe = new Image();
        probe.onload = function () {
          // decode() surfaces post-load corruption (truncated / zero-dimension / oversized). A decode REJECT
          // must FAIL preflight (no-black guarantee) — but some browsers reject decode() spuriously on images
          // that did load with real pixels, so fall back to naturalWidth before declaring it broken.
          var ok = function () { res(); };
          var bad = function () { if (probe.naturalWidth > 0) res(); else rej(new Error('image decoded to zero dimensions')); };
          if (probe.decode) probe.decode().then(ok, bad); else ok();
        };
        probe.onerror = function () { rej(new Error('image load failed')); };
        probe.src = url;
      });
    }
    function probeVideo(repl) {
      if (!repl.poster) return Promise.resolve();
      return new Promise(function (res) { var p = new Image(); p.onload = function () { res(); }; p.onerror = function () { res(); }; p.src = normUrl(repl.poster); });
    }
    function swapAsset(slot, el, repl) {
      return preflight(slot, repl)
        .then(function () { applyAsset(slot, el, repl); CE.scheduleLayout(); return true; })
        .catch(function (err) { CE.ui.toast('Swap failed (' + err.message + ') — kept original', 'error'); throw err; });
    }

    // the reapplier the kernel's MutationObserver + reapplyAll + Before/After use.
    // Direct paint (no preflight): it restores ALREADY-validated persisted state on (re)load.
    CE.registerReapplier(function (slot, el) {
      if (!CE.showAfter) return;                 // 'Before' view: leave original in place
      // section hidden survives reload (drop a whole section, reversible — display only, no structural change)
      if (slot.section && slot.section.hidden) withApplying(function () { el.style.display = 'none'; });
      // alt override survives reload even with no content replacement (img a11y/SEO edit)
      if (slot.altReplacement != null) { var im = (el.tagName === 'IMG') ? el : (el.querySelector && el.querySelector('img')); if (im) withApplying(function () { im.setAttribute('alt', slot.altReplacement); }); }
      var r = slot.replacement; if (!r) return;
      if (r.kind === 'text' || r.kind === 'link') {
        if (r.value != null) applyText(slot, el, r.value);
        if (r.href != null) withApplying(function () { var ht = hrefTarget(el); if (ht) ht.setAttribute('href', r.href); });
      } else if (r.assetRef) applyAsset(slot, el, r);
    });

    // ---------- manifest state helpers ----------
    function currentReplacement(slot) { var e = CE.entries.get(slot.number); var r = e && e.slot && e.slot.replacement; return r ? JSON.parse(JSON.stringify(r)) : null; }
    function groupMembers(slot) { return (slot.groupId && CE.entriesByGroup.get(slot.groupId)) || null; }

    // ---------- persist + paint primitives (return a promise; manage the saving chip) ----------
    function persistText(slot, value) {
      CE.ui.saving('saving');
      var grp = groupMembers(slot);
      if (grp && grp.length > 1) grp.forEach(function (e) { applyText(e.slot, e.el, value); });
      else { var el = elFor(slot); if (el) applyText(slot, el, value); }
      var req = (grp && grp.length > 1) ? CE.api.group({ groupId: slot.groupId, op: 'replace-text', value: value })
        : CE.api.slot({ number: slot.number, op: 'replace-text', value: value });
      return req.then(function () { return CE.refreshManifest(); }).then(function () { CE.ui.saving('saved'); CE.emit('storeChange', { number: slot.number }); })
        .catch(function (e) { CE.ui.saving('error'); CE.ui.toast('save failed: ' + e.message, 'error'); throw e; });
    }
    // apply ANY replacement state (text / asset / null=clear) — the do/undo primitive. Group-aware: a media
    // slot in a group propagates to EVERY member (change-all-N), symmetric to persistText. NOTE: every member
    // receives the SAME asset (the one fit to the clicked slot's spec); fine for repeated logos/cards of equal
    // size, which is what same-content grouping detects.
    function applyReplacement(slot, repl, interactive) {
      var el = elFor(slot);
      var grp = groupMembers(slot);
      var isGroup = !!(grp && grp.length > 1);

      if (repl == null) { // clear / undo-to-original
        CE.ui.saving('saving');
        var clearReq = isGroup ? CE.api.group({ groupId: slot.groupId, op: 'clear' }) : CE.api.slot({ number: slot.number, op: 'clear' });
        return clearReq.then(function () { (isGroup ? grp : [{ slot: slot, el: el }]).forEach(function (e) { restoreOriginal(e.slot, e.el || elFor(e.slot)); }); return CE.refreshManifest(); })
          .then(function () { CE.ui.saving('saved'); CE.scheduleLayout(); CE.emit('storeChange', { number: slot.number }); })
          .catch(function (e) { CE.ui.saving('error'); throw e; });
      }
      if (repl.kind === 'text' || repl.kind === 'link') {
        // restore/apply text value and/or href together (so undo of a link edit also restores the right href)
        if (repl.href === undefined && repl.kind === 'text') return persistText(slot, repl.value);
        CE.ui.saving('saving');
        if (el) withApplying(function () { if (repl.value != null) applyText(slot, el, repl.value); var ht = hrefTarget(el); if (ht) { if (repl.href != null) ht.setAttribute('href', repl.href); else ht.removeAttribute('href'); } });
        var lbody = (repl.value != null) ? { op: 'replace-text', value: repl.value, href: (repl.href == null ? '' : repl.href) } : { op: 'set-href', href: (repl.href == null ? '' : repl.href) };
        return CE.api.slot(Object.assign({ number: slot.number }, lbody))
          .then(function () { return CE.refreshManifest(); })
          .then(function () { CE.ui.saving('saved'); CE.emit('storeChange', { number: slot.number }); })
          .catch(function (e) { CE.ui.saving('error'); throw e; });
      }

      // asset — PREFLIGHT/PAINT BEFORE PERSIST: an interactive swap decodes offscreen first, so a broken
      // asset REJECTS before it is written to the manifest (otherwise reapplyAll would paint it, with no
      // preflight, on the next reload — the UI would say 'kept original' yet reload shows black). The
      // non-interactive path (reload/undo) restores already-validated state, so it paints directly.
      CE.ui.saving('saving');
      var assetBody = { op: 'replace-asset', assetRef: repl.assetRef, srcset: repl.srcset, srcsetHtml: repl.srcsetHtml, poster: repl.poster, generated: repl.generated };
      function persistAsset() { return isGroup ? CE.api.group(Object.assign({ groupId: slot.groupId }, assetBody)) : CE.api.slot(Object.assign({ number: slot.number }, assetBody)); }
      function paintAll() { if (isGroup) grp.forEach(function (e) { applyAsset(e.slot, e.el || elFor(e.slot), repl); }); }
      // decode once on the clicked element (interactive), then propagate the validated asset to the rest
      var painted = interactive ? swapAsset(slot, elFor(slot), repl).then(paintAll) : Promise.resolve().then(function () { applyAsset(slot, elFor(slot), repl); paintAll(); });
      return painted
        .then(persistAsset)
        .then(function () { return CE.refreshManifest(); })
        .then(function () { CE.ui.saving('saved'); CE.scheduleLayout(); CE.emit('storeChange', { number: slot.number }); })
        .catch(function (e) { CE.ui.saving('error'); throw e; });
    }

    // ---------- TEXT: inline edit (sticks + propagates + undoable) ----------
    function editText(slot, el) {
      el = el || elFor(slot); if (!el) return;
      if (el.getAttribute('contenteditable') === 'true') return;
      snapshot(slot, el);
      el.setAttribute('contenteditable', 'true'); el.classList.add('cl-editing'); el.focus();
      try { var rg = document.createRange(); rg.selectNodeContents(el); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); } catch (e) {}
      function commit(save) {
        el.removeAttribute('contenteditable'); el.classList.remove('cl-editing');
        el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur);
        var o = originals.get(slot.number) || {};
        if (!save) { withApplying(function () { if (slot.directOnly) setDirectText(el, o.text != null ? o.text : directText(el)); else el.textContent = o.text != null ? o.text : el.textContent; }); return; }
        var val = slot.directOnly ? directText(el) : el.textContent;
        if (slot.directOnly) withApplying(function () { setDirectText(el, val); }); // strip stray markup
        var prev = currentReplacement(slot);
        var grpN = (groupMembers(slot) || [slot]).length;
        CE.history.run({
          label: 'edit text #' + slot.number, coalesceKey: 'text:' + slot.number,
          do: function () { return persistText(slot, val); },
          undo: function () { return applyReplacement(slot, prev, false); },
        }).then(function () { CE.ui.toast('#' + slot.number + ' saved' + (grpN > 1 ? ' (×' + grpN + ')' : '')); })
          .catch(function () {});
      }
      function onKey(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); } else if (ev.key === 'Escape') { commit(false); } }
      function onBlur() { commit(true); }
      el.addEventListener('keydown', onKey); el.addEventListener('blur', onBlur);
    }

    // ---------- MEDIA: drop / paste / url / file (with live thumbnail + decode-before-swap + undoable) ----------
    function editMedia(slot, el) {
      el = el || elFor(slot); if (!el) return;
      snapshot(slot, el);
      var pop = CE.ui.pop;
      var accept = slot.type === 'video' ? 'video/*' : (slot.type === 'svg' ? 'image/svg+xml,image/*' : 'image/*');
      pop.innerHTML =
        '<h4>#' + slot.number + ' — replace ' + slot.type + (slot.groupId ? ' <span class="cl-pop-all">· changes all matching</span>' : '') + '</h4>' +
        '<div id="cl-drop">Drop a file, paste, or click<br><small>keeps the exact slot size + responsiveness</small><input type="file" accept="' + accept + '" style="display:none"></div>' +
        '<div class="cl-urlrow"><input type="url" id="cl-url" placeholder="…or paste an image/video URL"><button data-act="url">use URL</button></div>' +
        '<div id="cl-lib" class="cl-lib"></div>' +
        '<div class="cl-err"></div>' +
        '<div class="cl-actions"><button class="cl-ghost" data-act="cancel">cancel</button><button data-act="keep">keep original</button></div>';
      var rect = el.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(rect.left, innerWidth - 320)) + 'px';
      pop.style.top = Math.max(8, Math.min(rect.top + 20, innerHeight - 260)) + 'px';
      pop.classList.add('cl-open');
      var drop = pop.querySelector('#cl-drop'), input = pop.querySelector('input[type=file]'),
        urlInput = pop.querySelector('#cl-url'), err = pop.querySelector('.cl-err');
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
      pop.querySelector('[data-act="keep"]').addEventListener('click', function () { keepSlot(slot); closePop(); });

      // ---- asset library: reuse a previously-uploaded image on THIS slot (re-fit, no re-upload) ----
      var libBox = pop.querySelector('#cl-lib');
      if (slot.type !== 'video') {
        CE.api.library().then(function (lib) {
          var items = (lib && lib.items || []).filter(function (it) { return !/^video\//.test(it.mime || ''); });
          if (!items.length) return;
          libBox.innerHTML = '<div class="cl-lib-h">reuse uploaded</div><div class="cl-lib-grid">' +
            items.slice(-12).reverse().map(function (it) { return '<button class="cl-lib-th" data-id="' + it.id + '" title="' + escapeAttr(it.filename) + '"><img src="/' + escapeAttr(String(it.previewRef || '')) + '" alt=""></button>'; }).join('') + '</div>';
          libBox.querySelectorAll('.cl-lib-th').forEach(function (b) {
            b.addEventListener('click', function () {
              drop.innerHTML = '<div class="cl-up">applying …</div>';
              CE.api.libraryApply({ number: slot.number, libraryId: b.getAttribute('data-id') })
                .then(function (res) { if (res.degraded) CE.ui.toast('⚠ not resized (install sharp/ffmpeg)'); return commitMedia(slot, res); })
                .then(function () { CE.ui.toast('#' + slot.number + ' reused from library'); closePop(); })
                .catch(function (e) { showErr(e.message || String(e)); });
            });
          });
        }).catch(function () { /* library is best-effort */ });
      }

      function fromUrl(u) {
        err.style.display = 'none'; drop.innerHTML = 'fetching …';
        fetch(u).then(function (r) { return r.blob(); }).then(function (b) { handleFile(new File([b], (u.split('/').pop() || 'asset'), { type: b.type })); })
          .catch(function (e) { showErr('URL fetch failed: ' + e.message); });
      }
      function handleFile(file) {
        err.style.display = 'none';
        var reader = new FileReader();
        reader.onload = function () {
          var dataUrl = String(reader.result), b64 = dataUrl.split(',')[1];
          // live thumbnail so the popover NEVER looks like a frozen black box while uploading
          if (/^image\//.test(file.type)) drop.innerHTML = '<img class="cl-thumb" src="' + dataUrl + '"><div class="cl-up">uploading ' + escapeAttr(file.name) + ' …</div>';
          else drop.innerHTML = '<div class="cl-up">uploading ' + escapeAttr(file.name) + ' …</div>';
          CE.api.upload({ number: slot.number, filename: file.name, mime: file.type, dataBase64: b64 })
            .then(function (res) {
              if (res.degraded) CE.ui.toast('⚠ ' + slot.type + ' not resized (install sharp/ffmpeg) — using native file');
              return commitMedia(slot, res).then(function () { return res; });
            })
            .then(function (res) { CE.ui.toast('#' + slot.number + ' swapped' + (res.degraded ? ' (degraded)' : '')); closePop(); })
            .catch(function (e) { showErr(e.message || String(e)); });
        };
        reader.readAsDataURL(file);
      }
      function showErr(m) { err.textContent = m; err.style.display = 'block'; drop.innerHTML = 'Drop a file, paste, or click<br><small>try again</small>'; }
    }
    function escapeAttr(s) { return String(s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; }); }

    // wrap a freshly-uploaded asset as an undoable replace command
    function commitMedia(slot, res) {
      var prev = currentReplacement(slot);
      var repl = { kind: 'asset', assetRef: res.assetRef, srcset: srcsetFromGenerated(res.generated), srcsetHtml: res.srcsetHtml, poster: posterFrom(res), generated: res.generated };
      return CE.history.run({
        label: 'replace ' + slot.type + ' #' + slot.number,
        do: function () { return applyReplacement(slot, repl, true); },     // interactive → preflight/decode
        undo: function () { return applyReplacement(slot, prev, false); },
      });
    }

    // set a slot's text programmatically (paste, future AI) — routes through the SAME command path as inline
    // edit so directOnly children are preserved and grouped instances propagate. Undoable.
    function setText(slot, value) {
      var el = elFor(slot); if (!el || slot.type !== 'text') return Promise.resolve();
      snapshot(slot, el);
      var prev = currentReplacement(slot);
      var grpN = (groupMembers(slot) || [slot]).length;
      return CE.history.run({
        label: 'set text #' + slot.number, coalesceKey: 'text:' + slot.number,
        do: function () { return persistText(slot, value); },
        undo: function () { return applyReplacement(slot, prev, false); },
      }).then(function () { CE.ui.toast('#' + slot.number + ' updated' + (grpN > 1 ? ' (×' + grpN + ')' : '')); }).catch(function () {});
    }

    // set a link target (anchor/button href) — undoable, persists, applied live. The clone ships with the
    // ORIGINAL site's hrefs; this points them at YOUR destination so the page is actually usable.
    function setHref(slot, href) {
      var el = elFor(slot); if (!el || slot.type !== 'text') return Promise.resolve();
      snapshot(slot, el);
      var prev = currentReplacement(slot);
      return CE.history.run({
        label: 'set link #' + slot.number,
        do: function () {
          CE.ui.saving('saving');
          withApplying(function () { var ht = hrefTarget(el); if (ht) ht.setAttribute('href', href); });
          return CE.api.slot({ number: slot.number, op: 'set-href', href: href })
            .then(function () { return CE.refreshManifest(); })
            .then(function () { CE.ui.saving('saved'); CE.emit('storeChange', { number: slot.number }); })
            .catch(function (e) { CE.ui.saving('error'); CE.ui.toast('link save failed: ' + e.message, 'error'); throw e; });
        },
        undo: function () { return applyReplacement(slot, prev, false); },
      }).then(function () { CE.ui.toast('#' + slot.number + ' link → ' + href); }).catch(function () {});
    }

    // set image alt text (accessibility + SEO) — undoable; applied live to the <img> and persisted.
    function setAlt(slot, alt) {
      var el = elFor(slot); if (!el) return Promise.resolve();
      snapshot(slot, el);   // capture original alt so a later reset restores it live
      var img = (el.tagName === 'IMG') ? el : (el.querySelector && el.querySelector('img'));
      var prevEntry = CE.entries.get(slot.number);
      var prevAlt = (prevEntry && prevEntry.slot && prevEntry.slot.altReplacement != null) ? prevEntry.slot.altReplacement : (img ? img.getAttribute('alt') : null);
      return CE.history.run({
        label: 'alt #' + slot.number,
        do: function () {
          CE.ui.saving('saving');
          if (img) withApplying(function () { img.setAttribute('alt', alt); });
          return CE.api.slot({ number: slot.number, op: 'set-alt', alt: alt })
            .then(function () { return CE.refreshManifest(); })
            .then(function () { CE.ui.saving('saved'); CE.emit('storeChange', { number: slot.number }); })
            .catch(function (e) { CE.ui.saving('error'); CE.ui.toast('alt save failed: ' + e.message, 'error'); throw e; });
        },
        undo: function () {
          if (img) withApplying(function () { if (prevAlt != null) img.setAttribute('alt', prevAlt); else img.removeAttribute('alt'); });
          return CE.api.slot({ number: slot.number, op: 'set-alt', alt: prevAlt == null ? '' : prevAlt }).then(function () { return CE.refreshManifest(); });
        },
      }).then(function () { CE.ui.toast('#' + slot.number + ' alt updated'); }).catch(function () {});
    }

    // hide / show a whole SECTION — manifest-only, reversible, zero structural/CSS drift (just display).
    // Useful to drop a section you don't need (pricing, testimonials, cookie banner) from preview + build.
    function setSectionHidden(slot, hidden) {
      var el = elFor(slot); if (!el || slot.type !== 'section') return Promise.resolve();
      var e = CE.entries.get(slot.number);
      var prevHidden = !!(e && e.slot && e.slot.section && e.slot.section.hidden);
      return CE.history.run({
        label: (hidden ? 'hide' : 'show') + ' section #' + slot.number,
        do: function () {
          CE.ui.saving('saving');
          withApplying(function () { el.style.display = hidden ? 'none' : ''; });
          return CE.api.slot({ number: slot.number, op: 'set-section', section: { hidden: !!hidden } })
            .then(function () { return CE.refreshManifest(); })
            .then(function () { CE.ui.saving('saved'); CE.emit('storeChange', { number: slot.number }); })
            .catch(function (err) { CE.ui.saving('error'); CE.ui.toast('section save failed: ' + err.message, 'error'); throw err; });
        },
        undo: function () {
          withApplying(function () { el.style.display = prevHidden ? 'none' : ''; });
          return CE.api.slot({ number: slot.number, op: 'set-section', section: { hidden: prevHidden } }).then(function () { return CE.refreshManifest(); });
        },
      }).then(function () { CE.ui.toast('#' + slot.number + ' section ' + (hidden ? 'hidden' : 'shown')); }).catch(function () {});
    }

    // ---------- SECTION reorder (manifest-only — permute sibling sections, never edit their internals) ----------
    // Placeholder-permute: each section keeps the EXACT DOM slot the sections occupied; we only swap which
    // section sits where. Per-parent, so sections in different containers never interfere.
    function reorderSectionsLive() {
      var all = (CE.manifest && CE.manifest.slots || []).filter(function (s) { return s.type === 'section'; });
      if (!all.length) return;
      var groups = new Map();
      all.forEach(function (s) {
        var el = CE.resolveEl(s); if (!el || !el.parentElement) return;
        var p = el.parentElement;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push({ el: el, order: (s.section && typeof s.section.order === 'number') ? s.section.order : null });
      });
      withApplying(function () {
        groups.forEach(function (group, parent) {
          if (!group.some(function (g) { return g.order != null; })) return;
          var dom = group.slice().sort(function (a, b) { var p = a.el.compareDocumentPosition(b.el); return (p & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1; });
          var sorted = dom.map(function (g, i) { return { el: g.el, eff: (g.order != null ? g.order : i), i: i }; })
            .sort(function (a, b) { return a.eff - b.eff || a.i - b.i; }).map(function (x) { return x.el; });
          var orig = dom.map(function (g) { return g.el; });
          var same = true; for (var i = 0; i < orig.length; i++) { if (orig[i] !== sorted[i]) { same = false; break; } }
          if (same) return;
          var phs = orig.map(function (el) { var c = document.createComment('cl-sec'); parent.insertBefore(c, el); el.remove(); return c; });
          phs.forEach(function (ph, i) { parent.replaceChild(sorted[i], ph); });
        });
      });
      if (CE.scheduleLayout) CE.scheduleLayout();
    }
    // reorder the whole section list at once (the panel's drag handler), as ONE undoable command
    function setSectionOrderBatch(numbers) {
      var prev = numbers.map(function (n) { var s = CE.manifest.slots.find(function (x) { return x.number === n; }); return { n: n, order: (s && s.section && typeof s.section.order === 'number') ? s.section.order : null }; });
      CE.history.run({
        label: 'reorder sections', coalesceKey: null,
        do: function () { return Promise.all(numbers.map(function (n, i) { return CE.api.slot({ number: n, op: 'set-section', section: { order: i } }); })).then(function () { return CE.refreshManifest(); }); },
        undo: function () { return Promise.all(prev.map(function (p) { return CE.api.slot({ number: p.n, op: 'set-section', section: { order: p.order } }); })).then(function () { return CE.refreshManifest(); }); },
      }).then(function () { reorderSectionsLive(); CE.ui.toast('sections reordered'); }).catch(function (er) { CE.ui.toast('reorder failed: ' + er.message, 'error'); });
    }
    function setSectionOrder(slot, order) {
      var prev = (slot.section && typeof slot.section.order === 'number') ? slot.section.order : null;
      CE.history.run({
        label: 'move section #' + slot.number, coalesceKey: null,
        do: function () { return CE.api.slot({ number: slot.number, op: 'set-section', section: { order: order } }).then(function () { return CE.refreshManifest(); }); },
        undo: function () { return CE.api.slot({ number: slot.number, op: 'set-section', section: { order: prev } }).then(function () { return CE.refreshManifest(); }); },
      }).then(function () { reorderSectionsLive(); CE.ui.toast('section #' + slot.number + ' moved'); }).catch(function (er) { CE.ui.toast('reorder failed: ' + er.message, 'error'); });
    }

    // ---------- keep / reset (undoable) ----------
    function keepSlot(slot) {
      return CE.history.run({
        label: 'keep #' + slot.number,
        do: function () { CE.ui.saving('saving'); return CE.api.slot({ number: slot.number, op: 'keep' }).then(function () { return CE.refreshManifest(); }).then(function () { CE.ui.saving('saved'); CE.ui.toast('#' + slot.number + ' kept'); }); },
        undo: function () { return CE.api.slot({ number: slot.number, op: 'unkeep' }).then(function () { return CE.refreshManifest(); }); },
      });
    }
    function resetSlot(slot) {
      var prev = currentReplacement(slot);
      if (prev == null) { CE.ui.toast('#' + slot.number + ' already original'); return Promise.resolve(); }
      return CE.history.run({
        label: 'reset #' + slot.number,
        do: function () { return applyReplacement(slot, null, false); },
        undo: function () { return applyReplacement(slot, prev, false); },
      }).then(function () { CE.ui.toast('#' + slot.number + ' reset to original'); }).catch(function () {});
    }

    function closePop() { CE.ui.pop.classList.remove('cl-open'); CE.ui.pop.innerHTML = ''; }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

    // ---------- before/after ----------
    CE.on('beforeAfter', function (after) {
      CE.entries.forEach(function (entry) {
        var slot = entry.slot, el = entry.el, o = originals.get(slot.number);
        if (!slot.replacement && !o) return;
        if (after) { if (slot.replacement) CE.reapply(slot, el); }
        else if (o) restoreOriginal(slot, el);
      });
    });

    // ---------- decoration only; selection/dblclick/right-click live in select.js + menu.js ----------
    CE.registerInteractor(function (ctx) {
      var slot = ctx.slot, el = ctx.el;
      el.style.cursor = el.style.cursor || 'pointer';
      el.setAttribute('title', '#' + slot.number + ' — ' + (slot.type === 'text' ? 'edit text' : 'replace ' + slot.type) + (slot.groupId ? ' (changes all matching)' : ''));
    });

    // expose so select.js / menu.js / panel.js / palette.js drive the same flows
    CE.editText = editText; CE.editMedia = editMedia; CE.keepSlot = keepSlot; CE.resetSlot = resetSlot; CE.setText = setText; CE.setHref = setHref; CE.setAlt = setAlt; CE.setSectionHidden = setSectionHidden;
    CE.setSectionOrder = setSectionOrder; CE.setSectionOrderBatch = setSectionOrderBatch; CE.reorderSections = reorderSectionsLive;
    CE.applyAsset = applyAsset; CE.swapAsset = swapAsset; CE.originals = originals;

    // paint every saved replacement onto the live DOM so edits STICK across reloads
    try { CE.reapplyAll(); } catch (e) {}
    // apply any persisted section order on load + after each manifest refresh (idempotent — no-op if sorted)
    CE.on('manifest', reorderSectionsLive);
    try { reorderSectionsLive(); } catch (e) {}

    console.log('[clone] interactive editor v2 armed — media shape-aware (no black), decode-before-swap, undo/redo, visible toasts');
  }

  function whenReady() {
    if (window.__CloneEditor && window.__CloneEditor.manifest) return start(window.__CloneEditor);
    if (window.__CloneEditor) return window.__CloneEditor.on('ready', function () { start(window.__CloneEditor); });
    setTimeout(whenReady, 50);
  }
  whenReady();
})();
