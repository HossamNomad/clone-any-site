// Zero-dependency loopback static server for the INTERNAL mirror (Phase C) + the Repurpose Layer editor.
// Serves a folder on 127.0.0.1 ONLY. Supports HTTP Range (so seekable <video> works in the fidelity gate)
// and, if a sw.js sits at the served root, injects its registration into HTML on the fly.
//
// EDITOR MODE (loopback only) — opt-in via env:
//   CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose node serve.mjs clones/<name>/mirror/<host>
//   -> injects the numbered edit-map + interactive editor + a hard "LOOPBACK PREVIEW — NOT SHIPPABLE" watermark,
//      and mounts loopback write-back endpoints under /__clone/* (manifest / state / slot / upload / editor assets).
//
// Usage (plain mirror):  node serve.mjs ./mirror/www.example.com
// NEVER bind to 0.0.0.0 or deploy this publicly under the original brand. Loopback only.

import { createServer } from 'node:http';
import { stat, readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, extname, normalize, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(process.env.CLONE_SERVE_ROOT || process.argv[2] || '.');
const PORT = Number(process.env.CLONE_SERVE_PORT || 4321);
const HOSTNAME = '127.0.0.1';
const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR_DIR = join(HERE, 'editor');

// editor mode
const EDIT = process.env.CLONE_EDIT === '1' || process.argv.includes('--edit');
const LOOPBACK_OK = process.env.CLONE_LOOPBACK_OK === '1';          // arms write-back (POST) endpoints
const REPURPOSE_DIR = process.env.CLONE_REPURPOSE_DIR ? normalize(process.env.CLONE_REPURPOSE_DIR) : null;
const MANIFEST = REPURPOSE_DIR ? join(REPURPOSE_DIR, 'manifest.json') : null;
const FIT_SLOT = join(HERE, 'fit-slot.mjs');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.avif': 'image/avif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.hdr': 'image/vnd.radiance',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};
const ctype = (p) => TYPES[extname(p).toLowerCase()] || 'application/octet-stream';
const exists = (p) => access(p).then(() => true).catch(() => false);
let hasSW = false; // resolved at boot

async function resolveFile(pathname, root) {
  let p = decodeURIComponent(pathname.split('?')[0]);
  // path-traversal guard — robust to a root that already ends with a separator (else the prefix would
  // get a DOUBLE sep and every sub-path would falsely fail the startsWith check → spurious 404s).
  const rootN = normalize(root);
  const prefix = rootN.endsWith(sep) ? rootN : rootN + sep;
  const target = normalize(join(root, p));
  if (!(target === rootN || target.startsWith(prefix))) return null;
  let fp = join(root, p);
  try { const s = await stat(fp); if (s.isDirectory()) fp = join(fp, 'index.html'); }
  catch { if (!extname(fp) && await exists(fp + '.html')) fp += '.html'; }
  return (await exists(fp)) ? fp : null;
}

const SW_SNIPPET = `<script>if('serviceWorker'in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}</script>`;
function editorInject(meta) {
  const cfg = JSON.stringify({ repurposeDir: REPURPOSE_DIR, viewports: (meta && meta.viewports) || [390, 768, 1440], armed: LOOPBACK_OK });
  return `<link rel="stylesheet" href="/__clone/editor/edit-map.css">` +
    `<div id="cl-watermark">LOOPBACK PREVIEW — NOT SHIPPABLE</div>` +
    `<script>window.__CLONE_EDIT=${cfg}</script>` +
    `<script src="/__clone/editor/edit-map.js" defer></script>` +
    `<script src="/__clone/editor/editor.js" defer></script>`;
}

// ---------- editor endpoints ----------
function readBody(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', (c) => { len += c.length; if (len > max) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function readManifest() { return JSON.parse(await readFile(MANIFEST, 'utf8')); }
async function writeManifest(m) { const tmp = MANIFEST + '.tmp'; await writeFile(tmp, JSON.stringify(m, null, 2)); await rename(tmp, MANIFEST); }
function recomputeBlocking(m) {
  const b = m.slots.filter((s) => s.provenance === 'original' && !s.keep && !s.replacement).length;
  m.meta.counts = m.meta.counts || {}; m.meta.counts.blocking = b; return b;
}

async function handleClone(req, res) {
  const url = req.url.split('?')[0];
  // editor static assets
  if (url.startsWith('/__clone/editor/')) {
    const fp = await resolveFile(url.replace('/__clone/editor/', '/'), EDITOR_DIR);
    if (!fp) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': ctype(fp), 'Cache-Control': 'no-store' });
    createReadStream(fp).pipe(res); return;
  }
  if (!REPURPOSE_DIR || !MANIFEST || !(await exists(MANIFEST))) return sendJson(res, 404, { error: 'no manifest — run extract-manifest first', repurposeDir: REPURPOSE_DIR });

  if (req.method === 'GET' && url === '/__clone/manifest') return sendJson(res, 200, await readManifest());
  if (req.method === 'GET' && url === '/__clone/state') {
    const m = await readManifest();
    return sendJson(res, 200, {
      blockingCount: recomputeBlocking(m), structureAuthorization: m.meta.structureAuthorization,
      slots: m.slots.map((s) => ({ number: s.number, type: s.type, role: s.role, provenance: s.provenance, keep: !!s.keep, hasReplacement: !!s.replacement, flags: s.flags || [] })),
    });
  }
  // writes require the loopback arm
  if (req.method === 'POST' && (url === '/__clone/slot' || url === '/__clone/upload')) {
    if (!LOOPBACK_OK) return sendJson(res, 403, { error: 'write-back not armed — set CLONE_LOOPBACK_OK=1 (loopback only)' });
    let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }

    if (url === '/__clone/slot') {
      const m = await readManifest();
      const slot = m.slots.find((s) => s.number === body.number);
      if (!slot) return sendJson(res, 404, { error: 'no slot #' + body.number });
      switch (body.op) {
        case 'replace-text': slot.replacement = { kind: 'text', value: String(body.value == null ? '' : body.value) }; slot.keep = false; slot.provenance = 'user'; break;
        case 'replace-asset': slot.replacement = { kind: 'asset', assetRef: body.assetRef, srcsetHtml: body.srcsetHtml || (slot.replacement && slot.replacement.srcsetHtml) }; slot.keep = false; slot.provenance = 'user'; break;
        case 'keep': slot.keep = true; break;
        case 'unkeep': slot.keep = false; break;
        case 'clear': slot.replacement = null; slot.keep = false; slot.provenance = 'original'; break;
        default: return sendJson(res, 400, { error: 'unknown op: ' + body.op });
      }
      recomputeBlocking(m); await writeManifest(m);
      return sendJson(res, 200, { ok: true, slot, blockingCount: m.meta.counts.blocking });
    }

    if (url === '/__clone/upload') {
      if (body.dataBase64 == null || body.number == null) return sendJson(res, 400, { error: 'need {number, filename, dataBase64}' });
      const assetsDir = join(REPURPOSE_DIR, 'assets'); const incoming = join(assetsDir, 'incoming');
      await mkdir(incoming, { recursive: true });
      const safe = basename(String(body.filename || 'file')).replace(/[^A-Za-z0-9._-]/g, '_');
      const raw = join(incoming, body.number + '__' + safe);
      await writeFile(raw, Buffer.from(body.dataBase64, 'base64'));
      const r = spawnSync(process.execPath, [FIT_SLOT, '--slot', String(body.number), '--in', raw, '--manifest', MANIFEST, '--out', assetsDir], { encoding: 'utf8' });
      if (r.status !== 0) return sendJson(res, 500, { error: 'fit-slot failed', detail: (r.stderr || '').slice(-400) });
      let out; try { out = JSON.parse(r.stdout); } catch { return sendJson(res, 500, { error: 'fit-slot bad output', detail: r.stdout.slice(-400) }); }
      return sendJson(res, 200, out); // { assetRef, generated, srcsetHtml, degraded }
    }
  }
  return sendJson(res, 404, { error: 'unknown __clone route' });
}

const server = createServer(async (req, res) => {
  try {
    if (EDIT && req.url.startsWith('/__clone/')) return await handleClone(req, res);

    const fp = await resolveFile(req.url, ROOT);
    if (!fp) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }

    const type = ctype(fp);
    const isSW = fp.toLowerCase().endsWith(`${sep}sw.js`) || fp.toLowerCase().endsWith('/sw.js');
    const isHTML = type.startsWith('text/html');

    if (isHTML) {
      let body = await readFile(fp, 'utf8');
      if (hasSW && !/serviceWorker\.register/.test(body)) {
        body = body.includes('</body>') ? body.replace('</body>', SW_SNIPPET + '</body>') : body + SW_SNIPPET;
      }
      if (EDIT) {
        let meta = null; try { if (MANIFEST && await exists(MANIFEST)) meta = (await readManifest()).meta; } catch {}
        const inj = editorInject(meta);
        body = body.includes('</body>') ? body.replace('</body>', inj + '</body>') : body + inj;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body); return;
    }

    const s = await stat(fp);
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    if (isSW) headers['Service-Worker-Allowed'] = '/';

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : s.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= s.size) end = s.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': end - start + 1 });
      createReadStream(fp, { start, end }).pipe(res); return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': s.size });
    createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('500 ' + (e.message || e));
  }
});

(async () => {
  if (!(await exists(ROOT))) { console.error('serve root not found:', ROOT); process.exit(1); }
  hasSW = await exists(join(ROOT, 'sw.js'));
  server.listen(PORT, HOSTNAME, () => {
    const actualPort = server.address().port;
    console.log('CLONE_PORT=' + actualPort); // parseable by callers that spawn an ephemeral-port server
    console.log(`serving ${ROOT}\n  -> http://${HOSTNAME}:${actualPort}/  ${hasSW ? '(sw.js active)' : ''}`);
    if (EDIT) console.log(`  EDITOR MODE ${LOOPBACK_OK ? '(write-back armed)' : '(read-only — set CLONE_LOOPBACK_OK=1 to arm)'} · repurpose=${REPURPOSE_DIR || 'UNSET (set CLONE_REPURPOSE_DIR)'}`);
    console.log('  loopback only — do NOT expose publicly.');
  });
})();
