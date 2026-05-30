// Runtime dependency probe for the clone-any-site Repurpose Layer. ZERO deps.
// Single source of truth for "is sharp/ffmpeg/playwright present?" — fit-slot and the gate import this.
//
//   node clone-deps-check.mjs          # human table
//   node clone-deps-check.mjs --json   # machine JSON
//
// Exit 0 if the CORE (node built-ins only) is fine; non-core tools are optional and only degrade features.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

function hasModule(name) {
  try { require.resolve(name); return true; } catch { return false; }
}
function hasBinary(bin, args = ['-version']) {
  try {
    // pass as ONE shell command string (no separate args array) to avoid Node DEP0190 with shell:true
    const cmd = bin + (args.length ? ' ' + args.join(' ') : '');
    const r = spawnSync(cmd, { stdio: 'ignore', timeout: 8000, shell: true });
    return r.status === 0 || r.status === 1; // ffmpeg -version exits 0; some tools 1 but exist
  } catch { return false; }
}

export const deps = {
  // module: [present, whatItUnlocks, installHint]
  sharp:       { present: hasModule('sharp'),       feature: 'responsive image sets (webp/avif/srcset) in fit-slot', install: 'npm i sharp' },
  ffmpeg:      { present: hasBinary('ffmpeg'),      feature: 'video transcode (mp4/webm) + poster in fit-slot',     install: 'install ffmpeg + add to PATH' },
  playwright:  { present: hasModule('playwright'),  feature: 'extract-manifest, publish-gate pHash, fidelity gate', install: 'npm i -D playwright && npx playwright install chromium' },
  pixelmatch:  { present: hasModule('pixelmatch'),  feature: 'fidelity gate pixel diff',                            install: 'npm i -D pixelmatch' },
  pngjs:       { present: hasModule('pngjs'),        feature: 'fidelity gate + pHash png decode',                    install: 'npm i -D pngjs' },
  'ssim.js':   { present: hasModule('ssim.js'),      feature: 'fidelity gate structural similarity',                 install: 'npm i -D ssim.js' },
};

export function require_(name) {
  if (!deps[name] || !deps[name].present) {
    throw new Error(`[clone-deps] "${name}" required but absent. ${deps[name]?.install || ''}`.trim());
  }
}

function main() {
  const asJson = process.argv.includes('--json');
  if (asJson) { process.stdout.write(JSON.stringify(deps, null, 2) + '\n'); return; }
  console.log('clone-any-site — dependency check\n');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('tool', 12), pad('status', 9), 'unlocks');
  console.log('-'.repeat(64));
  for (const [name, d] of Object.entries(deps)) {
    console.log(pad(name, 12), pad(d.present ? 'PRESENT' : 'absent', 9), d.feature);
    if (!d.present) console.log(' '.repeat(22) + '↳ ' + d.install);
  }
  const core = ['playwright', 'pixelmatch', 'pngjs', 'ssim.js'].every((k) => deps[k].present);
  console.log('\ngate-ready (extract/fidelity/publish):', core ? 'yes' : 'NO — install the absent -D tools above');
  console.log('asset pipeline (fit-slot):', deps.sharp.present ? (deps.ffmpeg.present ? 'full' : 'images only (no video)') : 'degraded (copies source at native size)');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('clone-deps-check.mjs')) main();
