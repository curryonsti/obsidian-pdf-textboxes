import { App, TFile } from 'obsidian';
import workerCode from 'worker:./bake.worker.ts';
import { Store } from './store';
import { BakeResponse, InspectResponse, PdfInspection, TextBox } from './types';

interface OwnWrite {
	size: number;
	mtime: number;
}

/**
 * Decides *when* to rebuild the visible PDF and does it in a Web Worker:
 *  - `schedule()` after every change: bakes once you pause for `idleMs`
 *  - `bakeNow()` when you switch away from / close the PDF, or on quit
 * Bakes for one file never overlap; changes during a bake trigger one rerun.
 */
export class Baker {
	private worker: Worker | null = null;
	private workerUrl: string | null = null;
	private nextId = 1;
	private pending = new Map<number, (r: BakeResponse | InspectResponse) => void>();
	private workerReady: Promise<Worker> | null = null;
	private timers = new Map<string, number>();
	private running = new Map<string, Promise<void>>();
	private rerun = new Set<string>();
	private ownWrites = new Map<string, OwnWrite>();
	onStatus: (path: string, state: 'baking' | 'done' | 'error', info?: { ms: number } | string) => void = () => {};

	constructor(
		private app: App,
		private store: Store,
		private loadFonts: () => Promise<{ primary: ArrayBuffer | null; fallback: ArrayBuffer; baselineEm?: number }>,
		public idleMs: number,
	) {}

	/** Fonts changed: start a fresh worker on the next bake. Running bakes finish first. */
	async resetWorker() {
		await Promise.all([...this.running.values()].map((p) => p.catch(() => undefined)));
		this.worker?.terminate();
		this.worker = null;
		this.workerReady = null;
	}

	destroy() {
		this.timers.forEach((t) => window.clearTimeout(t));
		this.timers.clear();
		this.worker?.terminate();
		this.worker = null;
		this.workerReady = null;
		if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
		this.pending.forEach((resolve, id) => resolve({ id, ok: false, error: 'worker terminated' }));
		this.pending.clear();
	}

	/** True if the current state of `file` on disk is exactly what we last wrote. */
	isOwnWrite(file: TFile): boolean {
		const w = this.ownWrites.get(file.path);
		if (!w || w.size !== file.stat.size) return false;
		// mtime is unknown while our write is still in progress.
		return w.mtime < 0 || Math.abs(w.mtime - file.stat.mtime) <= 2;
	}

	schedule(path: string, delay = this.idleMs) {
		const old = this.timers.get(path);
		if (old) window.clearTimeout(old);
		this.timers.set(
			path,
			window.setTimeout(() => {
				this.timers.delete(path);
				void this.bakeNow(path);
			}, delay),
		);
	}

	/** Bake now if the visible PDF is behind the JSON. Resolves when written. */
	bakeNow(path: string): Promise<void> {
		const t = this.timers.get(path);
		if (t) {
			window.clearTimeout(t);
			this.timers.delete(path);
		}
		const running = this.running.get(path);
		if (running) {
			this.rerun.add(path);
			return running;
		}
		const p = this.run(path).finally(() => {
			this.running.delete(path);
			if (this.rerun.delete(path)) void this.bakeNow(path);
		});
		this.running.set(path, p);
		return p;
	}

	/** Bake everything that is behind (used on quit / unload). */
	async flushAll(paths: string[]) {
		const all = new Set([...paths, ...this.timers.keys()]);
		await Promise.all([...all].map((p) => this.bakeNow(p).catch(() => undefined)));
		await Promise.all([...this.running.values()].map((p) => p.catch(() => undefined)));
	}

	onRename(oldPath: string, newPath: string) {
		for (const map of [this.timers, this.ownWrites] as Map<string, unknown>[]) {
			for (const [k, v] of [...map]) {
				if (k === oldPath || k.startsWith(oldPath + '/')) {
					map.delete(k);
					map.set(newPath + k.slice(oldPath.length), v);
				}
			}
		}
	}

