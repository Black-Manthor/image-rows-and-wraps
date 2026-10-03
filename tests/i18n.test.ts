import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLanguage, t, type Strings } from '../src/i18n';
import { en } from '../src/i18n/en';
import { it } from '../src/i18n/it';
import { registerCommands } from '../src/commands';
import { registerRowSettingCommands } from '../src/ui/row-settings';
import { defaultSettings } from '../src/settings';

// Every text of a language, with the values the plugin puts in.
function texts(strings: Strings): Array<[string, string]> {
	return Object.entries(strings).flatMap(([key, value]): Array<[string, string]> =>
		typeof value === 'string' ? [[key, value]]
			: typeof value === 'function' ? [[key, (value as (...args: unknown[]) => string)(2, 'Nota')], [`${key} (1)`, (value as (...args: unknown[]) => string)(1, 'Nota')]]
				: Object.entries(value as Record<string, string>).map(([inner, text]) => [`${key}.${inner}`, text]));
}

test('Obsidian in Italian shows the Italian texts; any other language, the English ones', () => {
	try {
		for (const code of ['it', 'IT', 'it-IT']) { setLanguage(code); assert.equal(t(), it, code); }
		for (const code of ['en', 'en-GB', 'fr', 'de', 'pt-BR', 'zh-TW', 'ita', '']) { setLanguage(code); assert.equal(t(), en, code); }
	} finally { setLanguage('it'); }
});

test('each text exists in both languages, filled in, and the English ones are not Italian', () => {
	const [italian, english] = [texts(it), texts(en)];
	assert.deepEqual(english.map(([key]) => key), italian.map(([key]) => key));
	for (const [key, text] of [...italian, ...english]) assert.ok(text.trim(), key);
	// Accents, the typographic apostrophe and « » belong to the Italian texts.
	for (const [key, text] of english) assert.ok(!/[àèéìòù’«»]/.test(text), `${key}: ${text}`);
	// Proper names aside, every English text differs from its Italian one.
	const same = english.filter(([key, text]) => text === italian.find(([other]) => other === key)?.[1]).map(([key]) => key);
	assert.deepEqual(same, ['menuWrap', 'wrapHeading']);
});

test('the toolbars of rows and wraps have their own name in both languages', () => {
	assert.deepEqual([it.rowToolbar, it.wrapToolbar], ['Comandi della riga di immagini', 'Comandi del wrap']);
	assert.deepEqual([en.rowToolbar, en.wrapToolbar], ['Image row commands', 'Wrap commands']);
});

test('the Italian texts never say a bare «riga», which in a note is a line of text', () => {
	const allowed = /\b(?:riga|righe) di (?:più )?immagini\b|\briga propria\b|\bnella riga\b|\brighe vuote\b/gi;
	for (const [key, text] of texts(it)) assert.ok(!/\b(?:riga|righe)\b/i.test(text.replace(allowed, '')), `${key}: ${text}`);
});

test('messages with values: the PDF notice in singular and plural, the wrap width limit', () => {
	assert.equal(it.compactWrapsInPdf(1, 'Nota'), 'Nel PDF 1 wrap di «Nota» non è impaginato: ha i marcatori attaccati al testo. Usa «Correggi il formato dei wrap della nota» e riesporta.');
	assert.match(it.compactWrapsInPdf(2, 'Nota'), /^Nel PDF 2 wrap di «Nota» non sono impaginati: hanno i marcatori/);
	assert.equal(en.compactWrapsInPdf(1, 'Note'), 'In the PDF, 1 wrap of "Note" is not laid out: its markers touch the text. Use "Fix the format of the note\'s wraps" and export again.');
	assert.match(en.compactWrapsInPdf(2, 'Note'), /^In the PDF, 2 wraps of "Note" are not laid out: their markers/);
	// The limit names the setting, and where to change it, with the command's own words.
	assert.match(it.wrapLimit(45), /45% della colonna\. Si cambia in Impostazioni → Wrap\./);
	assert.match(en.wrapLimit(45), /45% of the column\. You can change it in Settings → Wrap\./);
	assert.ok(it.compactWrapsInPdf(1, 'x').includes(`«${it.commands['fix-wraps']}»`));
	assert.ok(en.compactWrapsInPdf(1, 'x').includes(`"${en.commands['fix-wraps']}"`));
});

test('commands get their names in the language set at load, under the same IDs', () => {
	const names = (code: string) => {
		setLanguage(code);
		const commands: Array<{ id: string; name: string }> = [];
		const plugin = { manifest: { name: 'Image Rows and Wraps' }, app: { workspace: {} }, register: () => {},
			addCommand: (command: { id: string; name: string }) => commands.push(command), addRibbonIcon: () => ({}) };
		registerCommands(plugin as never, defaultSettings);
		registerRowSettingCommands(plugin as never, defaultSettings);
		return commands;
	};
	try {
		const [italian, english] = [names('it'), names('en')];
		assert.deepEqual(english.map(command => command.id), italian.map(command => command.id));
		assert.equal(italian.length, 13);
		assert.deepEqual(italian.map(command => command.name), italian.map(command => it.commands[command.id as keyof Strings['commands']]));
		assert.deepEqual(english.map(command => command.name), english.map(command => en.commands[command.id as keyof Strings['commands']]));
	} finally { setLanguage('it'); }
});
