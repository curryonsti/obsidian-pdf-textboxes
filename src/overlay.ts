import { Notice, setIcon, setTooltip, TFile } from 'obsidian';
import { PdfPage, ViewerHandle } from './viewer-hooks';
import { AnnotationDoc, BACKGROUNDS, BASELINE_OFFSET_EM, BG_PAD_EM, BoxHistory, LINE_HEIGHT, TextBox } from './types';

export const COLORS = ['#000000', '#d00000', '#0050d0', '#008a00', '#e07000', '#8a2be2'];
export const COLOR_NAMES = ['Black', 'Red', 'Blue', 'Green', 'Orange', 'Purple'];
/** Symbol palette contents (rows of the grid). */
export const SYMBOLS: { label: string; rows: string[][]; base?: string }[] = [
	{
		label: 'Greek',
		rows: [
			[...'αβγδεζηθικλμν'],
			[...'ξπρστυφχψωΓΔΘ'],
			[...'ΛΞΠΣΦΨΩ'],
		],
	},
	{
		label: 'Superscript / subscript',
		base: 'x', // shown faintly so the tiny glyphs are readable; not inserted
		rows: [
			[...'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ'],
			[...'₀₁₂₃₄₅₆₇₈₉₊₋ᵢ'],
			[...'ⱼₖₙₓ⁽⁾₍₎ⁱ'],
		],
	},
	{
		label: 'Math',
		rows: [
			[...'±×÷·≈≠≤≥∞√∑∏∫'],
			[...'∂∇∈∉⊂∪∩∀∃¬∧∨∝'],
			['→', '←', '↔', '⇒', '⇔', '∼', '°', '‰', 'x̄', 'ȳ'],
		],
	},
];

export const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

export interface OverlayHost {
	getDoc(file: TFile): AnnotationDoc | null;
	/** Creates storage (pristine copy + JSON) on first use. */
	ensureDoc(file: TFile): Promise<AnnotationDoc>;
	/** Persist now (JSON) and schedule a bake. */
	changed(file: TFile, doc: AnnotationDoc): void;
	setEditing(file: TFile, editing: boolean): void;
	zoomChanged(file: TFile, scaleValue: string | null): void;
	style: { fontSize: number; color: string; bg: string | null };
	/** Undo/redo stacks for a PDF (kept by the plugin so they survive file switches). */
	history(file: TFile): BoxHistory;
	/** Session-wide UI state shared by all open PDFs. */
	ui: { symbolsOpen: boolean };
}

const DRAG_THRESHOLD = 3;

/** Text box overlay for one open PDF viewer. */
export class PdfOverlay {
	private layers = new Map<number, HTMLElement>();
	private boxEls = new Map<string, HTMLElement>();
	private unsubs: (() => void)[] = [];
	private toolbarBtn: HTMLElement | null = null;
	private tool: HTMLElement | null = null;
	private panel: { el: HTMLElement; size: HTMLElement; swatches: HTMLElement[]; symBtn: HTMLElement; bgBtn: HTMLElement } | null = null;
	/** Box state when the current editing session started (one undo step per session). */
	private editSnapshot: string | null = null;
	private symbols: { el: HTMLElement; hint: HTMLElement } | null = null;
	private addMode = false;
	private selectedId: string | null = null;
	private editingId: string | null = null;
	private disposed = false;
	private relayoutQueued = false;
	/** Set when a click closed the symbol palette; that click must not place a box. */
	private paletteJustClosed = false;

	constructor(readonly handle: ViewerHandle, private host: OverlayHost) {}

	get file() {
		return this.handle.file;
	}