	cancel(path: string) {
		const t = this.timers.get(path);
		if (t) window.clearTimeout(t);
		this.timers.delete(path);
		this.ownWrites.delete(path);
	}

	private async run(path: string) {
		const doc = await this.store.load(path);
		if (!doc || doc.bakedRevision === doc.revision) return;
		const rev = doc.revision;
		const boxes: TextBox[] = doc.boxes.map((b) => ({ ...b }));
		this.onStatus(doc.pdfPath, 'baking');
		const t0 = performance.now();
		try {
			const original = await this.store.readOriginal(doc.pdfPath);
			const res = await this.request(original, boxes);
			if (!res.ok) throw new Error(res.error);

			// The file may have been renamed or deleted while the worker ran.
			const target = this.app.vault.getAbstractFileByPath(doc.pdfPath);
			if (!(target instanceof TFile)) {
				// Mid-rename (the data folder is still moving): try again shortly.
				// Deleted files drop out of the store's cache and are not retried.
				if (this.store.cachedDoc(doc.pdfPath) === doc) this.schedule(doc.pdfPath, 500);
				this.onStatus(doc.pdfPath, 'done', { ms: res.ms });
				return;
			}
			const bytes = new Uint8Array(res.bytes);
			// Register before writing: Obsidian fires `modify` during the write.
			this.ownWrites.set(doc.pdfPath, { size: bytes.byteLength, mtime: -1 });
			let stat: { size: number; mtime: number };
			try {
				stat = await this.store.writeVaultPdf(target, bytes);
			} catch (e) {
				this.ownWrites.delete(doc.pdfPath);
				throw e;
			}
			this.ownWrites.set(doc.pdfPath, { size: stat.size, mtime: Math.round(stat.mtime) });

			doc.bakedRevision = rev;
			doc.lastBake = {
				sha256: res.sha256,
				size: stat.size,
				mtime: Math.round(stat.mtime),
				at: Date.now(),
				ms: Math.round(res.ms),
			};
			await this.store.save(doc);
			const totalMs = performance.now() - t0;
			console.debug(
				`[pdf-textboxes] baked ${doc.pdfPath}: ${boxes.length} boxes, worker ${res.ms.toFixed(0)} ms, total ${totalMs.toFixed(0)} ms`,
			);
			this.onStatus(doc.pdfPath, 'done', { ms: res.ms });
			if (doc.revision !== rev) this.schedule(doc.pdfPath);
		} catch (e) {
			console.error('[pdf-textboxes] bake failed for', doc.pdfPath, e);
			this.onStatus(doc.pdfPath, 'error', String(e));
		}
	}

	private ensureWorker(): Promise<Worker> {
		// Memoised so concurrent bakes never start two workers.
		return (this.workerReady ??= this.startWorker().catch((e) => {
			this.workerReady = null;
			throw e;
		}));
	}

	private async startWorker(): Promise<Worker> {
		if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
		this.workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
		const w = new Worker(this.workerUrl);
		w.onmessage = (e: MessageEvent<BakeResponse | InspectResponse>) => {
			const resolve = this.pending.get(e.data.id);
			this.pending.delete(e.data.id);
			resolve?.(e.data);
		};
		w.onerror = (e) => console.error('[pdf-textboxes] worker error', e);
		const { primary, fallback, baselineEm } = await this.loadFonts();
		w.postMessage({ type: 'fonts', primary, fallback, baselineEm });
		this.worker = w;
		return w;
	}

	private async request(original: ArrayBuffer, boxes: TextBox[]): Promise<BakeResponse> {
		const w = await this.ensureWorker();
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve as (r: BakeResponse | InspectResponse) => void);
			w.postMessage({ type: 'bake', id, original, boxes }, [original]);
		});
	}

	/** Parse a PDF in the worker and report encryption, signatures and forms. */
	async inspect(bytes: ArrayBuffer): Promise<PdfInspection> {
		const w = await this.ensureWorker();
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, (r) => resolve((r as InspectResponse).inspection));
			w.postMessage({ type: 'inspect', id, bytes }, [bytes]);
		});
	}
}
