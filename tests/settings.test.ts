import { layoutVariables, registerLayoutSettings } from '../src/layout-settings';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings, rowDefaults } from '../src/settings';
import { registerCommands } from '../src/commands';
import { actions } from '../src/command-catalog';
import { MarkdownView, notices, shownMenus } from './obsidian-stub';
import { t } from '../src/i18n';

test('old preferences: absent or invalid data gives the defaults, removed keys go, kept values survive saving', () => {
	for (const data of [null, undefined, false, 42, 'old', {}, { visibleCommands: null }]) {
		assert.deepEqual(normalizeSettings(data), defaultSettings());
	}
	// Saved by earlier versions: groups, ribbon visibility, extended drag.
	const old = { noticeSeconds: 18, wrapGap: 1.4, groupGap: 0.7, columnMinRem: 12, maxImagesPerRow: 3, incompleteRows: 'left',
		visibleCommands: { 'center-image': false, 'remove-wrap': true, 'image-row': true }, extendedDrag: true, dragImages: false };
	const migrated = normalizeSettings(old);
	for (const key of ['groupGap', 'columnMinRem', 'maxImagesPerRow', 'incompleteRows', 'visibleCommands', 'extendedDrag']) assert.equal(key in migrated, false, key);
	assert.deepEqual([migrated.noticeSeconds, migrated.wrapGap, migrated.dragImages], [18, 1.4, false], 'the values that still exist are kept');
	assert.equal(migrated.rowGap, 12, 'a key the old data lacks: its default');
	assert.equal(normalizeSettings({}).dragImages, true, 'drag is on by default');
	assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(migrated))), migrated, 'saved and read again, the same');
});

test('ten commands and one ribbon button whose menu lists every action, grouped', () => {
	const commands: { id: string; editorCallback: unknown }[] = [];
	const ribbon: { icon: string; title: string; click: (event: unknown) => void }[] = [];
	let ran = 0;
	const editor = { listSelections: () => { ran++; return [{}]; }, getValue: () => 'Testo.', getCursor: () => ({ line: 0, ch: 0 }), posToOffset: () => 0, focus: () => {} };
	let mode = 'source';
	// The active view (null: a side panel has the focus) and the last note used.
	let active: unknown = { getMode: () => mode, editor };
	let recent: unknown = undefined;
	const plugin = { manifest: { name: 'Image Rows and Wraps' },
		app: { workspace: { getActiveViewOfType: () => active, getMostRecentLeaf: () => recent && { view: recent } } },
		addCommand: (command: typeof commands[number]) => commands.push(command),
		addRibbonIcon: (icon: string, title: string, click: (event: unknown) => void) => { ribbon.push({ icon, title, click }); return {}; },
	};
	registerCommands(plugin as never, defaultSettings);
	assert.equal(commands.length, 10);
	assert.ok(commands.every(command => typeof command.editorCallback === 'function'));
	assert.equal(ribbon.length, 1);
	assert.equal(ribbon[0]!.title, 'Image Rows and Wraps', 'the button is named after the plugin');
	ribbon[0]!.click({ clientX: 1, clientY: 2 });
	const menu = shownMenus[shownMenus.length - 1]!;
	// Each group opens with a title, a label that does nothing when clicked.
	assert.deepEqual(menu.flatMap((item, index) => item.label ? [[index, item.title]] : []),
		[[0, 'Wrap'], [5, 'Righe di immagini'], [11, 'Allineamento e distanza']]);
	assert.ok(menu.filter(item => item.label).every(item => !item.action));
	assert.deepEqual(menu.flatMap((item, index) => item.separatorBefore ? [index] : []), [5, 11]);
	// Centering is an alignment choice: first of the alignment and distance group.
	assert.equal(menu[12]!.title, 'Centra immagini');
	const items = menu.filter(item => !item.label);
	assert.deepEqual(items.map(item => item.title), [...actions.filter(item => item.group === 'wrap').map(item => t().commands[item.id]),
		...actions.filter(item => item.group === 'row').map(item => t().commands[item.id]),
		...actions.filter(item => item.group === 'style').map(item => t().commands[item.id]),
		'Scegli la distribuzione della riga di immagini…', 'Scegli l’allineamento verticale della riga di immagini…', 'Scegli la distanza tra le immagini…']);
	// Never a bare "riga" (a line of text, in a note): "riga di immagini", or "nella riga" after an image.
	for (const title of items.map(item => item.title)) assert.ok(!/\briga\b/.test(title) || /riga di immagini|nella riga|riga propria/.test(title), title);
	assert.ok(items.every(item => item.icon));
	// An item acts on the active note's editor, only in editing mode.
	items[0]!.action!();
	assert.equal(ran, 1);
	mode = 'preview';
	items[0]!.action!();
	assert.equal(ran, 1);
	assert.equal(notices.at(-1), 'Passa alla modalità modifica per usare questo comando.');
	// A side panel has the focus: the note still on screen is the last one used.
	mode = 'source';
	active = null;
	recent = Object.assign(new MarkdownView(), { getMode: () => mode, editor });
	items[0]!.action!();
	assert.equal(ran, 2);
	// No note at all, or only another kind of view.
	recent = { getMode: () => mode, editor };
	items[0]!.action!();
	assert.equal(ran, 2);
	assert.equal(notices.at(-1), 'Apri una nota per usare questo comando.');
});

