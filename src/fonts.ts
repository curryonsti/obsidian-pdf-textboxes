import { Platform } from 'obsidian';
// Bundled into main.js by esbuild (binary loader), so a release needs no extra files.
import dejavuBytes from '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
import { extractFace } from './ttc';

export const MAIN_FAMILY = 'PTB Main';
export const FALLBACK_FAMILY = 'PTB DejaVu Sans';

export interface LoadedFonts {
	/** Main font as a standalone TTF, or null to use DejaVu Sans only. */
	primary: ArrayBuffer | null;
	fallback: ArrayBuffer;
	/** What is actually used, for the settings tab. */
	description: string;
}

/** PostScript name of a Helvetica-like font that every install of the OS has. Empty = bundled DejaVu Sans. */
export function defaultMainFont(): string {
	if (Platform.isMacOS) return 'Helvetica';
	if (Platform.isWin) return 'ArialMT';
	return '';
}

/** Settings of version 1.0.x stored a font file path; map it to a font name. */
export function fontFromLegacyFile(file: string): string {
	const base = file.trim().split(/[\\/]/).pop()?.replace(/\.(ttc|ttf|otf)$/i, '') ?? '';
	if (!base) return '';
	if (/^arial$/i.test(base)) return 'ArialMT';
	return base;
}

// Local Font Access API (Chromium). Reads installed fonts without file system access.
interface LocalFontData {
	postscriptName: string;
	fullName: string;
	family: string;
	style: string;
	blob(): Promise<Blob>;
}
type QueryLocalFonts = (opts?: { postscriptNames?: string[] }) => Promise<LocalFontData[]>;

function queryLocalFonts(): QueryLocalFonts | null {
	const q = (activeWindow as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
	return q ? q.bind(activeWindow) : null;
}

/** Installed regular-weight fonts, for the settings dropdown. */
export async function listInstalledFonts(): Promise<{ name: string; label: string }[]> {
	const q = queryLocalFonts();
	if (!q) return [];
	const fonts = await q();
	return fonts
		.filter((f) => /^(regular|roman|book|normal)$/i.test(f.style))
		.map((f) => ({ name: f.postscriptName, label: f.fullName }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** The installed font with this PostScript name, as a standalone TTF/OTF. */
async function readInstalledFont(name: string): Promise<Uint8Array> {
	const q = queryLocalFonts();
	if (!q) throw new Error('this Obsidian version cannot read installed fonts');
	const [font] = await q({ postscriptNames: [name] });
	if (!font) throw new Error(`font “${name}” is not installed`);
	const raw = new Uint8Array(await (await font.blob()).arrayBuffer());
	// Some systems hand out the whole collection (.ttc): pick the face.
	return extractFace(raw, name);
}

/** Font bytes currently in use, so windows opened later get the same faces. */
let current: { faces: [string, ArrayBuffer][]; stack: string } | null = null;
/** Faces registered per window document (main window + popouts). */
const attached = new Map<Document, FontFace[]>();

/**
 * Loads the fonts used for text boxes and registers them with the browser
 * (FontFace), so the on-screen boxes and the baked PDF use the *same files*:
 *   main font (installed font `mainFont`)  →  per-character fallback to DejaVu Sans.
 * `mainFont` is the PostScript name of an installed font (read through the
 * browser's Local Font Access API). `docs` are the window documents to register them in (the first one is used
 * to measure the baseline). Sets the CSS variable --ptb-font-family on each body.
 */
export async function loadFonts(mainFont: string, docs: Document[]): Promise<LoadedFonts> {
	const fallback = copy(dejavuBytes);
	let primary: ArrayBuffer | null = null;
	let description = 'DejaVu Sans (bundled)';
	const file = mainFont.trim();
	if (file) {
		try {
			primary = copy(await readInstalledFont(file));
			description = `${file}, with DejaVu Sans for missing characters`;
		} catch (e) {
			console.warn('[pdf-textboxes] main font could not be loaded, using DejaVu Sans only', e);
			primary = null;
			description = `DejaVu Sans (bundled) – could not load ${file}: ${(e as Error).message}`;
		}
	}
	const faces: [string, ArrayBuffer][] = [[FALLBACK_FAMILY, fallback]];
	if (primary) faces.push([MAIN_FAMILY, primary]);
	const stack = primary ? `"${MAIN_FAMILY}", "${FALLBACK_FAMILY}", sans-serif` : `"${FALLBACK_FAMILY}", sans-serif`;
	current = { faces, stack };

	const targets = new Set([...attached.keys(), ...docs]);
	try {
		await Promise.all([...targets].map((d) => attachFonts(d)));
	} catch (e) {
		// A broken main font file: fall back to DejaVu Sans only.
		if (!primary) throw e;
		console.warn('[pdf-textboxes] main font could not be used, using DejaVu Sans only', e);
		current = { faces: [[FALLBACK_FAMILY, fallback]], stack: `"${FALLBACK_FAMILY}", sans-serif` };
		primary = null;
		description = `DejaVu Sans (bundled) – could not use ${file}`;
		await Promise.all([...targets].map((d) => attachFonts(d)));
	}
	return { primary, fallback, description };
}

/** Registers the current fonts in a window's document (e.g. a newly opened popout). */
export async function attachFonts(doc: Document) {
	if (!current) return;
	const win = doc.defaultView;
	if (!win) return;
	detachFonts(doc);
	const list: FontFace[] = [];
	attached.set(doc, list);
	for (const [family, bytes] of current.faces) {
		// Each window has its own FontFace constructor and FontFaceSet.
		const face = new win.FontFace(family, bytes.slice(0));
		await face.load();
		if (attached.get(doc) !== list) return; // detached or replaced meanwhile
		doc.fonts.add(face);
		list.push(face);
	}
	doc.body.style.setProperty('--ptb-font-family', current.stack);
}

export function detachFonts(doc: Document) {
	const list = attached.get(doc);
	if (!list) return;
	attached.delete(doc);
	for (const face of list) doc.fonts.delete(face);
	doc.body?.style.removeProperty('--ptb-font-family');
}

export function unloadFonts() {
	for (const doc of [...attached.keys()]) detachFonts(doc);
	current = null;
}

function copy(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

/**
 * Where the browser puts the baseline inside a text box line, in em. The
 * baker uses this so baked text sits exactly where the overlay showed it.
 * Measured at 1000px (see .ptb-measure in styles.css) so whole-pixel
 * rounding does not matter (0.001 em). Call it when the plugin's styles are
 * loaded (not during onload) and after `loadFonts`.
 */
export function measureBaselineEm(doc: Document): number | undefined {
	const box = doc.body.createDiv('ptb-box ptb-measure');
	try {
		const text = box.createDiv('ptb-text');
		text.setText('Hg');
		const probe = text.createSpan('ptb-measure-probe');
		const em = (probe.getBoundingClientRect().top - box.getBoundingClientRect().top) / 1000;
		return em > 0.5 && em < 1.2 ? em : undefined;
	} finally {
		box.remove();
	}
}
