/**
 * EVERYTHING that touches Obsidian's / pdf.js' private PDF viewer objects lives
 * in this file. If an Obsidian update breaks the plugin, start here.
 *
 * Verified against Obsidian 1.15.0 (bundled pdf.js 5.3.34) by reading app.js:
 *
 *   app.viewRegistry.viewByType.pdf      factory `leaf => new PdfView(leaf)`
 *   PdfView
 *     .viewer                              wrapper; .loadFile(file, subpath), .then(cb(child))
 *     .onModify(file)                      registered on vault "modify" in onload();
 *                                          RELOADS THE WHOLE PDF (scroll resets)
 *     .onUnloadFile(file)
 *   child (passed to viewer.then)
 *     .pdfViewer                           Obsidian's PDFViewerApplication object
 *       .open({url})                       loads a document; url comes from
 *                                          vault.getResourcePath(file)
 *       .eventBus                          pdf.js EventBus (on/off)
 *       .pdfViewer                         pdf.js PDFViewer: getPageView(i), pagesCount
 *       .dom.viewerContainerEl             the scrolling element
 *     .toolbar.toolbarRightEl              right side of the PDF toolbar
 *       .getInitialViewOverrides(stored, hash, opts)
 *                                          instance method; decides the initial
 *                                          page/zoom. Obsidian always uses its
 *                                          defaultZoomValue "page-width" here.
 *   PDFPageView: .div (page element), .viewport (convertToPdfPoint /
 *   convertToViewportPoint, width, height, scale). pdf.js removes unknown
 *   children of .div when a page is reset (zoom / re-render), so overlays must
 *   re-attach on "pagerendered".
 */
import { App, FileView, TFile, WorkspaceLeaf } from 'obsidian';

export interface PdfViewport {
	width: number;
	height: number;
	scale: number;
	rotation: number;
	convertToPdfPoint(x: number, y: number): number[];
	convertToViewportPoint(x: number, y: number): number[];
}

export interface PdfPage {
	pageNumber: number;
	div: HTMLElement;
	viewport: PdfViewport;
}

export type ViewerEvent = 'pagerendered' | 'scalechanging' | 'pagesinit' | 'pagesloaded' | 'pagesdestroy';

/** Stable, typed facade over one loaded PDF viewer. */
export interface ViewerHandle {
	view: FileView;
	file: TFile;
	pagesCount(): number;
	/** pdf.js currentScaleValue: "page-width", "auto", ... or a scale like "1.25". */
	scaleValue(): string | null;
	getPage(pageNumber: number): PdfPage | null;
	/** Element that scrolls; its children contain the page divs. */
	scrollEl: HTMLElement;
	toolbarEl: HTMLElement | null;
	on(event: ViewerEvent, cb: (e: { pageNumber?: number }) => void): () => void;
}

export interface HookCallbacks {
	/** Awaited before the viewer loads a file; use it to warm caches. */
	prepare(file: TFile): Promise<void>;
	/** URL the viewer should load instead of the vault file, or null. Must be sync. */
	resolveUrl(file: TFile): string | null;
	/** Zoom to open `file` with, as a pdf.js open-param ("page-width", "130"), or null. */
	initialZoom(file: TFile): string | null;
	/** True if this modify event was caused by our own bake write. */
	isOwnWrite(file: TFile): boolean;
	/** Viewer finished opening `file` (pages may still be rendering). */
	onReady(handle: ViewerHandle): void;
	/** View is about to stop showing `file` (file switch or close). */
	onUnload(view: FileView, file: TFile): void;
}

// ---------- Typed shapes of the private objects we touch (see header) ----------

type FileArg = TFile;

interface PdfJsEventBus {
	on(name: string, fn: (e?: { pageNumber?: number }) => void): void;
	off(name: string, fn: (e?: { pageNumber?: number }) => void): void;
}

interface PdfJsPageView {
	div?: HTMLElement;
	viewport?: PdfViewport;
}

interface PdfJsViewer {
	pagesCount?: number;
	currentScaleValue?: string | number | null;
	container?: HTMLElement;
	getPageView?(index: number): PdfJsPageView | undefined;
}

interface InitialViewOverrides {
	hash?: string;
}

