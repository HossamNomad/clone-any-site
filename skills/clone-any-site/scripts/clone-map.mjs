#!/usr/bin/env node
// clone-map.mjs — visual map + manual generator for a clone.
//
// After a site is cloned you have a MAP.json with numbered slots (IMG-1, VID-2,
// TITLE-3 ...) but no way to SEE which slot is which on the actual page. This
// builds:
//   repurpose/VISUAL-MAP.png   — full-page screenshot of the rewritten clone
//   repurpose/VISUAL-MAP.html  — that screenshot with a numbered, color-coded
//                                badge over every slot + a clickable table
//   repurpose/MANUAL.md / .html — the folder-drop edit workflow, color legend,
//                                slots-by-type, text/title editing, the
//                                "animations are locked" rule
//   repurpose/ANIM-LOCK.json   — the PRISTINE animation baseline census the
//                                verifier compares post-swap against. Because
//                                of this baseline, clone-map MUST run BEFORE
//                                any swap is applied.
//
// Deterministic: no Date.now / Math.random. opts.now stamps the output.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCensus } from './lib/anim-census.mjs';
import { COLORS, PREFIX } from './lib/slot-infer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// repoRoot = 4 dirs up from this script:
// scripts -> clone-any-site -> skills -> .claude -> hossam2(root)
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

// ---- legend (label + color per type) — keyed off slot-infer so they stay in sync
const TYPES = ['image', 'video', 'sequence', 'title', 'text'];
const LEGEND = TYPES.map((t) => ({ type: t, prefix: PREFIX[t], color: COLORS[t] }));
const LEGEND_LABEL = {
  image: 'IMG — image',
  video: 'VID — video / clip',
  sequence: 'SEQ — image sequence',
  title: 'TITLE — heading',
  text: 'TXT — body / label text'
};
const ACCEPTED_EXT = {
  image: '.webp .png .jpg .jpeg .avif',
  video: '.mp4 .webm .mov',
  sequence: '.webp .png .jpg (one numbered file per frame)',
  title: '(text — edit swaps.json)',
  text: '(text — edit swaps.json)'
};

// ---------- helpers ----------
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function trunc(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function loadJson(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
function constraintSummary(slot) {
  const c = slot.constraints || {};
  const parts = [];
  if (slot.type === 'title' || slot.type === 'text') {
    if (c.charLen != null) parts.push(`~${c.charLen} chars`);
  } else {
    if (c.aspectRatio) parts.push(c.aspectRatio);
    if (c.w && c.h) parts.push(`${c.w}×${c.h}px`);
    if (slot.type === 'video' && c.durationSec) parts.push(`${c.durationSec}s`);
    if (slot.type === 'sequence' && c.frameCount) parts.push(`${c.frameCount} frames`);
  }
  return parts.join(' · ') || '—';
}
function dropLine(slot, site) {
  if (slot.type === 'title' || slot.type === 'text') {
    return `edit swaps.json (set "${slot.id}" → your text)`;
  }
  if (slot.type === 'sequence') {
    return `advanced — see Sequences section (not a one-shot drop)`;
  }
  const ext = slot.type === 'video' ? 'mp4' : 'jpg';
  return `➜ drop \`${slot.id}.${ext}\` in clones/${site}/swaps/`;
}

// auto-detect the mirror subdir under <cloneDir>/mirror/
function detectMirror(cloneDir) {
  const mirrorRoot = join(cloneDir, 'mirror');
  if (!existsSync(mirrorRoot)) {
    throw new Error(`no mirror/ directory under ${cloneDir}`);
  }
  const subs = readdirSync(mirrorRoot).filter((n) => {
    try {
      return statSync(join(mirrorRoot, n)).isDirectory();
    } catch {
      return false;
    }
  });
  if (subs.length === 0) {
    throw new Error(`mirror/ has no subdirectory under ${cloneDir}`);
  }
  if (subs.length === 1) return join(mirrorRoot, subs[0]);
  // multiple — prefer one that looks like a host (has a dot, no leading underscore)
  const hostish = subs.filter((n) => n.includes('.') && !n.startsWith('_'));
  if (hostish.length === 1) return join(mirrorRoot, hostish[0]);
  throw new Error(
    `mirror/ has ${subs.length} subdirectories (${subs.join(', ')}); pass --mirror explicitly`
  );
}

// derive the entry html path from MAP.json meta.url
function detectEntry(map) {
  let path = '/index.html';
  try {
    const u = new URL(map?.meta?.url || '');
    path = u.pathname || '/';
  } catch {
    // meta.url may be a bare path like '/index.html' or '/fr/'
    const raw = map?.meta?.url;
    if (typeof raw === 'string' && raw.startsWith('/')) path = raw;
  }
  if (path.endsWith('/')) path += 'index.html';
  if (!/\.[a-z0-9]+$/i.test(path)) path = path.replace(/\/?$/, '/') + 'index.html';
  return path;
}

// spawn serve-repurpose, resolve when CLONE_PORT printed (timeout 15s)
function bootServer(cloneDir, mirrorDir, entry) {
  const proc = spawn(
    process.execPath,
    [join(HERE, 'serve-repurpose.mjs'), '--clone', cloneDir, '--mirror', mirrorDir, '--entry', entry],
    { env: { ...process.env, CLONE_SERVE_PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const port = new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => {
      proc.kill();
      rej(new Error('serve-repurpose did not print CLONE_PORT within 15s'));
    }, 15000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/CLONE_PORT=(\d+)/);
      if (m) {
        clearTimeout(to);
        res(m[1]);
      }
    });
    proc.on('exit', () => {
      clearTimeout(to);
      rej(new Error('serve-repurpose exited before printing CLONE_PORT'));
    });
  });
  return { proc, port };
}

