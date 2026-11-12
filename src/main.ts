import {
	App,
	FileView,
	Notice,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
	TAbstractFile,
	TFile,
	TFolder,
} from 'obsidian';
import { DEFAULT_ROOT, Store } from './store';
import { Baker } from './baker';
import { isObsidianSyncEnabled, ViewerHandle, ViewerHooks } from './viewer-hooks';
import { COLOR_NAMES, COLORS, OverlayHost, PdfOverlay } from './overlay';
import { AnnotationDoc, BoxHistory } from './types';
import { attachFonts, defaultMainFont, measureBaselineEm, detachFonts, fontFromLegacyFile, listInstalledFonts, LoadedFonts, loadFonts, unloadFonts } from './fonts';
import { sha256Hex } from './hash';
import { confirmDialog } from './ui';

interface Settings {
	idleSeconds: number;
	fontSize: number;
	color: string;
	showBakeNotices: boolean;
	/** Last zoom per PDF path, as a pdf.js open-param ("page-width", "130"). */
	zoomByPath: Record<string, string>;
	/** PostScript name of the installed font for the text. Empty = bundled DejaVu Sans only. */
	mainFont: string;
	/** Vault folder for originals + JSON. Hidden by default; Obsidian Sync users need a visible one. */
	dataFolder: string;
	/** The Obsidian Sync warning was shown once. */
	syncWarned: boolean;
}

const DEFAULTS: Settings = {
	idleSeconds: 3,
	fontSize: 12,
	color: '#000000',
	showBakeNotices: false,
	zoomByPath: {},
	mainFont: defaultMainFont(),
	dataFolder: DEFAULT_ROOT,
	syncWarned: false,
};

export default class PdfTextBoxesPlugin extends Plugin implements OverlayHost {
	settings!: Settings;
	store!: Store;
	baker!: Baker;
	hooks!: ViewerHooks;
	private overlays = new Map<FileView, PdfOverlay>();
	/** PDFs that have an original.pdf (shown instead of the baked file). */
	private managed = new Set<string>();
	private lastActivePdf: string | null = null;
	private statusEl!: HTMLElement;
	/** Font files in use (shared by the overlay via FontFace and the baker). */
	fonts!: Promise<LoadedFonts>;

	/** Size/colour for new boxes: starts at the defaults, follows your last pick this session. */
	style: { fontSize: number; color: string; bg: string | null } = { fontSize: DEFAULTS.fontSize, color: DEFAULTS.color, bg: null };
	ui = { symbolsOpen: false };
	private histories = new Map<string, BoxHistory>();
	history(file: TFile): BoxHistory {
		let h = this.histories.get(file.path);
		if (!h) this.histories.set(file.path, (h = { undo: [], redo: [] }));
		return h;
	}