/** Obsidian's PDFViewerApplication object (child.pdfViewer). */
interface PdfApp {
	open(args: { url?: string }): Promise<unknown>;
	eventBus: PdfJsEventBus;
	pdfViewer?: PdfJsViewer;
	dom?: { viewerContainerEl?: HTMLElement };
	subpath?: string | null;
	getInitialViewOverrides?: (...args: unknown[]) => InitialViewOverrides;
	__ptbPatched?: boolean;
	__ptbFile?: FileArg;
}

interface PdfChild {
	pdfViewer?: PdfApp;
	toolbar?: { toolbarRightEl?: HTMLElement };
}

interface ViewerWrapper {
	loadFile(file: FileArg, subpath?: string): Promise<unknown>;
	then(cb: (child: PdfChild) => void): void;
}

type PdfViewInternal = FileView & {
	viewer?: ViewerWrapper;
	onModify?: (file: FileArg) => unknown;
	__ptbPatched?: boolean;
};

type ViewFactory = (leaf: WorkspaceLeaf) => FileView;

interface AppInternal {
	viewRegistry?: { viewByType?: Record<string, ViewFactory | undefined> };
	internalPlugins?: {
		getPluginById?(id: string): SyncPlugin | null | undefined;
		plugins?: Record<string, SyncPlugin | undefined>;
	};
}

interface SyncPlugin {
	enabled?: boolean;
	/** Set once the vault is connected to a remote Sync vault. */
	instance?: { vaultId?: string | null };
}

function internals(app: App): AppInternal {
	return app as unknown as AppInternal;
}

export class ViewerHooks {
	private origFactory: ViewFactory | null = null;
	ok = true;

	constructor(
		private app: App,
		private cb: HookCallbacks,
	) {}

	install(): boolean {
		const registry = internals(this.app).viewRegistry?.viewByType;
		const factory = registry?.pdf;
		if (!registry || typeof factory !== 'function') {
			console.error('[pdf-textboxes] viewRegistry.viewByType.pdf not found – viewer internals changed');
			this.ok = false;
			return false;
		}
		this.origFactory = factory;
		registry.pdf = (leaf: WorkspaceLeaf) => {
			const view = factory(leaf);
			try {
				this.patchView(view);
			} catch (e) {
				console.error('[pdf-textboxes] could not patch PDF view', e);
			}
			return view;
		};
		// Views that were open before the plugin loaded registered their
		// modify handler already; rebuild them so they get the patched one.
		for (const leaf of this.app.workspace.getLeavesOfType('pdf')) this.rebuild(leaf);
		return true;
	}

	uninstall() {
		const registry = internals(this.app).viewRegistry?.viewByType;
		if (this.origFactory && registry) registry.pdf = this.origFactory;
		for (const leaf of this.app.workspace.getLeavesOfType('pdf')) this.rebuild(leaf);
	}

	/** Re-create a PDF leaf's view (keeps the file open, resets scroll). */
	rebuild(leaf: WorkspaceLeaf) {
		const l = leaf as WorkspaceLeaf & { rebuildView?: () => unknown };
		if (typeof l.rebuildView === 'function') void Promise.resolve(l.rebuildView()).catch((e) => console.error(e));
	}

	/** Make a view load its file again (e.g. after the original was replaced). */
	reload(view: FileView) {
		const v = view as PdfViewInternal;
		if (view.file && v.viewer) void v.viewer.loadFile(view.file).catch((e) => console.error(e));
	}

