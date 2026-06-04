// encode-recipes.mjs
// Single source of truth for compressing/encoding a dropped replacement asset
// so a cloned page loads fast WITHOUT changing playback timing.
//
// The clone server delivers ONE file per asset (endpoint /__swap/<id>), so each
// function produces exactly ONE optimized output per asset (not a responsive set).
//
// Timing safety: encodeVideo never trims (-ss/duration), never re-times (-r). It
// only rescales. probeMedia is used to verify the output duration/fps match the
// input within tolerance (syncOk), since animations may be synced to the video.

import { spawnSync } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import sharp from 'sharp';

const SPAWN_OPTS = {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 64,
  // NOTE: shell must stay FALSE. With shell:true on Windows, an args array is re-joined and
  // re-split on spaces, so any path containing a space (e.g. "...\Claude Code\...") is truncated
  // at the space and ffmpeg fails. Without shell, Node passes each arg verbatim. ffmpeg/ffprobe
  // resolve via PATH (matches the existing transcode.mjs which also runs shell-less).
  shell: false,
};

// Evaluate ffprobe r_frame_rate strings like "30000/1001" or "25/1" or "25".
function evalRate(str) {
  if (str == null) return 0;
  const s = String(str).trim();
  if (s === '' || s === '0/0' || s === 'N/A') return 0;
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    if (!d) return 0;
    return n / d;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Probe a media file's first video stream.
 * @returns {Promise<{duration:number, fps:number, width:number, height:number}>}
 */
export async function probeMedia(inPath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate,duration,width,height',
    '-show_entries', 'format=duration',
    '-of', 'json',
    inPath,
  ];
  const r = spawnSync('ffprobe', args, SPAWN_OPTS);
  if (r.status !== 0) {
    throw new Error('ffprobe failed: ' + ((r.stderr || '') + (r.error?.message || '')).slice(-300));
  }
  let json;
  try {
    json = JSON.parse(r.stdout || '{}');
  } catch (e) {
    throw new Error('ffprobe JSON parse failed: ' + (r.stdout || '').slice(-300));
  }
  const stream = (json.streams && json.streams[0]) || {};
  // Prefer stream.duration, fall back to format.duration.
  const duration = toNum(stream.duration) || toNum(json.format && json.format.duration);
  return {
    duration,
    fps: evalRate(stream.r_frame_rate),
    width: toNum(stream.width),
    height: toNum(stream.height),
  };
}

/**
 * Encode an image to a single optimized .webp.
 * Animated sources (meta.pages > 1) keep all frames + loop, are NOT resized,
 * NOT flattened. Static sources are auto-rotated, resized to maxWidth, stripped.
 * @returns {Promise<{outPath:string, bytes:number, width:number, height:number, animated:boolean}>}
 */
export async function encodeImage(inPath, outPath, opts = {}) {
  const { maxWidth = 2048, quality = 80 } = opts;
  const meta = await sharp(inPath, { animated: true }).metadata();
  const animated = (meta.pages || 1) > 1;

  let pipeline;
  if (animated) {
    // Keep frames/loop intact; do not resize, do not flatten.
    pipeline = sharp(inPath, { animated: true }).webp({
      quality: Math.min(quality, 75),
      effort: 4,
    });
  } else {
    // sharp strips metadata by default (we do NOT call withMetadata).
    pipeline = sharp(inPath)
      .rotate()
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality, effort: 5 });
  }

  await pipeline.toFile(outPath);

  // Read back true dimensions of the written webp.
  const outMeta = await sharp(outPath, { animated: true }).metadata();
  const bytes = (await stat(outPath)).size;
  return {
    outPath,
    bytes,
    width: toNum(outMeta.width),
    // For animated webp, metadata().height is the single-frame height (pageHeight),
    // which is the correct displayed height.
    height: toNum(outMeta.pageHeight || outMeta.height),
    animated,
  };
}

/**
 * Encode a video to a single optimized faststart MP4 + a webp poster.
 * Preserves timing: no -r, no -ss trim, no duration change. Only rescales.
 * @returns {Promise<{outMp4:string, posterPath:string, bytes:number,
 *   durIn:number, durOut:number, fpsIn:number, fpsOut:number,
 *   widthIn:number, widthOut:number, syncOk:boolean}>}
 */
export async function encodeVideo(inPath, outMp4, posterPath, opts = {}) {
  const { maxWidth = 1920, crf = 21 } = opts;

  const probeIn = await probeMedia(inPath);

  // Rescale only; even width via -2. Lanczos for quality. No timing flags.
  const vfArgs = [
    '-i', inPath,
    '-vf', `scale='min(${maxWidth},iw)':-2:flags=lanczos`,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.1',
    '-preset', 'medium',
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    outMp4,
  ];
  const v = spawnSync('ffmpeg', ['-y', ...vfArgs], SPAWN_OPTS);
  if (v.status !== 0) {
    throw new Error('ffmpeg video encode failed: ' + ((v.stderr || '') + (v.error?.message || '')).slice(-300));
  }

  // Poster: first frame -> png -> webp.
  const tmpPng = posterPath + '.tmp.png';
  const p = spawnSync('ffmpeg', ['-y', '-ss', '0', '-i', inPath, '-frames:v', '1', '-q:v', '2', tmpPng], SPAWN_OPTS);
  if (p.status !== 0) {
    throw new Error('ffmpeg poster extract failed: ' + ((p.stderr || '') + (p.error?.message || '')).slice(-300));
  }
  await sharp(tmpPng).webp({ quality: 80 }).toFile(posterPath);
  try { await unlink(tmpPng); } catch { /* best-effort cleanup */ }

  const probeOut = await probeMedia(outMp4);
  const durIn = probeIn.duration;
  const durOut = probeOut.duration;
  const fpsIn = probeIn.fps;
  const fpsOut = probeOut.fps;

  const tol = (1 / (fpsIn || 25)) + 0.05;
  const syncOk =
    Math.abs(durOut - durIn) <= tol &&
    Math.round(fpsOut) === Math.round(fpsIn);

  const bytes = (await stat(outMp4)).size;
  return {
    outMp4,
    posterPath,
    bytes,
    durIn,
    durOut,
    fpsIn,
    fpsOut,
    widthIn: probeIn.width,
    widthOut: probeOut.width,
    syncOk,
  };
}

/**
 * Test helper: generate a deterministic test video via lavfi testsrc.
 * @returns {Promise<string>} outPath
 */
export async function makeTestVideo(outPath, { seconds = 3, w = 320, h = 240, fps = 25 } = {}) {
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=${w}x${h}:rate=${fps}:duration=${seconds}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-an',
    outPath,
  ];
  const r = spawnSync('ffmpeg', args, SPAWN_OPTS);
  if (r.status !== 0) {
    throw new Error('ffmpeg makeTestVideo failed: ' + ((r.stderr || '') + (r.error?.message || '')).slice(-300));
  }
  return outPath;
}
