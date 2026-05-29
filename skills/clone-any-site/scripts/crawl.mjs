// Pure-Node recursive static-graph crawler — generalized, ZERO dependencies.
// Phase C of the clone-any-site workflow: mirror a site's COMPILED build into a
// loopback-only INTERNAL reference. Replicates wget --mirror/--page-requisites/--convert-links
// without any install (wget is absent on Windows by default; this never hangs on an installer).
//
// Usage:
//   CLONE_TARGET="https://www.example.com" node crawl.mjs
//   CLONE_TARGET="https://www.example.com" CLONE_OUT="./mirror" CLONE_SEEDS="/,/about,/pricing" node crawl.mjs
//   node crawl.mjs https://www.example.com            # target as positional arg
//
// Output: <CLONE_OUT default ./mirror>/<host>/...  + <CLONE_OUT>/<host>.crawl-log.json
// Then serve that folder on 127.0.0.1 with serve.mjs.
//
// HARD RULE: the mirror is INTERNAL/loopback only. Gitignore it. NEVER deploy it publicly
// under the original brand. Only the repurposed Phase B artifact (your own content) ships.

import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';

const TARGET = process.env.CLONE_TARGET || process.argv[2];
if (!TARGET) { console.error('Set CLONE_TARGET="https://host" (or pass as arg 1).'); process.exit(1); }

const u0 = new URL(TARGET);
const ORIGIN = u0.origin;
const HOST = u0.host;                         // www.example.com
const APEX = HOST.replace(/^www\./, '');      // example.com
const HOSTS = new Set([HOST, APEX, 'www.' + APEX]);
const OUT_ROOT = process.env.CLONE_OUT || './mirror';
const OUT = join(OUT_ROOT, HOST);
const SEEDS = (process.env.CLONE_SEEDS ? process.env.CLONE_SEEDS.split(',') : ['/'])
  .map((s) => s.trim()).filter(Boolean).map((s) => new URL(s, ORIGIN).href);
const UA = process.env.CLONE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CONCURRENCY = Number(process.env.CLONE_CONCURRENCY || 5);

