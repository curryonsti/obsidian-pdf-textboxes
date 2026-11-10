// Web Worker: runs pdf-lib off the main thread so baking never blocks typing.
import { BakeFonts, bakePdf, inspectPdf } from './bake';
import { sha256Hex } from './hash';
import type { BakeRequest, BakeResponse } from './types';

let fonts: BakeFonts | null = null;
const ctx = self as unknown as {
	onmessage: ((e: MessageEvent) => void) | null;
	postMessage(msg: BakeResponse, transfer?: Transferable[]): void;
};

type FontsMsg = { type: 'fonts'; primary: ArrayBuffer | null; fallback: ArrayBuffer; baselineEm?: number };

ctx.onmessage = (e: MessageEvent) => {
	void handle(e);
};

async function handle(e: MessageEvent) {
	const msg = e.data as FontsMsg | ({ type: 'bake' } & BakeRequest) | { type: 'inspect'; id: number; bytes: ArrayBuffer };
	if (msg.type === 'inspect') {
		const inspection = await inspectPdf(new Uint8Array(msg.bytes));
		(ctx as unknown as { postMessage(m: unknown): void }).postMessage({ id: msg.id, inspection });
		return;
	}
	if (msg.type === 'fonts') {
		fonts = {
			primary: msg.primary ? new Uint8Array(msg.primary) : null,
			fallback: new Uint8Array(msg.fallback),
			baselineEm: msg.baselineEm,
		};
		return;
	}
	const t0 = performance.now();
	try {
		if (!fonts) throw new Error('fonts not loaded');
		const out = await bakePdf(new Uint8Array(msg.original), msg.boxes, fonts);
		const buf = out.slice().buffer; // own copy, transferred to the main thread
		const sha256 = await sha256Hex(new Uint8Array(buf));
		ctx.postMessage({ id: msg.id, ok: true, bytes: buf, sha256, ms: performance.now() - t0 }, [buf]);
	} catch (err) {
		ctx.postMessage({ id: msg.id, ok: false, error: String((err as Error)?.stack ?? err) });
	}
}
