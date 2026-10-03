import { setPressedImage } from './image-gesture';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { Component, editorInfoField, editorLivePreviewField } from 'obsidian';
import { moveDraggedImage } from '../markdown/drag-image';
import { parseDocument, type DocumentModel } from '../markdown/model';
import type { ImageSettings } from '../settings';
import { imageAtElement, resolveImageDrop } from './drag-target';
import { wrapModelField } from './wrap-state';
import { DropFeedback } from './drop-feedback';
import { notifyError } from '../ui/notify';
import { eventElement } from './preview-dom';
import { startGesture, type GestureEnd } from './pointer-gesture';
import { t } from '../i18n';

// Dragging an image in Live Preview (drag-image.ts composes the move). The
// gesture itself is the common base (pointer-gesture.ts), exclusive: while an
// image is pressed no other listener gets the pointer, so CodeMirror starts no
// selection and Obsidian no native drag. A press without a move is a click
// that enters the Markdown at the image. A drag started from a drawn row or
// wrap leaves the Markdown closed: the caret stays where it was (carried along
// by the edit), wherever the image goes; started from open Markdown, the caret
// follows the image.
export class ImageDragController {
	private life = new Component();
	private pending: { from: number; source: string; model: DocumentModel; file: unknown; fromPreview: boolean; stop: () => void } | undefined;
	private dropFeedback: DropFeedback;
	private suppressClick = false;
	private clickTimer: number | undefined;
	constructor(private view: EditorView, private getSettings: () => ImageSettings) {
		this.life.load();
		const doc = view.dom.doc;
		this.dropFeedback = new DropFeedback(doc);
		this.life.registerDomEvent(view.contentDOM, 'pointerdown', event => this.down(event), true);
		// The click that follows a release belongs to the gesture, not to the editor.
		this.life.registerDomEvent(doc, 'click', event => {
			if (this.suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); this.suppressClick = false; }
		}, true);
	}
	private down(event: PointerEvent): void {
		if (event.defaultPrevented || this.pending || !this.getSettings().dragImages || !this.view.state.field(editorLivePreviewField, false) ||
			event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.pointerType === 'touch') return;
		const target = eventElement(event);
		if (target?.tagName !== 'IMG') return;
		const rect = target.getBoundingClientRect();
		// Leave the resize edge and handles to Obsidian/integrations.
		if (event.clientX > rect.right - 8 || event.clientY > rect.bottom - 8) return;
		// The model of the current text is kept by wrapModelField: no parse here.
		const source = this.view.state.doc.toString();
		const model = this.view.state.field(wrapModelField, false) ?? parseDocument(source);
		const image = imageAtElement(this.view, target, model);
		if (!image) return;
		event.stopImmediatePropagation();
		// The source is frozen for the whole gesture.
		const file = this.view.state.field(editorInfoField, false)?.file;
		setPressedImage(this.view, image.from);
		// Decided now: at the release the DOM under the pointer may have changed.
		const pending = { from: image.from, source, model, file, fromPreview: Boolean(target.closest('.iw-preview')), stop: () => {} };
		this.pending = pending;
		// Moving, not resizing: the row handles step aside until release (bodyClass).
		pending.stop = startGesture({ event, capture: target, doc: this.view.dom.doc, win: this.view.dom.win,
			threshold: 6, scroller: this.view.scrollDOM, bodyClass: 'iw-image-dragging', exclusive: true,
			onFrame: (x, y) => this.feedback(x, y), onEnd: end => this.end(end) });
	}
	private destination(x: number, y: number) {
		const p = this.pending!;
		if (!this.getSettings().dragImages || p.source !== this.view.state.doc.toString() || p.file !== this.view.state.field(editorInfoField, false)?.file) {
			throw new Error(t().dragCancelled);
		}
		const target = resolveImageDrop(this.view, x, y, p.model);
		return { target, edit: moveDraggedImage(p.source, p.from, target.drop, p.model) };
	}
	// Once per frame, for the last pointer position.
	private feedback(x: number, y: number): void {
		if (!this.pending) return;
		try {
			const { target, edit } = this.destination(x, y);
			if (edit) this.dropFeedback.show(target); else this.dropFeedback.clear();
		} catch (error) {
			this.dropFeedback.reject(error instanceof Error ? error.message : t().dropNotAllowed, x, y);
		}
	}
	private end({ commit, moved, x, y }: GestureEnd): void {
		const p = this.pending;
		if (p && commit) {
			try {
				if (moved) {
					const { edit } = this.destination(x, y);
					// From a drawn row or wrap the caret is not moved into the image:
					// that would open its Markdown, and the view would follow it.
					const caret = p.fromPreview ? {} : { selection: { anchor: edit?.cursor ?? p.from }, scrollIntoView: Boolean(edit) };
					if (edit) this.view.dispatch({ changes: edit.changes, annotations: isolateHistory.of('full'), userEvent: 'move.image', ...caret });
					else if (!p.fromPreview) this.view.dispatch(caret);
				} else if (p.source === this.view.state.doc.toString()) this.view.dispatch({ selection: { anchor: p.from }, scrollIntoView: true });
				this.view.focus();
			} catch (error) {
				if (p.source === this.view.state.doc.toString() && p.file === this.view.state.field(editorInfoField, false)?.file &&
					this.view.state.field(editorLivePreviewField, false)) {
					if (!p.fromPreview) this.view.dispatch({ selection: { anchor: p.from } });
					this.view.focus();
				}
				notifyError(this.getSettings(), error, t().moveCancelled);
			} finally {
				this.suppressClick = true;
				const win = this.view.dom.win;
				if (this.clickTimer !== undefined) win.clearTimeout(this.clickTimer);
				this.clickTimer = win.setTimeout(() => { this.suppressClick = false; this.clickTimer = undefined; }, 0);
			}
		}
		this.pending = undefined;
		setPressedImage(this.view, undefined);
		this.dropFeedback.clear();
	}
	// Esc, the window losing focus and the browser cancelling end the gesture
	// in the base; a change of note, document or mode ends it here.
	private cancel() { this.pending?.stop(); }
	update(update: ViewUpdate) {
		if (update.docChanged || !update.state.field(editorLivePreviewField, false) ||
			update.state.field(editorInfoField, false)?.file !== update.startState.field(editorInfoField, false)?.file) this.cancel();
	}
	destroy() {
		this.cancel();
		if (this.clickTimer !== undefined) this.view.dom.win.clearTimeout(this.clickTimer);
		this.life.unload();
	}
}

export function imageDrag(getSettings: () => ImageSettings) {
	return ViewPlugin.define(view => new ImageDragController(view, getSettings));
}
