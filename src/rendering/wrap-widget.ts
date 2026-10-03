import { WidgetType, type EditorView } from '@codemirror/view';
import { Component, MarkdownRenderer, type Plugin } from 'obsidian';
import { annotateImagePosition, annotateBlocks, eventElement, previewTargets, registerPreviewSource, remapPreviewPositions, windowOf } from './preview-dom';
import { remeasureEffect, type WrapSnapshot } from './wrap-state';
import { layoutWrapContent, wrapContainerClasses } from './image-layout';
import { parseDocument } from '../markdown/model';
import type { ImageSettings } from '../settings';
import { BLOCK_TOOLBAR_CLASS } from './block-toolbar';
import { createWrapToolbar } from './wrap-toolbar';
import { WRAP_HANDLE_CLASS, ensureWrapHandle, startWrapResize } from './wrap-resize';
import { t } from '../i18n';

const mounts = new WeakMap<HTMLElement, Component>();
// A drawn wrap updates itself in place when only its side or the size of its
// image changed (see updateDOM).
const updaters = new WeakMap<HTMLElement, (snapshot: WrapSnapshot, sourcePath: string) => boolean>();

const SIZE = /^(\d+)(?:x(\d+))?$/;

// The new size of the wrap's image (its first line) when that is all that
// differs between the two texts; undefined when anything else changed.
function imageSizeChange(before: string, after: string): { width?: string; height?: string } | undefined {
	const a = parseDocument(before).images[0], b = parseDocument(after).images[0];
	if (!a || !b || a.from !== 0 || b.from !== 0 || before.slice(a.to) !== after.slice(b.to) || a.path !== b.path) return undefined;
	const params = (raw: string) => raw.slice(3, -2).split('|').slice(1).map(param => param.trim());
	const others = (raw: string) => params(raw).filter(param => !SIZE.test(param)).join('|');
	if (others(a.raw) !== others(b.raw)) return undefined;
	const size = params(b.raw).map(param => SIZE.exec(param)).find(Boolean);
	return { ...(size?.[1] ? { width: size[1] } : {}), ...(size?.[2] ? { height: size[2] } : {}) };
}

