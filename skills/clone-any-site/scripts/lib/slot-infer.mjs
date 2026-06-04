// lib/slot-infer.mjs
export const COLORS = { image: '#2b6cff', video: '#ff3b30', sequence: '#9b51e0', title: '#ff9500', text: '#cfcfcf' };
export const PREFIX = { image: 'IMG', video: 'VID', sequence: 'SEQ', title: 'TITLE', text: 'TXT' };

// consecutive same-folder, same-prefix, numerically-suffixed images -> one sequence
export function groupSequences(imgs) {
  const key = (u) => { const m = String(u).match(/^(.*?)(\d+)(\.[a-z0-9]+)(?:\?.*)?$/i); return m ? { base: m[1], n: +m[2], ext: m[3] } : null; };
  const buckets = new Map();
  for (const im of imgs) { const k = key(im.url); if (!k) continue; (buckets.get(k.base) || buckets.set(k.base, []).get(k.base)).push({ ...im, n: k.n }); }
  const sequences = [], used = new Set();
  for (const [base, arr] of buckets) {
    if (arr.length >= 3) { arr.sort((a, b) => a.n - b.n); sequences.push({ base, frameCount: arr.length, frames: arr.map((a) => a.url) }); arr.forEach((a) => used.add(a.url)); }
  }
  const singles = imgs.filter((im) => !used.has(im.url));
  return { sequences, singles };
}

export function assignIds(items) {
  const counters = {};
  return items.map((it) => { const p = PREFIX[it.type] || 'EL'; counters[p] = (counters[p] || 0) + 1; return { ...it, id: `${p}-${counters[p]}`, color: COLORS[it.type] || '#888' }; });
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
export function inferConstraints(s) {
  if (s.type === 'text' || s.type === 'title') return { charLen: (s.text || '').trim().length };
  const w = Math.round(s.rect?.width || 0), h = Math.round(s.rect?.height || 0);
  let ar = ''; if (w && h) { const g = gcd(w, h) || 1; ar = `${Math.round(w / g)}:${Math.round(h / g)}`; }
  const out = { aspectRatio: ar, w, h };
  if (s.type === 'video') out.durationSec = s.durationSec || null;
  if (s.type === 'sequence') out.frameCount = s.frameCount || null;
  return out;
}
export function inferRole(s) {
  if (s.isCta) return 'cta';
  if (s.type === 'title' && s.arcRatio < 0.15) return 'hook';
  if (s.type === 'title') return 'section-head';
  if (s.type === 'video') return 'immersion';
  if (s.type === 'sequence') return 'proof';
  if (s.type === 'image') return s.arcRatio < 0.15 ? 'hook' : 'proof';
  if (s.arcRatio < 0.2) return 'stakes';
  if (s.arcRatio > 0.85) return 'cta';
  return 'narrative';
}
