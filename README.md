# PDF Text Boxes

Type notes directly onto PDFs in Obsidian's built-in PDF viewer. Your notes are
written **into the PDF itself as real, searchable text**, so any app or AI tool
that reads the PDF also sees them. They stay editable in Obsidian.

- Click on a page to place a text box, type, drag it around, change size, colour and background
- German and other accented characters, Greek letters, super/subscripts and math symbols, with a symbol palette
- Undo/redo for everything you do with the boxes
- Works on top of Obsidian's own PDF viewer: search, outline, zoom and links stay as they are
- The untouched original of every PDF is kept, so you can always go back

> Desktop only (macOS, Windows, Linux). Tested on macOS with Obsidian 1.15.

## Install

### From a zip (simplest)
1. Download `pdf-textboxes-<version>.zip` from the [latest release](../../releases/latest)
   (or get it from a friend).
2. Unzip it. You get a folder called `pdf-textboxes`.
3. Move that folder into your vault's plugin folder: `<your vault>/.obsidian/plugins/`.
   The `.obsidian` folder is hidden. On macOS press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>.</kbd> in Finder to show hidden folders;
   on Windows enable "Hidden items" in Explorer's View menu.
4. In Obsidian: **Settings → Community plugins**. If needed, turn off *Restricted mode*,
   click the refresh icon next to *Installed plugins*, and switch on **PDF Text Boxes**.

### With BRAT (gets updates automatically)
Install the *BRAT* community plugin, then *Add beta plugin* with this repository's URL.

## How to use

| Action | How |
|---|---|
| Place a text box | Press **T** (or click the **T** button in the PDF toolbar), then click on the page. **⌥/Alt-click** works anytime. |
| Leave placement mode | **T** again or **Esc** |
| Edit | Double-click a box (or select it and press **Enter**) |
| Move | Drag the box |
| Size, colour, background, delete | Select a box; a small panel slides out next to the **T** button |
| Symbols (α, ², ₁, ≤, ∈ …) | **⌘⇧G / Ctrl+Shift+G** or the **Σ** button; click a symbol to insert it |
| Delete | Select the box and press **Backspace/Delete** |
| Undo / redo | **⌘Z / ⌘⇧Z** (Ctrl on Windows/Linux) while the PDF is active |

Clicking outside a box (or outside the symbol palette) only closes it; the next click places a new box.

Commands (command palette): *Write text boxes into this PDF now*, *Use the current PDF
file as the new original*, *Remove all text boxes and restore the original PDF*,
*Toggle text box placement mode*, *Toggle symbol panel*.

## What happens to your PDFs

**Read this before using it on files you care about.**

- The first time you add a box to a PDF, the plugin stores an **untouched copy** of it
  (`original.pdf`) plus your notes (`annotations.json`) in a data folder, by default the
  hidden folder `.pdf-annotations/` at the vault root.
- After you stop typing for a few seconds, switch files or close the PDF, the PDF file
  in your vault is **rebuilt** from that original plus your notes. The notes become normal
  page text (not PDF annotations), which is what makes them readable by every tool.
- While you work, Obsidian shows the original with your notes as an editable layer on top.
- Your notes and the stored original are always written as a complete new copy first, so
  a crash can't lose them. If Obsidian crashes while a PDF is being rebuilt, it is simply
  rebuilt again the next time you open it.
- Renaming or moving a PDF moves its notes along. Deleting a PDF moves its notes to
  `<data folder>/.trash/` instead of deleting them.
- *Remove all text boxes and restore the original PDF* puts the untouched original back.

The plugin **refuses** to modify PDFs that are **digitally signed** (rewriting would break
the signature) or **encrypted/password-protected**. PDFs with **fillable forms** are
allowed; you get a warning and the form fields are kept.

## Sync

- **iCloud / Dropbox / Syncthing / Git**: sync the whole vault folder including hidden
  folders, so the notes stay editable on every computer that has the plugin.
- **Obsidian Sync** skips hidden folders. In the plugin settings, move the data folder to a
  visible folder (e.g. `PDF text boxes data`) and turn on *Sync all other types* in
  Obsidian Sync's settings. The stored originals then appear as PDFs in your vault.
- Avoid editing the same PDF on two devices at the same time.
- On phones and tablets the plugin does not run, but you still see the notes, because
  they are part of the PDF.

## Fonts

On macOS the notes use Helvetica, on Windows Arial, on Linux the bundled DejaVu Sans.
Characters the main font lacks (e.g. some math symbols) are drawn with the bundled
DejaVu Sans, both on screen and in the PDF. You can pick any other installed font in
the settings.

## Privacy and file access

- **No network access.** The plugin never connects to the internet, has no telemetry and no ads.
- **No access outside your vault.** All files are read and written through Obsidian's
  own file API. The font (Helvetica/Arial or the one you choose) is read through the
  browser's font access, the same list of installed fonts any app can use.
- **Inside your vault** it rewrites only the PDFs you add text boxes to (see above) and
  keeps its data in the data folder.

## Limitations

- Desktop only.
- Embedded PDFs (`![[file.pdf]]`) and canvas cards show the PDF with the notes baked in,
  but you can't edit the boxes there.
- The plugin builds on undocumented parts of Obsidian's PDF viewer. A future Obsidian
  update may break it until the plugin is updated; your notes and originals are not
  affected by that.

## License

MIT © curryonsti. Bundled third-party software and the DejaVu font are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
