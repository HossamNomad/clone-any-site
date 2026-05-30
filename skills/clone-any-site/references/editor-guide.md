# The interactive editor (`/clone-modifier`)

A zero-dependency visual editor served over the loopback mirror. Open it in **VS Code's Simple Browser** or any
browser and edit the clone by clicking — every change writes back to the numbered manifest (single source of
truth). It never mutates the mirror payload and can never be exposed publicly.

## Open it

```bash
# after the mirror exists + the fidelity gate passed + extract-manifest ran:
CLONE_EDIT=1 CLONE_LOOPBACK_OK=1 CLONE_REPURPOSE_DIR=clones/<name>/repurpose \
  node .claude/skills/clone-any-site/scripts/serve.mjs clones/<name>/mirror/<host>
```
Then in VS Code: **Cmd/Ctrl-Shift-P → "Simple Browser: Show" → `http://127.0.0.1:4321/`**. (Any browser works
too.) A red **"LOOPBACK PREVIEW — NOT SHIPPABLE"** watermark is always present — that's intentional.

## Edit by clicking

- **Numbered badges** sit on every editable element. Amber = still the original (counts toward publish block),
  green = your content. Chrome (nav/footer/legal) is hidden from the view but listed in the **Slots** panel and
  always scanned.
- **Double-click text** → edit inline. **Enter** saves, **Esc** cancels.
- **Double-click an image / illustration / photo / video / svg** → a drop-zone popover opens. **Drag-drop a
  file** (or click to choose). It's automatically fit to the slot's responsive set (`fit-slot`) and swapped into
  the original's exact layout.
- **Slots** button → the full table (incl. chrome), with a **keep** toggle per row to consciously retain an
  original.

## Toolbar

- **Map / Manual** — Map shows full badges for picking; **Manual** shrinks them to dots so the page stays fully
  usable while you still double-click to edit. (Content-only either way — structure/animation/CSS are never
  touched.)
- **All / 390 / 768 / 1440** — filter badges to a breakpoint (mobile art-direction). Slots that don't exist at a
  breakpoint drop out.
- **Before / After** — compare your content against the original, in place.
- **"N slots block publish"** — live counter of retained originals. It must reach **ready to publish** (and pass
  `/clone-publish`) before anything ships.

## What it writes

Every action hits a loopback endpoint (`/__clone/slot`, `/__clone/upload`) that updates
`clones/<name>/repurpose/manifest.json` + `manifest.lock.json`. Imported files land in
`repurpose/assets/` (gitignored). The same manifest later drives the publishable build. The server refuses to
arm these endpoints unless it's bound to `127.0.0.1` with `CLONE_LOOPBACK_OK=1`.
