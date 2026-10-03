import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { parseDocument, regionAt, wrapImage } from '../markdown/model';
import type { ImageSettings } from '../settings';
import { notify } from '../ui/notify';
import { DropFeedback } from './drop-feedback';
import { startGesture } from './pointer-gesture';
import { eventElement, previewStart } from './preview-dom';
import { withWidth } from './row-resize';
import { t } from '../i18n';

// Resizing the image of a wrap in Live Preview, with a handle on its edge
// toward the text. The width saved in the link (`|W`, or `|WxH` in proportion)
// stays within «Larghezza massima dell'immagine» of the column as it is during
// the gesture; asking for more stops at the limit and says why, next to the
// pointer, only while it lasts.

export const WRAP_HANDLE_CLASS = 'iw-wrap-handle';
export const MIN_WRAP_WIDTH = 50;

// The width for a pointer moved by `delta` px from `start`, between the minimum
// and `maxPercent` of the column; `over` when the pointer asks for more.
export function wrapResizeWidth(start: number, delta: number, column: number, maxPercent: number,
	min = MIN_WRAP_WIDTH): { width: number; over: boolean } {
	const max = Math.max(min, Math.floor(column * maxPercent / 100));
	const wanted = start + delta;
	return { width: Math.round(Math.min(max, Math.max(min, wanted))), over: wanted > max };
}


// One handle, on the edge that moves: the right one for an image on the left.
export function ensureWrapHandle(embed: HTMLElement, side: 'iw-left' | 'iw-right'): void {
	if (embed.querySelector(`:scope > .${WRAP_HANDLE_CLASS}`)) return;
	embed.createSpan({ cls: [WRAP_HANDLE_CLASS, ...(side === 'iw-right' ? ['mod-left'] : [])],
		attr: { 'aria-label': t().resizeImage } });
}

// The link the wrap at `root` is laid out with, read from the editor now.
function wrapLink(view: EditorView, root: HTMLElement) {
	const start = previewStart(view, root);
	if (start === undefined) return undefined;
	const model = parseDocument(view.state.doc.toString());
	const region = regionAt(model, start);
	return region ? wrapImage(model, region) : undefined;
}

// Starts the gesture when `event` is on a wrap handle; `onEnd` runs once it is
// over, whatever ends it. Returns the cancel function, for the widget's cleanup.
export function startWrapResize(event: PointerEvent, root: HTMLElement, content: HTMLElement, view: EditorView,
	side: 'iw-left' | 'iw-right', getSettings: () => ImageSettings, onEnd?: () => void): (() => void) | undefined {
	const handle = eventElement(event)?.closest<HTMLElement>(`.${WRAP_HANDLE_CLASS}`);
	const embed = handle?.parentElement;
	if (!handle || !embed || event.button !== 0) return undefined;
	const link = wrapLink(view, root);
	const start = embed.getBoundingClientRect().width;
	const column = content.getBoundingClientRect().width;
	if (!link || !(start > 0) || !(column > 0)) return undefined;
	const settings = getSettings();
	const direction = side === 'iw-right' ? -1 : 1;
	const feedback = new DropFeedback(root.doc);
	let width = Math.round(start);
	const show = (x: number, y: number) => {
		const next = wrapResizeWidth(start, direction * (x - event.clientX), column, settings.wrapMaxPercent);
		width = next.width;
		// A variable styles.css applies to the image while the handle is pressed.
		embed.setCssProps({ '--iw-resize-width': `${width}px` });
		if (next.over) feedback.reject(t().wrapLimit(settings.wrapMaxPercent), x, y); else feedback.clear();
	};
	// The starting width first: with `iw-resizing` alone the image would fill
	// its maximum until the first move.
	embed.setCssProps({ '--iw-resize-width': `${width}px` });
	embed.addClass('iw-resizing');
	return startGesture({ event, capture: handle, bodyClass: 'iw-wrap-resizing', onFrame: show, onEnd: ({ commit, x, y }) => {
		if (commit) show(x, y);
		feedback.clear();
		embed.removeClass('iw-resizing');
		embed.setCssProps({ '--iw-resize-width': '' });
		if (commit && width !== Math.round(start)) save(view, root, link.raw, width, settings);
		onEnd?.();
	} });
}

// The link is looked up again at release: it must still be the same one.
function save(view: EditorView, root: HTMLElement, raw: string, width: number, settings: ImageSettings): void {
	const image = wrapLink(view, root);
	if (!image || image.raw !== raw) {
		notify(settings, t().wrapChangedWhileResizing);
		return;
	}
	view.dispatch({ changes: { from: image.from, to: image.to, insert: withWidth(image.raw, width) },
		userEvent: 'input.iw-resize', annotations: isolateHistory.of('full') });
	// The keyboard back to the editor, for Undo; the caret does not move.
	view.focus();
}
