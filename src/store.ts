import { App, DataAdapter, normalizePath, TFile } from 'obsidian';
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
 * Dot-folders are invisible to Obsidian's vault API, so the data folder goes
 * through `app.vault.adapter`. Data files are replaced via a complete
 * `<name>.ptb-new` copy, so a crash can always be recovered from (see
 * `replaceFile` / `recover`). The visible PDF is written with the Vault API.
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
		await Promise.all([...this.pendingWrites].map((p) => p.catch(() => undefined)));
		if (await this.adapter.exists(this.root)) {
			if (parentOf(target)) await this.adapter.mkdir(parentOf(target));
			await this.adapter.rename(this.root, target);
		}
		this.root = target;
		return null;
	}

	private pendingWrites = new Set<Promise<void>>();

	get adapter(): DataAdapter {
		return this.app.vault.adapter;
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
		await this.recover(p, true);
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
		const bytes = new Uint8Array(await this.readVaultFile(pdfPath));
		await this.adapter.mkdir(this.dataDir(pdfPath));
		await this.replaceFile(this.originalPath(pdfPath), bytes);
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
				await this.adapter.mkdir(this.dataDir(doc.pdfPath));
				await this.replaceFile(this.docPath(doc.pdfPath), json);
			});
		this.queuedWrites.set(doc, next);
		this.writeChains.set(doc, next);
		this.pendingWrites.add(next);
		void next.finally(() => this.pendingWrites.delete(next)).catch(() => undefined);
		return next;
	}

	async readOriginal(pdfPath: string): Promise<ArrayBuffer> {
		await this.recover(this.originalPath(pdfPath), false);
		return this.adapter.readBinary(this.originalPath(pdfPath));
	}

	originalResourceUrl(pdfPath: string): string {
		return this.adapter.getResourcePath(this.originalPath(pdfPath));
	}

	/** Replace original.pdf with the current visible file (after an outside edit). */
	async adoptCurrentAsOriginal(pdfPath: string) {
		const bytes = new Uint8Array(await this.readVaultFile(pdfPath));
		const doc = await this.load(pdfPath);
		await this.replaceFile(this.originalPath(pdfPath), bytes);
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
						await this.replaceFile(docFile, JSON.stringify(doc, null, 1));
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
		if (parentOf(to)) await this.adapter.mkdir(parentOf(to));
		if (!(await this.adapter.exists(to))) {
			await this.adapter.rename(from, to);
			return;
		}
		const st = await this.adapter.stat(from);
		if (st?.type !== 'folder') {
			// Never silently overwrite stored data: keep the old one aside.
			await this.adapter.rename(to, `${to}.replaced-${Date.now()}`);
			await this.adapter.rename(from, to);
			return;
		}
		const list = await this.adapter.list(from);
		for (const child of [...list.files, ...list.folders]) {
			await this.movePath(child, `${to}/${child.slice(from.length + 1)}`);
		}
		await this.adapter.rmdir(from, false).catch(() => undefined);
	}

	private async removeEmptyParents(path: string) {
		let dir = parentOf(path);
		while (dir.startsWith(this.root + '/') && dir !== this.trash) {
			try {
				const list = await this.adapter.list(dir);
				const files = list.files.filter((f) => !f.endsWith('/.DS_Store'));
				if (files.length || list.folders.length) break;
				await this.adapter.rmdir(dir, true);
			} catch {
				break;
			}
			dir = parentOf(dir);
		}
	}

	// ---------- low level ----------

	/** Reads a file in the vault (the visible PDF), through the Vault API when it is indexed. */
	async readVaultFile(path: string): Promise<ArrayBuffer> {
		const file = this.app.vault.getFileByPath(path);
		return file ? this.app.vault.readBinary(file) : this.adapter.readBinary(path);
	}

	/**
	 * Replaces a file in the data folder so that a crash at any moment leaves a
	 * complete copy behind: the new content is first written in full to
	 * `<path>.ptb-new`, then the old file is removed and the new one renamed
	 * into place. `recover()` finishes an interrupted replace on the next read.
	 */
	async replaceFile(path: string, data: Uint8Array | string) {
		const tmp = `${path}${NEW_SUFFIX}`;
		this.replacing.add(path);
		try {
			if (typeof data === 'string') await this.adapter.write(tmp, data);
			else await this.adapter.writeBinary(tmp, toArrayBuffer(data));
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
			await this.adapter.rename(tmp, path);
		} finally {
			this.replacing.delete(path);
		}
	}
	private replacing = new Set<string>();

	/**
	 * Finishes or discards an interrupted `replaceFile`:
	 *  - only `<path>.ptb-new` exists: it was complete (the old file is only
	 *    removed after it was written), so it becomes the file;
	 *  - both exist: the crash happened while writing the new copy, or just
	 *    before removing the old one. For JSON the newer valid one wins; a
	 *    binary file keeps the old (known complete) version.
	 */
	private async recover(path: string, isJson: boolean) {
		const tmp = `${path}${NEW_SUFFIX}`;
		if (this.replacing.has(path) || !(await this.adapter.exists(tmp))) return;
		if (!(await this.adapter.exists(path))) {
			await this.adapter.rename(tmp, path);
			return;
		}
		if (isJson) {
			const parse = async (p: string) => {
				try {
					return JSON.parse(await this.adapter.read(p)) as AnnotationDoc;
				} catch {
					return null;
				}
			};
			const [cur, next] = [await parse(path), await parse(tmp)];
			if (next && (!cur || next.revision >= cur.revision)) {
				await this.adapter.remove(path);
				await this.adapter.rename(tmp, path);
				return;
			}
		}
		await this.adapter.remove(tmp);
	}

	/**
	 * Writes the visible PDF through the Vault API. Not atomic, but safe: the
	 * doc's `bakedRevision` is only updated afterwards, so after a crash the
	 * PDF is rebuilt the next time it is opened.
	 */
	async writeVaultPdf(file: TFile, data: Uint8Array) {
		await this.app.vault.modifyBinary(file, toArrayBuffer(data));
		return { size: file.stat.size, mtime: file.stat.mtime };
	}
}

const NEW_SUFFIX = '.ptb-new';

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
		? (data.buffer as ArrayBuffer)
		: (data.slice().buffer);
}

function parentOf(path: string) {
	const i = path.lastIndexOf('/');
	return i > 0 ? path.slice(0, i) : '';
}

function normalizeRoot(root: string) {
	return normalizePath(root.trim()).replace(/^\/+|\/+$/g, '');
}
