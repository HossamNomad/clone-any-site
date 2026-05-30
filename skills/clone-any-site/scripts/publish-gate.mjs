// publish-gate.mjs — the BLOCKING legitimacy gate for the clone-any-site Repurpose Layer.
// Conforms to clone-interfaces.md §5 ("publish-gate verdict") + manifest.schema.json.
//
// CLI:
//   node publish-gate.mjs --manifest <path> --build <dir> [--attest <attestation.json>] [--interactive] [--now <iso>]
//
// Exit codes: 0 PASS · 1 BLOCK · 2 error.
//
// DETERMINISM (hard rule): this script NEVER reads the wall clock or uses runtime randomness.
//   - Any timestamp comes from --now (ISO string passed by the caller).
//   - Any id is content-derived (sha1 via node:crypto).
//   Two runs over a frozen --build + frozen --manifest + same --attest + same --now are byte-identical.
//
// What it does (clone-interfaces.md §5):
//   1. Drift guard: <manifestDir>/build-fingerprint.json vs manifest.meta.buildFingerprint. Mismatch => BLOCK.
//   2. Structure attestation: from --attest { structureAuthorization, slots:{ '<number>': 'authorized'|... } }
//      (or stdin when --interactive). Writes manifest.meta.structureAuthorization. 'unauthorized' =>
//      verdict.buildMode='clean-room' and DOM-derivative is refused (reported); scans still run.
//   3. Retained-originals enumeration: every slot provenance 'original' && !keep && no replacement
//      (INCLUDING role 'chrome', forms, analytics/verification, text-as-image) needs slots[number]
//      ==='authorized' in the attestation. Any pending/missing/'unauthorized' => BLOCK with the list.
//   4. Mechanical scans over --build (recursive):
//        - font-leak grep        (paid-font family names in built css/js)  => BLOCK
//        - brand-string scrub    (original brand label in the build)        => BLOCK
//        - byte-hash + pHash      (any original image, even re-encoded)       => BLOCK
//        - JS-dep license check   (gated gsap plugins: MorphSVG/SplitText…)   => WARN
//        - analytics/verification (GA4/UA / Meta pixel / Hotjar / gsv)        => BLOCK
//   5. PASS only if no BLOCK. On PASS write <build>/NOTICE with the licensing summary. exit 0.

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, extname, basename, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { deps } from './clone-deps-check.mjs';

const require = createRequire(import.meta.url);

// ───────────────────────────────────────────────────────────────────────────
// tiny hand-rolled flag parser (no deps)
// ───────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// determinism helpers
// ───────────────────────────────────────────────────────────────────────────
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const sha1hex = (s) => sha1(Buffer.from(String(s), 'utf8'));

// ───────────────────────────────────────────────────────────────────────────
// known paid / commercial font family names (small maintained list).
// Augmented at runtime by any manifest computed.fontFamily flagged 'paid-font'.
// Matching is case-insensitive whole-token-ish; we only test the built css/js text.
// ───────────────────────────────────────────────────────────────────────────
const KNOWN_PAID_FONTS = [
  'Brier', 'Söhne', 'Sohne', 'GT America', 'GT Walsheim', 'GT Sectra',
  'Neue Haas Grotesk', 'Neue Haas Unica', 'Helvetica Now', 'Akkurat',
  'Circular', 'Circular Std', 'Founders Grotesk', 'Maison Neue',
  'Calibre', 'Tiempos', 'Graphik', 'Aktiv Grotesk', 'Suisse Int',
  'ABC Diatype', 'PP Neue Montreal', 'PP Editorial', 'Monument Extended',
  'TWK Lausanne', 'Reckless', 'Druk', 'Untitled Sans', 'Gerstner',
];

// Gated / commercial JS libs (license check => WARN, never auto-BLOCK).
const GATED_JS_PATTERNS = [
  /MorphSVGPlugin/i, /\bMorphSVG\b/i,
  /SplitText/i,
  /DrawSVGPlugin/i, /\bDrawSVG\b/i,
  /MotionPathHelper/i,
  /GSDevTools/i,
  /ScrambleTextPlugin/i, /\bScrambleText\b/i,
  /InertiaPlugin/i, /ThrowPropsPlugin/i,
  /Physics2DPlugin/i, /PhysicsPropsPlugin/i,
  /CustomBounce/i, /CustomWiggle/i,
];