	async onload() {
		const saved = (await this.loadData()) as (Partial<Settings> & { mainFontFile?: string }) | null;
		this.settings = Object.assign({}, DEFAULTS, saved);
		// 1.0.x stored a font file path.
		if (saved && saved.mainFont === undefined && typeof saved.mainFontFile === 'string') {
			this.settings.mainFont = fontFromLegacyFile(saved.mainFontFile);
		}
		delete (this.settings as { mainFontFile?: string }).mainFontFile;
		this.style = { fontSize: this.settings.fontSize, color: this.settings.color, bg: null };
		this.store = new Store(this.app, this.settings.dataFolder);
		this.fonts = loadFonts(this.settings.mainFont, this.windowDocs());
		// The baseline is measured when the worker starts (first bake), when styles.css is surely loaded.
		const bakeFonts = async () => {
			const f = await this.fonts;
			return { ...f, baselineEm: measureBaselineEm(this.app.workspace.containerEl.doc) };
		};
		this.baker = new Baker(this.app, this.store, bakeFonts, this.settings.idleSeconds * 1000);
		this.statusEl = this.addStatusBarItem();
		this.baker.onStatus = (path, state, info) => this.onBakeStatus(path, state, info);

		this.hooks = new ViewerHooks(this.app, {
			prepare: (file) => this.prepare(file),
			resolveUrl: (file) => (this.managed.has(file.path) ? this.store.originalResourceUrl(file.path) : null),
			initialZoom: (file) => this.settings.zoomByPath[file.path] ?? null,
			isOwnWrite: (file) => this.baker.isOwnWrite(file),
			onReady: (handle) => this.onViewerReady(handle),
			onUnload: (view, file) => this.onViewerUnload(view, file),
		});
		this.app.workspace.onLayoutReady(() => {
			this.warnAboutSyncOnce();
			if (!this.hooks.install()) {
				new Notice('Text boxes are unavailable: this Obsidian version changed the PDF viewer. See the developer console for details.', 10000);
			}
		});

		// Popout windows have their own document, so they need their own font faces.
		this.registerEvent(this.app.workspace.on('window-open', (w) => void this.fonts.then(() => attachFonts(w.doc))));
		this.registerEvent(this.app.workspace.on('window-close', (w) => detachFonts(w.doc)));
		this.registerEvent(this.app.vault.on('rename', (f, old) => void this.onRename(f, old)));
		this.registerEvent(this.app.vault.on('delete', (f) => void this.onDelete(f)));
		this.registerEvent(this.app.vault.on('modify', (f) => void this.onModify(f)));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onActiveLeafChange()));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.cleanupClosedViews()));
		this.registerEvent(
			this.app.workspace.on('quit', (tasks) => {
				tasks.add(() => this.baker.flushAll([...this.managed]));
				tasks.add(() => this.flushZoomSave());
			}),
		);

		this.addCommand({
			id: 'toggle-add-mode',
			name: 'Toggle text box placement mode',
			checkCallback: (checking) => {
				const o = this.activeOverlay();
				if (!o) return false;
				if (!checking) o.toggleAddMode();
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-symbols',
			name: 'Toggle symbol panel',
			checkCallback: (checking) => {
				const o = this.activeOverlay();
				if (!o) return false;
				if (!checking) o.toggleSymbols();
				return true;
			},
		});
		for (const [kind, id, name] of [
			['^', 'superscript', 'Superscript'],
			['_', 'subscript', 'Subscript'],
		] as const) {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const o = this.activeOverlay();
					if (!o) return false;
					if (!checking) o.toggleScript(kind);
					return true;
				},
			});
		}
		this.addCommand({
			id: 'bake-now',
			name: 'Write text boxes into this PDF now',
			checkCallback: (checking) => {
				const f = this.activePdf();
				if (!f || !this.managed.has(f.path)) return false;
				if (!checking) {
					void this.baker.bakeNow(f.path).then(() => new Notice('PDF updated'));
				}
				return true;
			},
		});
		this.addCommand({
			id: 'adopt-original',
			name: 'Use the current PDF file as the new original',
			checkCallback: (checking) => {
				const f = this.activePdf();
				if (!f || !this.managed.has(f.path)) return false;
				if (!checking) void this.adoptOriginal(f);
				return true;
			},
		});
		this.addCommand({
			id: 'restore-original',
			name: 'Remove all text boxes and restore the original PDF',
			checkCallback: (checking) => {
				const f = this.activePdf();
				if (!f || !this.managed.has(f.path)) return false;
				if (!checking) void this.restoreOriginal(f);
				return true;
			},
		});
		this.addSettingTab(new SettingsTab(this.app, this));
	}

	onunload() {
		void this.flushZoomSave();
		void this.baker.flushAll([...this.managed]).finally(() => this.baker.destroy());
		this.overlays.forEach((o) => o.dispose());
		this.overlays.clear();
		this.hooks?.uninstall();
		unloadFonts();
	}

	/** Obsidian Sync skips hidden folders, so with the default data folder the notes would not sync. */
	private warnAboutSyncOnce() {
		if (this.settings.syncWarned || !isObsidianSyncEnabled(this.app) || !this.store.root.startsWith('.')) return;
		this.settings.syncWarned = true;
		void this.saveData(this.settings);
		new Notice(
			'Your vault uses Obsidian Sync, which skips hidden folders. Your editable PDF notes would only exist on this device (the PDF files with baked text still sync). To sync them, choose a visible data folder in the PDF text boxes settings.',
			20000,
		);
	}

	/** Data folder setting changed: move the folder. */
	async changeDataFolder(folder: string): Promise<string | null> {
		await this.baker.flushAll([...this.managed]);
		const err = await this.store.moveRoot(folder);
		if (err) return err;
		this.settings.dataFolder = this.store.root;
		await this.saveData(this.settings);
		for (const p of [...this.managed]) this.managed.delete(p);
		for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
			const view = leaf.view as FileView;
			if (view.file) this.hooks.reload(view);
		}
		return null;
	}

	/** The main window's document plus those of open popout windows. */
	private windowDocs(): Document[] {
		const docs = new Set<Document>([this.app.workspace.containerEl.doc]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.view.containerEl.doc);
		});
		return [...docs];
	}

	/** Main font setting changed: reload fonts and restart the baker's worker. */
	async reloadFonts() {
		this.fonts = loadFonts(this.settings.mainFont, this.windowDocs());
		await this.fonts;
		await this.baker.resetWorker();
	}

	async saveSettings() {
		this.style = { fontSize: this.settings.fontSize, color: this.settings.color, bg: null };
		this.baker.idleMs = this.settings.idleSeconds * 1000;
		await this.saveData(this.settings);
	}

	// ---------- OverlayHost ----------

	getDoc(file: TFile): AnnotationDoc | null {
		return this.store.cachedDoc(file.path) ?? null;
	}

	async ensureDoc(file: TFile): Promise<AnnotationDoc> {
		if (!this.managed.has(file.path)) await this.checkCanAnnotate(file);
		const doc = await this.store.init(file.path);
		this.managed.add(file.path);
		return doc;
	}

	/**
	 * First use of a PDF: refuse files that must not be rewritten (signed,
	 * encrypted, unreadable) and warn about fillable forms.
	 */
	private async checkCanAnnotate(file: TFile) {
		const doc = await this.store.load(file.path);
		if (doc && (await this.store.hasOriginal(file.path))) return;
		const info = await this.baker.inspect(await this.app.vault.readBinary(file));
		const no = (why: string) => {
			throw new UserFacingError(`Can't add text boxes to “${file.name}”: ${why} The file was not changed.`);
		};
		if (info.error) no('the PDF could not be read.');
		if (info.encrypted) no('it is password-protected or encrypted.');
		if (info.signed) no('it is digitally signed, and rewriting it would break the signature.');
		if (info.formFields > 0) {
			new Notice(
				`“${file.name}” has ${info.formFields} fillable form field(s). They are kept, but check the form after the first save. The untouched original is kept as a backup.`,
				10000,
			);
		}
	}

	changed(file: TFile, doc: AnnotationDoc) {
		doc.revision += 1;
		this.store.save(doc).catch((e) => {
			console.error(e);
			new Notice(`Could not save the notes for ${file.name}: ${String(e)}`);
		});
		this.baker.schedule(file.path);
		this.setStatus('Notes saved · PDF update pending');
		for (const o of this.overlays.values()) {
			if (o.file === file && o.handle.view !== this.activeOverlay()?.handle.view) o.refresh();
		}
	}

	zoomChanged(file: TFile, scaleValue: string | null) {
		if (!scaleValue) return;
		const n = Number(scaleValue);
		// pdf.js open-params take zoom in percent; presets stay as they are.
		const zoom = Number.isFinite(n) && n > 0 ? String(Math.round(n * 10000) / 100) : scaleValue === 'page-actual' ? '100' : scaleValue;
		if (this.settings.zoomByPath[file.path] === zoom) return;
		this.settings.zoomByPath[file.path] = zoom;
		window.clearTimeout(this.zoomSaveTimer);
		this.zoomSaveTimer = window.setTimeout(() => void this.flushZoomSave(), 1000);
	}
	private zoomSaveTimer = 0;
	private flushZoomSave(): Promise<void> {
		if (!this.zoomSaveTimer) return Promise.resolve();
		window.clearTimeout(this.zoomSaveTimer);
		this.zoomSaveTimer = 0;
		return this.saveData(this.settings);
	}

	// ---------- viewer lifecycle ----------

	private async prepare(file: TFile) {
		const doc = await this.store.load(file.path);
		if (doc && (await this.store.hasOriginal(file.path))) this.managed.add(file.path);
	}

	private onViewerReady(handle: ViewerHandle) {
		this.overlays.get(handle.view)?.dispose();
		const overlay = new PdfOverlay(handle, this);
		this.overlays.set(handle.view, overlay);
		overlay.attach();
		void this.checkExternalChange(handle.file);
		// PDF behind its notes (e.g. Obsidian quit or crashed mid-rebuild): catch up.
		const doc = this.store.cachedDoc(handle.file.path);
		if (doc && doc.revision !== doc.bakedRevision) this.baker.schedule(handle.file.path, 1000);
	}

	private onViewerUnload(view: FileView, file: TFile) {
		this.overlays.get(view)?.dispose();
		this.overlays.delete(view);
		if (this.managed.has(file.path)) void this.baker.bakeNow(file.path);
	}

	private cleanupClosedViews() {
		for (const [view, overlay] of [...this.overlays]) {
			if (!view.containerEl.isConnected || view.file !== overlay.file) {
				overlay.dispose();
				this.overlays.delete(view);
				if (this.managed.has(overlay.file.path)) void this.baker.bakeNow(overlay.file.path);
			}
		}
	}

	private onActiveLeafChange() {
		const now = this.activePdf()?.path ?? null;
		const prev = this.lastActivePdf;
		this.lastActivePdf = now;
		if (prev && prev !== now && this.managed.has(prev)) void this.baker.bakeNow(prev);
	}

	private activePdf(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(FileView);
		return view?.getViewType() === 'pdf' && view.file ? view.file : null;
	}

	private activeOverlay(): PdfOverlay | null {
		const view = this.app.workspace.getActiveViewOfType(FileView);
		return (view && this.overlays.get(view)) ?? null;
	}

	// ---------- vault events ----------

	private async onRename(f: TAbstractFile, oldPath: string) {
		if (this.store.isDataPath(oldPath) || this.store.isDataPath(f.path)) return;
		if (f instanceof TFile && f.extension !== 'pdf') return;
		if (!(f instanceof TFile) && !(f instanceof TFolder)) return;
		this.baker.onRename(oldPath, f.path);
		for (const [p, h] of [...this.histories]) {
			if (p === oldPath || p.startsWith(oldPath + '/')) {
				this.histories.delete(p);
				this.histories.set(f.path + p.slice(oldPath.length), h);
			}
		}
		const zooms = this.settings.zoomByPath;
		for (const p of Object.keys(zooms)) {
			if (p === oldPath || p.startsWith(oldPath + '/')) {
				zooms[f.path + p.slice(oldPath.length)] = zooms[p]!;
				delete zooms[p];
			}
		}
		void this.saveData(this.settings);
		for (const p of [...this.managed]) {
			if (p === oldPath || p.startsWith(oldPath + '/')) {
				this.managed.delete(p);
				this.managed.add(f.path + p.slice(oldPath.length));
			}
		}
		const newPath = f.path;
		try {
			await this.serial(() => this.store.onRename(oldPath, newPath));
		} catch (e) {
			console.error('[pdf-textboxes] rename failed', e);
			new Notice(`Could not move the PDF notes for ${oldPath}: ${String(e)}`);
		}
	}

	private async onDelete(f: TAbstractFile) {
		if (this.store.isDataPath(f.path)) return;
		if (f instanceof TFile && f.extension !== 'pdf') return;
		for (const p of [...this.histories.keys()]) {
			if (p === f.path || p.startsWith(f.path + '/')) this.histories.delete(p);
		}
		for (const p of [...this.managed]) {
			if (p === f.path || p.startsWith(f.path + '/')) {
				this.managed.delete(p);
				this.baker.cancel(p);
			}
		}
		const path = f.path;
		try {
			await this.serial(() => this.store.onDelete(path));
		} catch (e) {
			console.error('[pdf-textboxes] delete handling failed', e);
		}
	}

	/**
	 * Renaming a folder fires one event for the folder and one per file inside;
	 * run the storage moves one after another so they cannot race.
	 */
	private fsQueue: Promise<unknown> = Promise.resolve();
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.fsQueue.catch(() => undefined).then(fn);
		this.fsQueue = next;
		return next;
	}

	private onModify(f: TAbstractFile) {
		if (!(f instanceof TFile) || !this.managed.has(f.path) || this.baker.isOwnWrite(f)) return;
		void this.checkExternalChange(f);
	}

	/** Warn if the visible PDF was changed by something other than this plugin. */
	private async checkExternalChange(file: TFile) {
		const doc = await this.store.load(file.path);
		if (!doc || !this.managed.has(file.path)) return;
		const lb = doc.lastBake;
		if (lb && lb.size === file.stat.size && Math.abs(lb.mtime - file.stat.mtime) <= 2) return;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const sha = await sha256Hex(bytes);
		if (sha === lb?.sha256 || sha === doc.originalSha256) return;
		new Notice(
			`“${file.name}” was changed outside the text box plugin. ` +
				`You are still seeing the stored original with your notes. If the new file should ` +
				`replace it, run “Use the current PDF file as the new original”.`,
			15000,
		);
	}

	// ---------- commands ----------

	private async adoptOriginal(file: TFile) {
		const ok = await confirmDialog(
			this.app,
			'Use the current file as the new original?',
			`The stored original of “${file.name}” will be replaced with the file as it is now.\n\nIf the current file already contains baked notes, they become part of the new original. The old original is kept as a backup in ${this.store.trash}.`,
			'Replace original',
		);
		if (!ok) return;
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backup = `${this.store.trash}/${stamp}/${file.path}.original.pdf`;
		await this.app.vault.adapter.mkdir(backup.slice(0, backup.lastIndexOf('/')));
		await this.app.vault.adapter.copy(this.store.originalPath(file.path), backup);
		await this.store.adoptCurrentAsOriginal(file.path);
		this.reloadViews(file);
		new Notice('New original stored');
	}

	private async restoreOriginal(file: TFile) {
		const ok = await confirmDialog(
			this.app,
			'Remove all text boxes?',
			`All text boxes are removed from “${file.name}” and the original PDF is restored.\n\nThe notes are moved to ${this.store.trash}, not deleted.`,
			'Remove and restore',
		);
		if (!ok) return;
		this.baker.cancel(file.path);
		const original = new Uint8Array(await this.store.readOriginal(file.path));
		await this.store.writeVaultPdf(file, original);
		this.managed.delete(file.path);
		await this.store.onDelete(file.path);
		this.reloadViews(file);
		new Notice('Original restored');
	}

	private reloadViews(file: TFile) {
		for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
			const view = leaf.view as FileView;
			if (view.file === file) this.hooks.reload(view);
		}
	}

	// ---------- misc ----------

	private onBakeStatus(path: string, state: string, info?: unknown) {
		if (state === 'baking') this.setStatus('Updating PDF…');
		else if (state === 'done') {
			const r = info as { ms: number };
			this.setStatus(`PDF up to date`);
			if (this.settings.showBakeNotices) new Notice(`Baked ${path.split('/').pop()} in ${r.ms.toFixed(0)} ms`);
		} else {
			this.setStatus('PDF update failed – see console');
			new Notice(`Could not update ${path}: ${String(info)}`, 10000);
		}
	}

	private statusTimer = 0;
	private setStatus(text: string) {
		this.statusEl.setText(text);
		window.clearTimeout(this.statusTimer);
		if (text === 'PDF up to date') this.statusTimer = window.setTimeout(() => this.statusEl.setText(''), 4000);
	}
}

