// transcode.mjs
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
export async function transcodeImage(src, dst, { w, h } = {}) {
  let img = sharp(src).rotate();
  if (w && h) img = img.resize(w, h, { fit: 'cover' }); else if (w) img = img.resize({ width: w });
  await img.webp({ quality: 82 }).toFile(dst); return dst;
}
export async function transcodeVideo(src, dst, { w, h, lavfi } = {}) {
  const inArgs = lavfi ? ['-f', 'lavfi', '-i', `${src}=s=${w||1280}x${h||720}:rate=25:d=3`] : ['-i', src];
  const vf = (w && h && !lavfi) ? ['-vf', `scale=${w}:${h}:force_original_aspect_ratio=cover,crop=${w}:${h}`] : [];
  const r = spawnSync('ffmpeg', ['-y', ...inArgs, ...vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', dst], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr||'').slice(-300));
  return dst;
}
