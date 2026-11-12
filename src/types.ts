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
	/**
	 * Character styles as consecutive runs over `text` (lengths add up to
	 * text.length): colour (default: `color`) and superscript/subscript.
	 * Missing = all characters in the box colour, normal position.
	 */
	runs?: StyleRun[];
	/** Box width in points set by dragging its edges; the text wraps to fit. Missing = as wide as the text. */
	w?: number;
	/** Minimum box height in points set by dragging; the box still grows if the text needs more. */
	h?: number;
	/**
	 * The layout the overlay showed, so the PDF matches it exactly: `at` =
	 * offsets of characters that start a new line because the text wrapped
	 * (at the box width or the page edge), `width` = the box's text width in
	 * points. Present when the text wraps or the box has a set width.
	 */
	wrap?: { at: number[]; width: number };
}

export type ScriptKind = '^' | '_';
export interface CharStyle {
	/** CSS hex colour; missing = the box colour. */
	color?: string;
	/** '^' superscript, '_' subscript. */
	s?: ScriptKind;
}
export interface StyleRun extends CharStyle {
	len: number;
}

/**
 * Superscript/subscript geometry, in em of the box's font size. The overlay
 * (styles.css: `.ptb-text sup/sub`) and the baker must use the same values.
 */
export const SCRIPT_SCALE = 0.65;
export const SUP_RISE_EM = 0.33;
export const SUB_DROP_EM = 0.14;

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