/** An error whose message is meant for the user (shown as a notice). */
export class UserFacingError extends Error {}

class SettingsTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PdfTextBoxesPlugin,
	) {
		super(app, plugin);
	}

	/** Persist like the default, then apply side effects (bake delay, defaults). */
	async setControlValue(key: string, value: unknown) {
		await super.setControlValue(key, value);
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const syncOn = isObsidianSyncEnabled(this.app);
		const colorOptions: Record<string, string> = {};
		COLOR_NAMES.forEach((name, i) => (colorOptions[COLORS[i]!] = name));
		return [
			{
				name: 'Update the PDF after a pause of (seconds)',
				desc: 'Your notes are saved instantly. The PDF file itself is rebuilt after this pause, and also when you switch to another file or close it.',
				control: { type: 'slider', key: 'idleSeconds', min: 1, max: 30, step: 1, defaultValue: DEFAULTS.idleSeconds },
			},
			{
				name: 'Default font size (pt)',
				control: { type: 'number', key: 'fontSize', min: 4, max: 96, step: 1, defaultValue: DEFAULTS.fontSize },
			},
			{
				name: 'Default color',
				control: { type: 'dropdown', key: 'color', options: colorOptions, defaultValue: DEFAULTS.color },
			},
			{
				name: 'Font',
				desc: 'A Helvetica-like font used on screen and in the PDF. Characters it lacks are drawn with the bundled fallback font.',
				aliases: ['font', 'helvetica', 'arial'],
				render: (setting) => {
					const status = setting.descEl.createDiv({ cls: 'ptb-setting-status', text: 'Loading…' });
					void this.plugin.fonts.then((f) => status.setText(`In use: ${f.description}.`));
					const apply = async (name: string) => {
						s.mainFont = name;
						await this.plugin.saveSettings();
						await this.plugin.reloadFonts();
						this.update();
					};
					setting.addDropdown((d) => {
						d.addOption('', 'DejaVu Sans (bundled)');
						if (s.mainFont) d.addOption(s.mainFont, s.mainFont);
						d.setValue(s.mainFont).onChange((v) => void apply(v));
						void listInstalledFonts()
							.then((fonts) => {
								d.selectEl.empty();
								d.addOption('', 'DejaVu Sans (bundled)');
								for (const f of fonts) d.addOption(f.name, f.label);
								if (s.mainFont && !fonts.some((f) => f.name === s.mainFont)) d.addOption(s.mainFont, `${s.mainFont} (not installed)`);
								d.setValue(s.mainFont);
							})
							.catch((e) => console.warn('[pdf-textboxes] could not list installed fonts', e));
					});
					setting.addExtraButton((b) =>
						b
							.setIcon('rotate-ccw')
							.setTooltip('Reset to the default for this system')
							.onClick(() => void apply(defaultMainFont())),
					);
				},
			},
			{
				name: 'Data folder',
				desc:
					'Where the untouched originals and the editable notes are kept, inside the vault. A name starting with “.” is hidden from the file explorer. ' +
					(syncOn
						? 'Obsidian Sync is on and skips hidden folders: use a visible folder and turn on “sync all other types” in the Sync settings, so the notes sync. The stored originals then show up as PDFs in the vault.'
						: 'If you use Obsidian Sync, choose a visible folder here, because Sync skips hidden folders.'),
				aliases: ['sync', 'storage', 'pdf-annotations'],
				render: (setting) => {
					let value = s.dataFolder;
					if (syncOn && s.dataFolder.startsWith('.')) setting.descEl.addClass('mod-warning');
					setting
						.addText((t) => t.setValue(s.dataFolder).onChange((v) => (value = v)))
						.addButton((b) =>
							b.setButtonText('Move').onClick(async () => {
								const err = await this.plugin.changeDataFolder(value);
								new Notice(err ?? `Data folder is now “${this.plugin.settings.dataFolder}”.`);
								this.update();
							}),
						);
				},
			},
			{
				name: 'Show a notice after each PDF update',
				desc: 'Shows how long rebuilding the PDF took.',
				control: { type: 'toggle', key: 'showBakeNotices', defaultValue: DEFAULTS.showBakeNotices },
			},
		];
	}
}