	attach() {
		const h = this.handle;
		this.unsubs.push(
			h.on('pagerendered', (e) => e.pageNumber && this.renderPage(e.pageNumber)),
			h.on('pagesinit', () => this.renderAll()),
			h.on('scalechanging', () => {
				this.queueRelayout();
				this.host.zoomChanged(this.file, h.scaleValue());
			}),
		);
		// Any click outside the symbol palette (except its Σ toggle) closes it.
		// Runs in the capture phase on the whole window, before the PDF handler.
		const win = h.view.containerEl.win ?? window;
		const onWinDown = (ev: PointerEvent) => {
			const el = this.symbols?.el;
			if (!el?.hasClass('is-open')) return;
			const t = ev.target as Node;
			if (el.contains(t) || this.panel?.symBtn.contains(t)) return;
			this.toggleSymbols(false);
			this.paletteJustClosed = true;
			win.setTimeout(() => (this.paletteJustClosed = false), 0);
		};
		win.addEventListener('pointerdown', onWinDown, true);
		this.unsubs.push(() => win.removeEventListener('pointerdown', onWinDown, true));

		const onDown = (ev: PointerEvent) => this.onViewerPointerDown(ev);
		h.scrollEl.addEventListener('pointerdown', onDown, true);
		this.unsubs.push(() => h.scrollEl.removeEventListener('pointerdown', onDown, true));

		// Keyboard: T toggles placement mode while this PDF is the active pane
		// (ignored while typing in a box or the search field); Esc leaves it.
		const scope = h.view.scope;
		if (scope) {
			const tKey = scope.register([], 't', (evt) => {
				if (isEditable(evt.target)) return;
				this.toggleAddMode();
				return false;
			});
			// ⌘Z / ⌘⇧Z undo box actions (create, move, delete, style, a whole
			// typing session). While typing, the browser's own text undo runs.
			const undoKey = scope.register(['Mod'], 'z', (evt) => {
				if (isEditable(evt.target)) return;
				this.undo();
				return false;
			});
			const symKey = scope.register(['Mod', 'Shift'], 'g', () => {
				this.toggleSymbols();
				return false;
			});
			const redoKey = scope.register(['Mod', 'Shift'], 'z', (evt) => {
				if (isEditable(evt.target)) return;
				this.redo();
				return false;
			});
			this.unsubs.push(() => {
				scope.unregister(tKey);
				scope.unregister(undoKey);
				scope.unregister(redoKey);
				scope.unregister(symKey);
			});
		}
		const onEsc = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape' || !this.addMode || this.selectedId || this.editingId || isEditable(ev.target)) return;
			this.setAddMode(false);
		};
		h.view.containerEl.addEventListener('keydown', onEsc);
		this.unsubs.push(() => h.view.containerEl.removeEventListener('keydown', onEsc));

