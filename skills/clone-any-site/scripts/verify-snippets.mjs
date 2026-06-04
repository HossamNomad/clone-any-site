#!/usr/bin/env node
// verify-snippets.mjs — Playwright harness that proves every DNA card's ## Code snippet runs.
//
// Convention: a card's snippet MUST set `window.__SNIPPET_OK = true` when its effect mounts.
// This signals the harness that the snippet ran without error and completed its intended action.
//
// Usage:
//   node verify-snippets.mjs [cardsDir]          # default: design-system/design-dna/cards
//   HARNESS_TIMEOUT=8000 node verify-snippets.mjs
//
// Exit 0 if all non-skipped snippets pass; exit 1 if any fail.
// Always writes verify-snippets.report.json to cwd.

import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * extractCodeBlock(md) -> string|null
 *
 * Returns the contents of the FIRST fenced ```...``` block that appears under a
 * `## Code` heading (strips fences + optional language tag). Returns null if
 * there is no `## Code` section or no fenced block within it.
 */
export function extractCodeBlock(md) {
  // Find the ## Code section; capture everything from there until the next ## heading (EOF handled below).
  // Bug fix: a previous `\Z` here matched a LITERAL "Z" in JS regex (JS has no \Z), so snippets containing
  // a capital Z — e.g. `translateZ(0)` — truncated before the closing fence. Stop only at the next "## ".
  const sectionMatch = md.match(/^## Code\s*\n([\s\S]*?)(?=^## )/m);
  if (!sectionMatch) {
    // Also handle the case where ## Code is the last section (no following ##)
    const lastSectionMatch = md.match(/^## Code\s*\n([\s\S]*)$/m);
    if (!lastSectionMatch) return null;
    const block = lastSectionMatch[1].match(/```[a-z]*\n([\s\S]*?)```/m);
    return block ? block[1] : null;
  }
  const sectionBody = sectionMatch[1];
  const block = sectionBody.match(/```[a-z]*\n([\s\S]*?)```/m);
  return block ? block[1] : null;
}

/**
 * shouldSkip(fm) -> boolean
 *
 * Returns true iff fm.harness === 'skip'.
 */
export function shouldSkip(fm) {
  return fm.harness === 'skip';
}

// ---------------------------------------------------------------------------
// Inline minimal YAML frontmatter parser (mirrors dna-card.mjs approach)
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text };
  const fmRaw = m[1];
  const body = text.slice(m[0].length);
  const fm = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // Inline array: [a, b, c]
    if (val.startsWith('[')) {
      val = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
    }
    fm[key] = val;
  }
  return { fm, body };
}

// ---------------------------------------------------------------------------
// Minimal inline HTTP server (serves one HTML file per request)
// ---------------------------------------------------------------------------
function serveHtml(html) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, close: () => new Promise(r => server.close(r)) });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Build the test HTML wrapper for a snippet
// ---------------------------------------------------------------------------
function buildHtml(snippet) {
  return `<!doctype html><html><head><meta charset=utf-8><style>*{box-sizing:border-box}</style></head>
<body><div id="stage"></div><script>window.__SNIPPET_OK=false;window.__SNIPPET_ERR=null;
window.addEventListener('error',function(e){window.__SNIPPET_ERR=String(e.message||e.error||e);});
try{
${snippet}
}catch(e){window.__SNIPPET_ERR=String(e);}</script></body></html>`;
}

// ---------------------------------------------------------------------------
// verifyCards — main browser runner
// ---------------------------------------------------------------------------

/**
 * verifyCards(cardsDir, { chromium, timeout=4000 }) ->
 *   { checked, passed, skipped, failed:[{slug, reason}], _reportPath }
 *
 * Reads every *.md from cardsDir, runs each non-skipped snippet in a headless
 * Chromium page, and writes verify-snippets.report.json to process.cwd().
 */
export async function verifyCards(cardsDir, { chromium, timeout = 4000 } = {}) {
  // Read all card files
  let entries = [];
  try {
    entries = (await readdir(cardsDir)).filter(f => f.endsWith('.md')).sort();
  } catch (e) {
    throw new Error(`verifyCards: cannot read cardsDir "${cardsDir}": ${e.message}`);
  }

  const result = {
    checked: 0,
    passed: 0,
    skipped: 0,
    failed: [],
    _reportPath: join(process.cwd(), 'verify-snippets.report.json'),
  };

  let browser = null;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });

    for (const f of entries) {
      const text = await readFile(join(cardsDir, f), 'utf8');
      const { fm, body } = parseFrontmatter(text);
      const slug = fm.slug || f.replace(/\.md$/, '');
      result.checked++;

      // --- SKIP path ---
      if (shouldSkip(fm)) {
        // Skipped cards MUST have a ## Approximation section
        if (!/^## Approximation\b/m.test(body)) {
          result.failed.push({
            slug,
            reason: 'harness:skip without ## Approximation section',
          });
        } else {
          result.skipped++;
        }
        continue;
      }

      // --- Extract snippet ---
      const snippet = extractCodeBlock(body);
      if (!snippet) {
        result.failed.push({ slug, reason: 'no ## Code block found' });
        continue;
      }

      // --- Run in browser ---
      const html = buildHtml(snippet);
      let srv = null;
      let page = null;
      try {
        srv = await serveHtml(html);
        page = await browser.newPage({
          reducedMotion: 'reduce',
        });

        await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'load', timeout });

        let ok = false;
        let err = null;
        try {
          await page.waitForFunction(
            '(window.__SNIPPET_OK===true || window.__SNIPPET_ERR!==null)',
            { timeout }
          );
          ok  = await page.evaluate('window.__SNIPPET_OK');
          err = await page.evaluate('window.__SNIPPET_ERR');
        } catch (e) {
          err = `timeout: snippet did not set __SNIPPET_OK within ${timeout}ms`;
        }

        if (ok && !err) {
          result.passed++;
        } else {
          result.failed.push({
            slug,
            reason: err || 'snippet did not set window.__SNIPPET_OK = true',
          });
        }
      } catch (e) {
        result.failed.push({ slug, reason: `browser error: ${e.message}` });
      } finally {
        if (page) await page.close().catch(() => {});
        if (srv)  await srv.close().catch(() => {});
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // Write report (without _reportPath in JSON itself)
  const { _reportPath, ...reportData } = result;
  await writeFile(_reportPath, JSON.stringify(reportData, null, 2) + '\n');

  // Print summary
  const status = result.failed.length === 0 ? 'PASS' : 'FAIL';
  console.log(
    `[verify-snippets] ${status} — checked=${result.checked} passed=${result.passed} skipped=${result.skipped} failed=${result.failed.length}`
  );
  if (result.failed.length > 0) {
    for (const f of result.failed) console.log(`  FAIL ${f.slug}: ${f.reason}`);
  }
  console.log(`REPORT_FILE ${_reportPath}`);

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('[verify-snippets] playwright not installed — skipping browser checks');
    process.exit(0);
  }

  const cardsDir = process.argv[2] || join(HERE, '..', '..', '..', 'design-system', 'design-dna', 'cards');
  const timeout  = Number(process.env.HARNESS_TIMEOUT || 4000);

  const result = await verifyCards(cardsDir, { chromium, timeout });
  process.exit(result.failed.length === 0 ? 0 : 1);
}
