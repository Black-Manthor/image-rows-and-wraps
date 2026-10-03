import { FuzzySuggestModal, Menu, SuggestModal, type App, type Editor, type MarkdownFileInfo, type Modal, type Plugin } from 'obsidian';
import { rowAtPosition, rowSettingsAction } from '../markdown/row-actions';
import { REFERENCE_WIDTH, type RowAlign, type RowSettings, type RowValign } from '../markdown/row-model';
import { rowDefaults, type ImageSettings } from '../settings';
import { notify, notifyError } from './notify';
import { t } from '../i18n';
import type { CommandId } from '../command-catalog';

// Choices for the settings of one row, shared by the Live Preview bar (menus)
// and the palette commands (search dialogs). Applying a choice is always one
// edit of the row comment, through row-edits.ts rules.

export type RowSettingKind = 'align' | 'valign' | 'gap';

const ALIGNS: RowAlign[] = ['left', 'center', 'right', 'between', 'evenly'];
const VALIGNS: RowValign[] = ['top', 'center', 'bottom'];
export const alignChoices = (): Array<[RowAlign, string]> => ALIGNS.map(value => [value, t().align[value]]);
export const valignChoices = (): Array<[RowValign, string]> => VALIGNS.map(value => [value, t().valign[value]]);
const GAP_PRESETS = [0, 6, 12, 24, 48];

// A gap is a distance in px on the 700 px reference, never wider than it.
export function parseGap(text: string): number | undefined {
	if (!/^\d+(\.\d+)?$/.test(text.trim())) return undefined;
	const value = Number(text);
	return Number.isFinite(value) && value <= REFERENCE_WIDTH ? value : undefined;
}

const suffix = (isDefault: boolean) => isDefault ? t().isDefault : '';

// The choice dialogs open now: closed when the plugin unloads (registered once,
// in registerRowSettingCommands), so none outlives it with its callback.
const openDialogs = new Set<Modal>();

class ChoiceModal<T> extends FuzzySuggestModal<[T, string]> {
	constructor(app: App, private choices: Array<[T, string]>, private current: T, private fallback: T,
		private choose: (value: T) => void) {
		super(app);
		this.setPlaceholder(t().chooseValue);
	}
	getItems() { return this.choices; }
	getItemText([value, label]: [T, string]) {
		return `${value === this.current ? '✓ ' : ''}${label}${suffix(value === this.fallback)}`;
	}
	onChooseItem([value]: [T, string]) { this.choose(value); }
	onClose() { super.onClose(); openDialogs.delete(this); }
}

class GapModal extends SuggestModal<number> {
	constructor(app: App, private current: number, private fallback: number, private choose: (value: number) => void) {
		super(app);
		this.setPlaceholder(t().gapPlaceholder);
	}
	getSuggestions(query: string): number[] {
		const typed = parseGap(query);
		const presets = GAP_PRESETS.filter(value => !query.trim() || String(value).startsWith(query.trim()));
		return typed === undefined ? presets : [typed, ...presets.filter(value => value !== typed)];
	}
	renderSuggestion(value: number, element: HTMLElement) {
		element.setText(`${value === this.current ? '✓ ' : ''}${value} px${suffix(value === this.fallback)}`);
	}
	onChooseSuggestion(value: number) { this.choose(value); }
	onClose() { super.onClose(); openDialogs.delete(this); }
}

function openRowSettingModal(app: App, kind: RowSettingKind, current: RowSettings, defaults: RowSettings,
	apply: (patch: Partial<RowSettings>) => void): void {
	const dialog = kind === 'align' ? new ChoiceModal(app, alignChoices(), current.align, defaults.align, align => apply({ align }))
		: kind === 'valign' ? new ChoiceModal(app, valignChoices(), current.valign, defaults.valign, valign => apply({ valign }))
			: new GapModal(app, current.gap, defaults.gap, gap => apply({ gap }));
	openDialogs.add(dialog);
	dialog.open();
}

export function openRowSettingMenu(app: App, kind: RowSettingKind, position: { x: number; y: number },
	current: RowSettings, defaults: RowSettings, apply: (patch: Partial<RowSettings>) => void): void {
	const menu = new Menu();
	const add = (title: string, checked: boolean, patch: Partial<RowSettings>) =>
		menu.addItem(item => item.setTitle(title).setChecked(checked).onClick(() => apply(patch)));
	if (kind === 'align') for (const [value, label] of alignChoices()) add(label + suffix(value === defaults.align), value === current.align, { align: value });
	else if (kind === 'valign') for (const [value, label] of valignChoices()) add(label + suffix(value === defaults.valign), value === current.valign, { valign: value });
	else {
		for (const value of GAP_PRESETS) add(`${value} px${suffix(value === defaults.gap)}`, value === current.gap, { gap: value });
		menu.addSeparator();
		menu.addItem(item => item.setTitle(GAP_PRESETS.includes(current.gap) ? t().otherValue : t().otherValueNow(current.gap))
			.onClick(() => openRowSettingModal(app, 'gap', current, defaults, apply)));
	}
	menu.showAtPosition(position);
}

export const ROW_SETTING_COMMANDS: Array<[CommandId, RowSettingKind, string]> = [
	['row-set-align', 'align', 'iw-row-align'],
	['row-set-valign', 'valign', 'iw-row-valign'],
	['row-set-gap', 'gap', 'iw-row-gap'],
];

// Palette and ribbon menu: same choices for the row under the cursor, as one editor change.
export function registerRowSettingCommands(plugin: Plugin, getSettings: () => ImageSettings): void {
	plugin.register(() => { for (const dialog of [...openDialogs]) dialog.close(); openDialogs.clear(); });
	for (const [id, kind, icon] of ROW_SETTING_COMMANDS) plugin.addCommand({ id, name: t().commands[id], icon,
		editorCallback: (editor: Editor, owner: MarkdownFileInfo) => chooseRowSetting(plugin, editor, owner, kind, getSettings) });
}

// `owner` is the view or embed the editor belongs to: Obsidian reuses the same
// editor when another note opens in its pane, so the note is checked by file.
export function chooseRowSetting(plugin: Plugin, editor: Editor, owner: MarkdownFileInfo, kind: RowSettingKind,
	getSettings: () => ImageSettings): void {
	const settings = getSettings();
	const defaults = rowDefaults(settings);
	const position = editor.posToOffset(editor.getCursor('from'));
	const source = editor.getValue();
	const row = rowAtPosition(source, position, defaults);
	if (!row) { notify(settings, t().placeCursorOnRow); return; }
	const expected = source.slice(row.from, row.to);
	const file = owner.file;
	openRowSettingModal(plugin.app, kind, row.settings, defaults, patch => {
		// The dialog stays open while another note may open in the same editor,
		// with the same row at the same place: the note must be the same one.
		if (!file || owner.file !== file || owner.editor !== editor) { notify(settings, t().noteChangedWhileChoosing); return; }
		try {
			// The dialog stays open while the note may change: same row text, or nothing.
			const edit = rowSettingsAction(editor.getValue(), position, patch, defaults, expected);
			editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
		} catch (error) {
			notifyError(settings, error, t().cannotChangeRow);
		}
	});
}
