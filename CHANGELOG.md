# Changelog

All notable changes to this project. This project follows [Semantic Versioning](https://semver.org/).

## [1.11.2] — 2026-10-28

Fix: dragging the thumbnail sometimes did nothing.

The paste fallback from 1.11.0 was gated on `inComposer()`, which only checked
`editor.contains(target)`. During a real drag the `drop` / `dragover` target is a
**container above** the editor (`DIV.an3WzG_composerStack`, `DIV.GRgSLq_card`,
`DIV.GRgSLq_input`, `DIV.GRgSLq_row`, `BUTTON.GRgSLq_add`), so the check was
always false, `overComposer` never latched, and the fallback returned on its first
line. It only worked when the pointer happened to sweep the editor element itself.

### Fixed

- `inComposer(t, ev)` now accepts three relationships: `editor.contains(t)`,
  `t.contains(editor)`, and `t.closest('.cm-content,[data-lexical-editor="true"],.cm-editor')`.
- Added a geometric fallback: pointer coordinates inside the editor rect expanded by
  40 px horizontally, 70 px above and 30 px below (covers the toolbar and padding).
- `dragenter` now latches `overComposer` too (previously only `dragover` updated it),
  and latches monotonically with `||` so sweeping back out mid-drag does not clear it.
- `rescue()` gate is now `overComposer || inComposer(ev.target, ev)`; `dragend`
  carries the drag source as target, so the coordinate fallback covers it.
- Diagnostics gained `dragenter.over`, `drop-rescue.over` and `drop-rescue.near`.

## [1.11.1] — 2026-10-28

### Changed

- Removed the toast that fired when a drag was rescued through the paste channel.
  Dragging is supposed to be silent on success.

## [1.11.0] — 2026-10-28

Fix: dragging a screenshot into the composer stopped working.

Chromium does not expose `DataTransferItem` files to the drop target for same-page
DOM drags: `dragstart` reports `types='Files'`, `nfiles=1`, but at
`dragenter`/`dragover`/`drop` only `text/plain|chromium/x-drag-id` survives and
`dt.files` is empty. The host's `installDocumentDropEvents` guards on
`dt.types.includes("Files")` and returns early, so nothing is ingested.

The host composer (Lexical) accepts files through its paste command, which reads
`event.clipboardData.items` and never touches the OS clipboard — so a synthetic
`ClipboardEvent` can feed it.

### Added

- `pasteIntoComposer(file)` — `new DataTransfer()` → `items.add(file)` → dispatch
  `paste` on the editor. `dispatchEvent` returning false (host called
  `preventDefault`) means the host consumed it.
- `sendCardToComposer()` and a `发到输入框 / Send to composer` button on the preview card.
- `drop` / `dragend` fallback: when a drag ends over the composer but the host bailed
  out for lack of `Files`, the plugin injects the file itself. `dropRescued` prevents
  double insertion.

## [1.10.0] — 2026-10-28

Fix: the dragged file arrived as a virtual `file.png` with unreadable bytes.

Chromium's native `<img>` drag replaces whatever was put in `DataTransfer` with its
own virtual file whose name is the last URL segment (`.../dsh-longpress-shot/file`).

### Changed

- The drag source is now an outer `div._lps-drag[draggable=true]`; the `img` inside
  is `draggable="false"` with `pointer-events:none`, so native image dragging cannot
  take over.
- `onCardDragStart` only does `dt.items.add(file)`; `DownloadURL` and `text/uri-list`
  were removed. A text URL is set only as a last resort when no `File` is available.

## [1.9.x] — 2026-10-28

### Added

- The preview-card thumbnail is draggable again.
- Drag diagnostics appended to `~/.dsh/longpress-shots/diag.jsonl`.

## [1.8.0] — 2026-10-28

Fix: dragging a selection across the preview card froze the marquee and produced no
screenshot.

### Fixed

- The overlay `z-index` was `2147483000`, below the preview card's `2147483001`, so
  moving the pointer into the card handed events to the card and the window-capture
  shield swallowed the rest. Overlay is now `2147483002`.

## [1.7.0] — 2026-10-28

Fix: the saved image was uniformly 1.5× smaller than the dragged region.

### Fixed

- `capture.ps1` declared `SetProcessDpiAwarenessContext` without a return-type
  marshalling that actually applied; under 150 % display scaling `GetClientRect`
  reported CSS pixels (1279×821) instead of physical pixels (1919×1232). Signature
  corrected and the script now carries a UTF-8 BOM so Windows PowerShell 5.1 does not
  decode the Chinese comments as GBK and break the `Add-Type` compilation.

## [1.6.0] — 2026-10-28

### Added

- `/dsh-longpress-shot/log` route plus client-side `diag()` reporting, so failures
  can be diagnosed from `diag.jsonl` instead of by eyeballing pixels.

## [1.4.0] — 2026-10-28

### Added

- The preview card can be dragged by its header; position is remembered in
  `localStorage` and clamped to the viewport with an 8 px margin.
- Default position avoids the whale widget in the lower-right corner.
- A window-capture shield isolates card clicks from the whale widget behind it.

## [1.2.0] — 2026-10-26

### Fixed

- The injected loader row had a stray `}` that broke the inline script.
- The loader now polls `/dsh-longpress-shot/version` every 5 s and reloads the page
  when `shot.js` on disk differs from the running copy — the packaged desktop build
  has no Ctrl+R, so this is the only way to pick up edits without a full restart.

## [1.1.0] — 2026-10-26

Fix: dragging produced a full-window capture instead of the selection.

### Fixed

- Introduced the `armed` state machine between long-press and drag, so the selection
  rectangle follows the pointer and the crop is applied.

## [1.0.0] — 2026-10-26

First working release.

### Added

- Long-press (550 ms) anywhere in the DSH web UI opens a full-window overlay.
- Press and hold again, then drag, to select a region; double-click or Enter captures
  the whole window; Esc or right-click cancels.
- Capture runs on the host via PowerShell + GDI over the DSH window's client area, so
  no screen-share permission prompt appears.
- Screenshots are written to `~/.dsh/longpress-shots/shot-YYYYMMDD-HHMMSS-mmm.png`
  and copied to the clipboard.
- Preview card with save / copy-path / close actions.
