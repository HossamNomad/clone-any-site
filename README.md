# clone-any-site

A portable [Claude Code](https://claude.com/claude-code) skill + `/clone` slash command that clones **any
website** to a genuinely high fidelity bar — pixel-perfect against an empirical noise floor — and then helps
you **repurpose it as your own** site.

It handles the easy case (static marketing pages) *and* the hard case most tools choke on: **WebGL / 3D
scroll experiences** (React Three Fiber, three.js, GSAP, Lenis, Next.js). You can't hand-rebuild those from
guesses — so the skill mirrors the site's *real compiled build* on loopback as a measured reference, proves
fidelity, then writes a clean engine from scratch for your own content.

```
/clone https://www.example.com
```

---

## What it actually does

Two phases, always in this order:

| Phase | What | Where it runs |
|-------|------|---------------|
| **C — Mirror** | Recon (live DOM) → crawl the compiled build → vendor runtime assets → stub forms → serve on `127.0.0.1` → **prove fidelity** with a floor-derived gate (Playwright + pixelmatch + SSIM) | **Loopback only.** Internal reference. Never deployed. |
| **B — Repurpose** | A clean engine written from scratch (version-matched stack) + **your** 3D object / copy / branding / licensed fonts | This is the **only** thing that ships publicly. |

The bundled scripts are dependency-light and battle-tested on a real React-Three-Fiber + drei + Lenis +
Next.js landing page:

- `scripts/crawl.mjs` — recursive site crawler, **zero npm deps** (works where `wget` is unavailable, never hangs on an installer).
- `scripts/serve.mjs` — **zero-dep** loopback static server (HTTP Range for video, auto service-worker registration).
- `scripts/run-fidelity.mjs` — the fidelity gate: captures reference×2 + mirror×2, derives the noise floor, PASS/FAIL with a report + per-depth diff images.
- `scripts/sw.template.js` — offline shim (form stub + optional decoder/HDRI/image redirects).

---

## Install

### Option A — copy the folders (works everywhere)

Clone this repo, then copy the two folders into your Claude Code config:

```bash
git clone https://github.com/<owner>/clone-any-site.git

# Per-project:
cp -r clone-any-site/skills/clone-any-site   <your-project>/.claude/skills/
cp    clone-any-site/commands/clone.md        <your-project>/.claude/commands/

# OR globally (all projects):
cp -r clone-any-site/skills/clone-any-site   ~/.claude/skills/
cp    clone-any-site/commands/clone.md        ~/.claude/commands/
```

Restart Claude Code. Type `/clone <url>` — or just paste a URL and say *"clone this site"* (the skill
auto-triggers).

### Option B — download the zip

Grab the latest archive from [**Releases**](../../releases), unzip, and copy the `skills/` and `commands/`
folders as in Option A.

> Full handoff details are in [`skills/clone-any-site/INSTALL.md`](skills/clone-any-site/INSTALL.md).

---

## Requirements

- **Node 18+** — all the crawler/server need (built-in `fetch`, zero npm deps).
- The **fidelity gate** additionally needs Playwright + image-diff libs, installed once:
  ```bash
  cd skills/clone-any-site/scripts && npm install && npx playwright install chromium
  ```
- **Optional (better recon):** the [chrome-devtools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  server and [Firecrawl](https://firecrawl.dev). The skill works without them, just reads the live site less precisely.

---

## The one rule (legal + ethical)

The pixel-perfect 1:1 mirror is an **internal reference only** — loopback, gitignored, **never deployed under
the original brand**. The only thing that ever ships publicly is the **repurposed** version: your own copy,
your own branding, your own 3D object, and **licensed or open-source (OFL) fonts**.

This is a **build-your-own / white-label / design-study** tool — not for impersonating someone else's site or
passing off a clone as their property. The skill enforces this and will push back if asked to publish a raw
clone. Use it on sites you're authorized to study or rebuild, and respect copyright, trademarks, and font licenses.

---

## License

[MIT](LICENSE) — do what you want, no warranty. You are responsible for how you use it (see the rule above).
