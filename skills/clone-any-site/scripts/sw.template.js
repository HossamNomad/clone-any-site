// Offline shim TEMPLATE for the INTERNAL loopback mirror (Phase C).
// Copy to <mirror-root>/sw.js and fill the per-site bits from recon. serve.mjs serves it at
// root scope and injects the registration into HTML automatically. Zero edits to minified chunks —
// all redirection happens at the network layer.
//
// Most static marketing sites need ONLY block 1 (the form stub). Blocks 2–4 are for
// WebGL/3D sites (React Three Fiber / drei / three.js) that pull a decoder, an HDRI, or use a
// build-time image optimizer. Delete the blocks you don't need.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch { return; }

  // 1) FORM STUB — answer any same-origin POST with 200 JSON so submits don't error.
  //    (The only POST on a loopback mirror is the site's own form. Cross-origin POSTs fall through.)
  if (req.method === 'POST' && url.origin === self.location.origin) {
    e.respondWith(new Response(JSON.stringify({ ok: true, stubbed: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    return;
  }

  // 2) 3D DECODER (e.g. DRACO) -> vendored local copy. Set the exact version from recon.
  //    const DRACO = 'https://www.gstatic.com/draco/versioned/decoders/<VERSION>/';
  //    if (req.url.startsWith(DRACO)) { e.respondWith(fetch(req.url.replace(DRACO, '/_vendor/draco/<VERSION>/'))); return; }

  // 3) HDRI / environment map (any host/rev) -> vendored local copy. Match the filename from recon.
  //    if (/(raw\.githubusercontent|raw\.githack|cdn\.jsdelivr)\.[^/]+\/.*<HDRI_FILENAME>/.test(req.url)) {
  //      e.respondWith(fetch('/_vendor/hdri/<HDRI_FILENAME>')); return;
  //    }

  // 4) Next.js image optimizer (/_next/image?url=...) -> canonical same-origin source on disk.
  //    A dumb static server has no optimizer; the crawler captured the /public source.
  //    NOTE: the live optimizer transcodes webp->jpeg@q75 — if an image depth fails SSIM, pre-bake the
  //    exact optimizer bytes (pinned Accept header) instead of mapping to the raw source.
  //    if (url.pathname === '/_next/image' && url.searchParams.get('url')) {
  //      e.respondWith(fetch(decodeURIComponent(url.searchParams.get('url')))); return;
  //    }
});

// CAVEAT (honest): a decoder running inside a blob-created Web Worker makes cross-origin fetches the
// page service worker CANNOT intercept. Those will still hit their CDN. That's not an IP problem for
// CC0/Apache assets and does NOT affect fidelity (the bytes are deterministic). True offline would
// need the Cache API + the decoder path set locally (which touches the minified loader) — usually
// not worth it for an internal reference.
