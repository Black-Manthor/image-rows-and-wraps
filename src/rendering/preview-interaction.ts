import { EditorSelection } from '@codemirror/state';
import { Component } from 'obsidian';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { eventElement, previewElement, previewPosition, previewStart, previewTargets } from './preview-dom';

export class PreviewInteraction {
	private lifecycle = new Component();
	private drag: { anchor: number; pointerId: number; x: number; y: number } | undefined;
	constructor(private view: EditorView) {
		this.lifecycle.load();
		const doc = view.dom.doc;
		this.lifecycle.registerDomEvent(doc, 'pointermove', event => {
			const drag = this.drag;
			if (!drag || drag.pointerId !== event.pointerId || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
			const position = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
			if (position === null) return;
			event.preventDefault();
			view.dispatch({ selection: EditorSelection.single(drag.anchor, position), scrollIntoView: true, userEvent: 'select.pointer' });
		});
		const stop = () => { this.drag = undefined; };
		this.lifecycle.registerDomEvent(doc, 'pointerup', stop);
		this.lifecycle.registerDomEvent(doc, 'pointercancel', stop);
		this.lifecycle.registerDomEvent(view.dom.win, 'blur', stop);
	}
	update(update: ViewUpdate) {
		if (this.drag && update.docChanged) this.drag.anchor = update.changes.mapPos(this.drag.anchor);
	}
	// `top`: where the clicked element is on screen, before its source replaces it.
	private hit(event: Event): { root: HTMLElement; position: number; top: number } | undefined {
		const target = eventElement(event);
		const root = target?.closest<HTMLElement>('.iw-preview, .iw-marker');
		if (!root || !this.view.contentDOM.contains(root)) return undefined;
		const hit = previewTargets.get(root);
		const start = hit ? previewStart(this.view, root) : undefined;
		if (!hit || start === undefined) return undefined;
		return { root, position: start + Math.max(0, Math.min(hit.length, previewPosition(target!, root, hit.fallback))),
			top: previewElement(target!, root).getBoundingClientRect().top };
	}
	pointerdown(event: PointerEvent): boolean {
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return false;
		// The row and wrap bars handle their own clicks.
		if (eventElement(event)?.closest('.iw-block-toolbar')) return false;
		// Image pointer gestures belong to the image controller (or native handling).
		if (eventElement(event)?.closest('.image-embed') && !event.shiftKey) return false;
		const hit = this.hit(event);
		if (!hit) return false;
		event.preventDefault();
		const anchor = event.shiftKey ? this.view.state.selection.main.anchor : hit.position;
		this.drag = { anchor, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
		// The clicked line stays where it was on screen. In the source a wrap's
		// text is below its image, not beside it: without this the clicked words
		// slid down by the image's height.
		const margin = Math.max(0, hit.top - this.view.scrollDOM.getBoundingClientRect().top);
		this.view.dispatch({ selection: EditorSelection.single(anchor, hit.position), userEvent: 'select.pointer',
			effects: EditorView.scrollIntoView(hit.position, { y: 'start', yMargin: margin }) });
		this.view.focus();
		return true;
	}
	keydown(event: KeyboardEvent): boolean {
		if (event.key !== 'Enter') return false;
		const hit = this.hit(event);
		if (!hit || event.target !== hit.root) return false;
		event.preventDefault();
		this.view.dispatch({ selection: { anchor: hit.position }, scrollIntoView: true, userEvent: 'select.keyboard' });
		this.view.focus();
		return true;
	}
	destroy() { this.drag = undefined; this.lifecycle.unload(); }
}

export const previewInteraction = ViewPlugin.fromClass(PreviewInteraction, { eventHandlers: {
	pointerdown(event) { return this.pointerdown(event); },
	keydown(event) { return this.keydown(event); },
} });
