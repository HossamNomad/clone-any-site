// Zero-dependency loopback static server for the INTERNAL mirror (Phase C).
// Serves a folder on 127.0.0.1 ONLY. Supports HTTP Range (so seekable <video> works in the
// fidelity gate) and, if a sw.js sits at the served root, serves it at root scope and injects
// a registration snippet into HTML on the fly (folds the old "rewrite-runtime" step in here).
//
// Usage:
//   node serve.mjs ./mirror/www.example.com
//   CLONE_SERVE_ROOT=./mirror/www.example.com CLONE_SERVE_PORT=4321 node serve.mjs
//
// NEVER bind to 0.0.0.0 or deploy this publicly under the original brand. Loopback only.

import { createServer } from 'node:http';
import { stat, readFile, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';

const ROOT = normalize(process.env.CLONE_SERVE_ROOT || process.argv[2] || '.');
const PORT = Number(process.env.CLONE_SERVE_PORT || 4321);
const HOSTNAME = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.hdr': 'image/vnd.radiance',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
};
const ctype = (p) => TYPES[extname(p).toLowerCase()] || 'application/octet-stream';

const exists = (p) => access(p).then(() => true).catch(() => false);
let hasSW = false; // resolved at boot

// Map URL -> file path; default index.html for dirs, and /foo -> foo.html when bare.
async function resolveFile(pathname) {
  let p = decodeURIComponent(pathname.split('?')[0]);
  // prevent path traversal
  const safe = normalize(join(ROOT, p)).startsWith(normalize(ROOT) + sep) || normalize(join(ROOT, p)) === normalize(ROOT);
  if (!safe) return null;
  let fp = join(ROOT, p);
  try {
    const s = await stat(fp);
    if (s.isDirectory()) fp = join(fp, 'index.html');
  } catch {
    if (!extname(fp) && await exists(fp + '.html')) fp += '.html';
  }
  return (await exists(fp)) ? fp : null;
}

const SW_SNIPPET = `<script>if('serviceWorker'in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}</script>`;

const server = createServer(async (req, res) => {
  try {
    const fp = await resolveFile(req.url);
    if (!fp) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }

    const type = ctype(fp);
    const isSW = fp.toLowerCase().endsWith(`${sep}sw.js`) || fp.toLowerCase().endsWith('/sw.js');
    const isHTML = type.startsWith('text/html');

    // HTML: read fully so we can inject SW registration (cheap; pages are small).
    if (isHTML) {
      let body = await readFile(fp, 'utf8');
      if (hasSW && !/serviceWorker\.register/.test(body)) {
        body = body.includes('</body>') ? body.replace('</body>', SW_SNIPPET + '</body>') : body + SW_SNIPPET;
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    const s = await stat(fp);
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    if (isSW) headers['Service-Worker-Allowed'] = '/';

    // Range support (video seeking / large assets)
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : s.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= s.size) end = s.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': end - start + 1 });
      createReadStream(fp, { start, end }).pipe(res);
      return;
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
    console.log(`serving ${ROOT}\n  -> http://${HOSTNAME}:${PORT}/  ${hasSW ? '(sw.js active, registration injected into HTML)' : ''}`);
    console.log('  loopback only — do NOT expose publicly.');
  });
})();
