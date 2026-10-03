import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { Edit } from '../markdown/edits';
import { fixWrap, removeWrap, toggleWrapSide } from '../markdown/wrap-actions';
import { moveWrapBlock } from '../markdown/drag-image';
import type { ImageSettings } from '../settings';
import { createBlockToolbar } from './block-toolbar';
import { startBlockDrag } from './block-drag';
import { previewStart } from './preview-dom';
import { notifyError } from '../ui/notify';
import { t } from '../i18n';

// The wrap's own bar: move it (a handle, dragged), change side, remove it; on a
// compact wrap (a marker touching the text) also fix its form, first. The wrap
// is looked up at click time from the widget's position; each action is one
// undoable edit. A move in progress belongs to the editor (block-drag.ts), not
// to this widget: it goes on when the widget is dropped while scrolling.
export function createWrapToolbar(root: HTMLElement, view: EditorView, getSettings: () => ImageSettings,
	compact = false): HTMLElement {
	const run = (edit: (source: string, position: number) => Edit, userEvent: string) => {
		const position = previewStart(view, root);
		if (position === undefined) return;
		try {
			const change = edit(view.state.doc.toString(), position);
			// Its own undo step, even right after another click.
			view.dispatch({ changes: { from: change.from, to: change.to, insert: change.text }, userEvent,
				annotations: isolateHistory.of('full') });
			// The keyboard back to the editor (the button had it): Undo works at once.
			// The caret stays where it was, outside the wrap.
			view.focus();
		} catch (error) {
			notifyError(getSettings(), error, t().cannotChangeWrap);
		}
	};
	const fix = { icon: 'iw-wrap-separate', label: t().fixWrap, cls: 'mod-fix',
		action: () => run((source, position) => fixWrap(source, position), 'input.iw-wrap-format') };
	const bar = createBlockToolbar(root, 'iw-wrap-toolbar', t().wrapToolbar, [
		...(compact ? [fix] : []),
		{ icon: 'iw-wrap-move', label: t().moveWrap, cls: 'mod-move',
			press: (event, button) => startBlockDrag(event, root, button, view, getSettings, { move: moveWrapBlock, intoWrap: t().wrapIntoWrap, keepFollowing: true }) },
		{ icon: 'iw-wrap-toggle', label: t().commands['toggle-wrap-side'],
			action: () => run((source, position) => toggleWrapSide(source, position, position), 'input.iw-wrap-side') },
		{ icon: 'iw-remove-wrap', label: t().commands['remove-wrap'],
			action: () => run((source, position) => removeWrap(source, position, position), 'delete.iw-wrap') },
	]);
	if (compact) bar.addClass('mod-compact');
	return bar;
}
