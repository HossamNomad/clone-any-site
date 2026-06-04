#!/usr/bin/env node
// serve-repurpose.mjs — Composer server. Static-serves the mirror, but: rewrites the entry HTML (CDN->/__swap,
// SW kill, DOM-swap injection), serves /__swap/<id>[/<frame>] from the transcoded swaps, neutralizes /sw.js.
import http from 'node:http';
import { readFile, readFileSync, existsSync, readdirSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { rewriteEntryHtml } from './lib/compose-rewrite.mjs';
const A = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>{ if(v.startsWith('--')) a.push([v.slice(2),arr[i+1]]); return a; },[]));
const CLONE = A.clone, MIRROR = A.mirror, ENTRY = A.entry || '/index.html';
const PORT = Number(process.env.CLONE_SERVE_PORT || A.port || 0);
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm','.svg':'image/svg+xml','.woff2':'font/woff2','.glb':'model/gltf-binary' };
const loadJson = (p) => existsSync(p) ? JSON.parse(readFileSync(p,'utf8')) : null;

// Serve a buffer with HTTP Range support (so browsers can seek/loop swapped <video>).
// Parses simple single-range forms: bytes=START-END | bytes=START- | bytes=-SUFFIX.
export function rangeRespond(req, res, buf, mime) {
  const total = buf.length;
  const ct = mime || 'application/octet-stream';
  const range = req && req.headers && req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': total, 'Content-Type': ct });
    return res.end(buf);
  }
  let start, end;
  if (m[1] === '') {
    // suffix form: bytes=-N  → last N bytes
    const suffix = Number(m[2]);
    start = total - suffix;
    if (start < 0) start = 0;
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Number(m[2]);
  }
  if (end > total - 1) end = total - 1;
  if (start > end || start >= total) {
    res.writeHead(416, { 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes */' + total, 'Content-Type': ct });
    return res.end();
  }
  const chunkLen = end - start + 1;
  res.writeHead(206, {
    'Accept-Ranges': 'bytes',
    'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    'Content-Length': chunkLen,
    'Content-Type': ct
  });
  return res.end(buf.subarray(start, end + 1));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const map = loadJson(join(CLONE,'repurpose','MAP.json')) || { slots: [] };
    const swaps = loadJson(join(CLONE,'swaps','swaps.json')) || {};
    // folder-drop: a bare swaps/<SLOT-ID>.<ext> (top-level, not under .generated/) is auto-picked-up
    // even without a swaps.json entry — so Hossam can just drop a file named after a slot id.
    try {
      for (const f of readdirSync(join(CLONE, 'swaps'))) {
        const m = f.match(/^([A-Za-z]+-\d+)\.(webp|png|jpe?g|avif|mp4|webm|mov)$/i);
        if (m && !swaps[m[1]]) swaps[m[1]] = { type: /mp4|webm|mov/i.test(m[2]) ? 'video' : 'image', file: f };
      }
    } catch {}
    // neutralize the mirror's service worker
    if (url === '/sw.js') { res.writeHead(200,{'content-type':'text/javascript'}); return res.end('/* sw disabled */'); }
    // swap byte endpoint: /__swap/<id> or /__swap/<id>/<frame>
    if (url.startsWith('/__swap/')) {
      const [, , id, frame] = url.split('/'); const sw = swaps[id]; if (!sw) { res.writeHead(404); return res.end(); }
      const file = sw.file || (sw.frames && sw.frames[Number(frame)||0]);
      const abs = join(CLONE, 'swaps', file); const buf = await readFileP(abs);
      return rangeRespond(req, res, buf, MIME[extname(abs)]||'application/octet-stream');
    }
    if (url === '/__map.json') { res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(map)); }
    // entry html -> rewrite
    const isEntry = url === '/' || url === ENTRY || url.endsWith('/index.html');
    const rel = url === '/' ? ENTRY : url;
    const abs = join(MIRROR, rel);
    if (isEntry && existsSync(abs)) {
      let html = await readFileP(abs, 'utf8'); html = rewriteEntryHtml(html, map, swaps);
      res.writeHead(200,{'content-type':'text/html'}); return res.end(html);
    }
    if (existsSync(abs)) { res.writeHead(200,{'content-type':MIME[extname(abs)]||'application/octet-stream'}); return res.end(await readFileP(abs)); }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
if (!process.env.CLONE_NO_LISTEN) {
  server.listen(PORT, '127.0.0.1', () => { console.log('CLONE_PORT=' + server.address().port); console.log('repurpose server (loopback only)'); });
}