	private patchView(v: PdfViewInternal) {
		if (v.__ptbPatched) return;
		v.__ptbPatched = true;
		const cb = this.cb;

		// 1) Ignore modify events caused by our own bake, so writing the baked
		//    PDF never reloads the view while you work.
		const origOnModify = v.onModify;
		if (typeof origOnModify === 'function') {
			v.onModify = function (this: PdfViewInternal, file: FileArg) {
				if (file === this.file && cb.isOwnWrite(file)) return;
				return origOnModify.call(this, file);
			};
		}

		// 2) Substitute the URL the viewer loads (we show original.pdf so the
		//    baked text is not displayed twice), and get notified when a
		//    document has been opened.
		const wrapper = v.viewer;
		if (wrapper && typeof wrapper.loadFile === 'function') {
			const origLoad = wrapper.loadFile.bind(wrapper);
			wrapper.loadFile = async (file: FileArg, subpath?: string) => {
				try {
					await cb.prepare(file);
				} catch (e) {
					console.error('[pdf-textboxes] prepare failed', e);
				}
				wrapper.then((child) => patchChild(child, file));
				const result = await origLoad(file, subpath);
				wrapper.then((child) => {
					const handle = makeHandle(v, child, file);
					if (handle) cb.onReady(handle);
				});
				return result;
			};
		}

		const origUnload = v.onUnloadFile.bind(v);
		v.onUnloadFile = (file: FileArg) => {
			try {
				cb.onUnload(v, file);
			} catch (e) {
				console.error(e);
			}
			return origUnload(file);
		};

		const patchChild = (child: PdfChild, file: FileArg) => {
			const app = child.pdfViewer;
			if (!app) return;
			app.__ptbFile = file;
			if (app.__ptbPatched) return;
			app.__ptbPatched = true;
			const origOpen = app.open.bind(app);
			app.open = (args: { url?: string }) => {
				const f = app.__ptbFile;
				const url = f ? cb.resolveUrl(f) : null;
				return origOpen(url && typeof args?.url === 'string' ? { ...args, url } : args);
			};

			// 3) Open at the zoom you left this file at, instead of Obsidian's
			//    fixed "page-width". Page/scroll restoring is left untouched.
			const origOverrides = app.getInitialViewOverrides;
			if (typeof origOverrides === 'function') {
				app.getInitialViewOverrides = function (this: PdfApp, ...rest: unknown[]) {
					const res = origOverrides.apply(this, rest);
					try {
						const f = this.__ptbFile;
						const zoom = f ? cb.initialZoom(f) : null;
						const linkHasZoom = typeof this.subpath === 'string' && this.subpath.includes('zoom=');
						if (zoom && !linkHasZoom && typeof res?.hash === 'string' && /(^|&)zoom=/.test(res.hash)) {
							res.hash = res.hash.replace(/(^|&)zoom=[^,&]*/, `$1zoom=${zoom}`);
						}
					} catch (e) {
						console.error('[pdf-textboxes] zoom restore failed', e);
					}
					return res;
				};
			}
		};
	}
}

function makeHandle(view: FileView, child: PdfChild, file: FileArg): ViewerHandle | null {
	const app = child.pdfViewer;
	const pdfViewer = app?.pdfViewer;
	const scrollEl = app?.dom?.viewerContainerEl ?? pdfViewer?.container;
	if (!app || !pdfViewer || !scrollEl) {
		console.error('[pdf-textboxes] PDF viewer internals not found');
		return null;
	}
	return {
		view,
		file,
		scrollEl,
		toolbarEl: child.toolbar?.toolbarRightEl ?? null,
		pagesCount: () => pdfViewer.pagesCount ?? 0,
		scaleValue: () => (pdfViewer.currentScaleValue != null ? String(pdfViewer.currentScaleValue) : null),
		getPage(pageNumber) {
			const pv = pdfViewer.getPageView?.(pageNumber - 1);
			if (!pv?.div || !pv.viewport) return null;
			return { pageNumber, div: pv.div, viewport: pv.viewport };
		},
		on(event, fn) {
			// Read the bus lazily: pdf.js may replace it during initialisation.
			const bus = app.eventBus;
			const listener = (e?: { pageNumber?: number }) => fn({ pageNumber: e?.pageNumber });
			bus.on(event, listener);
			return () => bus.off(event, listener);
		},
	};
}

/**
 * Is this vault actually synced with Obsidian Sync? The core plugin is on by
 * default in every vault, so also require a connected remote vault.
 * Undocumented: app.internalPlugins.
 */
export function isObsidianSyncEnabled(app: App): boolean {
	try {
		const ip = internals(app).internalPlugins;
		const sync = ip?.getPluginById?.('sync') ?? ip?.plugins?.sync;
		return !!sync?.enabled && !!sync.instance?.vaultId;
	} catch {
		return false;
	}
}
