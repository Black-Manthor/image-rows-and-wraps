import { WidgetType, type EditorView } from '@codemirror/view';
import { Component, MarkdownRenderer, type Plugin } from 'obsidian';
import type { ImageRow } from '../markdown/row-model';
import { annotateImagePosition, eventElement, previewStart, previewTargets, windowOf } from './preview-dom';
import { watchRow } from './row-layout';
import { knownRowHeight, rowHeightEffect } from './row-height';
import { createRowToolbar } from './row-toolbar';
import { BLOCK_TOOLBAR_CLASS } from './block-toolbar';
import { ROW_HANDLE_CLASS, ensureRowHandles, startRowResize } from './row-resize-handle';
import type { ImageSettings } from '../settings';
import { t } from '../i18n';

const disposers = new WeakMap<HTMLElement, () => void>();
// A drawn row updates itself in place for a row with the same images (only
// sizes or settings differ) in the same note: see updateDOM.
const updaters = new WeakMap<HTMLElement, (row: ImageRow, path: string) => boolean>();

// The same images in the same order; sizes (`|W`, `|WxH`) may differ.
function sameImages(a: ImageRow, b: ImageRow): boolean {
	const key = (image: ImageRow['images'][number]) => [image.path, ...image.params.filter(param => !/^\d+(x\d+)?$/.test(param))].join('|');
	return a.images.length === b.images.length && a.images.every((image, index) => key(image) === key(b.images[index]!));
}

