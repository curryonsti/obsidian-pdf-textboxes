import { Keymap, Notice, setIcon, setTooltip, TFile } from 'obsidian';
import { PdfPage, ViewerHandle } from './viewer-hooks';
import { AnnotationDoc, BACKGROUNDS, BG_PAD_EM, BoxHistory, CharStyle, LINE_HEIGHT, ScriptKind, TextBox } from './types';
import { measureWrap, offsetOf, positionAt, readRich, renderRich, startRunAtCaret, StylePatch, styleAt } from './rich-dom';
import { compactStyles, expandStyles } from './rich';

export const COLORS = ['#000000', '#d00000', '#0050d0', '#008a00', '#e07000', '#8a2be2'];
export const COLOR_NAMES = ['Black', 'Red', 'Blue', 'Green', 'Orange', 'Purple'];
/** Symbol palette contents (rows of the grid). */
export const SYMBOLS: { label: string; rows: string[][] }[] = [
	{
		label: 'Greek',
		rows: [
			[...'αβγδεζηθικλμν'],
			[...'ξπρστυφχψωΓΔΘ'],
			[...'ΛΞΠΣΦΨΩ'],
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
	private panel: {
		el: HTMLElement;
		size: HTMLElement;
		swatches: HTMLElement[];
		symBtn: HTMLElement;
		bgBtn: HTMLElement;
		supBtn: HTMLElement;
		subBtn: HTMLElement;
	} | null = null;
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

		// Keep the x²/x₂ buttons in sync with the caret while typing.
		const doc = h.view.containerEl.doc;
		const onSel = () => {
			if (this.editingId) this.refreshStyleButtons();
		};
		doc.addEventListener('selectionchange', onSel);
		this.unsubs.push(() => doc.removeEventListener('selectionchange', onSel));

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
		window.requestAnimationFrame(() => {
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
		// A set width (from dragging an edge) wraps the text; it always wraps at
		// the right edge of the page. Sizes in % of the page, so zoom just scales.
		el.style.maxWidth = `${Math.max(0, (100 * (vp.width - vx)) / vp.width)}%`;
		el.style.width = box.w ? `${(100 * box.w * vp.scale) / vp.width}%` : '';
		el.style.minHeight = box.h ? `${(100 * box.h * vp.scale) / vp.height}%` : '';
		const text = el.querySelector<HTMLElement>('.ptb-text')!;
		if (this.editingId !== box.id) renderRich(text, box.text, box.runs);
		el.toggleClass('is-selected', this.selectedId === box.id);
		el.toggleClass('is-editing', this.editingId === box.id);
		this.syncWrap(box, el, page);
	}

	/**
	 * Store where the browser wrapped the text (soft line breaks) and the text
	 * width, so the baked PDF breaks the lines at exactly the same places.
	 */
	private syncWrap(box: TextBox, el: HTMLElement, page: PdfPage) {
		const text = el.querySelector<HTMLElement>('.ptb-text');
		if (!text || !el.isConnected) return;
		const at = measureWrap(text, box.text.split('\n').length);
		let wrap: TextBox['wrap'];
		if (at.length || box.w) {
			const layer = this.ensureLayer(page).getBoundingClientRect();
			const k = layer.width ? page.viewport.width / layer.width : 1; // screen px -> viewport px
			const width = (text.getBoundingClientRect().width * k) / page.viewport.scale;
			wrap = { at, width: Math.round(width * 100) / 100 };
		}
		if (JSON.stringify(wrap ?? null) === JSON.stringify(box.wrap ?? null)) return;
		const doc = this.host.getDoc(this.file);
		if (!doc) return;
		if (wrap) box.wrap = wrap;
		else delete box.wrap;
		this.host.changed(this.file, doc);
	}

	private syncWrapOf(id: string) {
		const box = this.findBox(id);
		const el = this.boxEls.get(id);
		const page = box && this.handle.getPage(box.page);
		if (box && el && page) this.syncWrap(box, el, page);
	}

	private createBoxEl(box: TextBox): HTMLElement {
		const el = createDiv('ptb-box');
		el.dataset.id = box.id;
		el.tabIndex = 0;
		const text = el.createDiv('ptb-text');
		text.addEventListener('input', () => this.commitText(box.id, text));
		text.addEventListener('blur', () => window.setTimeout(() => this.onTextBlur(box.id), 0));
		el.addEventListener('pointerdown', (ev) => this.onBoxPointerDown(ev, box.id));
		el.addEventListener('keydown', (ev) => this.onBoxKey(ev, box.id));
		// Resize handles (shown while selected): drag to change the box size.
		for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
			const h = el.createDiv(`ptb-handle ptb-handle-${dir}`);
			h.addEventListener('pointerdown', (ev) => this.onHandlePointerDown(ev, box.id, dir));
		}
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
		// Delete sits at the far left: it only shows while a box is selected, and
		// the panel is anchored at the right, so nothing else moves.
		btn('trash-2', 'Delete text box (⌫)', () => this.selectedId && this.deleteBox(this.selectedId), 'ptb-del');
		el.createDiv('ptb-sep ptb-del');
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
		const supBtn = btn('superscript', 'Superscript (⌘⇧.): selected text, or what you type next', () => this.toggleScript('^'));
		const subBtn = btn('subscript', 'Subscript (⌘⇧,): selected text, or what you type next', () => this.toggleScript('_'));
		el.createDiv('ptb-sep');
		const symBtn = btn('sigma', 'Symbols: Greek and math (⌘⇧G)', () => this.toggleSymbols());
		this.panel = { el, size, swatches, symBtn, bgBtn, supBtn, subBtn };
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
					b.appendText(sym);
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
		const text = this.textEl(id);
		if (!text) return;
		if (!text.contains(text.doc.activeElement)) this.focusText(id);
		insertAtCaret(text, sym);
		this.commitText(id, text);
	}

	/** Open the panel while a box is selected or placement mode is on, and show current values. */
	private refreshPanel() {
		if (!this.panel || !this.tool) return;
		const box = this.selectedId ? this.findBox(this.selectedId) : undefined;
		const fontSize = box?.fontSize ?? this.host.style.fontSize;
		const open = !!box || this.addMode;
		this.tool.toggleClass('is-open', open);
		this.panel.symBtn.toggleClass('is-active', this.host.ui.symbolsOpen);
		this.symbols?.el.toggleClass('is-open', open && this.host.ui.symbolsOpen);
		this.panel.el.toggleClass('has-box', !!box);
		this.panel.size.textContent = String(fontSize);
		const bg = box ? (box.bg ?? null) : this.host.style.bg;
		const bgLabel = BACKGROUNDS.find((b) => b.color === bg)?.label ?? 'none';
		this.panel.bgBtn.style.setProperty('--ptb-bg', bg ?? 'transparent');
		this.panel.bgBtn.toggleClass('is-active', !!bg);
		setTooltip(this.panel.bgBtn, `Background: ${bgLabel} (click to change)`);
		this.refreshStyleButtons();
	}

	/**
	 * Colour swatches and x²/x₂ show the style at the caret while typing, or
	 * of the whole box when it is only selected.
	 */
	private refreshStyleButtons() {
		if (!this.panel) return;
		const id = this.editingId ?? this.selectedId;
		const box = id ? this.findBox(id) : undefined;
		let color = box?.color ?? this.host.style.color;
		let s: ScriptKind | null = null;
		const text = id ? this.textEl(id) : null;
		if (box && text && this.editingId === id) {
			const sel = text.win.getSelection();
			if (sel?.rangeCount && text.contains(sel.anchorNode)) {
				const st = styleAt(sel.anchorNode, text);
				color = st.color ?? box.color;
				s = st.s ?? null;
			}
		} else if (box) {
			const chars = expandStyles(box.text, box.runs).filter((_, i) => box.text[i] !== '\n');
			const colors = new Set(chars.map((c) => c.color ?? box.color));
			color = colors.size === 1 ? [...colors][0]! : '';
			if (chars.length && chars.every((c) => c.s === chars[0]!.s)) s = chars[0]!.s ?? null;
		}
		this.panel.swatches.forEach((sw) => sw.toggleClass('is-active', sw.dataset.color === color));
		this.panel.supBtn.toggleClass('is-active', s === '^');
		this.panel.subBtn.toggleClass('is-active', s === '_');
	}

	private textEl(id: string) {
		return this.boxEls.get(id)?.querySelector<HTMLElement>('.ptb-text') ?? null;
	}

	/** x² / x₂ (also the Superscript/Subscript commands). */
	toggleScript(kind: ScriptKind) {
		this.applyStyle(
			(cur) => ({ s: cur.every((c) => c.s === kind) ? null : kind }),
			(st) => ({ s: st.s === kind ? null : kind }),
		);
	}

	/**
	 * Applies a style change where the user expects it:
	 *  - typing with text selected: to the selected characters;
	 *  - typing without a selection: to what is typed next (from the caret on);
	 *  - box selected, not typing: to all of its text.
	 * `forRange` gets the current styles of the affected characters,
	 * `forCaret` the style at the caret.
	 */
	private applyStyle(forRange: (cur: CharStyle[]) => StylePatch, forCaret: (st: CharStyle) => StylePatch) {
		const id = this.editingId ?? this.selectedId;
		const box = id ? this.findBox(id) : undefined;
		const text = id ? this.textEl(id) : null;
		if (!id || !box || !text) {
			new Notice('Select a text box or click into one first');
			return;
		}
		const patchRange = (b: TextBox, from: number, to: number) => {
			const chars = expandStyles(b.text, b.runs);
			const idx: number[] = [];
			for (let i = from; i < to; i++) if (b.text[i] !== '\n') idx.push(i);
			const patch = forRange(idx.map((i) => chars[i]!));
			for (const i of idx) {
				const c = { ...chars[i] };
				if (patch.color !== undefined) {
					if (patch.color === null || patch.color === b.color) delete c.color;
					else c.color = patch.color;
				}
				if (patch.s !== undefined) {
					if (patch.s === null) delete c.s;
					else c.s = patch.s;
				}
				chars[i] = c;
			}
			const runs = compactStyles(b.text, chars);
			if (runs) b.runs = runs;
			else delete b.runs;
		};
		if (this.editingId !== id) {
			this.checkpoint();
			this.update(id, (b) => patchRange(b, 0, b.text.length));
			this.refreshPanel();
			return;
		}
		const sel = text.win.getSelection();
		let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
		if (!range || !text.contains(range.startContainer) || !text.contains(range.endContainer)) {
			this.focusText(id);
			range = sel?.rangeCount ? sel.getRangeAt(0) : null;
			if (!range) return;
		}
		if (range.collapsed) {
			const patch = forCaret(styleAt(range.startContainer, text));
			if (patch.color && patch.color === box.color) patch.color = null;
			startRunAtCaret(text, range, patch);
		} else {
			this.commitText(id, text);
			const from = offsetOf(text, range.startContainer, range.startOffset);
			const to = offsetOf(text, range.endContainer, range.endOffset);
			this.update(id, (b) => patchRange(b, from, to), false);
			const b = this.findBox(id)!;
			renderRich(text, b.text, b.runs);
			const a = positionAt(text, from);
			const z = positionAt(text, to);
			const r = text.doc.createRange();
			r.setStart(a.node, a.offset);
			r.setEnd(z.node, z.offset);
			sel?.removeAllRanges();
			sel?.addRange(r);
			this.syncWrapOf(id);
		}
		this.refreshStyleButtons();
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

	/** Colour for the selection / what is typed next / the whole box (see applyStyle). */
	private setColor(c: string) {
		this.host.style.color = c;
		const id = this.editingId ?? this.selectedId;
		const box = id ? this.findBox(id) : undefined;
		if (box && this.editingId !== id) {
			// Whole box: the box colour, and no differently coloured parts left.
			const chars = expandStyles(box.text, box.runs).map((ch) => ({ ...ch, color: undefined }));
			const cleaned = compactStyles(box.text, chars);
			if (box.color !== c || JSON.stringify(cleaned ?? null) !== JSON.stringify(box.runs ?? null)) {
				this.checkpoint();
				this.update(box.id, (b) => {
					b.color = c;
					if (cleaned) b.runs = cleaned;
					else delete b.runs;
				});
			}
		} else if (box) {
			this.applyStyle(
				() => ({ color: c }),
				() => ({ color: c }),
			);
		}
		this.refreshPanel();
	}

	// ---------- selection / editing ----------

	private select(id: string | null) {
		if (this.selectedId === id) return;
		if (this.editingId && this.editingId !== id) this.finishEditing();
		// A deselected box must not keep keyboard focus (and with it a focus outline).
		const prev = this.selectedId ? this.boxEls.get(this.selectedId) : null;
		if (prev?.contains(prev.doc.activeElement)) prev.blur();
		this.selectedId = id;
		this.boxEls.forEach((el, bid) => el.toggleClass('is-selected', bid === id));
		if (id) this.boxEls.get(id)?.focus({ preventScroll: true });
		this.refreshPanel();
	}

	/** Start typing in a box; the caret goes to the clicked point `at`, or to the end. */
	startEditing(id: string, at?: { x: number; y: number }) {
		this.select(id);
		this.editSnapshot ??= this.snapshot();
		this.editingId = id;
		const el = this.boxEls.get(id);
		if (!el) return;
		el.addClass('is-editing');
		this.focusText(id, at);
	}

	private focusText(id: string, at?: { x: number; y: number }) {
		const text = this.textEl(id);
		if (!text) return;
		text.contentEditable = 'plaintext-only';
		text.spellcheck = false;
		text.focus({ preventScroll: true });
		const range = text.doc.createRange();
		const pos = at ? text.doc.caretPositionFromPoint(at.x, at.y) : null;
		if (pos && text.contains(pos.offsetNode)) {
			range.setStart(pos.offsetNode, pos.offset);
		} else {
			range.selectNodeContents(text);
			range.collapse(false);
		}
		const sel = text.win.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	finishEditing() {
		const id = this.editingId;
		if (!id) return;
		this.editingId = null;
		const el = this.boxEls.get(id);
		const text = el?.querySelector<HTMLElement>('.ptb-text');
		if (text) {
			text.contentEditable = 'false';
			this.commitText(id, text);
			// Editing may leave <div>/<br> structure and caret placeholders; re-render.
			const committed = this.findBox(id);
			if (committed) renderRich(text, committed.text, committed.runs);
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

	private commitText(id: string, text: HTMLElement) {
		const value = readRich(text);
		const box = this.findBox(id);
		if (box && (box.text !== value.text || JSON.stringify(box.runs ?? null) !== JSON.stringify(value.runs ?? null))) {
			this.update(
				id,
				(b) => {
					b.text = value.text;
					if (value.runs) b.runs = value.runs;
					else delete b.runs;
				},
				false,
			);
		}
		this.syncWrapOf(id);
	}

	private onBoxKey(ev: KeyboardEvent, id: string) {
		ev.stopPropagation(); // keep Obsidian / pdf.js shortcuts (arrows etc.) out
		// ⌘⇧. superscript, ⌘⇧, subscript (Ctrl on Windows/Linux). Physical keys, so
		// any keyboard layout works; ⌘, alone is taken by Obsidian's settings.
		if (Keymap.isModifier(ev, 'Mod') && ev.shiftKey && !ev.altKey && (ev.code === 'Period' || ev.code === 'Comma')) {
			ev.preventDefault();
			this.toggleScript(ev.code === 'Period' ? '^' : '_');
			return;
		}
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
		// Centre the first line (and the caret) vertically on the click point.
		const topVy = vy - (fontSize * page.viewport.scale * LINE_HEIGHT) / 2;
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
		if (this.editingId === id) return; // caret placement / text selection
		ev.preventDefault();
		const el = this.boxEls.get(id)!;
		// A click on the already selected box starts typing there (so does the
		// second click of a double-click on an unselected box).
		const wasSelected = this.selectedId === id;

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
				if (wasSelected) this.startEditing(id, { x: e.clientX, y: e.clientY });
				else this.select(id);
				return;
			}
			el.removeClass('is-dragging');
			const [vx, vy] = at(e);
			const [x, y] = vp.convertToPdfPoint(vx, vy) as [number, number];
			this.checkpoint();
			this.update(id, (b) => {
				b.x = round(x);
				b.y = round(y);
			});
			this.select(id);
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	}

	/**
	 * Drag a handle to resize the box: the font size stays, the text wraps to
	 * the new width. Left/top handles move that edge (the opposite one stays).
	 */
	private onHandlePointerDown(ev: PointerEvent, id: string, dir: string) {
		if (ev.button !== 0) return;
		ev.stopPropagation();
		ev.preventDefault();
		const el = this.boxEls.get(id);
		const box = this.findBox(id);
		const page = box && this.handle.getPage(box.page);
		if (!el || !box || !page) return;
		if (this.selectedId !== id) this.select(id);
		const vp = page.viewport;
		const layer = this.ensureLayer(page).getBoundingClientRect();
		const k = vp.width / layer.width; // screen px -> viewport px
		const r0 = el.getBoundingClientRect();
		const left0 = (r0.left - layer.left) * k;
		const top0 = (r0.top - layer.top) * k;
		const w0 = r0.width * k;
		const h0 = r0.height * k;
		const minW = box.fontSize * vp.scale * 1.5;
		const minH = box.fontSize * vp.scale * LINE_HEIGHT;
		const startX = ev.clientX;
		const startY = ev.clientY;
		let rect = { left: left0, top: top0, w: w0, h: h0 };
		el.addClass('is-resizing');
		el.setPointerCapture(ev.pointerId);

		const calc = (e: PointerEvent) => {
			const dx = (e.clientX - startX) * k;
			const dy = (e.clientY - startY) * k;
			let { left, top } = { left: left0, top: top0 };
			let w = w0;
			let h = h0;
			if (dir.includes('e')) w = Math.max(minW, w0 + dx);
			if (dir.includes('w')) {
				w = Math.max(minW, w0 - dx);
				left = left0 + w0 - w;
			}
			if (dir.includes('s')) h = Math.max(minH, h0 + dy);
			if (dir.includes('n')) {
				h = Math.max(minH, h0 - dy);
				top = top0 + h0 - h;
			}
			w = Math.min(w, vp.width - left);
			return { left, top, w, h };
		};
		const move = (e: PointerEvent) => {
			rect = calc(e);
			el.style.left = `${(100 * rect.left) / vp.width}%`;
			el.style.top = `${(100 * rect.top) / vp.height}%`;
			if (dir !== 'n' && dir !== 's') el.style.width = `${(100 * rect.w) / vp.width}%`;
			if (dir !== 'e' && dir !== 'w') el.style.minHeight = `${(100 * rect.h) / vp.height}%`;
		};
		const up = (e: PointerEvent) => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			el.removeClass('is-resizing');
			rect = calc(e);
			const [x, y] = vp.convertToPdfPoint(rect.left, rect.top) as [number, number];
			const editing = this.editingId === id;
			if (!editing) this.checkpoint();
			this.update(id, (b) => {
				b.x = round(x);
				b.y = round(y);
				if (dir !== 'n' && dir !== 's') b.w = round(rect.w / vp.scale);
				if (dir !== 'e' && dir !== 'w') b.h = round(rect.h / vp.scale);
			});
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
