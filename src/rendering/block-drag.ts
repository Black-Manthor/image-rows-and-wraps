import { isolateHistory } from '@codemirror/commands';
import type { StateEffect, Text } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import type { moveWrapBlock } from '../markdown/drag-image';
import { parseDocument, type DocumentModel } from '../markdown/model';
import type { ImageSettings } from '../settings';
import { resolveImageDrop } from './drag-target';
import { DropFeedback, type DropMark } from './drop-feedback';
import { wrapModelField } from './wrap-state';
import { previewStart } from './preview-dom';
import { carriedRowHeight } from './row-height';
import { notifyError } from '../ui/notify';
import { startGesture } from './pointer-gesture';
import { t } from '../i18n';

// How a block moves: moveWrapBlock or moveRowBlock (drag-image.ts), and the
// message for a drop inside a wrap. `keepFollowing`: moved down, the view keeps
// still what follows the destination instead of the moved block (rows and wraps).
// `carryHeight`: moved up, the block, drawn anew, takes its known height to its
// new line in the same transaction (rows, row-height.ts); moving down CodeMirror
// keeps its DOM.
type Move = NonNullable<ReturnType<typeof moveWrapBlock>>;
export interface BlockMove {
	move: (source: string, from: number, insertion: number, model: DocumentModel) => Move | undefined;
	intoWrap: string;
	keepFollowing?: boolean;
	carryHeight?: boolean;
}

// The start of the first line with text at or after `position` (a line start,
// or the end of the note): what follows a drop there. None at the end of the note.
function followingStart(doc: Text, position: number): number | undefined {
	let line = doc.lineAt(position);
	if (line.from < position) {
		if (line.number === doc.lines) return undefined;
		line = doc.line(line.number + 1);
	}
	for (;;) {
		if (line.text.trim()) return line.from;
		if (line.number === doc.lines) return undefined;
		line = doc.line(line.number + 1);
	}
}

// The move in progress of each editor. It belongs to the editor, not to the
// moved block's widget: scrolling far from the block, CodeMirror drops that
// widget and may draw it again later, and the move must go on. It ends with a
// change of note or mode, or with the editor (`blockMoves`), like the drag of
// an image; a change of the text meanwhile is refused at the drop.
const moves = new WeakMap<EditorView, () => void>();

export const blockMoves = ViewPlugin.define(view => ({
	update(update: ViewUpdate) {
		if (!update.state.field(editorLivePreviewField, false) ||
			update.state.field(editorInfoField, false)?.file !== update.startState.field(editorInfoField, false)?.file) moves.get(view)?.();
	},
	destroy() { moves.get(view)?.(); },
}));

