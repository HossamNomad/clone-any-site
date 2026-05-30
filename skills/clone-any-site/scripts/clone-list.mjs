// clone-list.mjs — live loopback DASHBOARD for every clone in a clones/ root.
// Zero runtime deps (Node 18+ built-ins). Playwright is OPTIONAL (only to generate a missing thumbnail).
//
//   node clone-list.mjs [clonesRoot]            # default ./clones
//   CLONE_LIST_PORT=4500 node clone-list.mjs    # fixed port (default 4500; 0 = ephemeral)
//
// Scans all clones (best-effort, tolerant of heterogeneous layouts), serves a card gallery, and exposes a
// loopback JSON API to Open / Edit / Stop each clone's mirror server, and to retire clones to a RECOVERABLE
// trash (clones/_trash/<name>-<ts>/ — never a real rm on a click).
//
// LOOPBACK ONLY (127.0.0.1). Never bind 0.0.0.0; never deploy.

import { createServer } from 'node:http';
import { stat, readFile, readdir, mkdir, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, basename, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GALLERY = join(HERE, 'editor', 'gallery.html');
const SERVE = join(HERE, 'serve.mjs');
const CLONES_ROOT = normalize(process.env.CLONE_LIST_ROOT || process.argv[2] || join(process.cwd(), 'clones'));
const PORT = process.env.CLONE_LIST_PORT != null ? Number(process.env.CLONE_LIST_PORT) : 4500;
const HOSTNAME = '127.0.0.1';
const TRASH_DIR = join(CLONES_ROOT, '_trash');

const RESERVED = new Set(['_trash', '_archive', 'node_modules']);
const exists = (p) => access(p).then(() => true).catch(() => false);

// ====================================================================================================
// scanClones(root) — PURE, defensive. Never throws on a malformed/partial clone. Returns clone records.
// ====================================================================================================
const FIDELITY_DIRS = [['docs', 'fidelity'], ['engine', 'fidelity'], ['_recon', 'fidelity']];

async function readJsonSafe(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

async function findFirst(dir, names) {
  for (const n of names) { const p = join(dir, n); if (await exists(p)) return p; }
  return null;
}

// most-recently-modified fidelity-report.md across the 3 known locations
async function findFidelityReport(cloneDir) {
  let best = null;
  for (const parts of FIDELITY_DIRS) {
    const p = join(cloneDir, ...parts, 'fidelity-report.md');
    if (await exists(p)) {
      try { const s = await stat(p); if (!best || s.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: s.mtimeMs }; } catch {}
    }
  }
  return best;
}
function parseFidelity(md) {
  const verdict = /Verdict:\s*(?:✅\s*)?PASS/i.test(md) ? 'PASS' : (/Verdict:\s*(?:❌\s*)?FAIL/i.test(md) ? 'FAIL' : null);
  const m = /mean SSIM\s*\*\*?\s*([0-9.]+)/i.exec(md) || /mean SSIM[^0-9]*([0-9.]+)/i.exec(md);
  return { verdict, meanSsim: m ? Number(m[1]) : null };
}

// the dir under mirror/ that holds an index.html (host folder), if any
async function findMirror(cloneDir) {
  const mdir = join(cloneDir, 'mirror');
  if (!(await exists(mdir))) return null;
  if (await exists(join(mdir, 'index.html'))) return mdir;
  let entries = [];
  try { entries = await readdir(mdir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const host = join(mdir, e.name);
    if (await exists(join(host, 'index.html'))) return host;
  }
  return null;
}

async function sourceUrlOf(cloneDir, mirrorPath) {
  // 1) any mirror/*.crawl-log.json .target
  const mdir = join(cloneDir, 'mirror');
  if (await exists(mdir)) {
    let entries = [];
    try { entries = await readdir(mdir); } catch {}
    for (const f of entries) {
      if (f.endsWith('.crawl-log.json')) {
        const j = await readJsonSafe(join(mdir, f));
        if (j && (j.target || j.origin)) return j.target || j.origin;
      }
    }
  }
  // 2) _recon/capture-preconditions.json (any url-ish field)
  const cap = await readJsonSafe(join(cloneDir, '_recon', 'capture-preconditions.json'));
  if (cap) {
    const v = cap.url || cap.href || cap.origin || cap.target || (cap.reference && (cap.reference.url || cap.reference));
    if (typeof v === 'string') return v;
  }
  // 3) derive from mirror host dir name
  if (mirrorPath) { const host = basename(mirrorPath); if (host.includes('.')) return 'https://' + host; }
  return null;
}

// bounded recursive byte size (skips node_modules / .git; caps file count to stay fast)
async function dirSize(dir, cap = 6000) {
  let total = 0, count = 0;
  async function walk(d) {
    if (count >= cap) return;
    let entries = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count >= cap) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { await walk(p); }
      else { try { const s = await stat(p); total += s.size; count++; } catch {} }
    }
  }
  await walk(dir);
  return { bytes: total, capped: count >= cap };
}

async function scanOne(name, cloneDir) {
  const rec = { name, dir: cloneDir };
  try {
    const mirrorPath = await findMirror(cloneDir);
    rec.mirrorPath = mirrorPath;
    rec.host = mirrorPath ? basename(mirrorPath) : null;
    rec.servable = !!mirrorPath;
    rec.sourceUrl = await sourceUrlOf(cloneDir, mirrorPath);

    const fr = await findFidelityReport(cloneDir);
    if (fr) { try { rec.fidelity = parseFidelity(await readFile(fr.path, 'utf8')); } catch { rec.fidelity = null; } }
    else rec.fidelity = null;

    const manifestPath = join(cloneDir, 'repurpose', 'manifest.json');
    rec.editable = await exists(manifestPath);
    rec.repurposeDir = rec.editable ? join(cloneDir, 'repurpose') : null;
    if (rec.editable) {
      const m = await readJsonSafe(manifestPath);
      if (m && Array.isArray(m.slots)) {
        rec.manifest = {
          elements: m.slots.length,
          swaps: m.slots.filter((s) => s && (s.replacement || s.keep)).length,
        };
      } else rec.manifest = { elements: 0, swaps: 0 };
    } else rec.manifest = null;

    rec.hasRepurpose = (await exists(join(cloneDir, 'pulsia'))) || (await exists(join(cloneDir, 'repurpose', 'build'))) || (await exists(join(cloneDir, 'mirror-pulsia')));

    const size = await dirSize(cloneDir);
    rec.sizeBytes = size.bytes;
    rec.sizeCapped = size.capped;

    try { rec.modifiedAt = (await stat(cloneDir)).mtime.toISOString(); } catch { rec.modifiedAt = null; }

    rec.thumb = `/api/thumb/${encodeURIComponent(name)}`;
    rec.ok = true;
  } catch (e) {
    rec.ok = false; rec.error = String(e && e.message || e);
  }
  return rec;
}

export async function scanClones(root = CLONES_ROOT) {
  if (!(await exists(root))) return [];
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const dirs = entries.filter((e) => e.isDirectory() && !RESERVED.has(e.name) && !e.name.startsWith('.'));
  const recs = await Promise.all(dirs.map((e) => scanOne(e.name, join(root, e.name))));
  recs.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
  return recs;
}

// ====================================================================================================
// portManager — ephemeral free-port allocation (bind :0, read back) + child process registry
// ====================================================================================================
export function makePortManager() {
  const running = new Map(); // name -> { proc, port, mode, startedAt }

  async function freePort() {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.on('error', reject);
      srv.listen(0, HOSTNAME, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
  }

  function start(name, cloneDir, mirrorPath, mode = 'open') {
    return new Promise(async (resolve, reject) => {
      if (running.has(name)) return resolve(running.get(name));
      if (!mirrorPath) return reject(new Error('not servable (mirror payload absent) — re-crawl this clone'));
      const env = { ...process.env, CLONE_SERVE_PORT: '0' };
      if (mode === 'edit') {
        const repurpose = join(cloneDir, 'repurpose');
        env.CLONE_EDIT = '1'; env.CLONE_LOOPBACK_OK = '1'; env.CLONE_REPURPOSE_DIR = repurpose;
      } else { env.CLONE_EDIT = ''; env.CLONE_LOOPBACK_OK = ''; env.CLONE_REPURPOSE_DIR = ''; }
      const proc = spawn(process.execPath, [SERVE, mirrorPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', done = false;
      const to = setTimeout(() => { if (!done) { done = true; proc.kill(); reject(new Error('serve boot timeout')); } }, 15000);
      proc.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/CLONE_PORT=(\d+)/);
        if (m && !done) {
          done = true; clearTimeout(to);
          const entry = { proc, port: Number(m[1]), mode, startedAt: new Date().toISOString() };
          running.set(name, entry);
          proc.on('exit', () => { const cur = running.get(name); if (cur && cur.proc === proc) running.delete(name); });
          resolve(entry);
        }
      });
      proc.on('error', (e) => { if (!done) { done = true; clearTimeout(to); reject(e); } });
    });
  }
  function stop(name) {
    const e = running.get(name);
    if (!e) return false;
    try { e.proc.kill(); } catch {}
    running.delete(name);
    return true;
  }
  function stopAll() { for (const name of [...running.keys()]) stop(name); }
  function status() {
    const out = {};
    for (const [name, e] of running) out[name] = { port: e.port, mode: e.mode, url: `http://${HOSTNAME}:${e.port}/`, startedAt: e.startedAt };
    return out;
  }
  return { freePort, start, stop, stopAll, status, running };
}

// ====================================================================================================
// trash — move a clone to clones/_trash/<name>-<ts>/  (recoverable). restore moves it back.
// ====================================================================================================
function tsStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

export async function trashClone(name, root = CLONES_ROOT) {
  const trashDir = join(root, '_trash');
  const src = join(root, name);
  if (!(await exists(src))) throw new Error('no such clone: ' + name);
  await mkdir(trashDir, { recursive: true });
  const dest = join(trashDir, `${name}-${tsStamp()}`);
  await rename(src, dest);
  return { name, trashedTo: basename(dest) };
}
export async function restoreClone(trashName, root = CLONES_ROOT) {
  const src = join(root, '_trash', trashName);
  if (!(await exists(src))) throw new Error('no such trash entry: ' + trashName);
  const orig = trashName.replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z?$/, '');
  let dest = join(root, orig);
  if (await exists(dest)) dest = join(root, `${orig}-restored-${tsStamp()}`);
  await rename(src, dest);
  return { restored: basename(dest) };
}
export async function listTrash(root = CLONES_ROOT) {
  const td = join(root, '_trash');
  if (!(await exists(td))) return [];
  let entries = [];
  try { entries = await readdir(td, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let mtime = null, bytes = 0;
    try { mtime = (await stat(join(td, e.name))).mtime.toISOString(); } catch {}
    try { bytes = (await dirSize(join(td, e.name), 3000)).bytes; } catch {}
    out.push({ trashName: e.name, modifiedAt: mtime, sizeBytes: bytes });
  }
  out.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
  return out;
}

// ====================================================================================================
// thumbnails — reuse an existing screenshot if present; else SVG placeholder. (Generation is opt-in.)
// ====================================================================================================
const THUMB_CANDIDATES = [
  ['_recon', 'clone-list-thumb.png'],
  ['_recon', 'fidelity', 'mir-0.png'], ['_recon', 'fidelity', 'ref-0.png'],
  ['docs', 'fidelity', 'mir-0.png'], ['engine', 'fidelity', 'mir-0.png'],
];
async function thumbPath(cloneDir) {
  for (const parts of THUMB_CANDIDATES) { const p = join(cloneDir, ...parts); if (await exists(p)) return p; }
  // any png inside a fidelity dir
  for (const parts of FIDELITY_DIRS) {
    const d = join(cloneDir, ...parts);
    if (await exists(d)) {
      let files = [];
      try { files = await readdir(d); } catch {}
      const png = files.find((f) => /^(mir|ref|shot|thumb).*\.png$/i.test(f)) || files.find((f) => f.endsWith('.png'));
      if (png) return join(d, png);
    }
  }
  return null;
}
function placeholderSvg(name, servable) {
  const sub = servable ? 'mirror ready' : 'payload absent — re-crawl';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
<rect width="480" height="300" fill="#15171c"/>
<rect x="0" y="0" width="480" height="300" fill="url(#g)" opacity="0.5"/>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#0b0d10"/></linearGradient></defs>
<text x="240" y="148" fill="#e5e7eb" font-family="system-ui,sans-serif" font-size="26" font-weight="600" text-anchor="middle">${escapeXml(name)}</text>
<text x="240" y="178" fill="#9ca3af" font-family="system-ui,sans-serif" font-size="14" text-anchor="middle">${escapeXml(sub)}</text>
</svg>`;
}
function escapeXml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

// ====================================================================================================
// HTTP API + static gallery
// ====================================================================================================
const CT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req, max = 1 << 20) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', (c) => { len += c.length; if (len > max) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function safeName(n) { return String(n || '').replace(/[^A-Za-z0-9._-]/g, ''); }

export function createDashboard(root = CLONES_ROOT) {
  const pm = makePortManager();

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${HOSTNAME}`);
      const path = u.pathname;

      if (path === '/' || path === '/index.html') {
        if (!(await exists(GALLERY))) { res.writeHead(500); res.end('gallery.html missing'); return; }
        res.writeHead(200, { 'Content-Type': CT['.html'], 'Cache-Control': 'no-store' });
        createReadStream(GALLERY).pipe(res); return;
      }

      if (path === '/api/clones' && req.method === 'GET') return sendJson(res, 200, { root, clones: await scanClones(root) });
      if (path === '/api/status' && req.method === 'GET') return sendJson(res, 200, pm.status());
      if (path === '/api/trash-list' && req.method === 'GET') return sendJson(res, 200, { trash: await listTrash(root) });

      if (path.startsWith('/api/thumb/') && req.method === 'GET') {
        const name = safeName(decodeURIComponent(path.slice('/api/thumb/'.length)));
        const cloneDir = join(root, name);
        const tp = (await exists(cloneDir)) ? await thumbPath(cloneDir) : null;
        if (tp) { res.writeHead(200, { 'Content-Type': CT[extname(tp).toLowerCase()] || 'image/png', 'Cache-Control': 'no-store' }); createReadStream(tp).pipe(res); return; }
        const servable = (await exists(cloneDir)) ? !!(await findMirror(cloneDir)) : false;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        res.end(placeholderSvg(name, servable)); return;
      }

      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (path === '/api/start') {
          const name = safeName(body.name);
          const cloneDir = join(root, name);
          if (!(await exists(cloneDir))) return sendJson(res, 404, { error: 'no such clone' });
          const mirrorPath = await findMirror(cloneDir);
          if (!mirrorPath) return sendJson(res, 409, { error: 'not servable — mirror payload absent, re-crawl this clone' });
          if (body.mode === 'edit' && !(await exists(join(cloneDir, 'repurpose', 'manifest.json')))) return sendJson(res, 409, { error: 'no edit-map — run /clone-map first' });
          try { const e = await pm.start(name, cloneDir, mirrorPath, body.mode === 'edit' ? 'edit' : 'open'); return sendJson(res, 200, { url: `http://${HOSTNAME}:${e.port}/`, port: e.port, mode: e.mode }); }
          catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
        }
        if (path === '/api/stop') return sendJson(res, 200, { stopped: pm.stop(safeName(body.name)) });
        if (path === '/api/stop-all') { pm.stopAll(); return sendJson(res, 200, { ok: true }); }
        if (path === '/api/trash') {
          const names = (Array.isArray(body.names) ? body.names : []).map(safeName).filter(Boolean);
          const moved = [];
          for (const n of names) { pm.stop(n); try { moved.push(await trashClone(n, root)); } catch (e) { moved.push({ name: n, error: String(e.message || e) }); } }
          return sendJson(res, 200, { moved });
        }
        if (path === '/api/restore') { try { return sendJson(res, 200, await restoreClone(safeName(body.trashName), root)); } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); } }
        return sendJson(res, 404, { error: 'unknown route' });
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404');
    } catch (e) {
      try { sendJson(res, 500, { error: String(e && e.message || e) }); } catch {}
    }
  });

  const shutdown = () => { try { pm.stopAll(); } catch {} };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });

  return { server, pm };
}

// ---- boot (skip when imported by tests) ----
const isMain = process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
if (isMain) {
  (async () => {
    if (!(await exists(CLONES_ROOT))) { console.error('clones root not found:', CLONES_ROOT); process.exit(1); }
    const { server } = createDashboard(CLONES_ROOT);
    server.listen(PORT, HOSTNAME, () => {
      const p = server.address().port;
      console.log('CLONE_LIST_PORT=' + p);
      console.log(`clone-list dashboard — scanning ${CLONES_ROOT}\n  -> http://${HOSTNAME}:${p}/`);
      console.log('  loopback only — Open/Edit/Stop clones, recoverable trash. Ctrl-C to stop (kills child servers).');
    });
  })();
}