		if (h.toolbarEl) {
			// [slide-out panel][T] in the PDF toolbar; the panel opens to the left.
			const tool = (this.tool = createDiv('ptb-tool'));
			this.buildPanel(tool);
			const btn = (this.toolbarBtn = tool.createDiv('clickable-icon ptb-toolbar-toggle'));
			setIcon(btn, 'type');
			setTooltip(btn, 'Add text boxes (T) · ⌥-click works anytime');
			btn.addEventListener('click', () => this.setAddMode(!this.addMode));
			h.toolbarEl.prepend(tool);
			this.unsubs.push(() => tool.remove());
		}
		this.renderAll();
	}

	dispose() {
		if (this.disposed) return;
		this.finishEditing();
		this.disposed = true;
		this.unsubs.forEach((u) => u());
		this.unsubs = [];
		this.layers.forEach((l) => l.remove());
		this.layers.clear();
		this.boxEls.clear();
	}

	setAddMode(on: boolean) {
		this.addMode = on;
		this.toolbarBtn?.toggleClass('is-active', on);
		this.handle.scrollEl.toggleClass('ptb-add-mode', on);
		this.refreshPanel();
	}
	toggleAddMode() {
		this.setAddMode(!this.addMode);
	}

	// ---------- rendering ----------

	renderAll() {
		const doc = this.host.getDoc(this.file);
		if (!doc) return;
		const pages = new Set(doc.boxes.map((b) => b.page));
		this.layers.forEach((_, n) => pages.add(n));
		pages.forEach((n) => this.renderPage(n));
	}

	private queueRelayout() {
		if (this.relayoutQueued) return;
		this.relayoutQueued = true;
		activeWindow.requestAnimationFrame(() => {
			this.relayoutQueued = false;
			if (!this.disposed) this.renderAll();
		});
	}

	/** (Re-)attach the layer of a page and lay out its boxes. */
	renderPage(pageNumber: number) {
		if (this.disposed) return;
		const page = this.handle.getPage(pageNumber);
		if (!page) return;
		const doc = this.host.getDoc(this.file);
		const boxes = doc?.boxes.filter((b) => b.page === pageNumber) ?? [];
		if (!boxes.length && !this.layers.has(pageNumber)) return;
		const layer = this.ensureLayer(page);

		const seen = new Set<string>();
		for (const box of boxes) {
			seen.add(box.id);
			let el = this.boxEls.get(box.id);
			if (!el) el = this.createBoxEl(box);
			if (el.parentElement !== layer) layer.appendChild(el);
			this.layoutBox(el, box, page);
		}
		layer.querySelectorAll<HTMLElement>('.ptb-box').forEach((el) => {
			if (!seen.has(el.dataset.id!)) {
				this.boxEls.delete(el.dataset.id!);
				el.remove();
			}
		});
	}

	/** The page's layer element, (re-)attached to the page div. */
	private ensureLayer(page: PdfPage): HTMLElement {
		let layer = this.layers.get(page.pageNumber);
		if (!layer) {
			layer = createDiv('ptb-layer');
			layer.dataset.page = String(page.pageNumber);
			const n = page.pageNumber;
			layer.addEventListener('pointerdown', (ev) => this.onLayerPointerDown(ev, n));
			this.layers.set(n, layer);
		}
		if (layer.parentElement !== page.div) {
			const wasEditing = this.editingId && layer.querySelector(`[data-id="${this.editingId}"]`);
			page.div.appendChild(layer);
			if (wasEditing) this.focusText(this.editingId!);
		}
		return layer;
	}

	private layoutBox(el: HTMLElement, box: TextBox, page: PdfPage) {
		const vp = page.viewport;
		const [vx, vy] = vp.convertToViewportPoint(box.x, box.y) as [number, number];
		el.style.left = `${(100 * vx) / vp.width}%`;
		el.style.top = `${(100 * vy) / vp.height}%`;
		el.style.fontSize = `${box.fontSize * vp.scale}px`;
		el.style.lineHeight = String(LINE_HEIGHT);
		el.style.color = box.color;
		// Background via box-shadow so it does not change the text layout.
		el.toggleClass('has-bg', !!box.bg);
		el.style.backgroundColor = box.bg ?? '';
		el.style.boxShadow = box.bg ? `0 0 0 ${BG_PAD_EM}em ${box.bg}` : '';
		const text = el.querySelector<HTMLElement>('.ptb-text')!;
		if (this.editingId !== box.id && text.textContent !== box.text) text.textContent = box.text;
		el.toggleClass('is-selected', this.selectedId === box.id);
		el.toggleClass('is-editing', this.editingId === box.id);
	}

	private createBoxEl(box: TextBox): HTMLElement {
		const el = createDiv('ptb-box');
		el.dataset.id = box.id;
		el.tabIndex = 0;
		const text = el.createDiv('ptb-text');
		text.textContent = box.text;
		text.addEventListener('input', () => this.onInput(box.id, text));
		text.addEventListener('blur', () => window.setTimeout(() => this.onTextBlur(box.id), 0));
		el.addEventListener('pointerdown', (ev) => this.onBoxPointerDown(ev, box.id));
		el.addEventListener('dblclick', (ev) => {
			ev.stopPropagation();
			this.startEditing(box.id);
		});
		el.addEventListener('keydown', (ev) => this.onBoxKey(ev, box.id));
		this.boxEls.set(box.id, el);
		return el;
	}

	// ---------- slide-out style panel next to the T button ----------

	private buildPanel(tool: HTMLElement) {
		const el = tool.createDiv('ptb-panel');
		// Keep focus (and the caret) in the box being edited.
		el.addEventListener('pointerdown', (ev) => ev.preventDefault());
		const btn = (icon: string, tip: string, fn: () => void, cls = '') => {
			const b = el.createDiv(`clickable-icon ptb-btn ${cls}`);
			setIcon(b, icon);
			setTooltip(b, tip);
			b.addEventListener('click', fn);
			return b;
		};
		btn('minus', 'Smaller', () => this.stepSize(-1));
		const size = el.createDiv('ptb-size');
		btn('plus', 'Larger', () => this.stepSize(+1));
		el.createDiv('ptb-sep');
		const swatches = COLORS.map((c) => {
			const sw = el.createDiv('ptb-swatch');
			sw.style.backgroundColor = c;
			sw.dataset.color = c;
			sw.addEventListener('click', () => this.setColor(c));
			return sw;
		});
		const bgBtn = btn('square', 'Background', () => this.cycleBackground(), 'ptb-bg-btn');
		el.createDiv('ptb-sep');
		const symBtn = btn('sigma', 'Symbols: Greek, ², math (⌘⇧G)', () => this.toggleSymbols());
		el.createDiv('ptb-sep ptb-del');
		btn('trash-2', 'Delete text box (⌫)', () => this.selectedId && this.deleteBox(this.selectedId), 'ptb-del');
		this.panel = { el, size, swatches, symBtn, bgBtn };
		this.buildSymbols(tool);
		this.refreshPanel();
	}

	/**
	 * Drop-down grid of symbols at the top right of the PDF, under the T button;
	 * a click types the symbol at the caret. Lives in the PDF content container
	 * because the toolbar clips its children (overflow: auto).
	 */
	private buildSymbols(tool: HTMLElement) {
		const host = this.handle.scrollEl.parentElement ?? tool;
		const el = host.createDiv('ptb-symbols');
		this.unsubs.push(() => el.remove());
		el.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep the caret
		const head = el.createDiv('ptb-symbols-head');
		const hint = head.createDiv({ cls: 'ptb-symbols-hint', text: 'Click a symbol to insert it' });
		const close = head.createDiv('clickable-icon ptb-symbols-close');
		setIcon(close, 'x');
		close.addEventListener('click', () => this.toggleSymbols(false));
		for (const group of SYMBOLS) {
			el.createDiv({ cls: 'ptb-symbols-label', text: group.label });
			const grid = el.createDiv('ptb-symbols-grid');
			for (const row of group.rows) {
				for (const sym of row) {
					const b = grid.createDiv('ptb-sym');
					if (group.base) b.createSpan({ cls: 'ptb-sym-base', text: group.base });
					b.appendText(sym);
					b.dataset.sym = sym;
					b.addEventListener('click', () => this.insertSymbol(sym));
				}
			}
		}
		this.symbols = { el, hint };
	}

	toggleSymbols(open = !this.host.ui.symbolsOpen) {
		this.host.ui.symbolsOpen = open;
		this.refreshPanel();
	}

	private insertSymbol(sym: string) {
		const id = this.editingId ?? this.selectedId;
		if (!id) {
			const hint = this.symbols?.hint;
			if (hint) {
				hint.setText('Click into a text box first');
				hint.addClass('is-warning');
				window.setTimeout(() => {
					hint.setText('Click a symbol to insert it');
					hint.removeClass('is-warning');
				}, 1500);
			}
			return;
		}
		if (this.editingId !== id) this.startEditing(id);
		const text = this.boxEls.get(id)?.querySelector<HTMLElement>('.ptb-text');
		if (text && !text.contains(text.doc.activeElement)) this.focusText(id);
		if (text) insertAtCaret(text, sym);
		if (text) this.commitText(id, text);
	}

	/** Open the panel while a box is selected or placement mode is on, and show current values. */
	private refreshPanel() {
		if (!this.panel || !this.tool) return;
		const box = this.selectedId ? this.findBox(this.selectedId) : undefined;
		const fontSize = box?.fontSize ?? this.host.style.fontSize;
		const color = box?.color ?? this.host.style.color;
		const open = !!box || this.addMode;
		this.tool.toggleClass('is-open', open);
		this.panel.symBtn.toggleClass('is-active', this.host.ui.symbolsOpen);
		this.symbols?.el.toggleClass('is-open', open && this.host.ui.symbolsOpen);
		this.panel.el.toggleClass('has-box', !!box);
		this.panel.size.textContent = String(fontSize);
		this.panel.swatches.forEach((sw) => sw.toggleClass('is-active', sw.dataset.color === color));
		const bg = box ? (box.bg ?? null) : this.host.style.bg;
		const bgLabel = BACKGROUNDS.find((b) => b.color === bg)?.label ?? 'none';
		this.panel.bgBtn.style.setProperty('--ptb-bg', bg ?? 'transparent');
		this.panel.bgBtn.toggleClass('is-active', !!bg);
		setTooltip(this.panel.bgBtn, `Background: ${bgLabel} (click to change)`);
	}

	/** none → white → yellow → none, for the selected box or the next new box. */
	private cycleBackground() {
		const box = this.selectedId ? this.findBox(this.selectedId) : undefined;
		const current = box ? (box.bg ?? null) : this.host.style.bg;
		const i = BACKGROUNDS.findIndex((b) => b.color === current);
		const next = BACKGROUNDS[(i + 1) % BACKGROUNDS.length]!.color;
		this.host.style.bg = next;
		if (box) {
			this.checkpoint();
			this.update(box.id, (b) => (b.bg = next));
		}
		this.refreshPanel();
	}

	/** Size/colour buttons edit the selected box, or the style for the next new box. */
	private stepSize(dir: number) {
		const box = this.selectedId ? this.findBox(this.selectedId) : undefined;
		const current = box?.fontSize ?? this.host.style.fontSize;
		const i = FONT_SIZES.findIndex((s) => s >= current);
		const idx = Math.min(FONT_SIZES.length - 1, Math.max(0, (i < 0 ? FONT_SIZES.length - 1 : i) + dir));
		const next = FONT_SIZES[idx]!;
		this.host.style.fontSize = next;
		if (box && box.fontSize !== next) {
			this.checkpoint();
			this.update(box.id, (b) => (b.fontSize = next));
		}
		this.refreshPanel();
	}

	private setColor(c: string) {
		this.host.style.color = c;
		const box = this.selectedId ? this.findBox(this.selectedId) : undefined;
		if (box && box.color !== c) {
			this.checkpoint();
			this.update(box.id, (b) => (b.color = c));
		}
		this.refreshPanel();
	}

	// ---------- selection / editing ----------

	private select(id: string | null) {
		if (this.selectedId === id) return;
		if (this.editingId && this.editingId !== id) this.finishEditing();
		this.selectedId = id;
		this.boxEls.forEach((el, bid) => el.toggleClass('is-selected', bid === id));
		if (id) this.boxEls.get(id)?.focus({ preventScroll: true });
		this.refreshPanel();
	}

	startEditing(id: string) {
		this.select(id);
		this.editSnapshot ??= this.snapshot();
		this.editingId = id;
		const el = this.boxEls.get(id);
		if (!el) return;
		el.addClass('is-editing');
		this.host.setEditing(this.file, true);
		this.focusText(id, true);
	}

	private focusText(id: string, selectEnd = true) {
		const text = this.boxEls.get(id)?.querySelector<HTMLElement>('.ptb-text');
		if (!text) return;
		text.contentEditable = 'plaintext-only';
		text.spellcheck = false;
		text.focus({ preventScroll: true });
		if (selectEnd) {
			const range = text.doc.createRange();
			range.selectNodeContents(text);
			range.collapse(false);
			const sel = text.win.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
		}
	}

	finishEditing() {
		const id = this.editingId;
		if (!id) return;
		this.editingId = null;
		this.host.setEditing(this.file, false);
		const el = this.boxEls.get(id);
		const text = el?.querySelector<HTMLElement>('.ptb-text');
		if (text) {
			text.contentEditable = 'false';
			this.commitText(id, text);
			// Editing may leave <div>/<br> structure; normalise to plain text.
			const committed = this.findBox(id);
			if (committed) text.textContent = committed.text;
		}
		el?.removeClass('is-editing');
		const box = this.findBox(id);
		if (box && !box.text.trim()) this.deleteBox(id, false);
		// One undo step for the whole session (nothing if an empty new box vanished).
		const before = this.editSnapshot;
		this.editSnapshot = null;
		if (before !== null && before !== this.snapshot()) this.pushUndo(before);
	}

	private onTextBlur(id: string) {
		if (this.disposed || this.editingId !== id) return;
		const el = this.boxEls.get(id);
		// Blur caused by pdf.js re-rendering the page: keep editing.
		if (!el || !el.isConnected) return;
		if (el.contains(el.doc.activeElement)) return;
		this.finishEditing();
		if (this.selectedId === id && !el.contains(el.doc.activeElement)) this.select(null);
	}

	private onInput(id: string, text: HTMLElement) {
		this.commitText(id, text);
	}

	private commitText(id: string, text: HTMLElement) {
		const value = text.innerText.replace(/\r/g, '').replace(/\n$/, '');
		const box = this.findBox(id);
		if (box && box.text !== value) this.update(id, (b) => (b.text = value), false);
	}

	private onBoxKey(ev: KeyboardEvent, id: string) {
		ev.stopPropagation(); // keep Obsidian / pdf.js shortcuts (arrows etc.) out
		if (this.editingId === id) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				this.finishEditing();
				this.boxEls.get(id)?.focus({ preventScroll: true });
			}
			return;
		}
		if (ev.key === 'Backspace' || ev.key === 'Delete') {
			ev.preventDefault();
			this.deleteBox(id);
		} else if (ev.key === 'Enter') {
			ev.preventDefault();
			this.startEditing(id);
		} else if (ev.key === 'Escape') {
			this.select(null);
		}
	}

	// ---------- pointer handling ----------

	private onViewerPointerDown(ev: PointerEvent) {
		const target = ev.target as HTMLElement;
		if (target.closest('.ptb-box')) return;
		const closedPalette = this.paletteJustClosed;
		this.paletteJustClosed = false;
		if (this.editingId || this.selectedId || closedPalette) {
			// A click outside a selected/edited box (or one that closed the symbol
			// palette) only deselects and returns to the idle state; the *next*
			// click places a new box.
			this.finishEditing();
			this.select(null);
			if ((this.addMode || ev.altKey) && ev.button === 0) {
				ev.preventDefault();
				ev.stopPropagation();
			}
			return;
		}
		// In add mode a click places a box; ⌥-click works in any mode.
		if ((this.addMode || ev.altKey) && ev.button === 0) {
			const pageEl = target.closest<HTMLElement>('.page');
			const n = pageEl ? Number(pageEl.dataset.pageNumber) : NaN;
			if (n) {
				ev.preventDefault();
				ev.stopPropagation();
				void this.createBoxAt(n, ev);
			}
		}
	}

	private onLayerPointerDown(ev: PointerEvent, pageNumber: number) {
		// Only receives events in add mode (layer is pointer-events:none otherwise).
		if (!this.addMode || ev.button !== 0 || (ev.target as HTMLElement).closest('.ptb-box')) return;
		ev.preventDefault();
		ev.stopPropagation();
		void this.createBoxAt(pageNumber, ev);
	}

	/** Viewport coords (CSS px at current scale) of a mouse event on a page. */
	private eventToViewport(page: PdfPage, ev: MouseEvent): [number, number] {
		// The layer covers exactly the rendered page (inside the page border).
		const r = this.ensureLayer(page).getBoundingClientRect();
		return [
			((ev.clientX - r.left) * page.viewport.width) / r.width,
			((ev.clientY - r.top) * page.viewport.height) / r.height,
		];
	}

	private async createBoxAt(pageNumber: number, ev: MouseEvent) {
		const page = this.handle.getPage(pageNumber);
		if (!page) return;
		const { fontSize } = this.host.style;
		const color = this.host.style.color;
		const [vx, vy] = this.eventToViewport(page, ev);
		// Put the caret's baseline roughly where the user clicked.
		const topVy = vy - fontSize * page.viewport.scale * BASELINE_OFFSET_EM * 0.8;
		const [x, y] = page.viewport.convertToPdfPoint(vx, topVy) as [number, number];
		let doc: AnnotationDoc;
		try {
			doc = await this.host.ensureDoc(this.file);
		} catch (e) {
			new Notice((e as Error).message, 12000);
			console.warn('[pdf-textboxes]', e);
			return;
		}
		this.editSnapshot = this.snapshot();
		const box: TextBox = {
			id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			page: pageNumber,
			x: round(x),
			y: round(y),
			text: '',
			fontSize,
			color,
			bg: this.host.style.bg,
		};
		doc.boxes.push(box);
		this.host.changed(this.file, doc);
		this.renderPage(pageNumber);
		this.startEditing(box.id);
	}

	private onBoxPointerDown(ev: PointerEvent, id: string) {
		if (ev.button !== 0) return;
		ev.stopPropagation();
		const el = this.boxEls.get(id)!;
		const editing = this.editingId === id;
		const onGrip = (ev.target as HTMLElement).closest('.ptb-grip, .ptb-box:not(.is-editing)');
		if (editing && !onGrip) return; // caret placement / text selection
		if (!editing) ev.preventDefault();

		const box = this.findBox(id);
		const page = box && this.handle.getPage(box.page);
		if (!box || !page) return;
		const vp = page.viewport;
		const startX = ev.clientX;
		const startY = ev.clientY;
		const [startVx, startVy] = vp.convertToViewportPoint(box.x, box.y) as [number, number];
		const r = this.ensureLayer(page).getBoundingClientRect();
		const k = vp.width / r.width; // screen px -> viewport px
		const at = (e: MouseEvent): [number, number] => [startVx + (e.clientX - startX) * k, startVy + (e.clientY - startY) * k];
		let dragging = false;

		const move = (e: PointerEvent) => {
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
			if (!dragging) {
				dragging = true;
				el.addClass('is-dragging');
				el.setPointerCapture(ev.pointerId);
			}
			const [vx, vy] = at(e);
			el.style.left = `${(100 * vx) / vp.width}%`;
			el.style.top = `${(100 * vy) / vp.height}%`;
		};
		const up = (e: PointerEvent) => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			if (!dragging) {
				if (!editing) this.select(id);
				return;
			}
			el.removeClass('is-dragging');
			const [vx, vy] = at(e);
			const [x, y] = vp.convertToPdfPoint(vx, vy) as [number, number];
			if (!editing) this.checkpoint(); // while editing, the session step covers it
			this.update(id, (b) => {
				b.x = round(x);
				b.y = round(y);
			});
			if (!editing) this.select(id);
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	}

	// ---------- model helpers ----------

	private findBox(id: string) {
		return this.host.getDoc(this.file)?.boxes.find((b) => b.id === id);
	}

	private update(id: string, fn: (b: TextBox) => void, relayout = true) {
		const doc = this.host.getDoc(this.file);
		const box = doc?.boxes.find((b) => b.id === id);
		if (!doc || !box) return;
		fn(box);
		this.host.changed(this.file, doc);
		if (relayout) this.renderPage(box.page);
	}

	deleteBox(id: string, record = true) {
		const doc = this.host.getDoc(this.file);
		if (!doc) return;
		const box = doc.boxes.find((b) => b.id === id);
		if (!box) return;
		if (record) {
			// Deleting while editing ends the session; record its start state.
			this.pushUndo(this.editingId === id && this.editSnapshot !== null ? this.editSnapshot : this.snapshot());
			if (this.editingId === id) this.editSnapshot = null;
		}
		if (this.editingId === id) {
			this.editingId = null;
			this.host.setEditing(this.file, false);
		}
		if (this.selectedId === id) this.selectedId = null;
		doc.boxes = doc.boxes.filter((b) => b.id !== id);
		this.host.changed(this.file, doc);
		this.boxEls.get(id)?.remove();
		this.boxEls.delete(id);
		this.refreshPanel();
	}

	// ---------- undo / redo ----------

	private snapshot(): string {
		return JSON.stringify(this.host.getDoc(this.file)?.boxes ?? []);
	}

	private pushUndo(snap: string) {
		const h = this.host.history(this.file);
		if (h.undo[h.undo.length - 1] === snap) return;
		h.undo.push(snap);
		if (h.undo.length > 200) h.undo.shift();
		h.redo = [];
	}

	/** Record the current state before a box action. */
	private checkpoint() {
		this.pushUndo(this.snapshot());
	}

	undo() {
		this.travel('undo');
	}
	redo() {
		this.travel('redo');
	}

	private travel(dir: 'undo' | 'redo') {
		this.finishEditing();
		const h = this.host.history(this.file);
		const from = dir === 'undo' ? h.undo : h.redo;
		const to = dir === 'undo' ? h.redo : h.undo;
		const doc = this.host.getDoc(this.file);
		const snap = from.pop();
		if (!doc || snap === undefined) return;
		to.push(this.snapshot());
		this.select(null);
		const before = new Set(doc.boxes.map((b) => b.page));
		doc.boxes = JSON.parse(snap) as TextBox[];
		this.host.changed(this.file, doc);
		const pages = new Set([...before, ...doc.boxes.map((b) => b.page)]);
		pages.forEach((n) => this.renderPage(n));
	}

	/** External change of the doc (e.g. another pane showing the same PDF). */
	refresh() {
		this.renderAll();
	}
}

/** Insert plain text at the caret inside `el` (or at its end) and move the caret after it. */
function insertAtCaret(el: HTMLElement, value: string) {
	const sel = el.win.getSelection();
	let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
	if (!range || !el.contains(range.commonAncestorContainer)) {
		range = el.doc.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
	}
	range.deleteContents();
	const node = el.doc.createTextNode(value);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	sel?.removeAllRanges();
	sel?.addRange(range);
	el.normalize();
}

function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || !!target.closest('input, textarea, select');
}

function round(n: number) {
	return Math.round(n * 100) / 100;
}
