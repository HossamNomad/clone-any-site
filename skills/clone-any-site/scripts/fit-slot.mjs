// fit-slot.mjs — turn ONE dropped file into a slot's exact responsive asset set.
// Reads the slot's slotSpec (per viewport) from the manifest and emits webp/avif at each breakpoint's
// dims + a ready srcset/<picture> string; video -> mp4/webm + poster; svg -> passthrough (light optimize).
// Uses optional sharp (images) + the ffmpeg binary (video). Degrades gracefully if either is absent.
//
//   node fit-slot.mjs --slot 3 --in ./drop/hero.jpg --manifest <repurpose>/manifest.json --out <repurpose>/assets [--now <iso>]
//
// Prints JSON { assetRef, generated:[...], srcsetHtml, degraded:bool }. Never reads wall-clock time / randomness.

import { readFile, mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { join, extname, basename, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deps } from './clone-deps-check.mjs';

function args(argv) {
  const o = {}; for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) o[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  return o;
}
const A = args(process.argv);
for (const k of ['slot', 'in', 'manifest', 'out']) if (!A[k]) { console.error(`fit-slot: missing --${k}`); process.exit(1); }
const NOW = A.now || '';

// focal [x,y] (0..1) -> sharp position keyword
function focalPos(focal) {
  const [x, y] = focal || [0.5, 0.5];
  const v = y < 0.4 ? 'top' : y > 0.6 ? 'bottom' : '';
  const h = x < 0.4 ? 'left' : x > 0.6 ? 'right' : '';
  return (v + (v && h ? ' ' : '') + h) || 'centre';
}
const IMG_FMT = { webp: 1, avif: 1, jpeg: 1, png: 1 };

async function loadSharp() { try { return (await import('sharp')).default; } catch { return null; } }

async function run() {
  const manifest = JSON.parse(await readFile(A.manifest, 'utf8'));
  const slot = manifest.slots.find((s) => String(s.number) === String(A.slot));
  if (!slot) { console.error('fit-slot: no slot #' + A.slot); process.exit(1); }
  const viewports = (manifest.meta && manifest.meta.viewports) || [390, 768, 1440];
  const spec = slot.slotSpec || {};
  const outDir = join(A.out, 'slot-' + slot.number);
  await mkdir(outDir, { recursive: true });
  const inputBuf = await readFile(A.in);
  const inExt = extname(A.in).toLowerCase().replace('.', '') || 'bin';
  const base = 'fill';
  const generated = [];
  let degraded = false;
  const manifestDir = dirname(A.manifest);
  const relOut = (p) => 'assets/' + relative(A.out, p).split(/[\\/]/).join('/');

  const isVideo = slot.type === 'video' || /mp4|webm|mov|m4v/.test(inExt);
  const isSvg = slot.type === 'svg' || inExt === 'svg';
  const sharp = (!isVideo && !isSvg) ? await loadSharp() : null;

  if (isSvg) {
    // light optimize: strip XML comments; keep as-is otherwise (safe, lossless)
    let svg = inputBuf.toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
    const dest = join(outDir, base + '.svg');
    await writeFile(dest, svg); generated.push(relOut(dest));
  } else if (isVideo) {
    if (deps.ffmpeg.present) {
      const widths = viewports.map((v) => (spec[v] && spec[v].w) || 1280);
      const w = Math.max.apply(null, widths);
      const mp4 = join(outDir, base + '.mp4'), webm = join(outDir, base + '.webm'), poster = join(outDir, base + '.poster.webp');
      const tmpIn = join(outDir, '_src.' + inExt); await writeFile(tmpIn, inputBuf);
      runBin('ffmpeg', ['-y', '-i', tmpIn, '-vf', `scale=${w}:-2`, '-c:v', 'libx264', '-crf', '24', '-preset', 'medium', '-movflags', '+faststart', '-an', mp4]);
      runBin('ffmpeg', ['-y', '-i', tmpIn, '-vf', `scale=${w}:-2`, '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-an', webm]);
      runBin('ffmpeg', ['-y', '-i', tmpIn, '-vframes', '1', poster]);
      generated.push(relOut(mp4), relOut(webm), relOut(poster));
    } else {
      degraded = true;
      const dest = join(outDir, base + '.' + inExt); await copyFile(A.in, dest); generated.push(relOut(dest));
      console.error('fit-slot: ffmpeg absent — video copied at native size (degraded). Install ffmpeg for mp4/webm/poster.');
    }
  } else if (sharp) {
    for (const v of viewports) {
      const sp = spec[v]; if (!sp) continue;
      const fmt = IMG_FMT[sp.format] ? sp.format : 'webp';
      const pos = focalPos(sp.focal);
      for (const f of [fmt, fmt === 'avif' ? null : 'avif']) {
        if (!f) continue;
        const dest = join(outDir, `${base}.${v}.${f}`);
        let q = 82;
        let pipe = sharp(inputBuf).resize(sp.w, sp.h, { fit: sp.fit || 'cover', position: pos });
        await pipe.toFormat(f, { quality: q }).toFile(dest);
        // one weight-budget step-down
        if (sp.maxBytes) { const sz = (await stat(dest)).size; if (sz > sp.maxBytes && q > 50) { await sharp(inputBuf).resize(sp.w, sp.h, { fit: sp.fit || 'cover', position: pos }).toFormat(f, { quality: 60 }).toFile(dest); } }
        generated.push(relOut(dest));
      }
    }
    if (!generated.length) { // no slotSpec — emit one native webp
      const dest = join(outDir, base + '.webp'); await sharp(inputBuf).toFormat('webp', { quality: 82 }).toFile(dest); generated.push(relOut(dest));
    }
  } else {
    degraded = true;
    const dest = join(outDir, base + '.' + inExt); await copyFile(A.in, dest); generated.push(relOut(dest));
    console.error('fit-slot: sharp absent — image copied at native size (degraded). `npm i sharp` for responsive sets.');
  }

  // primary assetRef = largest/default
  const assetRef = generated.find((g) => /\.(webp|mp4|svg)$/.test(g)) || generated[0];
  const srcsetHtml = buildSrcset(slot, viewports, spec, generated, degraded);
  const out = { assetRef, generated, srcsetHtml, degraded, now: NOW };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function buildSrcset(slot, viewports, spec, generated, degraded) {
  if (slot.type === 'video') {
    const mp4 = generated.find((g) => g.endsWith('.mp4')); const webm = generated.find((g) => g.endsWith('.webm')); const poster = generated.find((g) => g.includes('poster'));
    return `<video autoplay muted loop playsinline${poster ? ` poster="/${poster}"` : ''}>${webm ? `<source src="/${webm}" type="video/webm">` : ''}${mp4 ? `<source src="/${mp4}" type="video/mp4">` : ''}</video>`;
  }
  if (slot.type === 'svg' || degraded) { const g = generated[0]; return `<img src="/${g}" alt="">`; }
  // <picture> with per-viewport sources (avif then webp), largest as fallback <img>
  const byVp = {};
  generated.forEach((g) => { const m = g.match(/\.(\d+)\.(\w+)$/); if (m) { (byVp[m[1]] = byVp[m[1]] || {})[m[2]] = g; } });
  const sorted = viewports.slice().sort((a, b) => a - b);
  let sources = '';
  sorted.forEach((v, i) => {
    const next = sorted[i + 1];
    const media = next ? `(max-width:${next - 1}px)` : '';
    const set = byVp[v]; if (!set) return;
    if (set.avif) sources += `<source ${media ? `media="${media}" ` : ''}srcset="/${set.avif}" type="image/avif">`;
    if (set.webp) sources += `<source ${media ? `media="${media}" ` : ''}srcset="/${set.webp}" type="image/webp">`;
  });
  const largest = byVp[sorted[sorted.length - 1]] || {};
  const fallback = largest.webp || generated[0];
  return `<picture>${sources}<img src="/${fallback}" alt=""></picture>`;
}

function runBin(bin, a) {
  // shell:false (default) — on Windows libuv still resolves `ffmpeg.exe` on PATH, and the args
  // array is passed verbatim so input paths containing spaces (e.g. "…\Claude Code\…") are NOT
  // re-split by a shell. shell:true silently truncated such paths at the space. Matches transcode.mjs.
  const r = spawnSync(bin, a, { stdio: 'pipe' });
  if (r.error) throw new Error(bin + ' not found / failed to spawn: ' + r.error.code + ' (' + r.error.message + ')');
  if (r.status !== 0) throw new Error(bin + ' failed: ' + (r.stderr ? r.stderr.toString().slice(-300) : r.status));
}

run().catch((e) => { console.error('fit-slot FATAL', e); process.exit(1); });
