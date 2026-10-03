import type { RowAction } from './markdown/row-actions';
import type { Strings } from './i18n';

export type CommandId = keyof Strings['commands'];

export type Action = RowAction | 'center' | 'add-wrap' | 'toggle-wrap-side' | 'remove-wrap' | 'fix-wraps';
// `group` places each action in the ribbon menu: wraps, rows of images, then
// alignment and distance (with the row settings); catalog order is kept inside
// each group. Names are in the language files (i18n/), by ID.
export type ActionGroup = 'wrap' | 'row' | 'style';
export const actions: { id: CommandId; icon: string; action: Action; group: ActionGroup }[] = [
	{ id: 'center-image', icon: 'iw-image-center', action: 'center', group: 'style' },
	{ id: 'add-wrap', icon: 'iw-wrap-left', action: 'add-wrap', group: 'wrap' },
	{ id: 'toggle-wrap-side', icon: 'iw-wrap-toggle', action: 'toggle-wrap-side', group: 'wrap' },
	{ id: 'remove-wrap', icon: 'iw-remove-wrap', action: 'remove-wrap', group: 'wrap' },
	{ id: 'fix-wraps', icon: 'iw-wrap-separate', action: 'fix-wraps', group: 'wrap' },
	{ id: 'row-merge', icon: 'iw-row-merge', action: 'row-merge', group: 'row' },
	{ id: 'row-separate', icon: 'iw-row-separate', action: 'row-separate', group: 'row' },
	{ id: 'row-split-before', icon: 'iw-row-split', action: 'row-split-before', group: 'row' },
	{ id: 'row-move-left', icon: 'iw-row-left', action: 'row-move-left', group: 'row' },
	{ id: 'row-move-right', icon: 'iw-row-right', action: 'row-move-right', group: 'row' },
];