export class WrapWidget extends WidgetType {
	constructor(readonly snapshot: WrapSnapshot, private sourcePath: string, private plugin: Plugin,
		private getSettings: () => ImageSettings) { super(); }
	eq(other: WrapWidget): boolean {
		// Shape, not place: offsets inside the widget are relative to its start.
		// The form counts too: text typed against a marker makes the wrap compact
		// without changing it, and the bar then offers the fix.
		const a = this.snapshot, b = other.snapshot;
		return a.to - a.from === b.to - b.from && a.contentFrom - a.from === b.contentFrom - b.from &&
			a.markdown === b.markdown && a.side === b.side && a.compact === b.compact && this.sourcePath === other.sourcePath;
	}
	toDOM(view: EditorView): HTMLElement {
		// Not attached yet: made in the editor's own document (pop-out windows).
		const root = view.dom.doc.createElement('div');
		root.addClass('iw-preview');
		// What this DOM shows: replaced in place by updateDOM.
		const current = { snapshot: this.snapshot, images: parseDocument(this.snapshot.markdown).images, contentOffset: 0 };
		root.classList.add(...wrapContainerClasses(this.snapshot.markdown, this.snapshot.side));
		root.tabIndex = 0;
		root.setAttribute('aria-label', t().wrapPreview);
		// `markdown-rendered`: Obsidian and the theme style rendered Markdown
		// (quotes, code, tables, lists, margins) only inside it, as in Reading
		// view; without it the browser's defaults apply.
		const content = root.createDiv({ cls: ['iw-preview-content', 'markdown-rendered'] });
		// Source positions of this snapshot: offsets from the widget's start.
		const locate = () => {
			const { snapshot } = current;
			current.contentOffset = snapshot.contentFrom - snapshot.from;
			previewTargets.set(root, { length: snapshot.to - snapshot.from, fallback: current.contentOffset });
			registerPreviewSource(content, snapshot.markdown, current.contentOffset);
		};
		locate();
		const component = this.plugin.addChild(new Component());
		// After the content, out of the layout: move, change side, remove.
		createWrapToolbar(root, view, this.getSettings, this.snapshot.compact);
		mounts.set(root, component);
		let alive = true;
		let drawn = false;
		// A bare requestMeasure(), called from outside any transaction (as this
		// ResizeObserver callback is), can leave CodeMirror's gutter stale, and
		// an empty dispatch({}) does not recompute the decorations. A dedicated
		// effect forces the same recompute a click does, without re-asserting
		// the selection: that would interrupt input composition in progress.
		// Once per frame, and only for a new height: class changes and loads
		// inside the widget arrive in bursts, and each dispatch rebuilds every
		// decoration of the note.
		const win = windowOf(view.dom);
		let frame: number | undefined;
		let reported = -1;
		// Not during a resize of the image: a transaction then could redraw the
		// widget and end the gesture. Reported once it is over.
		let resizing = false;
		const measure = () => {
			if (!alive || resizing || frame !== undefined) return;
			frame = win.requestAnimationFrame(() => {
				frame = undefined;
				if (!alive) return;
				const height = Math.round(root.getBoundingClientRect().height);
				if (height === reported) return;
				reported = height;
				view.requestMeasure();
				view.dispatch({ effects: remeasureEffect.of(null) });
			});
		};
		const refresh = () => {
			if (!alive) return;
			const { snapshot, images, contentOffset } = current;
			annotateBlocks(content);
			layoutWrapContent(content, snapshot.side);
			const embeds = Array.from(content.querySelectorAll('.image-embed'));
			if (embeds.length === images.length) embeds.forEach((embed, index) => {
				annotateImagePosition(embed as HTMLElement, contentOffset + images[index]!.from);
			});
			// The wrap's own image (layoutWrapContent gave it the side) gets the resize handle.
			const image = content.querySelector<HTMLElement>(`.image-embed.${snapshot.side}`);
			if (image) ensureWrapHandle(image, snapshot.side);
			measure();
		};
		const observer = new win.MutationObserver(() => refresh());
		observer.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'src', 'width'] });
		const resize = new win.ResizeObserver(() => measure());
		resize.observe(root);
		component.register(() => {
			alive = false; observer.disconnect(); resize.disconnect();
			if (frame !== undefined) win.cancelAnimationFrame(frame);
		});
		component.registerDomEvent(content, 'load', () => refresh(), true);
		let cancelResize: (() => void) | undefined;
		component.registerDomEvent(root, 'pointerdown', event => {
			const cancel = startWrapResize(event, root, content, view, current.snapshot.side, this.getSettings, () => { resizing = false; measure(); });
			if (cancel) { resizing = true; cancelResize = cancel; }
		});
		component.register(() => cancelResize?.());
		// Only the image's size or the side changed (the handle, the bar): the wrap
		// stays as it is drawn, and the text flows around the new image by itself.
		updaters.set(root, (next, sourcePath) => {
			const before = current.snapshot;
			// The bar depends on the form: a wrap fixed or made compact is drawn anew.
			if (!alive || !drawn || sourcePath !== this.sourcePath || next.compact !== before.compact) return false;
			const size = before.markdown === next.markdown ? null : imageSizeChange(before.markdown, next.markdown);
			if (size === undefined) return false;
			const image = content.querySelector<HTMLElement>(`.image-embed.${before.side}`);
			if (!image) return false;
			if (next.side !== before.side) {
				image.classList.remove(before.side);
				image.querySelector(`:scope > .${WRAP_HANDLE_CLASS}`)?.remove();
				root.classList.remove(...wrapContainerClasses(before.markdown, before.side));
				root.classList.add(...wrapContainerClasses(next.markdown, next.side));
			}
			if (size) for (const element of [image, image.querySelector('img')]) {
				if (!element) continue;
				for (const name of ['width', 'height'] as const) {
					const value = size[name];
					if (value) element.setAttribute(name, value); else element.removeAttribute(name);
				}
			}
			// Only the header (the side) and the image link can change length:
			// the text keeps its place relative to them.
			const header = (next.contentFrom - next.from) - current.contentOffset;
			const imageEnd = current.contentOffset + (current.images[0]?.to ?? 0);
			const link = next.markdown.length - before.markdown.length;
			remapPreviewPositions(content, position => position + header + (position >= imageEnd ? link : 0));
			current.snapshot = next;
			current.images = parseDocument(next.markdown).images;
			locate();
			refresh();
			return true;
		});
		void MarkdownRenderer.render(this.plugin.app, this.snapshot.markdown, content, this.sourcePath, component)
			.then(() => { drawn = true; refresh(); }).catch(() => {
				if (!alive) return;
				content.textContent = this.snapshot.markdown;
				content.classList.add('iw-preview-fallback');
				root.setAttribute('aria-label', t().previewUnavailable);
				measure();
			});
		return root;
	}
	// Events in the bar and on the resize handle belong to them: they must not
	// move the caret into the wrap.
	ignoreEvent(event: Event): boolean { return Boolean(eventElement(event)?.closest(`.${BLOCK_TOOLBAR_CLASS}, .${WRAP_HANDLE_CLASS}`)); }
	// CodeMirror offers the DOM of the wrap this widget replaces: kept when only
	// the side or the size of the image changed.
	updateDOM(dom: HTMLElement): boolean {
		return updaters.get(dom)?.(this.snapshot, this.sourcePath) ?? false;
	}
	destroy(root: HTMLElement): void {
		const component = mounts.get(root);
		if (component) this.plugin.removeChild(component);
		mounts.delete(root);
		updaters.delete(root);
		previewTargets.delete(root);
	}
}

// Keep both delimiters visible while another line is edited. A delimiter under
// the selection is ordinary source; clicking its label moves the caret into it.
export class MarkerWidget extends WidgetType {
	constructor(readonly from: number, readonly to: number, private text: string) { super(); }
	eq(other: MarkerWidget): boolean { return this.to - this.from === other.to - other.from && this.text === other.text; }
	toDOM(view: EditorView): HTMLElement {
		const span = view.dom.doc.createElement('span');
		span.addClass('iw-marker');
		span.textContent = this.text;
		previewTargets.set(span, { length: this.to - this.from, fallback: 0 });
		return span;
	}
	ignoreEvent(): boolean { return false; }
	destroy(root: HTMLElement): void { previewTargets.delete(root); }
}
