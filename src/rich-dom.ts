// DOM side of styled text in an editable text box: rendering, reading back,
// caret offsets, starting a new style at the caret, and measuring soft wraps.
import { compactStyles, segments } from './rich';
import { CharStyle, ScriptKind, StyleRun } from './types';

/** Zero-width space: placeholder that gives the caret a place inside a new, still empty run. */
const ZWSP = '\u200b';
const ZWSP_RE = /\u200b/g;

/** Fills `el` with the text: unstyled parts as text, styled parts as <span>/<sup>/<sub>. */
export function renderRich(el: HTMLElement, text: string, runs: StyleRun[] | undefined) {
	el.empty();
	for (const seg of segments(text, runs)) {
		if (!seg.color && !seg.s) el.appendText(seg.text);
		else el.appendChild(runElement(el.doc, seg, seg.text));
	}
}

function runElement(doc: Document, style: CharStyle, text: string): HTMLElement {
	const e = doc.createElement(style.s === '^' ? 'sup' : style.s === '_' ? 'sub' : 'span');
	e.className = 'ptb-run';
	if (style.color) {
		e.dataset.color = style.color;
		e.style.color = style.color;
	}
	e.textContent = text;
	return e;
}

/** Style of the text at a DOM node (nearest sup/sub and nearest colour). */
export function styleAt(node: Node | null, root: Node): CharStyle {
	const out: CharStyle = {};
	for (let n = node; n && n !== root; n = n.parentNode) {
		if (!out.s && (n.nodeName === 'SUP' || n.nodeName === 'SUB')) out.s = n.nodeName === 'SUP' ? '^' : '_';
		if (!out.color && n.instanceOf(HTMLElement) && n.dataset.color) out.color = n.dataset.color;
	}
	return out;
}

function walk(root: Node, styleRoot: Node) {
	let text = '';
	const chars: CharStyle[] = [];
	const add = (t: string, st: CharStyle) => {
		text += t;
		for (let i = 0; i < t.length; i++) chars.push(st);
	};
	const visit = (node: Node) => {
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				add((child.nodeValue ?? '').replace(/[\u200b\r]/g, ''), styleAt(child, styleRoot));
			} else if (child.nodeName === 'BR') {
				add('\n', {});
			} else {
				// Block elements (from pasting or Enter) start a new line.
				if ((child.nodeName === 'DIV' || child.nodeName === 'P') && text && !text.endsWith('\n')) add('\n', {});
				visit(child);
			}
		}
	};
	visit(root);
	return { text, chars };
}

/** Text and styles as currently shown in the editable element. */
export function readRich(root: HTMLElement): { text: string; runs: StyleRun[] | undefined } {
	const { text, chars } = walk(root, root);
	const t = text.endsWith('\n') ? text.slice(0, -1) : text;
	return { text: t, runs: compactStyles(t, chars) };
}

/** Number of characters before a DOM position (ignores placeholders). */
export function offsetOf(root: HTMLElement, node: Node, offset: number): number {
	const r = root.doc.createRange();
	r.selectNodeContents(root);
	r.setEnd(node, offset);
	const tmp = root.doc.createElement('div');
	tmp.append(r.cloneContents());
	return walk(tmp, tmp).text.length;
}

/** DOM position of a character offset, for an element just filled by renderRich. */
export function positionAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
	const it = root.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let left = offset;
	let last: Text | null = null;
	for (let n = it.nextNode() as Text | null; n; n = it.nextNode() as Text | null) {
		const len = n.data.length;
		if (left <= len) return { node: n, offset: left };
		left -= len;
		last = n;
	}
	return last ? { node: last, offset: last.data.length } : { node: root, offset: root.childNodes.length };
}

/** Changes to the style at the caret; null removes that property. */
export interface StylePatch {
	color?: string | null;
	s?: ScriptKind | null;
}

/**
 * Collapsed caret: what is typed next gets the current style changed by
 * `patch`. Splits the run at the caret and puts the caret into a new run
 * that holds a zero-width placeholder (removed when the text is read back).
 */
export function startRunAtCaret(root: HTMLElement, range: Range, patch: StylePatch) {
	const doc = root.doc;
	const style = { ...styleAt(range.startContainer, root) };
	if (patch.color !== undefined) style.color = patch.color ?? undefined;
	if (patch.s !== undefined) style.s = patch.s ?? undefined;

	// Top-level node containing the caret (a run element or a text node).
	let top: Node | null = range.startContainer;
	while (top && top.parentNode !== root) top = top.parentNode;

	let ref: Node | null;
	if (!top || top === root) {
		ref = root.childNodes[range.startOffset] ?? null;
	} else if (top.nodeType === Node.TEXT_NODE) {
		ref = (top as Text).splitText(range.startContainer === top ? range.startOffset : 0);
	} else {
		// <span>ab|cd</span> -> <span>ab</span>|<span>cd</span>
		const tail = doc.createRange();
		tail.setStart(range.startContainer, range.startOffset);
		tail.setEnd(top, top.childNodes.length);
		const rest = top.cloneNode(false) as HTMLElement;
		rest.appendChild(tail.extractContents());
		(top as HTMLElement).after(rest);
		ref = rest;
		if (!(rest.textContent ?? '').replace(ZWSP_RE, '')) {
			ref = rest.nextSibling;
			rest.remove();
		}
		if (!(top.textContent ?? '').replace(ZWSP_RE, '')) (top as HTMLElement).remove();
	}
	const placeholder = doc.createTextNode(ZWSP);
	if (!style.color && !style.s) {
		root.insertBefore(placeholder, ref);
	} else {
		const e = runElement(doc, style, '');
		e.appendChild(placeholder);
		root.insertBefore(e, ref);
	}
	const caret = doc.createRange();
	caret.setStart(placeholder, 1);
	caret.collapse(true);
	const sel = root.win.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(caret);
}

/**
 * Offsets of the characters that start a new visual line because the text
 * wrapped (not because of a newline), as laid out by the browser.
 */
export function measureWrap(root: HTMLElement, hardLines: number): number[] {
	const lineHeight = parseFloat(root.win.getComputedStyle(root).lineHeight);
	if (!(lineHeight > 0)) return [];
	// Fast path: no wrapping if the height is just the hard lines.
	if (root.getBoundingClientRect().height < (hardLines + 0.5) * lineHeight) return [];
	const breaks: number[] = [];
	const range = root.doc.createRange();
	const it = root.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let offset = 0;
	let lastMid: number | null = null;
	for (let n = it.nextNode() as Text | null; n; n = it.nextNode() as Text | null) {
		for (let i = 0; i < n.data.length; i++) {
			const ch = n.data[i];
			if (ch === ZWSP || ch === '\r') continue;
			if (ch === '\n') {
				lastMid = null;
				offset++;
				continue;
			}
			range.setStart(n, i);
			range.setEnd(n, i + 1);
			const r = range.getClientRects()[0];
			if (r) {
				const mid = (r.top + r.bottom) / 2;
				if (lastMid !== null && mid > lastMid + 0.7 * lineHeight) breaks.push(offset);
				if (lastMid === null || mid > lastMid + 0.7 * lineHeight) lastMid = mid;
			}
			offset++;
		}
	}
	return breaks;
}
