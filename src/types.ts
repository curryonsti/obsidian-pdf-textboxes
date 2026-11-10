/**
 * One text box. Coordinates are in PDF user space (points, origin at the
 * bottom-left of the page's unrotated MediaBox, y grows upwards), exactly as
 * returned by pdf.js `viewport.convertToPdfPoint`. That makes them independent
 * of zoom, scroll and the viewer's own rotation.
 *
 * (x, y) is the top-left corner of the box *as the page is displayed*
 * (i.e. after the page's /Rotate is applied). The text flows right and down
 * from there in display orientation.
 */
export interface TextBox {
	id: string;
	/** 1-based page number. */
	page: number;
	x: number;
	y: number;
	text: string;
	/** Font size in PDF points. */
	fontSize: number;
	/** CSS hex colour, e.g. "#d00000". */
	color: string;
	/** Optional background fill behind the text (CSS hex), drawn into the PDF too. */
	bg?: string | null;
}

/** Background padding around the text, in em (overlay box-shadow and baked rectangle). */
export const BG_PAD_EM = 0.15;
export const BACKGROUNDS: { color: string | null; label: string }[] = [
	{ color: null, label: 'none' },
	{ color: '#ffffff', label: 'white' },
	{ color: '#fff59d', label: 'yellow' },
];

/** Undo/redo stacks of box snapshots (JSON) for one PDF. */
export interface BoxHistory {
	undo: string[];
	redo: string[];
}

export interface BakeRecord {
	/** SHA-256 (hex) of the PDF bytes we last wrote to the visible file. */
	sha256: string;
	size: number;
	mtime: number;
	at: number;
	ms: number;
}

/** Contents of `.pdf-annotations/<pdf path>/annotations.json`. */
export interface AnnotationDoc {
	version: 1;
	/** Vault path of the PDF this belongs to (kept in sync on rename). */
	pdfPath: string;
	/** SHA-256 of `original.pdf`. */
	originalSha256: string;
	boxes: TextBox[];
	/** Monotonic counter, bumped on every change. */
	revision: number;
	/** Revision that the visible PDF currently reflects. */
	bakedRevision: number;
	lastBake?: BakeRecord;
}

export interface BakeRequest {
	id: number;
	original: ArrayBuffer;
	boxes: TextBox[];
}

/** What a PDF contains that matters before we rewrite it. */
export interface PdfInspection {
	encrypted: boolean;
	/** Has a digital signature (rewriting would invalidate it). */
	signed: boolean;
	/** Number of fillable form fields (kept, but worth a warning). */
	formFields: number;
	pages: number;
	/** Could not be parsed at all. */
	error?: string;
}

export type InspectResponse = { id: number; inspection: PdfInspection };

export type BakeResponse =
	| { id: number; ok: true; bytes: ArrayBuffer; sha256: string; ms: number }
	| { id: number; ok: false; error: string };

/** Layout constants shared by the overlay and the baker so both match. */
export const LINE_HEIGHT = 1.2;
/** Approximate top-of-line to baseline distance (em); only used to place a new box under the click. */
export const BASELINE_OFFSET_EM = 0.94;
