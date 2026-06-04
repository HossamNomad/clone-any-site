// Zero-dependency loopback static server for the INTERNAL mirror (Phase C) + the Repurpose Layer editor.
// Serves a folder on 127.0.0.1 ONLY. Supports HTTP Range (so seekable <video> works in the fidelity gate)
// and, if a sw.js sits at the served root, injects its registration into HTML on the fly.
//
// EDITOR MODE (loopback only) — opt-in via env:
//   CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose node serve.mjs clones/<name>/mirror/<host>
//   -> injects the numbered edit-map + interactive editor (no watermark, no publish-block — the user decides
//      when to publish), and mounts loopback write-back endpoints under /__clone/* (manifest/state/slot/upload/assets).
//
// Usage (plain mirror):  node serve.mjs ./mirror/www.example.com
// NEVER bind to 0.0.0.0 or deploy this publicly under the original brand. Loopback only.

import { createServer } from 'node:http';
import { stat, readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const cfg = JSON.stringify({ repurposeDir: REPURPOSE_DIR, viewports: (meta && meta.viewports) || [390, 768, 1440], armed: LOOPBACK_OK, theme: (meta && meta.theme) || null });
  // defer preserves order: kernel → themes → panel → palette → select → menu → interactions
  // (each guards on __CloneEditor; select/menu call into editor.js flows at interaction time).
  return `<link rel="stylesheet" href="/__clone/editor/edit-map.css">` +
    `<script>window.__CLONE_EDIT=${cfg}</script>` +
    `<script src="/__clone/editor/edit-map.js" defer></script>` +
    `<script src="/__clone/editor/themes.js" defer></script>` +
    `<script src="/__clone/editor/panel.js" defer></script>` +
    `<script src="/__clone/editor/palette.js" defer></script>` +
    `<script src="/__clone/editor/select.js" defer></script>` +
    `<script src="/__clone/editor/menu.js" defer></script>` +
    `<script src="/__clone/editor/editor.js" defer></script>` +
    `<script src="/__clone/editor/coach.js" defer></script>`;
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
  const b = m.slots.filter((s) => s.provenance === 'original' && !s.keep && !s.replacement && s.role === 'content'
    && !(s.flags || []).some((f) => String(f).startsWith('advanced:'))).length;
  m.meta.counts = m.meta.counts || {}; m.meta.counts.blocking = b; return b;
}
// Apply ONE op to ONE slot object (in-memory). Shared by /slot, /group, /batch. Returns false if op unknown.
function applySlotOp(slot, op, body) {
  switch (op) {
    case 'replace-text': slot.replacement = { kind: 'text', value: String(body.value == null ? '' : body.value),
      href: (body.href !== undefined ? body.href : (slot.replacement && slot.replacement.href)) }; slot.keep = false; slot.provenance = 'user'; return true;
    case 'set-href': { // link target edit — keep an existing text value; never clobber a media (asset) replacement
      var prev = slot.replacement;
      if (prev && prev.kind === 'asset') { prev.href = String(body.href == null ? '' : body.href); }   // defensive: img-link slot keeps its asset
      else { var curVal = prev && prev.value; slot.replacement = { kind: (curVal != null ? 'text' : 'link'), value: curVal, href: String(body.href == null ? '' : body.href) }; }
      slot.keep = false; slot.provenance = 'user'; return true;
    }
    // alt is METADATA, not the content swap: don't touch replacement, and don't flip provenance (so it never
    // wrongly clears a content original from the publish-blocking count). Only meaningful on image slots.
    case 'set-alt': if (slot.type !== 'img' && slot.type !== 'icon') return false; slot.altReplacement = String(body.alt == null ? '' : body.alt); return true;
    // section visibility — hide/show a whole section without touching its internals (reversible, no structural
    // rewrite, no CSS drift). Metadata like alt: doesn't flip provenance, doesn't touch replacement.
    case 'set-section': if (slot.type !== 'section') return false; slot.section = Object.assign({}, slot.section, body.section || {}); return true;
    case 'replace-asset': { var pa = slot.replacement; slot.replacement = { kind: 'asset', assetRef: body.assetRef,
      srcset: body.srcset || (pa && pa.srcset),
      srcsetHtml: body.srcsetHtml || (pa && pa.srcsetHtml),
      poster: body.poster || (pa && pa.poster),
      href: (pa && pa.href) || undefined,   // preserve a link target set on the same slot
      generated: body.generated || (pa && pa.generated) }; slot.keep = false; slot.provenance = 'user'; return true; }
    case 'keep': slot.keep = true; return true;
    case 'unkeep': slot.keep = false; return true;
    case 'clear': slot.replacement = null; slot.keep = false; slot.provenance = 'original'; delete slot.altReplacement; delete slot.section; return true; // reset drops alt + section overrides too
    default: return false;
  }
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
  if (req.method === 'GET' && url === '/__clone/library') return sendJson(res, 200, await libraryRead(join(REPURPOSE_DIR, 'assets')));
  if (req.method === 'GET' && url === '/__clone/state') {
    const m = await readManifest();
    return sendJson(res, 200, {
      blockingCount: recomputeBlocking(m), structureAuthorization: m.meta.structureAuthorization,
      slots: m.slots.map((s) => ({ number: s.number, type: s.type, role: s.role, provenance: s.provenance, keep: !!s.keep, hasReplacement: !!s.replacement, flags: s.flags || [] })),
    });
  }
  // writes require the loopback arm
  if (req.method === 'POST' && (url === '/__clone/slot' || url === '/__clone/upload' || url === '/__clone/group' || url === '/__clone/batch' || url === '/__clone/theme' || url === '/__clone/seo' || url === '/__clone/library-apply' || url === '/__clone/ai-rewrite')) {
    if (!LOOPBACK_OK) return sendJson(res, 403, { error: 'write-back not armed — set CLONE_LOOPBACK_OK=1 (loopback only)' });
    let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json: ' + e.message }); }

    // SEO head overrides — store under meta.seo.replacement; build emits replacement-over-original.
    if (url === '/__clone/seo') {
      const m = await readManifest();
      m.meta.seo = m.meta.seo || { original: {}, replacement: {} };
      m.meta.seo.replacement = Object.assign({}, m.meta.seo.replacement, body.seo || {});
      await writeManifest(m);
      return sendJson(res, 200, { ok: true, seo: m.meta.seo });
    }

    if (url === '/__clone/slot') {
      const m = await readManifest();
      const slot = m.slots.find((s) => s.number === body.number);
      if (!slot) return sendJson(res, 404, { error: 'no slot #' + body.number });
      if (!applySlotOp(slot, body.op, body)) return sendJson(res, 400, { error: 'unknown op: ' + body.op });
      recomputeBlocking(m); await writeManifest(m);
      return sendJson(res, 200, { ok: true, slot, blockingCount: m.meta.counts.blocking });
    }

    // change-all-N: apply one op to every member of a group (by groupId)
    if (url === '/__clone/group') {
      const m = await readManifest();
      const members = m.slots.filter((s) => s.groupId && s.groupId === body.groupId);
      if (!members.length) return sendJson(res, 404, { error: 'no group ' + body.groupId });
      let n = 0; for (const s of members) { if (applySlotOp(s, body.op, body)) n++; }
      recomputeBlocking(m); await writeManifest(m);
      return sendJson(res, 200, { ok: true, applied: n, numbers: members.map((s) => s.number), blockingCount: m.meta.counts.blocking });
    }

    // atomic multi-op (find-replace, theme apply) — ONE read/write = ONE logical change
    if (url === '/__clone/batch') {
      const m = await readManifest();
      const ops = Array.isArray(body.ops) ? body.ops : [];
      let n = 0;
      for (const o of ops) {
        const targets = o.groupId ? m.slots.filter((s) => s.groupId === o.groupId) : m.slots.filter((s) => s.number === o.number);
        for (const s of targets) { if (applySlotOp(s, o.op, o)) n++; }
      }
      recomputeBlocking(m); await writeManifest(m);
      return sendJson(res, 200, { ok: true, applied: n, blockingCount: m.meta.counts.blocking });
    }

    // theme record (palette/font tokens) — applied at runtime via CSS vars; baked at publish
    if (url === '/__clone/theme') {
      const m = await readManifest();
      m.meta.theme = body.themeId ? { id: body.themeId, tokens: body.tokens || {}, fonts: body.fonts || {}, appliedAtRef: body.now || '' } : null;
      await writeManifest(m);
      return sendJson(res, 200, { ok: true, theme: m.meta.theme });
    }

    if (url === '/__clone/upload') {
      if (body.dataBase64 == null || body.number == null) return sendJson(res, 400, { error: 'need {number, filename, dataBase64}' });
      const assetsDir = join(REPURPOSE_DIR, 'assets'); const incoming = join(assetsDir, 'incoming');
      await mkdir(incoming, { recursive: true });
      const buf = Buffer.from(body.dataBase64, 'base64');
      const id = createHash('sha1').update(buf).digest('hex').slice(0, 12);   // content id → dedup re-uploads
      const safe = basename(String(body.filename || 'file')).replace(/[^A-Za-z0-9._-]/g, '_');
      // store the raw under a content-addressed name so the SAME bytes reused on another slot need no re-upload
      const rawRel = join('incoming', id + '__' + safe);
      const raw = join(assetsDir, rawRel);
      await writeFile(raw, buf);
      const r = spawnSync(process.execPath, [FIT_SLOT, '--slot', String(body.number), '--in', raw, '--manifest', MANIFEST, '--out', assetsDir], { encoding: 'utf8' });
      if (r.status !== 0) return sendJson(res, 500, { error: 'fit-slot failed', detail: (r.stderr || '').slice(-400) });
      let out; try { out = JSON.parse(r.stdout); } catch { return sendJson(res, 500, { error: 'fit-slot bad output', detail: r.stdout.slice(-400) }); }
      await libraryAdd(assetsDir, { id, filename: safe, mime: String(body.mime || ''), raw: rawRel.split(sep).join('/'), previewRef: out.assetRef || '', now: body.now || '' });
      return sendJson(res, 200, out); // { assetRef, generated, srcsetHtml, degraded }
    }

    // AI copy rewrite — rewrite a slot's text in the brand voice. OFFLINE-SAFE + PORTABLE:
    //   • CLONE_AI_FAKE=1     → deterministic local transform (tests + no-key demo), no network
    //   • ANTHROPIC_API_KEY   → real Claude call, brand voice from repurpose/voice.md (or CLONE_AI_VOICE)
    //   • neither             → 503 with a clear message; the editor degrades to a graceful no-op
    // Never writes anything — returns variants; the editor applies the chosen one via the undoable text path.
    if (url === '/__clone/ai-rewrite') {
      const text = String(body.text == null ? '' : body.text).trim();
      if (!text) return sendJson(res, 400, { error: 'need {text}' });
      const intent = String(body.intent || 'rewrite in the brand voice; keep it concise; preserve meaning');
      const n = Math.max(1, Math.min(4, Number(body.n) || 3));

      if (process.env.CLONE_AI_FAKE === '1') {
        // deterministic, no-network variants so the flow is testable without a key or cost
        const v = [text.replace(/\.$/, '') + ' — refined.', 'In short: ' + text, text.toUpperCase()];
        return sendJson(res, 200, { variants: v.slice(0, n), source: 'fake' });
      }
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return sendJson(res, 503, { error: 'AI not configured — set ANTHROPIC_API_KEY (and optionally CLONE_AI_VOICE or repurpose/voice.md) to enable AI rewrite', source: 'none' });
      let voice = process.env.CLONE_AI_VOICE || '';
      if (!voice && REPURPOSE_DIR) { try { voice = await readFile(join(REPURPOSE_DIR, 'voice.md'), 'utf8'); } catch {} }
      try {
        const prompt = `You rewrite website copy.${voice ? ' Brand voice guidelines:\n' + voice.slice(0, 4000) + '\n' : ''}\nRewrite the text below. ${intent}. Return ONLY a JSON array of ${n} distinct rewrites (strings), no prose.\n\nTEXT:\n${text}`;
        const ar = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.CLONE_AI_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!ar.ok) { const t = await ar.text(); return sendJson(res, 502, { error: 'AI upstream ' + ar.status, detail: t.slice(-300) }); }
        const j = await ar.json();
        const txt = (j.content && j.content[0] && j.content[0].text) || '';
        let variants; try { variants = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1)); } catch { variants = [txt.trim()].filter(Boolean); }
        if (!Array.isArray(variants) || !variants.length) variants = [txt.trim()].filter(Boolean);
        return sendJson(res, 200, { variants: variants.slice(0, n).map(String), source: 'anthropic' });
      } catch (e) { return sendJson(res, 502, { error: 'AI call failed: ' + e.message }); }
    }

    // re-apply a previously-uploaded asset to ANOTHER slot, re-fit to THAT slot's spec — no re-upload.
    if (url === '/__clone/library-apply') {
      if (body.number == null || !body.libraryId) return sendJson(res, 400, { error: 'need {number, libraryId}' });
      const assetsDir = join(REPURPOSE_DIR, 'assets');
      const lib = await libraryRead(assetsDir);
      const item = lib.items.find((x) => x.id === body.libraryId);
      if (!item) return sendJson(res, 404, { error: 'no library item ' + body.libraryId });
      const rawAbs = join(assetsDir, item.raw);
      if (!(await exists(rawAbs))) return sendJson(res, 410, { error: 'library asset bytes missing (re-upload)' });
      const r = spawnSync(process.execPath, [FIT_SLOT, '--slot', String(body.number), '--in', rawAbs, '--manifest', MANIFEST, '--out', assetsDir], { encoding: 'utf8' });
      if (r.status !== 0) return sendJson(res, 500, { error: 'fit-slot failed', detail: (r.stderr || '').slice(-400) });
      let out; try { out = JSON.parse(r.stdout); } catch { return sendJson(res, 500, { error: 'fit-slot bad output', detail: r.stdout.slice(-400) }); }
      return sendJson(res, 200, out);
    }
  }
  return sendJson(res, 404, { error: 'unknown __clone route' });
}

// ---- asset library: a content-addressed index of uploaded originals so they can be reused without re-upload ----
function libraryPath(assetsDir) { return join(assetsDir, '_library', 'index.json'); }
async function libraryRead(assetsDir) { try { return JSON.parse(await readFile(libraryPath(assetsDir), 'utf8')); } catch { return { schema: 1, items: [] }; } }
async function libraryAdd(assetsDir, entry) {
  const lib = await libraryRead(assetsDir);
  if (!lib.items.some((x) => x.id === entry.id)) { lib.items.push(entry); }
  else { const i = lib.items.findIndex((x) => x.id === entry.id); if (entry.previewRef) lib.items[i].previewRef = entry.previewRef; } // refresh preview
  await mkdir(dirname(libraryPath(assetsDir)), { recursive: true });
  const tmp = libraryPath(assetsDir) + '.tmp'; await writeFile(tmp, JSON.stringify(lib, null, 2)); await rename(tmp, libraryPath(assetsDir));
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
