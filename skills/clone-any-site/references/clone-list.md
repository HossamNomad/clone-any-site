# `/clone-list` — the clone dashboard

A live, loopback-only dashboard that inventories every clone under a `clones/` root and lets you preview,
launch, edit, and retire them. Zero runtime dependencies (Node 18+ built-ins); Playwright is only ever
optional (for generating a missing thumbnail — not required).

## Launch

```bash
node scripts/clone-list.mjs [clonesRoot]      # default ./clones
CLONE_LIST_PORT=4500 node scripts/clone-list.mjs
CLONE_LIST_PORT=0    node scripts/clone-list.mjs   # ephemeral port (prints CLONE_LIST_PORT=<n>)
```

Open the printed `http://127.0.0.1:<port>/`.

## What a card shows

- **Thumbnail** — the first existing screenshot found (`_recon/clone-list-thumb.png`, then a `mir-0.png` /
  `ref-0.png` in any of `docs/fidelity` · `engine/fidelity` · `_recon/fidelity`), else an SVG placeholder.
- **Fidelity badge** — PASS / FAIL + mean SSIM, parsed from the most-recent `fidelity-report.md`.
- **Source URL** (click to copy), **N elements · M swaps** (from `repurpose/manifest.json` if present),
  **disk size**, **last-modified**, and a **live dot** (green when its mirror server is running).

The scan is **best-effort**: clones whose mirror payload isn't on disk (gitignored) still appear, with
Open/Edit disabled and a "re-crawl" hint.

## Actions

| Button | Effect |
|--------|--------|
| **Open** | starts `serve.mjs` for that clone's mirror on a free port, opens the URL |
| **Edit** | starts it in editor mode (`CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=…`) — needs an edit-map |
| **Stop** | kills that clone's server |
| **Stop all** | kills every running clone server |
| delete tick → **Move to trash…** | moves marked clones to `clones/_trash/<name>-<ts>/` after a confirm modal |
| **Trash** drawer → **Restore** | moves a trashed clone back |

## Safety

- **Loopback only** (`127.0.0.1`) — never binds `0.0.0.0`, never deploys.
- **No real deletion on a click** — "delete" = move to a recoverable trash. Permanently emptying the trash is
  a separate manual act you take yourself.
- **No zombie servers** — child servers use ephemeral ports (read back from `CLONE_PORT=`), are tracked, and
  are killed when the dashboard exits (SIGINT/SIGTERM/exit).

## API (loopback JSON)

`GET /api/clones` · `GET /api/status` · `GET /api/trash-list` · `GET /api/thumb/:name` ·
`POST /api/start {name,mode}` (`mode`: `open`|`edit`) · `POST /api/stop {name}` · `POST /api/stop-all` ·
`POST /api/trash {names:[]}` · `POST /api/restore {trashName}`.
