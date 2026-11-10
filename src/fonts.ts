import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
// Bundled into main.js by esbuild (binary loader), so a release needs no extra files.
import dejavuBytes from '../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
import { extractFace } from './ttc';
import { LINE_HEIGHT } from './types';

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

/**
 * Loads the fonts used for text boxes and registers them with the browser
 * (FontFace), so the on-screen boxes and the baked PDF use the *same files*:
 *   main font (from `mainFontFile`)  →  per-character fallback to DejaVu Sans.
 * Also sets the CSS variable --ptb-font-family on <body>.
 */
export async function loadFonts(mainFontFile: string): Promise<LoadedFonts> {
	const fallback = copy(dejavuBytes);
	await registerFace(FALLBACK_FAMILY, fallback);

	let primary: ArrayBuffer | null = null;
	let description = 'DejaVu Sans (bundled)';
	if (mainFontFile.trim()) {
		try {
			const raw = new Uint8Array(await fs.promises.readFile(mainFontFile.trim()));
			const preferred = path.basename(mainFontFile.trim()).replace(/\.(ttc|ttf|otf)$/i, '');
			primary = copy(extractFace(raw, preferred));
			await registerFace(MAIN_FAMILY, primary);
			description = `${path.basename(mainFontFile.trim())}, with DejaVu Sans for missing characters`;
		} catch (e) {
			console.warn('[pdf-textboxes] main font could not be loaded, using DejaVu Sans only', e);
			primary = null;
			description = `DejaVu Sans (bundled) – could not load ${mainFontFile}`;
		}
	}
	const stack = primary ? `"${MAIN_FAMILY}", "${FALLBACK_FAMILY}", sans-serif` : `"${FALLBACK_FAMILY}", sans-serif`;
	document.body.style.setProperty('--ptb-font-family', stack);
	return { primary, fallback, baselineEm: measureBaselineEm(), description };
}

export function unloadFonts() {
	document.body.style.removeProperty('--ptb-font-family');
	for (const face of [...registered]) document.fonts.delete(face);
	registered.clear();
}

const registered = new Set<FontFace>();

async function registerFace(family: string, bytes: ArrayBuffer) {
	for (const f of [...registered]) {
		if (f.family.replace(/"/g, '') === family) {
			document.fonts.delete(f);
			registered.delete(f);
		}
	}
	const face = new FontFace(family, bytes.slice(0));
	await face.load();
	document.fonts.add(face);
	registered.add(face);
}

function copy(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

/**
 * Where the browser puts the baseline inside a text box line, in em. The
 * baker uses this so baked text sits exactly where the overlay showed it.
 */
function measureBaselineEm(): number | undefined {
	const box = document.body.createDiv('ptb-box');
	try {
		// Large size so whole-pixel rounding does not matter (0.001 em).
		box.setCssStyles({ position: 'fixed', left: '-100000px', top: '0', fontSize: '1000px', lineHeight: String(LINE_HEIGHT), visibility: 'hidden' });
		const text = box.createDiv('ptb-text');
		text.setText('Hg');
		const probe = text.createSpan();
		probe.setCssStyles({ display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
		const em = (probe.getBoundingClientRect().top - box.getBoundingClientRect().top) / 1000;
		return em > 0.5 && em < 1.2 ? em : undefined;
	} finally {
		box.remove();
	}
}