// Moving a whole block (a wrap or a row of images) with the handle in its bar.
// It goes between two blocks, never inside a wrap, a list or code; over a row
// of images, before or after it. The gesture is the common base
// (pointer-gesture.ts): nothing is sent to the editor before the release.
export function startBlockDrag(event: PointerEvent, root: HTMLElement, handle: HTMLElement, view: EditorView,
	getSettings: () => ImageSettings, block: BlockMove): void {
	if (event.button !== 0) return;
	const blockFrom = previewStart(view, root);
	if (blockFrom === undefined) return;
	moves.get(view)?.();
	const doc = root.doc;
	const source = view.state.doc.toString();
	const model = view.state.field(wrapModelField, false) ?? parseDocument(source);
	const feedback = new DropFeedback(doc);

	const destination = (x: number, y: number): { mark: DropMark; changes: Move['changes']; start: Move['cursor']; position: number } | undefined => {
		if (view.state.doc.toString() !== source) throw new Error(t().noteChangedMoveCancelled);
		const found = doc.elementFromPoint(x, y);
		const element = found?.instanceOf(HTMLElement) ? found : null;
		// Over itself, perhaps drawn again meanwhile: nothing moves.
		const over = element?.closest<HTMLElement>('.iw-preview');
		if (over && (over === root || previewStart(view, over) === blockFrom)) return undefined;
		let resolved: ReturnType<typeof resolveImageDrop>;
		try { resolved = resolveImageDrop(view, x, y, model); } catch (error) {
			throw error instanceof Error && error.message === t().imageIntoWrap ? new Error(block.intoWrap) : error;
		}
		let position: number;
		let mark: DropMark = resolved;
		if (resolved.drop.kind === 'row') {
			// A row is a block: the moved block goes before or after it.
			const line = view.state.doc.lineAt(resolved.drop.row);
			const box = (element?.closest('.iw-row-preview') ?? element?.closest('.cm-line') ?? element)?.getBoundingClientRect() ?? resolved.rect;
			const content = view.contentDOM.getBoundingClientRect();
			const after = y > (box.top + box.bottom) / 2;
			position = after ? Math.min(line.to + 1, view.state.doc.length) : line.from;
			mark = { rect: { left: content.left, right: content.right, top: box.top, bottom: box.bottom }, vertical: false, after };
		} else position = resolved.drop.position;
		const edit = block.move(source, blockFrom, position, model);
		return edit && { mark, changes: edit.changes, start: edit.cursor, position };
	};
	const show = (x: number, y: number) => {
		try {
			const result = destination(x, y);
			if (result) feedback.show(result.mark); else feedback.clear();
		} catch (error) {
			feedback.reject(error instanceof Error ? error.message : t().dropNotAllowed, x, y);
		}
	};
	// Ended by the editor (`blockMoves`): it may be in the middle of an update,
	// or gone, so it is left alone.
	let ending = false;
	const stop = () => { ending = true; cancel(); };
	// The handle may leave the page with its block: the scroller takes the pointer.
	const cancel = startGesture({ event, capture: handle, recapture: view.scrollDOM, threshold: 4, scroller: view.scrollDOM, bodyClass: 'iw-block-moving',
		onFrame: show, onEnd: ({ commit, moved, x, y }) => {
			if (moves.get(view) === stop) moves.delete(view);
			feedback.clear();
			if (ending) return;
			// The keyboard back to the editor, for Undo; the caret does not move.
			view.focus();
			if (!commit || !moved) return;
			try {
				const result = destination(x, y);
				// Its own undo step. The caret stays where it was, so the block stays
				// drawn; the view follows the drop, not the caret (which may be anywhere
				// in the note). Only the jump of the drop itself is corrected: the scroll
				// the gesture reached at the edge stays.
				if (!result) return;
				const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
				// Moved down: what follows the destination keeps its place on screen
				// and the content in between moves up. Keeping the block where it was
				// dropped scrolled the whole view by the block's height.
				const next = block.keepFollowing && result.position > blockFrom ? followingStart(view.state.doc, result.position) : undefined;
				let effect: StateEffect<unknown>;
				if (next !== undefined) {
					const top = view.coordsAtPos(next)?.top ?? view.lineBlockAt(next).top + view.documentTop;
					effect = EditorView.scrollIntoView(result.changes.mapPos(next, 1), { y: 'start', yMargin: Math.max(0, top - scrollerTop) });
				} else {
					// The moved block where it was dropped. Moving up, this keeps still
					// what precedes the destination; at the end of the note, where nothing
					// follows, what is on screen (with no scroll at all it moved up by the
					// block's height).
					const mark = result.mark.after ? result.mark.rect.bottom : result.mark.rect.top;
					effect = EditorView.scrollIntoView(result.start, { y: 'start', yMargin: Math.max(0, mark - scrollerTop) });
				}
				const height = block.carryHeight && result.position < blockFrom ? carriedRowHeight(view.state, blockFrom, result.start) : [];
				view.dispatch({ changes: result.changes, userEvent: 'move.block', annotations: isolateHistory.of('full'), effects: [effect, ...height] });
			} catch (error) {
				notifyError(getSettings(), error, t().moveCancelled);
			}
		} });
	moves.set(view, stop);
}
