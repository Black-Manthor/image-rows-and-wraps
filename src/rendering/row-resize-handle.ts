import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { rowAtPosition } from '../markdown/row-actions';
import { REFERENCE_WIDTH, type ImageRow } from '../markdown/row-model';
import { rowDefaults, type ImageSettings } from '../settings';
import { applyRow, naturalWidth } from './row-layout';
import { rowHeightEffect } from './row-height';
import { composedWidths, resizedWidth, withWidth } from './row-resize';
import { previewStart } from './preview-dom';
import { notify } from '../ui/notify';
import { eventElement } from './preview-dom';
import { startGesture } from './pointer-gesture';
import { t } from '../i18n';

export const ROW_HANDLE_CLASS = 'iw-row-handle';

// One handle per image of the row, on the edge that moves: the left edge in a
// right-aligned row, the right edge otherwise.
export function ensureRowHandles(paragraph: HTMLElement, row: ImageRow): void {
	for (const embed of Array.from(paragraph.children) as HTMLElement[]) {
		if (!embed.matches('.internal-embed') || embed.querySelector(`:scope > .${ROW_HANDLE_CLASS}`)) continue;
		embed.createSpan({ cls: [ROW_HANDLE_CLASS, ...(row.settings.align === 'right' ? ['mod-left'] : [])],
			attr: { 'aria-label': t().resizeImage } });
	}
}

// The gesture works in the 700 px reference: the pointer changes the image's
// on-screen width, converted to its composed width, then to the desired width
// through the limits of row-resize.ts. The preview during the gesture is the
// exact composition that will be saved, so the release never jumps.
// `onEnd` runs once the gesture is over, whatever ends it.
export function startRowResize(event: PointerEvent, root: HTMLElement, paragraph: HTMLElement, row: ImageRow,
	view: EditorView, getSettings: () => ImageSettings, onEnd?: () => void): (() => void) | undefined {
	const handle = eventElement(event)?.closest<HTMLElement>(`.${ROW_HANDLE_CLASS}`);
	const embeds = Array.from(paragraph.children) as HTMLElement[];
	const index = handle ? embeds.indexOf(handle.parentElement as HTMLElement) : -1;
	if (!handle || index < 0 || event.button !== 0 || embeds.length !== row.images.length) return undefined;
	const widths = row.images.map((image, i) => image.width ?? naturalWidth(embeds[i]!));
	if (widths.some(width => width === undefined)) {
		notify(getSettings(), t().waitForImages);
		return undefined;
	}
	const known = widths as number[];
	const context = { widths: known, gap: row.settings.gap, index };
	const start = composedWidths(known, row.settings.gap)?.[index];
	const band = paragraph.getBoundingClientRect().width;
	if (start === undefined || !(band > 0)) return undefined;
	const scale = band / REFERENCE_WIDTH;
	const factor = row.settings.align === 'center' ? 2 : row.settings.align === 'right' ? -1 : 1;
	const startX = event.clientX;
	let width = known[index]!;
	const preview = (value: number) => applyRow(paragraph, { ...row,
		images: row.images.map((image, i) => ({ ...image, width: i === index ? value : known[i] })) });
	const follow = (x: number) => {
		const next = resizedWidth(context, (start * scale + factor * (x - startX)) / scale);
		if (next !== undefined && next !== width) { width = next; preview(width); }
	};
	// The common gesture base: Esc, the browser cancelling the pointer or the
	// window losing focus end it without saving; Obsidian's embeds are draggable,
	// and their native drag (which would cancel the gesture) is blocked.
	// The pressed handle alone shows its bar (styles.css); the body class gives
	// the cursor everywhere.
	handle.addClass('iw-resizing');
	return startGesture({ event, capture: handle, bodyClass: 'iw-row-resizing', onFrame: follow, onEnd: ({ commit, x }) => {
		handle.removeClass('iw-resizing');
		if (commit) follow(x);
		if (!commit || width === known[index]) applyRow(paragraph, row);
		else save(root, row, index, width, view, getSettings);
		onEnd?.();
	} });
}

// The row is looked up again at release: the saved link must be the same one.
function save(root: HTMLElement, row: ImageRow, index: number, width: number, view: EditorView, getSettings: () => ImageSettings): void {
	const position = previewStart(view, root);
	if (position === undefined) return;
	const current = rowAtPosition(view.state.doc.toString(), position, rowDefaults(getSettings()));
	const image = current?.images[index];
	if (!current || !image || current.images.length !== row.images.length || image.raw !== row.images[index]!.raw) {
		notify(getSettings(), t().rowChangedWhileResizing);
		return;
	}
	// The row's new height (the preview showed the final composition) goes with
	// the change: one transaction, so CodeMirror does not redraw the row twice.
	const height = Math.round(root.getBoundingClientRect().height);
	view.dispatch({ changes: { from: current.from + image.from, to: current.from + image.to, insert: withWidth(image.raw, width) },
		effects: rowHeightEffect.of({ line: current.from, height }),
		userEvent: 'input.iw-resize', annotations: isolateHistory.of('full') });
	// The keyboard back to the editor, for Undo; the caret does not move.
	view.focus();
}
