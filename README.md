# clone-any-site

A portable [Claude Code](https://claude.com/claude-code) skill + `/clone` slash command that clones **any
website** to a genuinely high fidelity bar — pixel-perfect against an empirical noise floor — and then helps
you **repurpose it as your own** site.

It handles the easy case (static marketing pages) *and* the hard case most tools choke on: **WebGL / 3D
scroll experiences** (React Three Fiber, three.js, GSAP, Lenis, Next.js). You can't hand-rebuild those from
guesses — so the skill mirrors the site's *real compiled build* on loopback as a measured reference, proves
fidelity, then **repurposes it by swapping numbered elements** — keeping 100% of the structure and animations,
so your own copy / media / branding ride the real build. (When the original's structure genuinely can't be
reused, it falls back to a clean-room rebuild.)

```
/clone https://www.example.com
```

## Commands

| Command | What it does |
|---------|--------------|
| `/clone <url>` | Mirror the site pixel-perfect on loopback, prove fidelity, hand you a numbered edit-map — then **stop**. |
| `/clone-list` | **Dashboard** of every clone you've made: thumbnails, fidelity badges, Open/Edit/Stop loopback servers, recoverable trash. |
| `/clone-map <name>` | Numbered edit-map overlay (badges + slot table + "N block publish" counter). |
| `/clone-modifier <name>` | **Visual editor** — double-click text/images to edit, drag-drop/paste import, Cmd-K palette, CMS panel, 1-click themes. |
| `/clone-swap "#N <file\|text>"` | Swap a single numbered element. |
| `/clone-preview <name>` | Watermarked loopback before/after. |
| `/clone-publish <name>` | IP publish-gate → publishable build (human-pause before deploy). |

## New in v1.3

- **Clone Atlas — folder-drop swaps.** Drop a numbered file in a clone's `swaps/` folder and it's auto-compressed (sharp/ffmpeg, timing preserved) and swapped into *only* that slot — animations untouched. Four commands: `npm run clone:map | clone:swap | clone:watch | clone:verify`.
- **DOM-derivative is now the default repurpose path.** Keep the proven mirror's structure + animations and swap numbered elements; clean-room rebuild is the *fallback* (not the default).
- **40-spec test suite.** `cd skills/clone-any-site/scripts && npm test` (`node --test`) — crawl/serve/manifest/swap/publish-gate all covered.
- **Lessons memory + more tooling.** `references/lessons-resolved.md` (every solved gotcha), plus `design-quality-score.mjs` and `distill-market.mjs`.
- **Windows-first hardening.** Media-swap subprocess calls no longer mangle paths that contain spaces (e.g. `…\Claude Code\…`).

## New in v1.2

- **Edits that stick + propagate.** Change a word once → it updates **every** matching instance, and the
  edit survives a reload and even React re-renders (stable `data-cl-id` anchors + a MutationObserver).
- **Media swaps keep responsiveness.** Replacing an image rebuilds its `srcset` instead of stripping it; logos, inline SVG, and `<video>`+poster all swap correctly.
- **Real editing UX.** A **Cmd/Ctrl-K command palette**, a searchable **CMS side panel** with **find-and-replace**, and a mobile FAB — works on phone and desktop.
- **1-click themes.** Recolor/retype the whole clone via CSS-variable overrides **without touching structure or animations**.
- **`/clone-list` dashboard.** See, preview, launch, edit, and retire all your clones from one loopback page.

---

## What it actually does

Two phases, always in this order:

| Phase | What | Where it runs |
|-------|------|---------------|
| **C — Mirror** | Recon (live DOM) → crawl the compiled build → vendor runtime assets → stub forms → serve on `127.0.0.1` → **prove fidelity** with a floor-derived gate (Playwright + pixelmatch + SSIM) | **Loopback only.** Internal reference. Never deployed. |
| **B — Repurpose** | **Default — DOM-derivative swap:** keep the proven mirror's structure + animations, swap numbered elements (copy / media / branding / licensed fonts) via the manifest + visual editor. **Fallback:** a clean engine from scratch when the original's structure genuinely can't be reused. | This is the **only** thing that ships publicly. |

The bundled scripts are dependency-light and battle-tested on a real React-Three-Fiber + drei + Lenis +
Next.js landing page:

- `scripts/crawl.mjs` — recursive site crawler, **zero npm deps** (works where `wget` is unavailable, never hangs on an installer).
- `scripts/serve.mjs` — **zero-dep** loopback static server (HTTP Range for video, auto service-worker registration).
- `scripts/run-fidelity.mjs` — the fidelity gate: captures reference×2 + mirror×2, derives the noise floor, PASS/FAIL with a report + per-depth diff images.
- `scripts/sw.template.js` — offline shim (form stub + optional decoder/HDRI/image redirects).

---

## Install

### Option A — as a Claude Code plugin (one-liner, recommended)

In Claude Code, run:

```
/plugin marketplace add HossamNomad/clone-any-site
/plugin install clone-any-site@hossam-skills
```

That's it — `/clone` is now available. (Run `/plugin` anytime for the interactive browser.)

### Option B — copy the folders (works everywhere, no plugin system)

Clone this repo, then copy the two folders into your Claude Code config:

```bash
git clone https://github.com/HossamNomad/clone-any-site.git

# Per-project:
cp -r clone-any-site/skills/clone-any-site   <your-project>/.claude/skills/
cp    clone-any-site/commands/clone.md        <your-project>/.claude/commands/

# OR globally (all projects):
cp -r clone-any-site/skills/clone-any-site   ~/.claude/skills/
cp    clone-any-site/commands/clone.md        ~/.claude/commands/
```

On **Windows (PowerShell)** the same copy:

```powershell
git clone https://github.com/HossamNomad/clone-any-site.git

# Per-project:
Copy-Item -Recurse clone-any-site\skills\clone-any-site "<your-project>\.claude\skills\"
Copy-Item          clone-any-site\commands\clone.md      "<your-project>\.claude\commands\"

# OR globally (all projects):
Copy-Item -Recurse clone-any-site\skills\clone-any-site "$HOME\.claude\skills\"
Copy-Item          clone-any-site\commands\clone.md      "$HOME\.claude\commands\"
```

Restart Claude Code. Type `/clone <url>` — or just paste a URL and say *"clone this site"* (the skill
auto-triggers).

### Option C — download the zip

Grab the latest archive from [**Releases**](../../releases), unzip, and copy the `skills/` and `commands/`
folders as in Option B.

> Full handoff details are in [`skills/clone-any-site/INSTALL.md`](skills/clone-any-site/INSTALL.md).

---

## Requirements

- **Node 18+** (minimum) — all the crawler/server need (built-in `fetch`, zero npm deps). **Node 20 LTS recommended** (see `.nvmrc`); the `engines` field enforces `>=18`.
- The **fidelity gate** additionally needs Playwright + image-diff libs, installed once:
  ```bash
  cd skills/clone-any-site/scripts && npm install && npx playwright install chromium
  ```
- **Optional media tooling** — `ffmpeg` on PATH (video swaps) and `sharp` (responsive image sets). **Both are optional and degrade gracefully** — without them media is copied at native size. Verify with `node skills/clone-any-site/scripts/clone-deps-check.mjs`.
- **Optional (better recon):** the [chrome-devtools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  server and [Firecrawl](https://firecrawl.dev). The skill works without them, just reads the live site less precisely.

### Quick start — run the scripts directly (no plugin needed)

```bash
cd skills/clone-any-site/scripts
npm install && npx playwright install chromium      # one-time
node crawl.mjs https://www.example.com              # mirror the compiled build
node serve.mjs ./mirror/www.example.com             # loopback 127.0.0.1 — prints CLONE_PORT=
node run-fidelity.mjs                               # PASS/FAIL fidelity gate + diff images
node extract-manifest.mjs                           # numbered manifest of every editable slot
npm test                                            # 40-spec suite, all green
```

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

[MIT](LICENSE) — do what you want, no warranty. **MIT covers the tool itself; it grants no rights to any site you clone.** You are responsible for how you use it (see the rule above).
