#!/usr/bin/env node
// clone-watch.mjs — leave it running; the moment you drop (or replace) a file named after a slot tag
// in <clone>/swaps/, it is auto-compressed + registered via processDrops (clone-swap.mjs). The live
// serve-repurpose server then serves the new bytes at /__swap/<ID> on the next reload — animations untouched.
//
//   node clone-watch.mjs --clone eiger-extreme        (bare name -> <repoRoot>/clones/<name>)
//   node clone-watch.mjs --clone ./clones/eiger-extreme
//
// On start it runs ONE catch-up pass over anything already in swaps/, then watches. Ctrl-C to stop.
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { processDrops } from './clone-swap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..'); // scripts -> clone-any-site -> skills -> .claude -> repoRoot(hossam2)

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) o[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  return o;
}
function resolveClone(c) {
  if (!c || c === true) throw new Error('clone-watch: --clone <dir|name> is required');
  return (isAbsolute(c) || /[\\/]/.test(c)) ? resolve(c) : join(REPO_ROOT, 'clones', c);
}
// only react to real drops: a tag-shaped filename, not our outputs / dotfiles / editor temp files
function isDropFile(name) {
  if (!name) return false;
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (name === 'swaps.json' || name === 'COMPRESSION-REPORT.json' || name.endsWith('.md')) return false;
  if (/~$|\.tmp$|\.crdownload$|^~\$/.test(name)) return false;
  return /^[A-Za-z]+-\d+\.[A-Za-z0-9]+$/.test(name);
}

async function run() {
  const A = parseArgs(process.argv);
  const cloneDir = resolveClone(A.clone);
  const swapsDir = join(cloneDir, 'swaps');
  const stamp = () => new Date().toISOString();

  async function runOnce(reason) {
    try {
      const r = await processDrops(cloneDir, { now: stamp() });
      const did = r.processed.length, warn = r.warnings.length;
      if (did || warn) console.log(`[${stamp()}] ${reason}: ${did} swapped, ${warn} skipped`);
    } catch (e) {
      console.error(`[${stamp()}] processDrops error:`, e && e.message ? e.message : e);
    }
  }

  console.log(`clone-watch: ${cloneDir}`);
  console.log(`watching: ${swapsDir}  (drop files named like the visual-map tags, e.g. VID-04.mp4)`);
  await runOnce('startup catch-up');

  let timer = null;
  const pending = new Set();
  watch(swapsDir, { persistent: true }, (_event, filename) => {
    const name = filename && filename.toString();
    if (!isDropFile(name)) return;
    pending.add(name);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const names = [...pending].join(', '); pending.clear(); timer = null;
      runOnce('drop ' + names);
    }, 250); // debounce: editors/copies fire multiple events; coalesce
  });

  // keep the process alive
  process.stdin && process.stdin.resume && process.stdin.resume();
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) run().catch((e) => { console.error('clone-watch FATAL', e && e.message ? e.message : e); process.exit(1); });

export { isDropFile, resolveClone };
