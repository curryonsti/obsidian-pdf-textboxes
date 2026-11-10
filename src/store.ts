import { App, FileSystemAdapter, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as nodePath from 'path';
import { AnnotationDoc } from './types';
import { sha256Hex } from './hash';

export const DEFAULT_ROOT = '.pdf-annotations';
const DOC_FILE = 'annotations.json';
const ORIGINAL_FILE = 'original.pdf';

/**
 * Storage in `<data folder>/<pdf path>/` (default `.pdf-annotations`, hidden):
 *   annotations.json  – the text boxes (written on every change)
 *   original.pdf      – pristine copy of the PDF, never modified
 *
 * Dot-folders are invisible to Obsidian's vault API, so everything goes
 * through `app.vault.adapter`. Writes that must never be half-done
 * (JSON, baked PDF) use write-to-temp + rename on the real filesystem.
 */
export class Store {
	private cache = new Map<string, AnnotationDoc | null>();
	private writeChains = new WeakMap<AnnotationDoc, Promise<void>>();
	private queuedWrites = new WeakMap<AnnotationDoc, Promise<void>>();

	/** Vault-relative data folder (default hidden: `.pdf-annotations`). */
	root: string;

	constructor(private app: App, root: string) {
		this.root = normalizeRoot(root);
	}

	get trash() {
		return `${this.root}/.trash`;
	}

	/** True for paths inside the data folder (ignore their vault events). */
	isDataPath(path: string) {
		return path === this.root || path.startsWith(this.root + '/');
	}

	/**
	 * Move the data folder (settings change). Refuses to overwrite an existing
	 * folder. Returns an error message for the user, or null on success.
	 */
	async moveRoot(newRoot: string): Promise<string | null> {
		const target = normalizeRoot(newRoot);
		if (!target) return 'The folder name is empty.';
		if (target === this.root) return null;
		if (target.startsWith(this.root + '/') || this.root.startsWith(target + '/')) return 'The new folder cannot be inside the old one (or the other way round).';
		if (await this.adapter.exists(target)) return `“${target}” already exists. Choose a new folder name.`;
		await Promise.all([...this.writeChainsList()].map((p) => p.catch(() => undefined)));
		if (await this.adapter.exists(this.root)) {
			const from = this.adapter.getFullPath(this.root);
			const to = this.adapter.getFullPath(target);
			await fs.promises.mkdir(nodePath.dirname(to), { recursive: true });
			await fs.promises.rename(from, to);
		}
		this.root = target;
		return null;
	}

	private pendingWrites = new Set<Promise<void>>();
	private writeChainsList() {
		return this.pendingWrites;
	}

	get adapter(): FileSystemAdapter {
		return this.app.vault.adapter as FileSystemAdapter;
	}

	dataDir(pdfPath: string) {
		return normalizePath(`${this.root}/${pdfPath}`);
	}
	docPath(pdfPath: string) {
		return `${this.dataDir(pdfPath)}/${DOC_FILE}`;
	}
	originalPath(pdfPath: string) {
		return `${this.dataDir(pdfPath)}/${ORIGINAL_FILE}`;
	}

	/** Cheap sync check, valid after `load()` ran once for this path. */
	cachedDoc(pdfPath: string): AnnotationDoc | null | undefined {
		return this.cache.get(pdfPath);
	}

	async load(pdfPath: string): Promise<AnnotationDoc | null> {
		if (this.cache.has(pdfPath)) return this.cache.get(pdfPath)!;
		let doc: AnnotationDoc | null = null;
		const p = this.docPath(pdfPath);
		if (await this.adapter.exists(p)) {
			try {
				doc = JSON.parse(await this.adapter.read(p)) as AnnotationDoc;
				doc.pdfPath = pdfPath;
			} catch (e) {
				console.error('[pdf-textboxes] could not parse', p, e);
				throw new Error(`Corrupt annotations file: ${p}`);
			}
		}
		this.cache.set(pdfPath, doc);
		return doc;
	}

	async hasOriginal(pdfPath: string) {
		return this.adapter.exists(this.originalPath(pdfPath));
	}

	/**
	 * First use of a PDF: copy the visible file to `original.pdf` (the backup and
	 * the source for every bake) and create an empty doc.
	 */
	async init(pdfPath: string): Promise<AnnotationDoc> {
		const existing = await this.load(pdfPath);
		if (existing && (await this.hasOriginal(pdfPath))) return existing;
		const bytes = new Uint8Array(await this.adapter.readBinary(pdfPath));
		await this.mkdirp(this.dataDir(pdfPath));
		await this.atomicWrite(this.originalPath(pdfPath), bytes);
		const doc: AnnotationDoc = existing ?? {
			version: 1,
			pdfPath,
			originalSha256: '',
			boxes: [],
			revision: 0,
			bakedRevision: 0,
		};
		doc.originalSha256 = await sha256Hex(bytes);
		await this.save(doc);
		return doc;
	}

	/**
	 * Write the doc now. Writes for one doc are serialised; while one write is
	 * running, further saves coalesce into a single follow-up write of the
	 * latest state (so fast typing never piles up writes).
	 */
	save(doc: AnnotationDoc): Promise<void> {
		this.cache.set(doc.pdfPath, doc);
		const queued = this.queuedWrites.get(doc);
		if (queued) return queued;
		const prev = this.writeChains.get(doc) ?? Promise.resolve();
		const next = prev
			.catch(() => undefined)
			.then(async () => {
				this.queuedWrites.delete(doc);
				// Serialise at write time so the latest state is written, at the
				// path the doc has now (it may have been renamed while queued).
				const json = JSON.stringify(doc, null, 1);
				await this.mkdirp(this.dataDir(doc.pdfPath));
				await this.atomicWrite(this.docPath(doc.pdfPath), json);
			});
		this.queuedWrites.set(doc, next);
		this.writeChains.set(doc, next);
		this.pendingWrites.add(next);
		void next.finally(() => this.pendingWrites.delete(next)).catch(() => undefined);
		return next;
	}

	async readOriginal(pdfPath: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(this.originalPath(pdfPath));
	}

	originalResourceUrl(pdfPath: string): string {
		return this.adapter.getResourcePath(this.originalPath(pdfPath));
	}

	/** Replace original.pdf with the current visible file (after an outside edit). */
	async adoptCurrentAsOriginal(pdfPath: string) {
		const bytes = new Uint8Array(await this.adapter.readBinary(pdfPath));
		const doc = await this.load(pdfPath);
		await this.atomicWrite(this.originalPath(pdfPath), bytes);
		if (doc) {
			doc.originalSha256 = await sha256Hex(bytes);
			doc.lastBake = undefined;
			doc.revision += 1;
			await this.save(doc);
		}
	}

	// ---------- rename / delete ----------

	async onRename(oldPath: string, newPath: string) {
		const from = this.dataDir(oldPath);
		if (!(await this.adapter.exists(from))) return;
		await this.movePath(from, this.dataDir(newPath));
		// Fix up cached docs and the pdfPath stored inside each moved doc.
		for (const [key, doc] of [...this.cache]) {
			if (key === oldPath || key.startsWith(oldPath + '/')) {
				const moved = newPath + key.slice(oldPath.length);
				this.cache.delete(key);
				if (doc) {
					doc.pdfPath = moved;
					this.cache.set(moved, doc);
					await this.save(doc);
				}
			}
		}
		await this.fixDocPathsUnder(this.dataDir(newPath), newPath);
		await this.removeEmptyParents(from);
	}

	async onDelete(path: string) {
		const from = this.dataDir(path);
		if (!(await this.adapter.exists(from))) return;
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		await this.movePath(from, normalizePath(`${this.trash}/${stamp}/${path}`));
		for (const key of [...this.cache.keys()]) {
			if (key === path || key.startsWith(path + '/')) this.cache.delete(key);
		}
		await this.removeEmptyParents(from);
	}

	/** Rewrites `pdfPath` inside docs on disk that were not in the cache. */
	private async fixDocPathsUnder(dir: string, vaultPath: string) {
		const docFile = `${dir}/${DOC_FILE}`;
		if (await this.adapter.exists(docFile)) {
			if (!this.cache.get(vaultPath)) {
				try {
					const doc = JSON.parse(await this.adapter.read(docFile)) as AnnotationDoc;
					if (doc.pdfPath !== vaultPath) {
						doc.pdfPath = vaultPath;
						await this.atomicWrite(docFile, JSON.stringify(doc, null, 1));
					}
				} catch {
					/* leave it */
				}
			}
			return;
		}
		const list = await this.adapter.list(dir).catch(() => null);
		if (!list) return;
		for (const sub of list.folders) {
			await this.fixDocPathsUnder(sub, `${vaultPath}/${sub.slice(dir.length + 1)}`);
		}
	}

	/** Move a file or folder, merging into an existing target folder. */
	private async movePath(from: string, to: string) {
		const fromFull = this.adapter.getFullPath(from);
		const toFull = this.adapter.getFullPath(to);
		await fs.promises.mkdir(nodePath.dirname(toFull), { recursive: true });
		if (!fs.existsSync(toFull)) {
			await fs.promises.rename(fromFull, toFull);
			return;
		}
		const st = await fs.promises.stat(fromFull);
		if (!st.isDirectory()) {
			// Never silently overwrite stored data: keep the old one aside.
			await fs.promises.rename(toFull, `${toFull}.replaced-${Date.now()}`);
			await fs.promises.rename(fromFull, toFull);
			return;
		}
		for (const name of await fs.promises.readdir(fromFull)) {
			await this.movePath(`${from}/${name}`, `${to}/${name}`);
		}
		await fs.promises.rmdir(fromFull).catch(() => undefined);
	}

	private async removeEmptyParents(path: string) {
		let dir = nodePath.posix.dirname(path);
		while (dir.startsWith(this.root + '/') && dir !== this.trash) {
			const full = this.adapter.getFullPath(dir);
			try {
				const entries = (await fs.promises.readdir(full)).filter((n) => n !== '.DS_Store');
				if (entries.length) break;
				await fs.promises.rm(full, { recursive: true });
			} catch {
				break;
			}
			dir = nodePath.posix.dirname(dir);
		}
	}

	// ---------- low level ----------

	async mkdirp(dir: string) {
		await fs.promises.mkdir(this.adapter.getFullPath(dir), { recursive: true });
	}

	/**
	 * Write to a hidden temp file in the same folder, fsync, then rename over the
	 * target. rename() is atomic on APFS, so readers (and a crash) only ever see
	 * the old or the new file, never a half-written one.
	 * Returns the stat of the written file.
	 */
	async atomicWrite(vaultPath: string, data: Uint8Array | string): Promise<fs.Stats> {
		const full = this.adapter.getFullPath(vaultPath);
		const tmp = nodePath.join(
			nodePath.dirname(full),
			`.${nodePath.basename(full)}.ptb-tmp-${process.pid}-${Date.now()}`,
		);
		const fh = await fs.promises.open(tmp, 'w');
		try {
			await fh.writeFile(data);
			await fh.sync();
		} finally {
			await fh.close();
		}
		try {
			await fs.promises.rename(tmp, full);
		} catch (e) {
			await fs.promises.rm(tmp, { force: true });
			throw e;
		}
		return fs.promises.stat(full);
	}
}

function normalizeRoot(root: string) {
	return normalizePath(root.trim()).replace(/^\/+|\/+$/g, '');
}