const SKIP = [/\/api(\/|$)/, /\/_next\/data\//, /\/_next\/webpack-hmr/, /\/_next\/image/, /^blob:/, /[?&]_rsc=/];
const isSkip = (u) => SKIP.some((re) => re.test(u));

// host alternation for regex (escaped dots)
const HOST_ALT = [...HOSTS].map((h) => h.replace(/\./g, '\\.')).join('|');
const BARE_RE = new RegExp(
  `["'\\\\]+((?:https:\\/\\/(?:${HOST_ALT}))?\\/[A-Za-z0-9_\\-./%@]+\\.(?:webp|svg|png|jpe?g|gif|glb|gltf|hdr|woff2?|ttf|otf|ico|css|js|mjs|json|mp4|webm))`,
  'gi'
);

// ---- tiny concurrency pool (no p-limit dep) ----
async function pool(items, n, worker) {
  const q = [...items];
  const runners = Array.from({ length: Math.min(n, q.length || 1) }, async () => {
    while (q.length) { const it = q.shift(); await worker(it); }
  });
  await Promise.all(runners);
}

// URL -> on-disk absolute path under OUT (decoded; strips query)
function diskPath(u) {
  const url = new URL(u, ORIGIN);
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  else if (!extname(p)) p += '.html'; // route docs: /about -> about.html
  return join(OUT, p.replace(/^\//, ''));
}
function sameHost(u) { try { return HOSTS.has(new URL(u, ORIGIN).host); } catch { return false; } }
function absUrl(u) { try { return new URL(u, ORIGIN).href.split('#')[0]; } catch { return null; } }

function startsWithHost(s) {
  return [...HOSTS].some((h) => s.startsWith('https://' + h) || s.startsWith('http://' + h));
}

// extract candidate same-host URLs from HTML / CSS / JS text
function extractRefs(text) {
  const out = new Set();
  const add = (raw) => {
    if (!raw) return;
    let s = raw.trim().replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (!s || s.startsWith('data:') || s.startsWith('#') || s.startsWith('mailto:') || s.startsWith('tel:')) return;
    if (s.startsWith('//')) s = 'https:' + s;
    if (s.startsWith('/') || startsWithHost(s)) {
      const a = absUrl(s);
      if (a && sameHost(a) && !isSkip(a)) out.add(a);
    }
  };
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["'\\]+([^"'\\>]+)/gi)) add(m[1]);
  for (const m of text.matchAll(/srcset\s*=\s*["'\\]+([^"'>]+)/gi))
    m[1].split(',').forEach((c) => add(c.trim().split(/\s+/)[0]));
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(m[1]);
  for (const m of text.matchAll(BARE_RE)) add(m[1]);
  return [...out];
}

const seen = new Set();
const log = { target: ORIGIN, pages: [], assets: [], failed: [], rewritten: 0 };

async function fetchBuf(u) {
  const reqUrl = encodeURI(decodeURIComponent(u)); // normalize spaces
  const res = await fetch(reqUrl, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok && res.status !== 304) throw new Error('HTTP ' + res.status);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, ct };
}
async function save(u, buf) {
  const dest = diskPath(u);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}
async function processUrl(u, { parse }) {
  if (seen.has(u)) return [];
  seen.add(u);
  try {
    const { buf, ct } = await fetchBuf(u);
    const dest = await save(u, buf);
    const isText = parse && /text\/html|css|javascript|json/.test(ct);
    const rel = dest.replace(OUT, '').replace(/\\/g, '/');
    (parse ? log.pages : log.assets).push({ u, rel, bytes: buf.length });
    if (isText) return extractRefs(buf.toString('utf8'));
    return [];
  } catch (e) {
    log.failed.push({ u, err: String(e.message || e) });
    return [];
  }
}

// ---- rewrite absolute same-host URLs -> root-relative, in saved HTML/CSS ----
async function* walk(dir) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) yield* walk(p);
    else yield p;
  }
}
async function rewriteAll() {
  const res = [...HOSTS].map((h) => new RegExp('https?:\\/\\/' + h.replace(/\./g, '\\.'), 'g'));
  const esc = [...HOSTS].map((h) => new RegExp('\\\\\\/\\\\\\/' + h.replace(/\./g, '\\.'), 'g')); // escaped \/\/host in JSON
  for await (const f of walk(OUT)) {
    if (!/\.(html?|css)$/i.test(f)) continue;
    let t = await readFile(f, 'utf8');
    const before = t;
    for (const re of res) t = t.replace(re, '');
    for (const re of esc) t = t.replace(re, '');
    if (t !== before) { await writeFile(f, t); log.rewritten++; }
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Optional: seed extra same-host assets from a recon manifest if present (clones-style).
  let manifestAssets = [];
  try {
    const m = JSON.parse(await readFile(join(OUT_ROOT, '..', '_recon', 'asset-manifest.json'), 'utf8'));
    manifestAssets = [
      ...(m.css || []),
      ...((m.jsChunks && m.jsChunks.observed) || []),
      ...(m.fonts || []), ...(m.svg || []), ...(m.publicWebp || []),
      ...((m.optimizerImages && m.optimizerImages.entries) || []).map((e) => e.source),
      m.favicon, m.model3d && m.model3d.url,
    ].filter(Boolean).map(absUrl).filter((u) => u && sameHost(u) && !isSkip(u));
  } catch { /* no manifest — fine, the crawler discovers refs itself */ }

  // BFS: pages first (parsed for refs), then asset frontier, then a final non-parsed sweep.
  const discovered = [];
  await pool(SEEDS, CONCURRENCY, async (u) => { discovered.push(...await processUrl(u, { parse: true })); });

  const assetQueue = [...new Set([...manifestAssets, ...discovered])].filter((u) => !seen.has(u));
  const round2 = [];
  await pool(assetQueue, CONCURRENCY, async (u) => {
    round2.push(...await processUrl(u, { parse: /\.(css|js|mjs)$/i.test(new URL(u).pathname) }));
  });

  const more = [...new Set(round2)].filter((u) => !seen.has(u) && !isSkip(u) && sameHost(u));
  await pool(more, CONCURRENCY, async (u) => { await processUrl(u, { parse: false }); });

  await rewriteAll();

  log.summary = {
    pages: log.pages.length, assets: log.assets.length, failed: log.failed.length, rewritten: log.rewritten,
    totalBytes: [...log.pages, ...log.assets].reduce((a, x) => a + x.bytes, 0),
  };
  const logPath = join(OUT_ROOT, HOST + '.crawl-log.json');
  await writeFile(logPath, JSON.stringify(log, null, 2));
  console.log('CRAWL DONE', JSON.stringify(log.summary), '\n  out:', OUT, '\n  log:', logPath);
  if (log.failed.length) console.log('FAILED:', log.failed.map((f) => f.u.replace(ORIGIN, '') + ' (' + f.err + ')').join(', '));
}
main().catch((e) => { console.error('CRAWL FATAL', e); process.exit(1); });
