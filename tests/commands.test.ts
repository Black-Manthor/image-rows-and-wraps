import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notices, openedModals } from './obsidian-stub';
import { registerCommands } from '../src/commands';
import { chooseRowSetting } from '../src/ui/row-settings';
import { centerImage } from '../src/markdown/actions';
import { t } from '../src/i18n';
import { defaultSettings } from '../src/settings';

// The commands as the palette runs them, on an editor that records each
// transaction: every command must be one editor change, so one Undo.
// Positions are plain offsets (line 0): the commands only convert them.
function editor(text: string, caret: number, selections = 1) {
	const state = { value: text, caret, transactions: 0, replaced: 0, focused: false };
	const at = (offset: number) => ({ line: 0, ch: offset });
	return { state,
		listSelections: () => Array.from({ length: selections }, () => ({})),
		getValue: () => state.value,
		getCursor: () => at(state.caret),
		posToOffset: (position: { ch: number }) => position.ch,
		offsetToPos: at,
		transaction({ changes }: { changes: Array<{ from: { ch: number }; to: { ch: number }; text: string }> }) {
			state.transactions++;
			for (const change of [...changes].sort((a, b) => b.from.ch - a.from.ch)) {
				state.value = state.value.slice(0, change.from.ch) + change.text + state.value.slice(change.to.ch);
			}
		},
		replaceRange(text: string, from: { ch: number }, to: { ch: number }) {
			state.replaced++;
			state.value = state.value.slice(0, from.ch) + text + state.value.slice(to.ch);
		},
		setCursor(position: { ch: number }) { state.caret = position.ch; },
		focus() { state.focused = true; },
	};
}

function commands() {
	const list = new Map<string, (editor: unknown) => void>();
	const plugin = { manifest: { name: 'Image Rows and Wraps' }, app: { workspace: {} },
		addCommand: (command: { id: string; editorCallback: (editor: unknown) => void }) => list.set(command.id, command.editorCallback),
		addRibbonIcon: () => ({}) };
	registerCommands(plugin as never, defaultSettings);
	return (id: string, target: ReturnType<typeof editor>) => list.get(id)!(target);
}

test('a command changes the note in one editor transaction: centering a wrap, merging rows', () => {
	const run = commands();
	const wrap = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|200]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
	const centering = editor(wrap, wrap.indexOf('Testo'));
	run('center-image', centering);
	const expected = centerImage(wrap, wrap.indexOf('Testo'), wrap.indexOf('Testo'));
	assert.equal(centering.state.value, wrap.slice(0, expected.from) + expected.text + wrap.slice(expected.to));
	assert.equal(centering.state.transactions, 1, 'one Undo step');
	assert.ok(centering.state.focused, 'the keyboard back to the editor');
	const rows = 'Prima.\n\n![[a.png]]\n\n![[b.png]]\n\nDopo.';
	const merging = editor(rows, rows.indexOf('a.png'));
	run('row-merge', merging);
	assert.equal(merging.state.value, 'Prima.\n\n![[a.png]] ![[b.png]]\n\nDopo.');
	assert.equal(merging.state.transactions, 1);
	assert.equal(merging.state.caret, rows.indexOf('![[a'), 'the caret at the merged row');
});

test('a command that cannot apply says why and leaves the note alone', () => {
	const run = commands();
	const single = editor('![[a.png]]', 3);
	run('row-separate', single);
	assert.equal(notices.at(-1), 'La riga di immagini contiene una sola immagine.');
	assert.deepEqual([single.state.value, single.state.transactions], ['![[a.png]]', 0]);
	const many = editor('![[a.png]] ![[b.png]]', 3, 2);
	run('row-separate', many);
	assert.equal(notices.at(-1), 'Usa una sola selezione.');
	assert.equal(many.state.transactions, 0);
});

test('a row setting from the palette: one change when chosen, nothing when the row changed meanwhile', () => {
	const row = '![[a.png]] ![[b.png]] %%iw-row gap=0%%';
	const choose = (change?: (value: string) => string) => {
		const target = editor(`Prima.\n\n${row}\n\nDopo.`, 10);
		const owner = { file: { path: 'nota.md' }, editor: target };
		chooseRowSetting({ app: {} } as never, target as never, owner as never, 'align', defaultSettings);
		const dialog = openedModals.at(-1) as unknown as { onChooseItem(item: [string, string]): void };
		// The note changes while the dialog is open (sync, another pane).
		if (change) target.state.value = change(target.state.value);
		dialog.onChooseItem(['center', 'Centro']);
		return target.state;
	};
	const chosen = choose();
	assert.equal(chosen.value, `Prima.\n\n![[a.png]] ![[b.png]] %%iw-row align=center gap=0%%\n\nDopo.`);
	assert.equal(chosen.replaced, 1, 'one Undo step');
	const changed = choose(value => value.replace('gap=0', 'gap=6'));
	assert.equal(notices.at(-1), t().rowChangedWhileChoosing);
	assert.equal(changed.replaced, 0, 'nothing written');
	// No row under the cursor: said at once, no dialog.
	const before = openedModals.length;
	const text = editor('Solo testo.', 2);
	chooseRowSetting({ app: {} } as never, text as never, { file: { path: 'n.md' }, editor: text } as never, 'gap', defaultSettings);
	assert.equal(notices.at(-1), 'Posiziona il cursore su una riga di immagini.');
	assert.equal(openedModals.length, before);
});