// ---------- VISUAL-MAP.html ----------
function renderVisualMapHtml({ pageW, pageH, placed, site, now }) {
  const badges = placed
    .filter((s) => s.rect)
    .map((s) => {
      const r = s.rect;
      const box = `<div class="cm-box" data-id="${escHtml(s.id)}" style="left:${Math.round(
        r.x
      )}px;top:${Math.round(r.y)}px;width:${Math.round(r.w)}px;height:${Math.round(
        r.h
      )}px;border-color:${escHtml(s.color)}"></div>`;
      const badge = `<button class="cm-badge" data-id="${escHtml(s.id)}" style="left:${Math.round(
        r.x
      )}px;top:${Math.round(r.y)}px;background:${escHtml(s.color)}">${escHtml(s.id)}</button>`;
      return box + badge;
    })
    .join('\n');

  const legendRows = LEGEND.map(
    (l) =>
      `<div class="cm-leg-item"><span class="cm-swatch" style="background:${escHtml(
        l.color
      )}"></span>${escHtml(LEGEND_LABEL[l.type])}</div>`
  ).join('');

  const tableRows = placed
    .map((s) => {
      const missing = s.rect ? '' : ' class="cm-missing"';
      return `<tr id="row-${escHtml(s.id)}"${missing}>
  <td><span class="cm-dot" style="background:${escHtml(s.color)}"></span>${escHtml(s.id)}</td>
  <td>${escHtml(s.type)}</td>
  <td>${escHtml(s.role || '—')}</td>
  <td>${escHtml(constraintSummary(s))}</td>
  <td>${escHtml(trunc(s.text, 60) || '—')}</td>
  <td><code>${escHtml(dropLine(s, site))}</code></td>
</tr>`;
    })
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual Map — ${escHtml(site)}</title>
<style>
  :root{--ink:#111;--muted:#666;--line:#e3e3e3;--bg:#fafafa}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
  header{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
  header h1{font-size:15px;margin:0;font-weight:700}
  header .meta{color:var(--muted);font-size:12px}
  .cm-legend{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto}
  .cm-leg-item{display:flex;align-items:center;gap:6px;font-size:12px}
  .cm-swatch{width:13px;height:13px;border-radius:3px;display:inline-block}
  .cm-wrap{display:flex;align-items:flex-start;gap:0}
  .cm-canvas-scroll{flex:1;overflow:auto;max-height:calc(100vh - 52px)}
  .cm-canvas{position:relative;width:${pageW}px;height:${pageH}px}
  .cm-canvas img{position:absolute;left:0;top:0;width:${pageW}px;height:auto;display:block}
  .cm-box{position:absolute;border:2px solid;opacity:.55;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px rgba(255,255,255,.4) inset}
  .cm-badge{position:absolute;transform:translate(-2px,-2px);color:#fff;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:3px 6px;border:1.5px solid #fff;border-radius:5px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);white-space:nowrap;z-index:5}
  .cm-badge:hover{filter:brightness(1.12);z-index:6}
  .cm-side{width:430px;max-width:42vw;border-left:1px solid var(--line);background:#fff;overflow:auto;max-height:calc(100vh - 52px)}
  .cm-side h2{font-size:13px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line);background:#f4f4f4;position:sticky;top:0}
  table{border-collapse:collapse;width:100%;font-size:12px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;position:sticky;top:34px;background:#fafafa;z-index:1}
  td code{font:11px ui-monospace,Menlo,monospace;color:#0a5}
  .cm-dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
  tr.cm-missing td{opacity:.5}
  tr.cm-missing td:first-child::after{content:" (off-screen / not found)";color:#c00;font-size:10px}
  tr.cm-flash{background:#fff4cc!important;transition:background 1.2s}
  .cm-badge.cm-flash{outline:3px solid #ffcf00;outline-offset:2px}
</style></head>
<body>
<header>
  <h1>Visual Map — ${escHtml(site)}</h1>
  <span class="meta">${placed.length} slots · page ${pageW}×${pageH}px${
    now ? ' · ' + escHtml(now) : ''
  }</span>
  <div class="cm-legend">${legendRows}</div>
</header>
<div class="cm-wrap">
  <div class="cm-canvas-scroll">
    <div class="cm-canvas">
      <img src="VISUAL-MAP.png" alt="full-page screenshot of the clone">
${badges}
    </div>
  </div>
  <aside class="cm-side">
    <h2>Slots — click a row or badge to jump</h2>
    <table>
      <thead><tr><th>id</th><th>type</th><th>role</th><th>constraint</th><th>current text</th><th>edit</th></tr></thead>
      <tbody>
${tableRows}
      </tbody>
    </table>
  </aside>
</div>
<script>
(function(){
  function flash(el){ if(!el) return; el.classList.add('cm-flash'); setTimeout(function(){el.classList.remove('cm-flash');},1200); }
  function jumpTo(id){
    var row=document.getElementById('row-'+id);
    var badge=document.querySelector('.cm-badge[data-id="'+id+'"]');
    if(row){ row.scrollIntoView({block:'center'}); flash(row); }
    if(badge){ badge.scrollIntoView({block:'center'}); flash(badge); }
  }
  document.querySelectorAll('.cm-badge').forEach(function(b){
    b.addEventListener('click',function(){ jumpTo(b.getAttribute('data-id')); });
  });
  document.querySelectorAll('tbody tr').forEach(function(tr){
    tr.style.cursor='pointer';
    tr.addEventListener('click',function(){ jumpTo(tr.id.replace('row-','')); });
  });
})();
</script>
</body></html>`;
}

// ---------- MANUAL.md ----------
function renderManualMd({ site, placed, baseline, now }) {
  const byType = {};
  for (const t of TYPES) byType[t] = placed.filter((s) => s.type === t);

  const legend = [
    '| Color | Tag | Meaning |',
    '|---|---|---|',
    ...LEGEND.map((l) => `| \`${l.color}\` | ${l.prefix} | ${LEGEND_LABEL[l.type]} |`)
  ].join('\n');

  function typeSection(type) {
    const rows = byType[type];
    if (!rows.length) return '';
    const head =
      type === 'title' || type === 'text'
        ? '| Tag | Role | Length | Current text |\n|---|---|---|---|'
        : '| Tag | Role | Spec | Accepted files |';
    const body = rows
      .map((s) => {
        if (type === 'title' || type === 'text') {
          return `| \`${s.id}\` | ${s.role || '—'} | ${constraintSummary(s)} | ${trunc(
            s.text,
            70
          ) || '—'} |`;
        }
        return `| \`${s.id}\` | ${s.role || '—'} | ${constraintSummary(s)} | ${
          ACCEPTED_EXT[type]
        } |`;
      })
      .join('\n');
    const titleMap = {
      image: 'IMG — images',
      video: 'VID — videos / clips',
      sequence: 'SEQ — image sequences',
      title: 'TITLE — headings',
      text: 'TXT — body / label text'
    };
    return `### ${titleMap[type]} (${rows.length})\n\n${head}\n${body}\n`;
  }

  const b = baseline || {};
  const censusLines = [
    `- CSS animations: **${b.cssAnim ?? 0}**`,
    `- CSS transitions: **${b.cssTransition ?? 0}**`,
    `- Web Animations (WAAPI): **${b.waapi ?? 0}**`,
    `- Reveal elements: **${b.reveals ?? 0}**`,
    `- \`<video>\` elements: **${b.videos ?? 0}** (${b.videosPlaying ?? 0} playing)`,
    `- \`<canvas>\` elements: **${b.canvas ?? 0}**`,
    `- Libraries: ${(b.libraries && b.libraries.length ? b.libraries : ['none']).map((x) => '`' + x + '`').join(', ')}`
  ].join('\n');

  return `# How to edit \`${site}\`

This clone keeps **100% of the original structure, animations, and interactivity**.
You don't rebuild anything — you only **swap the picture, clip, or text inside a numbered slot**.

${now ? `_Map generated: ${now}_\n` : ''}
## The 4-step workflow

1. **Find the tag.** Open \`repurpose/VISUAL-MAP.html\` — every editable element has a colored, numbered badge (e.g. \`VID-04\`) right on top of it.
2. **Name your file exactly like the tag.** A replacement clip for \`VID-04\` must be named \`VID-04.mp4\`. A new hero image for \`IMG-07\` → \`IMG-07.jpg\`.
3. **Drop it in the swaps folder:** \`clones/${site}/swaps/\`. That's it — no JSON needed for images/videos; a bare \`<TAG>.<ext>\` file is auto-picked-up.
4. **Apply + reload:** run

   \`\`\`bash
   npm run clone:swap -- --clone ${site}
   \`\`\`

   (or leave \`npm run clone:watch -- --clone ${site}\` running and it re-applies on every drop), then reload the page.

## Color legend

${legend}

## Slots by type

${TYPES.map(typeSection).filter(Boolean).join('\n')}
## Text & titles

\`TITLE-*\` and \`TXT-*\` are not files — you change them in \`clones/${site}/swaps/swaps.json\`:

\`\`\`json
{
  "TITLE-1": { "type": "text", "value": "Your new headline" },
  "TXT-3":   { "type": "text", "value": "Your new body copy" }
}
\`\`\`

## Sequences (advanced)

\`SEQ-*\` slots are multi-frame image sequences (scroll-scrubbed animations).
**v1 does not support a one-shot folder-drop for sequences** — each frame must
be supplied and re-encoded individually. Leave SEQ slots as-is unless you know
the frame pipeline.

## ⚠ ANIMATIONS ARE LOCKED

You only ever replace the **picture / clip / text** inside a slot. The **motion is never touched.**

Pristine baseline captured for this clone (before any swap):

${censusLines}

A swap that drops the animation count below this baseline is **auto-rejected by \`clone-verify\`**.
This is why \`clone-map\` must be run **before** you apply any swaps — it captures the
pristine \`repurpose/ANIM-LOCK.json\` the verifier compares against.
`;
}

// ---------- MANUAL.html (markdown wrapped, no external deps) ----------
function renderManualHtml({ site, md }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manual — ${escHtml(site)}</title>
<style>
  body{max-width:860px;margin:0 auto;padding:32px 20px 80px;font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#161616}
  h1{font-size:26px} h2{font-size:19px;margin-top:34px;border-bottom:1px solid #eee;padding-bottom:5px} h3{font-size:15px;margin-top:24px}
  code{font:13px ui-monospace,Menlo,monospace;background:#f3f3f3;padding:1px 5px;border-radius:4px}
  pre{background:#1c1c20;color:#e7e7e7;padding:14px 16px;border-radius:8px;overflow:auto}
  pre code{background:none;color:inherit;padding:0}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
  th,td{border:1px solid #e5e5e5;padding:6px 9px;text-align:left} th{background:#f7f7f7}
  blockquote,.warn{background:#fff6e5;border-left:4px solid #ff9500;padding:8px 14px;border-radius:4px}
</style></head>
<body>
<pre style="display:none" id="src">${escHtml(md)}</pre>
<div id="doc"></div>
<script>
(function(){
  var md=document.getElementById('src').textContent;
  // tiny markdown renderer: headings, code fences, inline code, tables, lists, bold, hr
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function inline(s){
    return esc(s)
      .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  }
  var lines=md.split('\\n'), out=[], i=0;
  while(i<lines.length){
    var ln=lines[i];
    if(/^\`\`\`/.test(ln)){ var buf=[]; i++; while(i<lines.length&&!/^\`\`\`/.test(lines[i])){buf.push(lines[i]);i++;} i++;
      out.push('<pre><code>'+esc(buf.join('\\n'))+'</code></pre>'); continue; }
    if(/^\\|/.test(ln)){ var tbl=[]; while(i<lines.length&&/^\\|/.test(lines[i])){tbl.push(lines[i]);i++;}
      var rows=tbl.filter(function(r){return !/^\\|[\\s:|-]+\\|?$/.test(r);});
      var html='<table>'; rows.forEach(function(r,ri){ var cells=r.split('|').slice(1,-1);
        html+='<tr>'+cells.map(function(c){var tag=ri===0?'th':'td';return '<'+tag+'>'+inline(c.trim())+'</'+tag+'>';}).join('')+'</tr>'; });
      html+='</table>'; out.push(html); continue; }
    var h=ln.match(/^(#{1,4})\\s+(.*)/);
    if(h){ var lvl=h[1].length; out.push('<h'+lvl+'>'+inline(h[2])+'</h'+lvl+'>'); i++; continue; }
    if(/^\\s*[-*]\\s+/.test(ln)){ var li=[]; while(i<lines.length&&/^\\s*[-*]\\s+/.test(lines[i])){li.push(lines[i].replace(/^\\s*[-*]\\s+/,''));i++;}
      out.push('<ul>'+li.map(function(x){return '<li>'+inline(x)+'</li>';}).join('')+'</ul>'); continue; }
    if(/^\\s*\\d+\\.\\s+/.test(ln)){ var ol=[]; while(i<lines.length&&/^\\s*\\d+\\.\\s+/.test(lines[i])){ol.push(lines[i].replace(/^\\s*\\d+\\.\\s+/,''));i++;}
      out.push('<ol>'+ol.map(function(x){return '<li>'+inline(x)+'</li>';}).join('')+'</ol>'); continue; }
    if(/^_.*_$/.test(ln.trim())&&ln.trim().length>2){ out.push('<p><em>'+inline(ln.trim().slice(1,-1))+'</em></p>'); i++; continue; }
    if(ln.trim()===''){ i++; continue; }
    out.push('<p>'+inline(ln)+'</p>'); i++;
  }
  document.getElementById('doc').innerHTML=out.join('\\n');
})();
</script>
</body></html>`;
}

// ---------- main ----------
export async function buildMap(cloneDir, opts = {}) {
  cloneDir = resolve(cloneDir);
  const site = cloneDir.split(/[\\/]/).filter(Boolean).pop();
  const now = opts.now || '';
  const repurposeDir = join(cloneDir, 'repurpose');
  const mapPath = join(repurposeDir, 'MAP.json');
  const map = loadJson(mapPath);
  if (!map) throw new Error(`MAP.json not found at ${mapPath} — run the cloner first`);
  const slots = Array.isArray(map.slots) ? map.slots : [];

  const mirrorDir = opts.mirror ? resolve(opts.mirror) : detectMirror(cloneDir);
  let entry = opts.entry || detectEntry(map);
  // self-heal: a shell (Git-Bash/MSYS) can mangle a leading-slash --entry into e.g.
  // "C:/Program Files/Git/fr/index.html". If the given entry isn't a real file under the
  // mirror, fall back to the MAP-derived path (no shell involved).
  if (!existsSync(join(mirrorDir, entry))) {
    const auto = detectEntry(map);
    if (existsSync(join(mirrorDir, auto))) {
      console.error(`[clone-map] --entry "${entry}" not found under mirror; using detected "${auto}"`);
      entry = auto;
    }
  }

  let proc = null;
  let browser = null;
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('playwright not installed — run `npx playwright install chromium`');
  }

  try {
    const boot = bootServer(cloneDir, mirrorDir, entry);
    proc = boot.proc;
    const port = await boot.port;
    const base = `http://127.0.0.1:${port}/`;

    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const ctx = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1
    });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(6000); // intro / hydration

    // scroll top->bottom so lazy/reveal elements mount, then back to 0
    const pageH0 = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < pageH0; y += 900) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);

    // measure each slot — PAGE coords (scroll-independent)
    const placed = [];
    let slotsWithRect = 0;
    let slotsMissing = 0;
    for (const slot of slots) {
      const css = slot.where && slot.where.cssPath;
      let rect = null;
      let note = '';
      try {
        const h = css ? await page.$(css) : null;
        if (h) {
          rect = await h.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return {
              x: r.left + window.scrollX,
              y: r.top + window.scrollY,
              w: r.width,
              h: r.height
            };
          });
          if (!rect || rect.w === 0 || rect.h === 0) {
            note = 'zero-size';
          }
          slotsWithRect++;
        } else {
          note = 'not-found';
          slotsMissing++;
        }
      } catch (e) {
        note = 'error: ' + String(e && e.message ? e.message : e);
        slotsMissing++;
        rect = null;
      }
      placed.push({
        id: slot.id,
        color: slot.color || COLORS[slot.type] || '#888',
        type: slot.type,
        role: slot.role,
        text: slot.text || '',
        cssPath: css || '',
        rect,
        note
      });
    }

    // full-page dimensions for the canvas + screenshot
    const dims = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight
    }));
    const pageW = Math.max(dims.w, 1440);
    const pageH = Math.max(dims.h, 900);

    const visualPng = join(repurposeDir, 'VISUAL-MAP.png');
    await page.screenshot({ path: visualPng, fullPage: true });

    await ctx.close();

    // write VISUAL-MAP.html
    const visualHtml = join(repurposeDir, 'VISUAL-MAP.html');
    await writeFile(
      visualHtml,
      renderVisualMapHtml({ pageW, pageH, placed, site, now }),
      'utf8'
    );

    // baseline animation census — pristine, pre-swap
    const baseline = await runCensus(base);
    const animLockPath = join(repurposeDir, 'ANIM-LOCK.json');
    await writeFile(
      animLockPath,
      JSON.stringify(
        { capturedFrom: base, baseline, generatedAtRef: opts.now || '' },
        null,
        2
      ),
      'utf8'
    );

    // MANUAL.md + MANUAL.html
    const md = renderManualMd({ site, placed, baseline, now });
    const manualMd = join(repurposeDir, 'MANUAL.md');
    const manualHtml = join(repurposeDir, 'MANUAL.html');
    await writeFile(manualMd, md, 'utf8');
    await writeFile(manualHtml, renderManualHtml({ site, md }), 'utf8');

    return {
      visualMap: visualHtml,
      visualPng,
      manual: manualMd,
      manualHtml,
      animLock: animLockPath,
      slotsWithRect,
      slotsMissing,
      pageW,
      pageH,
      baseline
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
  }
}

// ---------- CLI ----------
function resolveClone(arg) {
  if (!arg) throw new Error('--clone <dir|name> is required');
  // a path (absolute, or contains a separator, or exists relative to cwd)
  if (isAbsolute(arg) || /[\\/]/.test(arg)) return resolve(arg);
  const asName = join(REPO_ROOT, 'clones', arg);
  if (existsSync(asName)) return asName;
  const asPath = resolve(arg);
  if (existsSync(asPath)) return asPath;
  // default to the bare-name interpretation (clearer error downstream)
  return asName;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i++, i)] : true;
      a[k] = v;
    }
  }
  return a;
}

const isMain = (() => {
  try {
    return resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const cloneDir = resolveClone(a.clone);
  buildMap(cloneDir, { mirror: a.mirror, entry: a.entry, now: a.now })
    .then((r) => {
      console.log('clone-map done:');
      console.log('  VISUAL-MAP.html  ' + r.visualMap);
      console.log('  VISUAL-MAP.png   ' + r.visualPng);
      console.log('  MANUAL.md        ' + r.manual);
      console.log('  MANUAL.html      ' + r.manualHtml);
      console.log('  ANIM-LOCK.json   ' + r.animLock);
      console.log(
        `  page ${r.pageW}×${r.pageH}px · ${r.slotsWithRect} slots placed, ${r.slotsMissing} missing`
      );
      const b = r.baseline || {};
      console.log(
        `  baseline: cssAnim=${b.cssAnim} cssTransition=${b.cssTransition} waapi=${b.waapi} videos=${b.videos} canvas=${b.canvas} reveals=${b.reveals}`
      );
    })
    .catch((e) => {
      console.error('clone-map failed:', e && e.message ? e.message : e);
      process.exitCode = 1;
    });
}
