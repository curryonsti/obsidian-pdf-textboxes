// Per-character styles of a text box (pure functions, also used by the baker).
import { CharStyle, StyleRun } from './types';

function clean(c: CharStyle | undefined): CharStyle {
	const o: CharStyle = {};
	if (c?.color) o.color = c.color;
	if (c?.s === '^' || c?.s === '_') o.s = c.s;
	return o;
}

export function sameStyle(a: CharStyle, b: CharStyle) {
	return (a.color ?? '') === (b.color ?? '') && (a.s ?? '') === (b.s ?? '');
}

/** One style per character; newlines are always unstyled. */
export function expandStyles(text: string, runs: StyleRun[] | undefined): CharStyle[] {
	const out: CharStyle[] = [];
	for (const r of runs ?? []) {
		for (let i = 0; i < r.len && out.length < text.length; i++) out.push(clean(r));
	}
	while (out.length < text.length) out.push({});
	return out.map((c, i) => (text[i] === '\n' ? {} : c));
}

/** Back to runs; undefined when nothing is styled. */
export function compactStyles(text: string, chars: CharStyle[]): StyleRun[] | undefined {
	const runs: StyleRun[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i] === '\n' ? {} : clean(chars[i]);
		const last = runs[runs.length - 1];
		if (last && sameStyle(last, c)) last.len++;
		else runs.push({ len: 1, ...c });
	}
	return runs.some((r) => r.color || r.s) ? runs : undefined;
}

export interface Segment extends CharStyle {
	text: string;
}

function group(text: string, chars: CharStyle[], from: number, to: number): Segment[] {
	const segs: Segment[] = [];
	for (let i = from; i < to; i++) {
		const c = chars[i]!;
		const last = segs[segs.length - 1];
		if (last && sameStyle(last, c)) last.text += text[i];
		else segs.push({ text: text[i]!, ...c });
	}
	return segs;
}

/** Runs of equally styled characters (newlines included). */
export function segments(text: string, runs: StyleRun[] | undefined): Segment[] {
	return group(text, expandStyles(text, runs), 0, text.length);
}

/**
 * The lines as displayed: split at newlines and at the soft breaks where the
 * text wraps (`wrapAt`: offsets of characters that start a new line).
 */
export function visualLines(text: string, runs: StyleRun[] | undefined, wrapAt?: number[]): Segment[][] {
	const chars = expandStyles(text, runs);
	const soft = new Set(wrapAt ?? []);
	const lines: Segment[][] = [];
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text[i] === '\n') {
			lines.push(...splitSoft(start, i));
			start = i + 1;
		}
	}
	return lines;

	function splitSoft(from: number, to: number): Segment[][] {
		const out: Segment[][] = [];
		let s = from;
		for (let i = from + 1; i < to; i++) {
			if (soft.has(i)) {
				out.push(group(text, chars, s, i));
				s = i;
			}
		}
		out.push(group(text, chars, s, to));
		return out;
	}
}
