import { actions, type Action, type ActionGroup } from './command-catalog';
import { rowDefaults, type ImageSettings } from './settings';
import { fixWraps, removeWrap, toggleWrapSide } from './markdown/wrap-actions';
import { MarkdownView, Menu, type Editor, type Plugin } from 'obsidian';
import { chooseRowSetting, ROW_SETTING_COMMANDS } from './ui/row-settings';
import { addWrap, centerImage } from './markdown/actions';
import { rowAction } from './markdown/row-actions';
import { parseDocument } from './markdown/model';
import { notify, notifyError } from './ui/notify';
import { t } from './i18n';

function run(editor: Editor, action: Action, settings: ImageSettings): void {
	try {
		if (editor.listSelections().length !== 1) throw new Error(t().oneSelection);
		const source = editor.getValue();
		const from = editor.posToOffset(editor.getCursor('from'));
		const to = editor.posToOffset(editor.getCursor('to'));
		const edit = action === 'remove-wrap' ? removeWrap(source, from, to)
			: action === 'add-wrap' ? addWrap(source, from, to)
			: action === 'toggle-wrap-side' ? toggleWrapSide(source, from, to)
			: action === 'fix-wraps' ? fixWraps(source, from)
			: action === 'center' ? centerImage(source, from, to, rowDefaults(settings))
			: rowAction(source, from, to, action, rowDefaults(settings));
		if (edit.from === edit.to && !edit.text) { editor.focus(); return; }
		// One transaction, so one undo step, even for several separate changes.
		const changes = edit.changes ?? [{ from: edit.from, to: edit.to, insert: edit.text }];
		editor.transaction({ changes: changes.map(change =>
			({ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.insert })) });
		// The caret is an offset of the new text: set once the text has changed.
		if (edit.cursor !== undefined) editor.setCursor(editor.offsetToPos(edit.cursor));
		const model = parseDocument(editor.getValue());
		if (model.diagnostics[0]) notify(settings, model.diagnostics[0].message);
		editor.focus();
	} catch (error) {
		notifyError(settings, error, t().cannotChangeSelection);
	}
}

export function registerCommands(plugin: Plugin, getSettings: () => ImageSettings): void {
	for (const item of actions) {
		plugin.addCommand({ id: item.id, name: t().commands[item.id], icon: item.icon,
			editorCallback: editor => run(editor, item.action, getSettings()) });
	}
	// One ribbon button with every action: its visibility is Obsidian's own
	// ribbon setting (right click on the ribbon), not a plugin preference.
	plugin.addRibbonIcon('iw-wrap-left', plugin.manifest.name, event => openActionMenu(plugin, event, getSettings));
}

// The note the ribbon menu acts on: the active one or, when a side panel has
// the focus (the note is still on screen), the last one used in the main area.
function activeView(plugin: Plugin, settings: ImageSettings): MarkdownView | undefined {
	const workspace = plugin.app.workspace;
	const recent = workspace.getMostRecentLeaf()?.view;
	const view = workspace.getActiveViewOfType(MarkdownView) ?? (recent instanceof MarkdownView ? recent : null);
	if (!view) notify(settings, t().openNote);
	else if (view.getMode() !== 'source') notify(settings, t().switchToEditing);
	else return view;
	return undefined;
}

function openActionMenu(plugin: Plugin, event: MouseEvent, getSettings: () => ImageSettings): void {
	const menu = new Menu();
	const add = (title: string, icon: string, act: (editor: Editor, view: MarkdownView) => void) => menu.addItem(item => item.setTitle(title).setIcon(icon)
		.onClick(() => { const view = activeView(plugin, getSettings()); if (view) act(view.editor, view); }));
	// Each group opens with a title (a label, not clickable) saying what it changes.
	const heading = (title: string) => menu.addItem(item => item.setTitle(title).setIsLabel(true));
	const group = (title: string, name: ActionGroup) => {
		heading(title);
		for (const item of actions.filter(item => item.group === name)) add(t().commands[item.id], item.icon, editor => run(editor, item.action, getSettings()));
	};
	group(t().menuWrap, 'wrap');
	menu.addSeparator();
	group(t().menuRows, 'row');
	menu.addSeparator();
	group(t().menuStyle, 'style');
	for (const [id, kind, icon] of ROW_SETTING_COMMANDS) add(`${t().commands[id]}…`, icon, (editor, view) => chooseRowSetting(plugin, editor, view, kind, getSettings));
	menu.showAtMouseEvent(event);
}
