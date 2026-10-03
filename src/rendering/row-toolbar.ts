import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { type Plugin } from 'obsidian';
import { rowAtPosition, rowSettingsAction } from '../markdown/row-actions';
import type { RowSettings } from '../markdown/row-model';
import { rowDefaults, type ImageSettings } from '../settings';
import { openRowSettingMenu, type RowSettingKind } from '../ui/row-settings';
import { moveRowBlock } from '../markdown/drag-image';
import { startBlockDrag } from './block-drag';
import { createBlockToolbar } from './block-toolbar';
import { previewStart } from './preview-dom';
import { applyRow } from './row-layout';
import { rowHeightEffect } from './row-height';
import { notify, notifyError } from '../ui/notify';
import { t } from '../i18n';

const ROW_TOOLBAR_CLASS = 'iw-row-toolbar';

const BUTTONS: Array<[RowSettingKind, string, 'rowAlignBar' | 'rowValignBar' | 'rowGapBar']> = [
	['align', 'iw-row-align', 'rowAlignBar'],
	['valign', 'iw-row-valign', 'rowValignBar'],
	['gap', 'iw-row-gap', 'rowGapBar'],
];

// The row's bar (block-toolbar.ts): a handle that moves the whole row (with
// its comment) like the wrap's, then one button per setting. Each setting opens
// a menu; a choice is one undoable change of the row comment. The row is looked
// up at click time from the widget's position, and checked again when the
// choice is made. A move in progress belongs to the editor (block-drag.ts), not
// to this widget: it goes on when the widget is dropped while scrolling.
export function createRowToolbar(root: HTMLElement, view: EditorView, plugin: Plugin, getSettings: () => ImageSettings): HTMLElement {
	const handle = { icon: 'iw-wrap-move', label: t().moveRow, cls: 'mod-move',
		press: (event: PointerEvent, button: HTMLButtonElement) =>
			startBlockDrag(event, root, button, view, getSettings, { move: moveRowBlock, intoWrap: t().rowIntoWrap, keepFollowing: true, carryHeight: true }) };
	return createBlockToolbar(root, ROW_TOOLBAR_CLASS, t().rowToolbar, [handle, ...BUTTONS.map(([kind, icon, label]) => ({ icon, label: t()[label], action: (button: HTMLButtonElement) => {
		const settings = getSettings();
		const defaults = rowDefaults(settings);
		const position = previewStart(view, root);
		if (position === undefined) return;
		const doc = view.state.doc;
		const row = rowAtPosition(doc.toString(), position, defaults);
		if (!row) return;
		const expected = doc.sliceString(row.from, row.to);
		const rect = button.getBoundingClientRect();
		openRowSettingMenu(plugin.app, kind, { x: rect.left, y: rect.bottom }, row.settings, defaults, patch => {
			// The menu stays open while the note may change (sync, other panes):
			// find the row again, then check it is still the same text.
			let now = position;
			if (view.state.doc !== doc) {
				now = previewStart(view, root) ?? -1;
				if (!root.isConnected || now < 0) { notify(settings, t().rowChangedWhileChoosing); return; }
			}
			apply(view, root, now, patch, defaults, settings, expected);
		});
	} }))]);
}

function apply(view: EditorView, root: HTMLElement, position: number, patch: Partial<RowSettings>, defaults: RowSettings,
	settings: ImageSettings, expected: string): void {
	try {
		const source = view.state.doc.toString();
		const edit = rowSettingsAction(source, position, patch, defaults, expected);
		if (view.state.sliceDoc(edit.from, edit.to) === edit.text) return;
		// The row shown laid out with the new settings first, and its new height
		// sent with the change (as a resize does): a height reported afterwards
		// redraws the row in Obsidian, which showed as a jump (a new gap).
		const next = rowAtPosition(source.slice(0, edit.from) + edit.text + source.slice(edit.to), position, defaults);
		const paragraph = root.querySelector<HTMLElement>('p.iw-row');
		const laidOut = next && paragraph && root.isConnected && applyRow(paragraph, next);
		const effects = laidOut ? [rowHeightEffect.of({ line: next.from, height: Math.round(root.getBoundingClientRect().height) })] : [];
		// Its own undo step, even right after another choice.
		view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.text }, effects, userEvent: 'input.iw-row',
			annotations: isolateHistory.of('full') });
		// The keyboard back to the editor, for Undo; the caret does not move.
		view.focus();
	} catch (error) {
		notifyError(settings, error, t().cannotChangeRow);
	}
}
