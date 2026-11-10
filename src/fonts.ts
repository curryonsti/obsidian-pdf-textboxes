import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
// Bundled into main.js by esbuild (binary loader), so a release needs no extra files.
import dejavuBytes from '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
import { extractFace } from './ttc';

export const MAIN_FAMILY = 'PTB Main';
export const FALLBACK_FAMILY = 'PTB DejaVu Sans';

export interface LoadedFonts {
	/** Main font as a standalone TTF, or null to use DejaVu Sans only. */
	primary: ArrayBuffer | null;
	fallback: ArrayBuffer;
	/** Browser-measured baseline offset (em) for the font stack in use. */
	baselineEm?: number;
	/** What is actually used, for the settings tab. */
	description: string;
}

/** A Helvetica-like system font that exists by default on each desktop OS. */
export function defaultMainFontFile(): string {
	if (Platform.isMacOS) return '/System/Library/Fonts/Helvetica.ttc';
	if (Platform.isWin) return 'C:\\Windows\\Fonts\\arial.ttf';
	return '';
}

/** Font bytes currently in use, so windows opened later get the same faces. */
let current: { faces: [string, ArrayBuffer][]; stack: string } | null = null;
/** Faces registered per window document (main window + popouts). */
const attached = new Map<Document, FontFace[]>();

/**
 * Loads the fonts used for text boxes and registers them with the browser
 * (FontFace), so the on-screen boxes and the baked PDF use the *same files*:
 *   main font (from `mainFontFile`)  →  per-character fallback to DejaVu Sans.
 * `docs` are the window documents to register them in (the first one is used
 * to measure the baseline). Sets the CSS variable --ptb-font-family on each body.
 */
export async function loadFonts(mainFontFile: string, docs: Document[]): Promise<LoadedFonts> {
	const fallback = copy(dejavuBytes);
	let primary: ArrayBuffer | null = null;
	let description = 'DejaVu Sans (bundled)';
	const file = mainFontFile.trim();
	if (file) {
		try {
			const raw = new Uint8Array(await fs.promises.readFile(file));
			const preferred = path.basename(file).replace(/\.(ttc|ttf|otf)$/i, '');
			primary = copy(extractFace(raw, preferred));
			description = `${path.basename(file)}, with DejaVu Sans for missing characters`;
		} catch (e) {
			console.warn('[pdf-textboxes] main font could not be loaded, using DejaVu Sans only', e);
			primary = null;
			description = `DejaVu Sans (bundled) – could not load ${file}`;
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
	return { primary, fallback, baselineEm: docs[0] ? measureBaselineEm(docs[0]) : undefined, description };
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
 * rounding does not matter (0.001 em).
 */
function measureBaselineEm(doc: Document): number | undefined {
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
