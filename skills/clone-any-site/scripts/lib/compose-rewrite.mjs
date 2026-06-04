// lib/compose-rewrite.mjs
const SW_KILL = `<script>try{if('serviceWorker' in navigator){if(navigator.serviceWorker.getRegistrations)navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();})});navigator.serviceWorker.register=function(){return Promise.reject(new Error('sw off'))}}}catch(e){}</script>`;

export function rewriteEntryHtml(html, map, swaps) {
  // 1) rewrite each swapped image/sequence slot's CDN/original url(s) -> /__swap/<id>
  for (const s of map.slots) {
    if (!swaps[s.id]) continue;
    const urls = s.type === 'sequence' ? (s.frames || []) : [s.original];
    urls.forEach((u, i) => { if (!u) return; const target = s.type === 'sequence' ? `/__swap/${s.id}/${i}` : `/__swap/${s.id}`; html = html.split(u).join(target); });
  }
  // 2) build the DOM-swap payload (text/title/video/image) for the client script
  const dom = {};
  for (const s of map.slots) {
    const sw = swaps[s.id]; if (!sw) continue;
    if (sw.type === 'text') {
      // split-text slots (per-line/word reveal blocks) can't be matched by a single text node —
      // distribute our words across the existing fragment elements (keeps every element → animation intact).
      if (s.split && s.where?.cssPath) dom[s.id] = { kind: 'splittext', css: s.where.cssPath, value: sw.value };
      else dom[s.id] = { kind: 'text', value: sw.value, original: s.text, css: s.where?.cssPath };
    }
    if (sw.type === 'video') dom[s.id] = { kind: 'video', url: `/__swap/${s.id}`, css: s.where?.cssPath };
    if (sw.type === 'image') dom[s.id] = { kind: 'image', url: `/__swap/${s.id}`, css: s.where?.cssPath };
  }
  const domScript = `<script>window.__CL_SWAPS__=${JSON.stringify(dom)};(${clientSwap.toString()})();</script>`;
  // 3) preload hints for above-the-fold swapped assets (fast paint). Guard against missing fields.
  let preload = '';
  for (const s of map.slots) {
    const sw = swaps[s.id]; if (!sw) continue;
    if (sw.type === 'video') {
      preload += `<link rel="preload" as="video" href="/__swap/${s.id}">`;
    } else if (sw.type === 'image' && s.where && typeof s.where.arcRatio === 'number' && s.where.arcRatio < 0.15) {
      preload += `<link rel="preload" as="image" href="/__swap/${s.id}">`;
    }
  }
  html = html.replace(/<head>/i, '<head>' + SW_KILL + preload);
  html = html.includes('</body>') ? html.replace('</body>', domScript + '</body>') : html + domScript;
  return html;
}

// runs in the page — applies text/title/video swaps after the opening animation, re-applying on interval/scroll
function clientSwap() {
  var S = window.__CL_SWAPS__ || {};
  function apply() {
    Object.keys(S).forEach(function (id) {
      var s = S[id];
      if (s.kind === 'text') {
        var W = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n;
        while (n = W.nextNode()) { if (s.original && n.textContent.replace(/\s+/g,' ').trim() === s.original.trim()) n.textContent = s.value; }
      } else if (s.kind === 'video') {
        function swapVideo(v) {
          if (!v) return;
          if (v.src && v.src.indexOf('/__swap/') > -1) return;
          var ss = v.querySelectorAll('source');
          for (var i = 0; i < ss.length; i++) ss[i].remove();
          v.src = s.url; v.muted = true;
          if (v.load) v.load(); if (v.play) v.play().catch(function () {});
        }
        if (s.css) {
          // per-slot: target ONLY the matching element(s), resolve to their <video>
          var matches = document.querySelectorAll(s.css);
          for (var m = 0; m < matches.length; m++) {
            var el = matches[m], vid = null;
            if (el.tagName === 'VIDEO') vid = el;
            else {
              vid = el.querySelector ? el.querySelector('video') : null;
              if (!vid && el.closest) vid = el.closest('video');
            }
            swapVideo(vid);
          }
        } else {
          // fallback (no cssPath): old greedy behaviour — every not-yet-swapped <video>
          document.querySelectorAll('video').forEach(function (v) { swapVideo(v); });
        }
      } else if (s.kind === 'image') {
        if (!s.css) return;
        var imgs = document.querySelectorAll(s.css);
        for (var j = 0; j < imgs.length; j++) {
          var img = imgs[j];
          if (!img || img.tagName !== 'IMG') continue;
          if (img.src && img.src.indexOf('/__swap/') > -1) continue;
          var pic = img.closest ? img.closest('picture') : null;
          if (pic) { var srcs = pic.querySelectorAll('source'); for (var k = 0; k < srcs.length; k++) srcs[k].remove(); }
          img.removeAttribute('srcset'); img.removeAttribute('sizes'); img.removeAttribute('data-src'); img.removeAttribute('data-srcset');
          try { img.loading = 'eager'; img.decoding = 'sync'; } catch (e) {}
          img.src = s.url;
        }
      } else if (s.kind === 'splittext') {
        // animation-safe: NEVER remove an element. Distribute our words across the existing leaf
        // fragments (the per-line/word reveal spans), so the reveal animation plays unchanged on our text.
        if (!s.css) return;
        var cont = document.querySelector(s.css);
        if (!cont) return;
        // re-applies if a JS reveal re-asserts its own text; skips once OUR text is present (no flicker, no drift).
        var first2 = s.value.split(/\s+/).slice(0, 2).join(' ');
        if (first2 && (cont.textContent || '').indexOf(first2) > -1) return;
        var nodes = cont.querySelectorAll('*'), leaves = [];
        for (var a = 0; a < nodes.length; a++) { var el = nodes[a]; if (el.children.length === 0 && (el.textContent || '').trim()) leaves.push(el); }
        if (leaves.length === 0) { cont.textContent = s.value; return; }
        var words = s.value.split(/\s+/), total = 0, i, share;
        for (i = 0; i < leaves.length; i++) total += ((leaves[i].textContent || '').length || 1);
        var wi = 0;
        for (i = 0; i < leaves.length; i++) {
          share = (i === leaves.length - 1) ? (words.length - wi) : Math.round(words.length * (((leaves[i].textContent || '').length) || 1) / total);
          if (share < 0) share = 0; if (wi + share > words.length) share = words.length - wi;
          leaves[i].textContent = words.slice(wi, wi + share).join(' '); wi += share;
        }
        if (wi < words.length) leaves[leaves.length - 1].textContent += ' ' + words.slice(wi).join(' ');
      }
    });
  }
  function start(){ apply(); setInterval(apply, 1200); window.addEventListener('scroll', apply, { passive: true }); }
  if (document.readyState === 'complete') setTimeout(start, 5200); else window.addEventListener('load', function(){ setTimeout(start, 5200); });
}
