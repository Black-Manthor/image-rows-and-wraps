import { pressedImages, imageFeedbackRefresh } from './image-gesture';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { parseDocument } from '../markdown/model';
import { imageAtElement } from './drag-target';
import { windowOf } from './preview-dom';
import { wrapModelField } from './wrap-state';

// Refresh after native embeds or region widgets finish rendering. Only child
// changes are observed: our own class changes never trigger another refresh.
export const imageFeedback = ViewPlugin.fromClass(class {
	private observer: MutationObserver;
	private frame: number | undefined;
	private win: Window;
	constructor(private view: EditorView) {
		this.win = view.dom.win;
		imageFeedbackRefresh.set(view, () => this.schedule());
		this.observer = new (windowOf(view.dom).MutationObserver)(() => this.schedule());
		this.observer.observe(view.contentDOM, { childList: true, subtree: true });
		this.schedule();
	}
	private schedule() {
		if (this.frame !== undefined) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = undefined;
			const live = Boolean(this.view.state.field(editorLivePreviewField, false));
			// The model is maintained per document change by wrapModelField.
			const model = this.view.state.field(wrapModelField, false) ?? parseDocument(this.view.state.doc.toString());
			const selection = this.view.state.selection.main;
			const pressed = pressedImages.get(this.view);
			for (const embed of Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>('.image-embed'))) {
				const image = live ? imageAtElement(this.view, embed, model) : undefined;
				embed.classList.toggle('iw-image-feedback', Boolean(image));
				embed.classList.toggle('iw-image-active', Boolean(image && (pressed !== undefined ? image.from === pressed : selection.from >= image.from && selection.to <= image.to)));
			}
		});
	}
	// Only what changes the marks: the text, the selection, source vs Live
	// Preview. Images coming on screen are seen by the observer, the pressed
	// image calls imageFeedbackRefresh; scrolling alone needs nothing.
	update(update: ViewUpdate) {
		if (update.docChanged || update.selectionSet ||
			update.state.field(editorLivePreviewField, false) !== update.startState.field(editorLivePreviewField, false)) this.schedule();
	}
	destroy() {
		imageFeedbackRefresh.delete(this.view);
		this.observer.disconnect();
		if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
		for (const embed of Array.from(this.view.contentDOM.querySelectorAll('.iw-image-feedback'))) {
			embed.classList.remove('iw-image-feedback', 'iw-image-active');
		}
	}
});
