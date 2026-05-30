# clone-any-site — install & activate (handoff guide)

This is a self-contained Claude Code skill + a `/clone` slash command. Hand the folder to anyone — they drop
two things in place and it's live.

## What you're handing over

```
clone-any-site/                 # the skill
├── SKILL.md                    # the workflow + when it triggers + guardrails
├── INSTALL.md                  # this file
├── references/
│   ├── playbook.md             # the full method (fidelity rationale + traps)
│   ├── repurpose-layer.md      # the Repurpose Layer method (manifest → editor → gate → build)
│   ├── manifest-schema.md      # the numbered-manifest contract (human doc)
│   ├── editor-guide.md         # the interactive editor (double-click, drag-drop, manual mode)
│   ├── clone-interfaces.md     # engineering contract (CLI sigs + /__clone endpoints)
│   └── launch-prompt.md        # paste-into-plan-mode cahier-des-charges generator
└── scripts/
    ├── crawl.mjs               # zero-dep site crawler (the mirror)
    ├── serve.mjs               # zero-dep loopback server (+ --edit editor mode + /__clone/*)
    ├── run-fidelity.mjs        # Playwright fidelity gate (floor-derived, multi-viewport)
    ├── sw.template.js          # offline-shim template (form stub etc.)
    ├── extract-manifest.mjs    # numbered manifest from the hydrated mirror (Playwright)
    ├── manifest.schema.json    # the manifest data contract
    ├── validate-manifest.mjs   # dry-run validator (zero-dep)
    ├── apply-swaps.mjs         # two-target writer (preview + publishable build)
    ├── fit-slot.mjs            # dropped file → responsive set (sharp/ffmpeg, degrades)
    ├── publish-gate.mjs        # blocking IP gate (attestation + scans + pHash)
    ├── distill-techniques.mjs  # cumulative technique ledger → design-system/clone-techniques/
    ├── clone-deps-check.mjs    # runtime dependency probe
    ├── editor/                 # zero-dep edit-map + interactive editor overlay (served)
    └── package.json            # deps (gate + extract + sharp optional)
clone.md                        # the /clone slash command (ships separately, see below)
```

## Install (two ways)

### A. Per-project (recommended for a specific clone job)
From the repo root the work happens in:
```
.claude/skills/clone-any-site/      <- copy the skill folder here
.claude/commands/clone.md           <- copy the command file here
```
Restart Claude Code (or `/exit` and reopen). `/clone` now appears in the slash-command list.

### B. Global (available in every project on the machine)
```
~/.claude/skills/clone-any-site/    (Windows: C:\Users\<you>\.claude\skills\clone-any-site\)
~/.claude/commands/clone.md
```

> The skill also **auto-triggers** without the slash command — just paste a URL and say "clone this site" /
> "rebuild this landing page" / "make me a site like this".

## Use it

```
/clone https://www.example.com
```
or just:
```
clone this site to perfection: https://www.example.com
```

Claude will: scope the job → (for non-trivial sites) produce a plan for approval → recon the live site →
mirror its real compiled build on `127.0.0.1` → prove fidelity with a measured gate → **pause and ask you for
your brand / hero object / copy / fonts** → build a clean engine from scratch with your content → verify.

## Dependencies

- **Node 18+** is all the crawler (`crawl.mjs`) and server (`serve.mjs`) need — they have **zero npm deps**
  (built-in `fetch`).
- The **fidelity gate** (`run-fidelity.mjs`) needs Playwright + image-diff libs, installed once:
  ```bash
  cd .claude/skills/clone-any-site/scripts
  npm install
  npx playwright install chromium
  ```
- The **Repurpose Layer** (extract-manifest, publish-gate, the editor's image pipeline) uses the same
  Playwright above, plus optional **sharp** (`npm i sharp`) for responsive images and the **ffmpeg** binary on
  PATH for video. Both degrade gracefully. Verify everything with `node scripts/clone-deps-check.mjs`. The
  crawler, server (incl. editor mode), validator, swap-preview, technique ledger, and editor overlay stay
  **zero-dependency**.
- **Optional but recommended** for best recon: the **chrome-devtools** MCP server and **Firecrawl**
  (MCP or CLI). The skill works without them but reads the live site less precisely.

## The one rule to respect (legal + ethical)

The pixel-perfect 1:1 mirror is an **internal reference only** — loopback, gitignored, **never deployed under
the original brand**. The only thing that ever ships publicly is the **repurposed** version: your own copy,
your own branding, your own 3D object, and **licensed or open-source (OFL) fonts**. This is a build-your-own /
white-label / design-study tool — not for impersonating someone else's site. The skill enforces this and will
push back if asked to publish a raw clone.

## Package it for sending

To zip the skill + command into one file to send:
```bash
# from .claude/
zip -r clone-any-site.zip skills/clone-any-site commands/clone.md
```
The recipient unzips into their `.claude/` (project or `~`), restarts Claude Code, and runs `/clone <url>`.
