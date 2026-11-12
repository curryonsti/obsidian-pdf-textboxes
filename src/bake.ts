import { PDFDict, PDFDocument, PDFFont, PDFName, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { BG_PAD_EM, LINE_HEIGHT, PdfInspection, SCRIPT_SCALE, SUB_DROP_EM, SUP_RISE_EM, TextBox } from './types';
import { visualLines } from './rich';

export interface BakeFonts {
	/** Main font as a standalone TTF (e.g. Helvetica or Arial), or null. */
	primary: Uint8Array | null;
	/** DejaVu Sans: covers every character the primary font lacks. */
	fallback: Uint8Array;
	/**
	 * Distance from the top of a line box to the baseline, in em, as measured in
	 * the browser (so the PDF matches the overlay exactly). Computed from the
	 * font's hhea table if missing.
	 */
	baselineEm?: number;
}

/**
 * Pure bake function: original PDF + boxes -> new PDF bytes.
 * The text is drawn as real page content (BT/Tj operators with embedded,
 * subset fonts that have ToUnicode maps), not as annotations. Characters the
 * main font lacks are drawn with DejaVu Sans, exactly like the browser's
 * per-character fallback in the on-screen overlay.
 * Runs inside a Web Worker in the plugin, and in Node for the benchmark.
 */
export async function bakePdf(original: Uint8Array, boxes: TextBox[], fonts: BakeFonts): Promise<Uint8Array> {
	if (boxes.length === 0) return original;

	const doc = await PDFDocument.load(original, { updateMetadata: false });
	doc.registerFontkit(fontkit);

	const fbFk = fontkit.create(fonts.fallback);
	const fallback = { pdf: await doc.embedFont(fonts.fallback, { subset: true }), fk: fbFk };
	const primary = fonts.primary
		? { pdf: await doc.embedFont(fonts.primary, { subset: true }), fk: fontkit.create(fonts.primary) }
		: fallback;
	// Same formula the browser uses with `line-height: 1.2`: half-leading + ascent.
	const m = primary.fk;
	const ascent = m.ascent / m.unitsPerEm; // hhea ascender
	const descent = -m.descent / m.unitsPerEm; // hhea descender
	const baselineEm = fonts.baselineEm ?? (LINE_HEIGHT - (ascent + descent)) / 2 + ascent;

	const pageCount = doc.getPageCount();
	for (const box of boxes) {
		const text = box.text;
		if (!text.trim() || box.page < 1 || box.page > pageCount) continue;
		const page = doc.getPage(box.page - 1);
		const rot = ((page.getRotation().angle % 360) + 360) % 360;

		// The page is displayed rotated clockwise by `rot`. Convert the display
		// directions into user space (rotate counter-clockwise by rot).
		const t = (rot * Math.PI) / 180;
		const cos = Math.round(Math.cos(t));
		const sin = Math.round(Math.sin(t));
		const down = { x: sin, y: -cos }; // rotCCW((0,-1), rot)
		const right = { x: cos, y: sin }; // rotCCW((1, 0), rot)

		const size = box.fontSize;
		// Lines as the overlay showed them (newlines + where the text wrapped).
		// Each styled segment (colour, superscript/subscript) is split further
		// into main-font/fallback-font runs.
		const lines = visualLines(text, box.runs, box.wrap?.at).map((segs) => {
			const runs: { text: string; font: PDFFont; size: number; rise: number; color: string }[] = [];
			for (const seg of segs) {
				const runSize = seg.s ? size * SCRIPT_SCALE : size;
				const rise = seg.s === '^' ? SUP_RISE_EM * size : seg.s === '_' ? -SUB_DROP_EM * size : 0;
				for (const r of splitRuns(seg.text, primary, fallback)) {
					runs.push({ ...r, size: runSize, rise, color: seg.color ?? box.color });
				}
			}
			return { runs, width: runs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, r.size), 0) };
		});

		// Optional background: the same rectangle the overlay shows (text box
		// plus BG_PAD_EM on every side), drawn underneath the text.
		if (box.bg) {
			const pad = size * BG_PAD_EM;
			const textW = box.wrap?.width ?? Math.max(...lines.map((l) => l.width));
			const textH = Math.max(lines.length * LINE_HEIGHT * size, box.h ?? 0);
			const w = textW + 2 * pad;
			const h = textH + 2 * pad;
			const along = h - pad; // from the box top to the rectangle's bottom edge
			page.drawRectangle({
				x: box.x + down.x * along - right.x * pad,
				y: box.y + down.y * along - right.y * pad,
				width: w,
				height: h,
				color: hexToRgb(box.bg),
				rotate: degrees(rot),
			});
		}

		lines.forEach(({ runs }, i) => {
			if (!runs.length) return;
			const offset = size * (baselineEm + i * LINE_HEIGHT);
			let advance = 0;
			for (const run of runs) {
				const along = offset - run.rise; // raised = less far down
				page.drawText(run.text, {
					x: box.x + down.x * along + right.x * advance,
					y: box.y + down.y * along + right.y * advance,
					size: run.size,
					font: run.font,
					color: hexToRgb(run.color),
					rotate: degrees(rot),
				});
				advance += run.font.widthOfTextAtSize(run.text, run.size);
			}
		});
	}

	return doc.save({ updateFieldAppearances: false });
}

interface FontPair {
	pdf: PDFFont;
	fk: { hasGlyphForCodePoint(cp: number): boolean };
}

/** Split a line into runs that the primary font can draw and runs that need the fallback. */
function splitRuns(line: string, primary: FontPair, fallback: FontPair) {
	const runs: { text: string; font: PDFFont }[] = [];
	for (const ch of line) {
		const cp = ch.codePointAt(0)!;
		// Combining marks (e.g. the macron in x̄) stay with the previous run.
		const combining = cp >= 0x300 && cp <= 0x36f;
		const use = combining && runs.length ? null : primary === fallback || primary.fk.hasGlyphForCodePoint(cp) ? primary : fallback;
		const last = runs[runs.length - 1];
		if (last && (use === null || last.font === use.pdf)) last.text += ch;
		else runs.push({ text: ch, font: (use ?? primary).pdf });
	}
	return runs;
}

/** Check a PDF before the plugin starts rewriting it. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
	try {
		const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
		let signed = false;
		for (const [, obj] of doc.context.enumerateIndirectObjects()) {
			if (!(obj instanceof PDFDict)) continue;
			const type = obj.get(PDFName.of('Type'));
			if (obj.has(PDFName.of('ByteRange')) || (type instanceof PDFName && type.asString() === '/Sig')) {
				signed = true;
				break;
			}
		}
		const perms = doc.catalog.get(PDFName.of('Perms'));
		if (perms) signed = true;
		let formFields = 0;
		try {
			formFields = doc.getForm().getFields().length;
		} catch {
			/* broken AcroForm: treat as no form */
		}
		return { encrypted: doc.isEncrypted, signed, formFields, pages: doc.getPageCount() };
	} catch (e) {
		return { encrypted: false, signed: false, formFields: 0, pages: 0, error: String(e) };
	}
}

function hexToRgb(hex: string) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	const n = m ? parseInt(m[1]!, 16) : 0;
	return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