// Live Preview shows a row through its own rendering, laid out like Reading
// view. Clicking it enters the source line; the Markdown is never rewritten.
export class RowWidget extends WidgetType {
	constructor(readonly row: ImageRow, readonly markdown: string, private path: string, private plugin: Plugin,
		private getSettings: () => ImageSettings) { super(); }
	eq(other: RowWidget): boolean {
		// Settings may come from the defaults, not from the text: compare them too.
		// The position is not compared: offsets inside the widget are relative to
		// its start, so typing above a row keeps its DOM (preview-dom.ts).
		return this.markdown === other.markdown && this.path === other.path &&
			JSON.stringify(this.row.settings) === JSON.stringify(other.row.settings);
	}
	toDOM(view: EditorView): HTMLElement {
		// Not attached yet: made in the editor's own document (pop-out windows).
		const root = view.dom.doc.createElement('div');
		root.addClasses(['iw-preview', 'iw-row-preview']);
		// Images on the right: the bar goes to the other corner, off them and their handles.
		if (this.row.settings.align === 'right') root.classList.add('mod-align-right');
		root.tabIndex = 0;
		root.setAttribute('aria-label', t().rowPreview);
		previewTargets.set(root, { length: this.row.to - this.row.from, fallback: 0 });
		// Until it is drawn the row keeps its last known height: CodeMirror measures
		// a new widget at once, and would keep the empty one's height (0.26.3).
		const known = knownRowHeight(view.state, this.row.from);
		if (known !== undefined) {
			root.classList.add('iw-row-pending');
			root.setCssProps({ '--iw-row-pending-height': `${known}px` });
		}
		const component = this.plugin.addChild(new Component());
		let alive = true;
		// The row this DOM shows: replaced in place by updateDOM.
		const current = { row: this.row };
		// Every height the row takes is reported on its line (row-height.ts), so
		// CodeMirror measures again and the line numbers stay aligned.
		let reported = -1;
		// Not during a resize gesture: in Obsidian a transaction while the row
		// changes height redraws the widget, which ends the gesture. The height
		// is reported once the gesture is over.
		let resizing = false;
		// Not before the row is drawn either: the empty widget's height differs
		// from the drawn row's. In Obsidian reporting it redraws the widget, which
		// reports the empty height again: the row was redrawn every frame (all
		// rows at once after a change of the defaults or enabling the plugin).
		// A new height is reported once: the redrawn row starts at it
		// (`iw-row-pending`) and reports the same, so it stops there.
		let drawn = false;
		const measure = () => {
			if (!alive || resizing || !drawn) return;
			view.requestMeasure();
			const box = root.getBoundingClientRect();
			const start = previewStart(view, root);
			// No width: not laid out (the editor hidden by Reading view or a tab in
			// the background, 0×0; moving to another window, 0×8 of padding). Not
			// a height: reporting it changed the line's attribute, and coming back
			// that redrew every row. The last real height stays reported.
			if (start === undefined || box.width === 0) return;
			const height = Math.round(box.height);
			if (height === reported) return;
			reported = height;
			view.dispatch({ effects: rowHeightEffect.of({ line: view.state.doc.lineAt(start).from, height }) });
		};
		// From the observer, on the next frame: a transaction inside its callback
		// changes the layout again in the same frame, which the browser reports
		// as "ResizeObserver loop completed with undelivered notifications".
		const win = windowOf(view.dom);
		let frame: number | undefined;
		const resize = new win.ResizeObserver(() => {
			if (frame === undefined) frame = win.requestAnimationFrame(() => { frame = undefined; measure(); });
		});
		resize.observe(root);
		component.register(() => {
			alive = false; resize.disconnect();
			if (frame !== undefined) win.cancelAnimationFrame(frame);
		});
		disposers.set(root, () => this.plugin.removeChild(component));
		// The paragraph laid out as a row, and the watch that keeps it so.
		let watched: HTMLElement | null = null;
		let unwatch: (() => void) | undefined;
		component.register(() => unwatch?.());
		// Source positions let the existing drag controller find these images.
		const annotate = () => {
			Array.from(watched?.children ?? []).forEach((embed, index) => {
				const image = current.row.images[index];
				if (image && embed.matches('.image-embed')) annotateImagePosition(embed as HTMLElement, image.from);
			});
			if (watched) ensureRowHandles(watched, current.row);
		};
		// Watches `paragraph` (none: stops watching), or the same one again for a
		// changed row (updateDOM).
		const watch = (paragraph: HTMLElement | null) => {
			unwatch?.();
			unwatch = undefined;
			watched = paragraph;
			if (paragraph) unwatch = watchRow(paragraph, current.row, annotate);
		};
		const rendering = MarkdownRenderer.render(this.plugin.app, this.markdown, root, this.path, component);
		// Obsidian inserts the paragraph at once and settles a frame later: laid
		// out now, a row drawn anew (moved up) never shows Obsidian's own layout
		// of its embeds for a frame. With a width still unknown applyRow leaves
		// the paragraph as it is, and the watch completes it.
		watch(root.querySelector('p'));
		void rendering.then(() => {
			if (!alive) return;
			const paragraph = root.querySelector('p');
			// Not there at once, or replaced since: watched now. The same one stays watched.
			if (paragraph !== watched) watch(paragraph);
			// A new width or new settings of the same images: laid out again here,
			// with no new rendering. Recreating the row made it vanish and come back
			// for a moment at every resize (and CodeMirror would redraw it twice).
			if (paragraph) updaters.set(root, (row, path) => {
				// Links resolve against the note: another note's row is drawn anew.
				if (!alive || path !== this.path || !sameImages(current.row, row)) return false;
				current.row = row;
				root.classList.toggle('mod-align-right', row.settings.align === 'right');
				previewTargets.set(root, { length: row.to - row.from, fallback: 0 });
				// The handles stay (a new one under the mouse would be a fresh hover
				// for Obsidian, and its tooltip would appear after the release;
				// only their edge follows the alignment.
				for (const handle of Array.from(paragraph.querySelectorAll(`.${ROW_HANDLE_CLASS}`))) handle.classList.toggle('mod-left', row.settings.align === 'right');
				watch(paragraph);
				return true;
			});
			// After the rendered content, so it never becomes the row's paragraph.
			createRowToolbar(root, view, this.plugin, this.getSettings);
			if (paragraph) {
				let cancelResize: (() => void) | undefined;
				component.registerDomEvent(root, 'pointerdown', event => {
					const cancel = startRowResize(event, root, paragraph, current.row, view, this.getSettings, () => { resizing = false; measure(); });
					if (cancel) { resizing = true; cancelResize = cancel; }
				});
				component.register(() => cancelResize?.());
			}
			drawn = true;
			root.classList.remove('iw-row-pending');
			measure();
		}).catch(() => {
			if (!alive) return;
			watch(null);
			root.textContent = this.markdown;
			drawn = true;
			root.classList.remove('iw-row-pending');
			measure();
		});
		return root;
	}
	// Events in the bar and on the resize handles belong to them: they must not
	// move the caret into the row.
	ignoreEvent(event: Event): boolean { return Boolean(eventElement(event)?.closest(`.${BLOCK_TOOLBAR_CLASS}, .${ROW_HANDLE_CLASS}`)); }
	// CodeMirror offers the DOM of the row this widget replaces: kept when only
	// sizes or settings changed (resize, the row bar, new defaults).
	updateDOM(dom: HTMLElement): boolean {
		return updaters.get(dom)?.(this.row, this.path) ?? false;
	}
	destroy(root: HTMLElement): void {
		disposers.get(root)?.();
		disposers.delete(root);
		updaters.delete(root);
		previewTargets.delete(root);
	}
}