// Analytics / verification ID patterns — presence in the build => BLOCK (must be stripped).
const ANALYTICS_PATTERNS = [
  { name: 'GA4 measurement id (G-…)', re: /\bG-[A-Z0-9]{6,}\b/ },
  { name: 'Universal Analytics id (UA-…)', re: /\bUA-\d{4,}-\d{1,}\b/ },
  { name: 'Google Tag Manager container (GTM-…)', re: /\bGTM-[A-Z0-9]{4,}\b/ },
  { name: 'AdWords/AW conversion id (AW-…)', re: /\bAW-\d{6,}\b/ },
  { name: 'Meta/Facebook Pixel (fbq init)', re: /fbq\s*\(\s*['"]init['"]/ },
  { name: 'Meta/Facebook Pixel (connect.facebook.net)', re: /connect\.facebook\.net\/[^"'\s]*fbevents/ },
  { name: 'Hotjar (hjid / static.hotjar.com)', re: /(hjid\s*[:=]|static\.hotjar\.com)/ },
  { name: 'google-site-verification', re: /google-site-verification/ },
];

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tiff']);

// ───────────────────────────────────────────────────────────────────────────
// recursive file walk (deterministic order: sorted)
// ───────────────────────────────────────────────────────────────────────────
async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // skip NOTICE-irrelevant heavy dirs that should never be in a publish build, but still scan src
      out.push(...await walk(full));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// dHash (difference hash) — derivative perceptual hash that survives re-encode.
// Decode via sharp -> 9x8 grayscale raw -> compare adjacent columns -> 64-bit hash.
// Returns lowercase hex string (16 chars) or null if sharp absent / decode fails.
// ───────────────────────────────────────────────────────────────────────────
let _sharp = null;
function getSharp() {
  if (_sharp !== null) return _sharp;
  if (!deps.sharp || !deps.sharp.present) { _sharp = false; return false; }
  try { _sharp = require('sharp'); } catch { _sharp = false; }
  return _sharp;
}

async function dHash(buf) {
  const sharp = getSharp();
  if (!sharp) return null;
  try {
    // 9 wide x 8 tall grayscale; 8 comparisons per row * 8 rows = 64 bits.
    const raw = await sharp(buf)
      .greyscale()
      .resize(9, 8, { fit: 'fill', kernel: 'cubic' })
      .raw()
      .toBuffer();
    // raw is 9*8 = 72 bytes (1 channel after greyscale+raw)
    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = raw[row * 9 + col];
        const right = raw[row * 9 + col + 1];
        bits += left < right ? '1' : '0';
      }
    }
    // pack 64 bits -> 16 hex chars
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

// dHash threshold: 0 = identical hash. Re-encode of the SAME image typically <= 6 bits.
// A different image is usually >= 18. We block on <= 10 (conservative "looks like the original").
const DHASH_BLOCK_THRESHOLD = 10;

// ───────────────────────────────────────────────────────────────────────────
// derive brand label from manifest.meta.target host (e.g. https://www.drinksom.eu/ -> "drinksom")
// ───────────────────────────────────────────────────────────────────────────
function brandLabelFromTarget(target) {
  if (!target || typeof target !== 'string') return null;
  let host = target;
  try { host = new URL(target).hostname; }
  catch {
    // strip scheme + path manually
    host = String(target).replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
  host = host.replace(/^www\./i, '');
  const label = host.split('.')[0];
  if (!label || label.length < 3) return null;
  return label;
}

// ───────────────────────────────────────────────────────────────────────────
// collect original-image hashes from the manifest.
// Sources (in order): an explicit originals list passed via --originals (JSON [{ byteSha?, dHash?, ... }]),
// OR currentValueRef (mirror://…) when reachable under the manifest dir's mirror payload.
// For determinism + portability we accept hashes pre-computed on slots:
//   slot.computed.byteSha / slot.computed.dHash, or slot.originalHashes:{ byteSha, dHash }.
// We also resolve currentValueRef when it points to a readable file relative to manifestDir.
// ───────────────────────────────────────────────────────────────────────────
async function collectOriginalImageHashes(manifest, manifestDir, originalsFromFlag) {
  const records = []; // { stableId, number, byteSha, dHash, ref }
  // 1. explicit originals list (flag)
  if (Array.isArray(originalsFromFlag)) {
    for (const o of originalsFromFlag) {
      records.push({
        stableId: o.stableId || o.id || null,
        number: o.number ?? null,
        byteSha: o.byteSha || o.sha || null,
        dHash: o.dHash || null,
        ref: o.ref || o.currentValueRef || null,
      });
    }
  }
  // 2. per-slot precomputed + reachable currentValueRef
  for (const slot of manifest.slots || []) {
    const isImageType = ['img', 'bg', 'icon', 'video', 'svg'].includes(slot.type);
    if (slot.provenance !== 'original') continue;
    if (!isImageType) continue;
    const rec = {
      stableId: slot.stableId || null,
      number: slot.number ?? null,
      byteSha: (slot.computed && slot.computed.byteSha) || (slot.originalHashes && slot.originalHashes.byteSha) || null,
      dHash: (slot.computed && slot.computed.dHash) || (slot.originalHashes && slot.originalHashes.dHash) || null,
      ref: slot.currentValueRef || null,
    };
    // resolve currentValueRef -> a file under manifestDir to compute live hashes
    if ((!rec.byteSha || !rec.dHash) && rec.ref && typeof rec.ref === 'string') {
      const localPath = mirrorRefToPath(rec.ref, manifest, manifestDir);
      if (localPath) {
        try {
          const buf = await readFile(localPath);
          if (!rec.byteSha) rec.byteSha = sha1(buf);
          if (!rec.dHash && IMG_EXT.has(extname(localPath).toLowerCase())) rec.dHash = await dHash(buf);
        } catch { /* unreachable original — skip; human attestation backstops */ }
      }
    }
    if (rec.byteSha || rec.dHash) records.push(rec);
  }
  return records;
}

// mirror://path/to/asset  OR  a relative path -> absolute path under the mirror root, if reachable.
function mirrorRefToPath(ref, manifest, manifestDir) {
  let rel = ref;
  if (rel.startsWith('mirror://')) rel = rel.slice('mirror://'.length);
  rel = rel.replace(/^\/+/, '');
  const mirrorRoot = manifest.meta && manifest.meta.mirrorRoot;
  const candidates = [];
  if (mirrorRoot) {
    candidates.push(resolve(manifestDir, mirrorRoot, rel));
    candidates.push(resolve(manifestDir, '..', mirrorRoot, rel));
  }
  candidates.push(resolve(manifestDir, rel));
  candidates.push(resolve(manifestDir, '..', rel));
  return candidates[0] || null; // best-effort; readFile try/catch handles misses
}

// ───────────────────────────────────────────────────────────────────────────
// main
// ───────────────────────────────────────────────────────────────────────────
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.manifest || typeof args.manifest !== 'string') {
    console.error('publish-gate: --manifest <path> is required');
    return 2;
  }
  if (!args.build || typeof args.build !== 'string') {
    console.error('publish-gate: --build <dir> is required');
    return 2;
  }

  const manifestPath = resolve(args.manifest);
  const manifestDir = dirname(manifestPath);
  const buildDir = resolve(args.build);
  const now = typeof args.now === 'string' ? args.now : null;

  // load manifest
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    console.error('publish-gate: cannot read/parse manifest:', e.message);
    return 2;
  }
  manifest.meta = manifest.meta || {};
  manifest.slots = Array.isArray(manifest.slots) ? manifest.slots : [];

  // verify build dir exists
  try {
    const s = await stat(buildDir);
    if (!s.isDirectory()) { console.error('publish-gate: --build is not a directory'); return 2; }
  } catch {
    console.error('publish-gate: --build dir not found:', buildDir);
    return 2;
  }

  const verdict = {
    pass: null,
    buildMode: 'dom-derivative',
    drift: { ok: null, expected: null, found: null },
    structureAuthorization: 'unset',
    blocks: [],   // [{ kind, detail }]
    warns: [],    // [{ kind, detail }]
    retainedOriginals: { required: [], unauthorized: [] },
    scans: {},
    nowRef: now,
  };

  const BLOCK = (kind, detail) => verdict.blocks.push({ kind, detail });
  const WARN = (kind, detail) => verdict.warns.push({ kind, detail });

  // ── 1. DRIFT GUARD ────────────────────────────────────────────────────────
  const fpPath = join(manifestDir, 'build-fingerprint.json');
  let fpFile = null;
  try { fpFile = JSON.parse(await readFile(fpPath, 'utf8')); }
  catch { fpFile = null; }
  const manifestFp = manifest.meta.buildFingerprint || null;
  // build-fingerprint.json holds { buildId, crawlLogHash } → fingerprint string "<buildId>+<crawlLogHash>".
  let fileFp = null;
  if (fpFile) {
    if (typeof fpFile.buildFingerprint === 'string') fileFp = fpFile.buildFingerprint;
    else if (fpFile.buildId != null && fpFile.crawlLogHash != null) fileFp = `${fpFile.buildId}+${fpFile.crawlLogHash}`;
  }
  verdict.drift.expected = manifestFp;
  verdict.drift.found = fileFp;
  if (!fpFile) {
    verdict.drift.ok = false;
    BLOCK('drift', `build-fingerprint.json not found at ${relative(buildDir, fpPath) || fpPath} — cannot prove the manifest matches this mirror`);
  } else if (fileFp !== manifestFp) {
    verdict.drift.ok = false;
    BLOCK('drift', `fingerprint mismatch — manifest.meta.buildFingerprint="${manifestFp}" vs build-fingerprint.json="${fileFp}". A stale manifest applied to a fresh mirror is refused.`);
  } else {
    verdict.drift.ok = true;
  }

  // ── 2. STRUCTURE ATTESTATION ──────────────────────────────────────────────
  let attest = null;
  if (typeof args.attest === 'string') {
    try { attest = JSON.parse(await readFile(resolve(args.attest), 'utf8')); }
    catch (e) { console.error('publish-gate: cannot read --attest JSON:', e.message); return 2; }
  } else if (args.interactive) {
    try { attest = JSON.parse(await readStdin()); }
    catch (e) { console.error('publish-gate: cannot parse interactive attestation from stdin:', e.message); return 2; }
  } else {
    attest = { structureAuthorization: 'unset', slots: {} };
  }
  attest.slots = attest.slots || {};
  const structAuth = attest.structureAuthorization || 'unset';
  verdict.structureAuthorization = structAuth;
  manifest.meta.structureAuthorization = structAuth; // write-back into in-memory manifest (persisted below on read of policy)
  if (structAuth === 'unauthorized') {
    verdict.buildMode = 'clean-room';
    // DOM-derivative is refused; report it. Scans still run.
    verdict.domDerivativeRefused = true;
  } else if (structAuth === 'authorized') {
    verdict.buildMode = 'dom-derivative';
  } else {
    // 'unset' — neither authorized nor explicitly clean-room: this blocks a public deploy.
    BLOCK('structure-attestation', `meta.structureAuthorization is "unset" — a deploy needs an explicit attestation (authorized → DOM-derivative, or unauthorized → clean-room).`);
  }

  // ── 3. RETAINED-ORIGINALS ENUMERATION ─────────────────────────────────────
  // Every slot provenance 'original' && !keep && no replacement (incl. chrome/forms/analytics/text-as-image)
  // needs attest.slots[number] === 'authorized'.
  const hasReplacement = (s) => {
    const r = s.replacement;
    if (!r) return false;
    if (r.kind === 'text') return typeof r.value === 'string' && r.value.length > 0;
    if (r.kind === 'asset') return !!(r.assetRef || (Array.isArray(r.generated) && r.generated.length));
    return !!(r.value || r.assetRef);
  };
  for (const slot of manifest.slots) {
    if (slot.provenance !== 'original') continue;
    if (slot.keep === true) continue;
    if (hasReplacement(slot)) continue;
    // this is a retained original — needs explicit per-slot authorization
    const key = String(slot.number);
    const status = attest.slots[key];
    const desc = `#${slot.number} ${slot.type}/${slot.role}${slot.subtype ? '/' + slot.subtype : ''} (${slot.stableId || 'no-id'})`;
    verdict.retainedOriginals.required.push({ number: slot.number, desc, status: status || 'missing' });
    if (status !== 'authorized') {
      verdict.retainedOriginals.unauthorized.push({ number: slot.number, desc, status: status || 'missing' });
      // also write per-slot authorization record (deterministic; timestamp from --now)
      slot.authorization = {
        status: status === 'unauthorized' ? 'unauthorized' : 'pending',
        attestedAtRef: now,
        by: attest.by || null,
        note: 'enumerated by publish-gate; not authorized',
      };
    } else {
      slot.authorization = { status: 'authorized', attestedAtRef: now, by: attest.by || null };
    }
  }
  if (verdict.retainedOriginals.unauthorized.length > 0) {
    BLOCK('retained-originals',
      `${verdict.retainedOriginals.unauthorized.length} retained original slot(s) lack 'authorized' attestation: ` +
      verdict.retainedOriginals.unauthorized.map((r) => `${r.desc} [${r.status}]`).join('; '));
  }

  // ── 4. MECHANICAL SCANS over --build ──────────────────────────────────────
  const files = await walk(buildDir);

  // build the paid-font list: known + any manifest computed.fontFamily flagged 'paid-font'
  const paidFonts = new Set(KNOWN_PAID_FONTS.map((f) => f.toLowerCase()));
  for (const slot of manifest.slots) {
    const flagged = Array.isArray(slot.flags) && slot.flags.includes('paid-font');
    const fam = slot.computed && slot.computed.fontFamily;
    if (flagged && fam) {
      // a font-family CSS value can be a stack; split on commas, strip quotes
      for (const part of String(fam).split(',')) {
        const name = part.trim().replace(/^["']|["']$/g, '');
        if (name) paidFonts.add(name.toLowerCase());
      }
    }
  }

  const brandLabel = brandLabelFromTarget(manifest.meta.target);
  const brandLabelLc = brandLabel ? brandLabel.toLowerCase() : null;

  const originalHashes = await collectOriginalImageHashes(
    manifest, manifestDir,
    typeof args.originals === 'string' ? safeJsonFile(args.originals) : null
  );

  const scan = {
    fontLeaks: [],     // BLOCK
    brandHits: [],     // BLOCK
    analyticsHits: [], // BLOCK
    originalImages: [],// BLOCK ("no unmodified original detected")
    gatedJs: [],       // WARN
    textFilesScanned: 0,
    imagesScanned: 0,
  };

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const rel = relative(buildDir, file).split(sep).join('/');
    if (rel === 'NOTICE') continue; // our own output, don't scan/recurse into it

    if (TEXT_EXT.has(ext)) {
      let text;
      try { text = await readFile(file, 'utf8'); } catch { continue; }
      scan.textFilesScanned++;
      const lc = text.toLowerCase();

      // font-leak grep (css/js especially; we scan all text)
      if (ext === '.css' || ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.html' || ext === '.htm') {
        for (const fam of paidFonts) {
          if (lc.includes(fam)) {
            scan.fontLeaks.push({ file: rel, family: fam });
          }
        }
      }

      // brand-string scrub
      if (brandLabelLc && brandLabelLc.length >= 3 && lc.includes(brandLabelLc)) {
        scan.brandHits.push({ file: rel, brand: brandLabel });
      }

      // analytics / verification ID strip
      for (const a of ANALYTICS_PATTERNS) {
        if (a.re.test(text)) scan.analyticsHits.push({ file: rel, kind: a.name });
      }

      // gated JS-dep license check (WARN)
      for (const g of GATED_JS_PATTERNS) {
        if (g.test(text)) {
          scan.gatedJs.push({ file: rel, pattern: g.source });
          break; // one hit per file is enough to warn
        }
      }
    } else if (IMG_EXT.has(ext)) {
      let buf;
      try { buf = await readFile(file); } catch { continue; }
      scan.imagesScanned++;
      const byteSha = sha1(buf);
      const dh = await dHash(buf); // null if sharp absent / decode failed
      for (const orig of originalHashes) {
        let matched = false;
        let how = null;
        if (orig.byteSha && orig.byteSha === byteSha) { matched = true; how = 'byte-identical'; }
        else if (orig.dHash && dh) {
          const dist = hammingHex(orig.dHash, dh);
          if (dist <= DHASH_BLOCK_THRESHOLD) { matched = true; how = `dHash distance ${dist} (<=${DHASH_BLOCK_THRESHOLD})`; }
        }
        if (matched) {
          scan.originalImages.push({
            file: rel,
            originalSlot: orig.number != null ? `#${orig.number}` : (orig.stableId || 'original'),
            how,
          });
        }
      }
    }
    // other binary types (fonts, video, etc.): byte-hash compared above only for IMG; fonts covered by name grep
  }

  // dedupe font leaks (file+family)
  scan.fontLeaks = dedupe(scan.fontLeaks, (x) => `${x.file}::${x.family}`);
  scan.brandHits = dedupe(scan.brandHits, (x) => x.file);
  scan.analyticsHits = dedupe(scan.analyticsHits, (x) => `${x.file}::${x.kind}`);
  scan.originalImages = dedupe(scan.originalImages, (x) => `${x.file}::${x.originalSlot}`);
  scan.gatedJs = dedupe(scan.gatedJs, (x) => x.file);

  verdict.scans = {
    fontLeak: { block: scan.fontLeaks.length > 0, hits: scan.fontLeaks },
    brandScrub: { block: scan.brandHits.length > 0, hits: scan.brandHits },
    analytics: { block: scan.analyticsHits.length > 0, hits: scan.analyticsHits },
    originalImages: { block: scan.originalImages.length > 0, hits: scan.originalImages, dHashAvailable: getSharp() !== false },
    gatedJs: { warn: scan.gatedJs.length > 0, hits: scan.gatedJs },
    counts: { textFilesScanned: scan.textFilesScanned, imagesScanned: scan.imagesScanned, originalsTracked: originalHashes.length },
  };

  if (scan.fontLeaks.length) BLOCK('font-leak', `paid font family name(s) present in build: ` + scan.fontLeaks.map((h) => `${h.family}@${h.file}`).join(', '));
  if (scan.brandHits.length) BLOCK('brand-string', `original brand string "${brandLabel}" present in build: ` + scan.brandHits.map((h) => h.file).join(', '));
  if (scan.analyticsHits.length) BLOCK('analytics-id', `analytics/verification id(s) NOT stripped: ` + scan.analyticsHits.map((h) => `${h.kind}@${h.file}`).join(', '));
  if (scan.originalImages.length) BLOCK('original-image', `unmodified original image detected (byte or pHash) — "no unmodified original detected" FAILED: ` + scan.originalImages.map((h) => `${h.file} ~ ${h.originalSlot} [${h.how}]`).join(', '));
  if (scan.gatedJs.length) WARN('gated-js', `commercial/gated JS plugin reference(s) — verify license: ` + scan.gatedJs.map((h) => h.file).join(', '));

  // ── 5. VERDICT ────────────────────────────────────────────────────────────
  verdict.pass = verdict.blocks.length === 0;

  // Persist the attestation back into the manifest (contract §2: "Write manifest.meta.structureAuthorization").
  // Deterministic: same manifest + same attestation + same --now => byte-identical manifest output.
  // We only write when an attestation was actually supplied (--attest / --interactive), never on a bare run.
  if (typeof args.attest === 'string' || args.interactive) {
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    } catch (e) {
      WARN('manifest-writeback', `could not persist manifest attestation: ${e.message}`);
    }
  }

  // report (deterministic; ordered)
  printReport(verdict, { manifestPath, buildDir, brandLabel });

  if (verdict.pass) {
    await writeNotice(buildDir, manifest, verdict, now);
    return 0;
  }
  return 1;
}

function safeJsonFile(_p) {
  // Synchronous-free: we only support originals via slots/currentValueRef for determinism;
  // a flag-passed originals list is honored only if the caller inlined JSON. Kept null otherwise.
  try { return JSON.parse(_p); } catch { return null; }
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { const k = keyFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

function printReport(v, ctx) {
  const L = [];
  L.push('── publish-gate ─────────────────────────────────────────────');
  L.push(`manifest : ${ctx.manifestPath}`);
  L.push(`build    : ${ctx.buildDir}`);
  L.push(`brand    : ${ctx.brandLabel || '(none derivable)'}`);
  L.push(`buildMode: ${v.buildMode}${v.domDerivativeRefused ? ' (DOM-derivative REFUSED — clean-room rebuild required)' : ''}`);
  L.push(`structure: ${v.structureAuthorization}`);
  L.push(`drift    : ${v.drift.ok ? 'OK' : 'MISMATCH'} (expected="${v.drift.expected}" found="${v.drift.found}")`);
  L.push(`scans    : fonts=${v.scans.fontLeak.block ? 'BLOCK' : 'ok'} brand=${v.scans.brandScrub.block ? 'BLOCK' : 'ok'} analytics=${v.scans.analytics.block ? 'BLOCK' : 'ok'} originalImages=${v.scans.originalImages.block ? 'BLOCK' : 'ok (no unmodified original detected)'} gatedJs=${v.scans.gatedJs.warn ? 'WARN' : 'ok'}`);
  L.push(`         : textFiles=${v.scans.counts.textFilesScanned} images=${v.scans.counts.imagesScanned} originalsTracked=${v.scans.counts.originalsTracked} pHash=${v.scans.originalImages.dHashAvailable ? 'on' : 'OFF(sharp absent)'}`);
  if (v.warns.length) {
    L.push('WARN:');
    for (const w of v.warns) L.push(`  ⚠ [${w.kind}] ${w.detail}`);
  }
  if (v.blocks.length) {
    L.push('BLOCK:');
    for (const b of v.blocks) L.push(`  ✗ [${b.kind}] ${b.detail}`);
  }
  L.push(`VERDICT  : ${v.pass ? 'PASS ✅' : 'BLOCK ✗'}`);
  L.push('─────────────────────────────────────────────────────────────');
  process.stdout.write(L.join('\n') + '\n');
}

async function writeNotice(buildDir, manifest, verdict, now) {
  const lines = [];
  lines.push('NOTICE — clone-any-site publish-gate');
  lines.push('====================================');
  lines.push('');
  lines.push(`Clone name        : ${manifest.meta.name || '(unnamed)'}`);
  lines.push(`Studied reference : ${manifest.meta.target || '(unspecified)'} (provenance only; never a deploy target)`);
  lines.push(`Build mode        : ${verdict.buildMode}`);
  lines.push(`Structure auth    : ${verdict.structureAuthorization}`);
  lines.push(`Build fingerprint : ${manifest.meta.buildFingerprint || '(none)'} (drift guard: ${verdict.drift.ok ? 'matched' : 'n/a'})`);
  lines.push(`Attested at       : ${now || '(no --now supplied)'}`);
  lines.push('');
  lines.push('Legitimacy summary');
  lines.push('------------------');
  lines.push(`- Retained originals authorized : ${verdict.retainedOriginals.required.length} slot(s), 0 unauthorized.`);
  lines.push(`- Paid-font leak scan           : clean (no licensed font family name in built css/js).`);
  lines.push(`- Brand-string scrub            : clean (original brand label absent from build).`);
  lines.push(`- Original-image scan           : no unmodified original detected (byte-hash + perceptual dHash${verdict.scans.originalImages.dHashAvailable ? '' : '; dHash unavailable — sharp absent'}).`);
  lines.push(`- Analytics/verification IDs    : stripped (no GA4/UA/GTM/Meta-pixel/Hotjar/google-site-verification).`);
  if (verdict.warns.length) {
    lines.push('');
    lines.push('Warnings (non-blocking — verify license/usage):');
    for (const w of verdict.warns) lines.push(`  - [${w.kind}] ${w.detail}`);
  }
  lines.push('');
  lines.push('The human structure attestation is the real backstop; the mechanical scans above');
  lines.push('only assert "no unmodified original detected". Loopback mirror IP is excluded from this build.');
  lines.push('');
  // content-derived id of the NOTICE for traceability (no timestamp/random)
  const body = lines.join('\n');
  const id = sha1hex(body + '|' + (manifest.meta.buildFingerprint || '') + '|' + (now || '')).slice(0, 12);
  const final = body + `NOTICE-id: ${id}\n`;
  await writeFile(join(buildDir, 'NOTICE'), final, 'utf8');
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error('publish-gate FATAL', e && e.stack ? e.stack : e); process.exit(2); });
