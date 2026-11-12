# Development

```bash
npm install
npm run link -- "/path/to/a/test vault"   # symlinks this folder into <vault>/.obsidian/plugins/pdf-textboxes
npm run dev                                 # esbuild watch -> main.js
```

Install the *Hot Reload* community plugin in the test vault: `npm run link` creates the
`.hotreload` marker, so the plugin reloads whenever `main.js` changes. Without it, toggle the
plugin off and on in *Settings → Community plugins*.

Always test on copies of PDFs.

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Type-check and production build |
| `npm run lint` | ESLint with `eslint-plugin-obsidianmd` (the rules Obsidian's review bot uses) |
| `npm run package` | Build and create `dist/pdf-textboxes-<version>.zip` for sharing |
| `npm run notices` | Regenerate `THIRD_PARTY_NOTICES.md` from what is bundled |
| `npm run bench -- some.pdf [n]` | Bake benchmark: joins `some.pdf` n times, one box per page; writes `bench-out/baked.pdf` |
| `npm run test-pdfs -- <out-dir> <src.pdf>…` | Generates edge-case PDFs (582+ pages, rotated, form, fake-signed, scanned) |
| `swift scripts/extract.swift file.pdf 1 2` | Text that macOS PDFKit (Preview/Spotlight) extracts from pages 1 and 2 |
| `swift scripts/where.swift file.pdf 3 "Text"` | PDF coordinates of a string on page 3 |

## Releasing

1. Bump `version` in `manifest.json` and `package.json`, add it to `versions.json`.
2. Commit, then tag with the bare version and push: `git tag 1.0.1 && git push --tags`.
3. The *Release* workflow builds, lints and publishes `main.js`, `manifest.json`,
   `styles.css` and the zip.

## Architecture

| Piece | File | Role |
|---|---|---|
| Viewer internals | `src/viewer-hooks.ts` | **The only file that touches private Obsidian/pdf.js objects.** Fix this first after an Obsidian update. |
| Overlay | `src/overlay.ts` | Text box UI per page, style panel, symbol palette, resizing, undo/redo; re-attaches on `pagerendered`. |
| Rich text | `src/rich.ts`, `src/rich-dom.ts` | Per-character colour and superscript/subscript (`runs`), reading/writing them in the editable DOM, and measuring where the browser wrapped lines (`wrap`), which the baker reuses. |
| Storage | `src/store.ts` | `<data folder>/<pdf path>/annotations.json` + `original.pdf`; atomic writes; rename/delete. |
| Scheduler | `src/baker.ts` | When to rebuild; runs the worker; writes the visible PDF with `vault.modifyBinary` (re-baked on open if a write was interrupted). |
| Bake | `src/bake.ts`, `src/bake.worker.ts` | original + boxes → new PDF (pdf-lib), PDF inspection (signed/encrypted/forms). |
| Fonts | `src/fonts.ts`, `src/ttc.ts` | Loads the main font file + bundled DejaVu Sans into the browser (FontFace) and the baker, so both use identical glyphs. |

Key design points:

* **The viewer shows `original.pdf`** for PDFs with notes (URL substitution), and the boxes
  are drawn as an overlay, so the baked text is never displayed twice.
* **Writing the baked PDF does not reload the viewer.** Obsidian's PDF view reloads on every
  vault `modify` event; the plugin ignores the ones caused by its own writes (size + mtime).
* **Coordinates** are PDF points (origin bottom-left), the top-left corner of the box as
  displayed, so positions are independent of zoom and page rotation.
* **Layout parity:** `white-space: pre`, no kerning/ligatures, the same font files, and a
  browser-measured baseline, so baked text lands where the overlay showed it (verified to
  ~0.1 pt).
* **Saving:** JSON on every change (coalesced); the PDF is rebuilt in a Web Worker after a
  pause, on file switch/close and on quit.