test('numeric preferences keep valid values and bring the others within their limits', () => {
	const settings = normalizeSettings({ noticeSeconds: 20, wrapGap: 1.5, wrapMaxPercent: 60, rowGap: 24 });
	assert.equal(settings.noticeSeconds, 20);
	assert.equal(settings.rowGap, 24);
	const invalid = normalizeSettings({ noticeSeconds: 0, wrapGap: -2, wrapMaxPercent: 999, rowGap: NaN });
	assert.equal(invalid.noticeSeconds, 3);
	assert.equal(invalid.wrapGap, 0);
	assert.equal(invalid.wrapMaxPercent, 80);
	assert.equal(invalid.rowGap, 12);
	assert.equal(normalizeSettings({ rowGap: 500 }).rowGap, 100);
	assert.deepEqual(layoutVariables(settings), { '--iw-wrap-gap': '1.5em', '--iw-wrap-max': '60%' });
});

test('layout preferences update existing/new windows and remove their styles at teardown', () => {
	function doc() {
		const props = new Map<string, string>();
		return { props, body: {
			setCssProps: (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) { if (value) props.set(name, value); else props.delete(name); } },
			style: { removeProperty: (name: string) => { props.delete(name); } },
		} };
	}
	const main = doc(), popout = doc();
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { value: main, configurable: true });
	let settings = defaultSettings();
	const handlers = new Map<string, (...args: any[]) => void>();
	let cleanup = () => {};
	const plugin = { app: { workspace: {
		iterateAllLeaves: (callback: (leaf: unknown) => void) => callback({ view: { containerEl: { ownerDocument: main } } }),
		onLayoutReady: (callback: () => void) => callback(),
		on: (name: string, callback: (...args: any[]) => void) => handlers.set(name, callback),
	} }, registerEvent: () => {}, register: (callback: () => void) => { cleanup = callback; } };
	try {
		const update = registerLayoutSettings(plugin as never, () => settings);
		assert.equal(main.props.get('--iw-wrap-gap'), `${defaultSettings().wrapGap}em`);
		handlers.get('window-open')!({}, { document: popout });
		assert.equal(popout.props.size, 2);
		settings = { ...settings, wrapGap: 2 };
		update();
		assert.equal(main.props.get('--iw-wrap-gap'), '2em');
		assert.equal(popout.props.get('--iw-wrap-gap'), '2em');
		handlers.get('window-close')!({}, { document: popout });
		assert.equal(popout.props.size, 0);
		cleanup();
		assert.equal(main.props.size, 0);
	} finally {
		if (previous) Object.defineProperty(globalThis, 'document', previous);
		else Reflect.deleteProperty(globalThis, 'document');
	}
});


test('row defaults: valid choices are kept, invalid ones fall back', () => {
	assert.deepEqual(rowDefaults(defaultSettings()), { align: 'left', valign: 'top', gap: 12 });
	const chosen = normalizeSettings({ rowAlign: 'evenly', rowValign: 'bottom', rowGap: 8 });
	assert.deepEqual(rowDefaults(chosen), { align: 'evenly', valign: 'bottom', gap: 8 });
	assert.deepEqual(rowDefaults(normalizeSettings({ rowAlign: 'pippo', rowValign: 3 })), { align: 'left', valign: 'top', gap: 12 });
});

test('a layout-ready refresh arriving after unload does not put the variables back', () => {
	const props = new Map<string, string>();
	const doc = { body: { setCssProps: (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) { if (value) props.set(name, value); else props.delete(name); } },
		style: { removeProperty: (name: string) => { props.delete(name); } } } };
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
	let ready: (() => void) | undefined;
	let cleanup = () => {};
	const plugin = { app: { workspace: { iterateAllLeaves: () => {}, on: () => ({}), onLayoutReady: (callback: () => void) => { ready = callback; } } },
		registerEvent: () => {}, register: (callback: () => void) => { cleanup = callback; } };
	try {
		registerLayoutSettings(plugin as never, defaultSettings);
		assert.equal(props.size, 2);
		cleanup();
		assert.equal(props.size, 0);
		ready!();
		assert.equal(props.size, 0);
	} finally {
		if (previous) Object.defineProperty(globalThis, 'document', previous);
		else Reflect.deleteProperty(globalThis, 'document');
	}
});
