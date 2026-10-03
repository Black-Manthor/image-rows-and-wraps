import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWrap, centerImage } from '../src/markdown/actions';
import { removeWrap, toggleWrapSide } from '../src/markdown/wrap-actions';
import type { Edit } from '../src/markdown/edits';
import { parseDocument, startMarker, wrapImage, START, END } from '../src/markdown/model';
import { DEFAULT_ROW_SETTINGS, findRows } from '../src/markdown/row-model';

const result = (source: string, edit: Edit) => source.slice(0, edit.from) + edit.text + source.slice(edit.to);
const add = (source: string, from: number, to = from) => result(source, addWrap(source, from, to));
const center = (source: string, from: number, to = from) => result(source, centerImage(source, from, to));
const toggle = (source: string, from: number, to = from) => result(source, toggleWrapSide(source, from, to));
const LEFT = startMarker('left');
const RIGHT = startMarker('right');
const image = '![[folder/foto.png|caption|300x200|custom]]';
const text = image + '\n\nPrimo **paragrafo**.\n\nSecondo.';

test('adding a wrap on an image writes the side on the start marker; the link stays identical', () => {
	const wrapped = add(text, 0, text.length);
	assert.equal(wrapped, `${LEFT}\n\n${text}\n\n${END}\n`);
	const model = parseDocument(wrapped);
	assert.equal(model.regions[0]?.side, 'left');
	assert.equal(wrapImage(model, model.regions[0]!)?.raw, image);
});

test('changing side rewrites only the comment, in both directions, keeping unknown tokens', () => {
	const wrapped = add(text, 0, text.length);
	const cursor = wrapped.indexOf('Primo');
	const right = toggle(wrapped, cursor);
	assert.equal(right, wrapped.replace(LEFT, RIGHT));
	assert.equal(toggle(right, cursor), wrapped);
	// No comment, or an invalid side, counts as left: the change writes right.
	const bare = wrapped.replace(LEFT, START);
	assert.equal(toggle(bare, cursor), wrapped.replace(LEFT, RIGHT));
	const odd = wrapped.replace(LEFT, `${START} %%iw-wrap side=pippo futuro=1%%`);
	assert.equal(parseDocument(odd).regions[0]?.side, 'left');
	assert.equal(toggle(odd, cursor), wrapped.replace(LEFT, `${START} %%iw-wrap side=right futuro=1%%`));
	assert.throws(() => toggle(text, 4), /dentro un solo wrap/);
});

test('centering from the text removes the wrap with its blank lines and leaves a centered one-image row', () => {
	const wrapped = add(text, 0, text.length);
	const centered = center(wrapped, wrapped.indexOf('Primo'));
	assert.equal(centered, `${image} %%iw-row align=center%%\n\nPrimo **paragrafo**.\n\nSecondo.\n`);
	assert.equal(parseDocument(centered).regions.length, 0);
	assert.equal(findRows(centered)[0]?.settings.align, 'center');
});

test('centering a wrap leaves exactly one blank line around the row and its text', () => {
	// Before 0.26.48 the blank lines that parted the markers from the content
	// stayed: two blank lines above the row and two below the text.
	const row = (link: string) => `${link} %%iw-row align=center%%`;
	for (const eol of ['\n', '\r\n']) {
		const lines = (...parts: string[]) => parts.join(eol);
		const cases: Array<[string, string, string]> = [
			['in the middle of the note',
				lines('Prima.', '', LEFT, '', '![[a.png|200]]', '', 'Testo.', '', 'Altro.', '', END, '', 'Dopo.'),
				lines('Prima.', '', row('![[a.png|200]]'), '', 'Testo.', '', 'Altro.', '', 'Dopo.')],
			['the image alone',
				lines('Prima.', '', RIGHT, '', '![[a.png|200]]', '', END, '', 'Dopo.'),
				lines('Prima.', '', row('![[a.png|200]]'), '', 'Dopo.')],
			['compact markers touching the text outside',
				lines('Prima.', LEFT, '![[a.png|200]]', 'Testo.', END, 'Dopo.'),
				lines('Prima.', '', row('![[a.png|200]]'), '', 'Testo.', '', 'Dopo.')],
			['at the end of the note',
				lines('Prima.', '', LEFT, '', '![[a.png|200]]', '', 'Testo.', '', END),
				lines('Prima.', '', row('![[a.png|200]]'), '', 'Testo.')],
		];
		for (const [label, source, expected] of cases) {
			const at = source.indexOf('![[');
			const centered = center(source, at);
			assert.equal(centered, expected, `${label} (${JSON.stringify(eol)})`);
			assert.equal(findRows(centered).length, 1, `${label}: the image is a row of its own`);
		}
	}
});

test('centering a standalone image sets the row comment and never adds markers', () => {
	const centered = center(text, 4);
	assert.equal(centered, text.replace(image, `${image} %%iw-row align=center%%`));
	assert.equal(center(centered, 4), centered);
	// When center is already the default, no comment is needed.
	const defaults = { ...DEFAULT_ROW_SETTINGS, align: 'center' as const };
	assert.equal(result(centered, centerImage(centered, 4, 4, defaults)), text);
});

test('centering keeps other row settings and unknown tokens, and refuses images inside text', () => {
	const row = `${image} ![[b.png]] %%iw-row gap=4 futuro=1 align=right%%\n\nTesto`;
	assert.equal(center(row, 4), row.replace('%%iw-row gap=4 futuro=1 align=right%%', '%%iw-row align=center gap=4 futuro=1%%'));
	assert.throws(() => center(`Testo ${image} altro`, 10));
});

test('wrapping a one-image row drops its row comment, keeping unknown tokens; rows with more images are refused', () => {
	const wrapped = add(`${image} %%iw-row align=center%%\n\nPrimo.`, 4);
	assert.ok(!wrapped.includes('iw-row'));
	assert.ok(wrapped.startsWith(`${LEFT}\n\n${image}\n\n${END}`));
	const kept = add('![[a.png|200]] %%iw-row align=center futuro=1%%', 0);
	assert.ok(kept.includes('%%iw-row futuro=1%%') && !kept.includes('align=center'));
	assert.throws(() => add(`${image} ![[b.png]]\n\nPrimo.`, 4), /più immagini/);
});

test('wrapping an image line with text right above and below keeps the unknown tokens of its comment', () => {
	// Not a row of images of its own (no blank lines around it), but its comment
	// is still the plugin's: only the settings the plugin knows go.
	const source = 'Prima.\n![[a.png]] %%iw-row align=center futuro=1%%\nDopo.';
	const wrapped = add(source, source.indexOf('![['));
	assert.ok(wrapped.includes('%%iw-row futuro=1%%'), wrapped);
	assert.ok(!wrapped.includes('align=center'), wrapped);
});

test('cursor on an image wraps only that image, leaving following text outside', () => {
	const wrapped = add(text, 4);
	assert.equal(parseDocument(wrapped).regions.length, 1);
	assert.ok(wrapped.indexOf(END) < wrapped.indexOf('Primo'));
	assert.ok(wrapped.endsWith(text.slice(image.length)));
});

test('an image selection works with CRLF notes, keeping the text around', () => {
	const source = `Prima\r\n\r\n${image}\r\n\r\nDopo`;
	const from = source.indexOf(image);
	const wrapped = add(source, from, from + image.length);
	assert.equal(parseDocument(wrapped).regions.length, 1);
	assert.ok(wrapped.startsWith('Prima\r\n\r\n') && wrapped.endsWith('\r\n\r\nDopo'));
	assert.ok(!/(?<!\r)\n/.test(wrapped));
});

test('on text, «Aggiungi wrap» wraps the paragraph under the cursor, identical; the wrap is laid out once it starts with an image alone', () => {
	const source = 'Prima.\n\nTesto del paragrafo.\nSeconda riga.\n\nDopo.';
	const edit = addWrap(source, source.indexOf('Seconda'), source.indexOf('Seconda'));
	const wrapped = result(source, edit);
	assert.equal(wrapped, `Prima.\n\n${LEFT}\n\nTesto del paragrafo.\nSeconda riga.\n\n${END}\n\nDopo.`);
	assert.equal(wrapped.slice(edit.cursor, edit.cursor! + 7), 'Seconda', 'the caret stays on the same character');
	assert.equal(wrapImage(parseDocument(wrapped), parseDocument(wrapped).regions[0]!), undefined, 'text only: nothing to lay out yet');
	// An image alone on the paragraph's first line, its text right below: laid out, links untouched.
	const withImage = 'Prima.\n\n![[foto.png|100]]\nTesto accanto.\n\nDopo.';
	const laidOut = add(withImage, withImage.indexOf('accanto'));
	assert.equal(laidOut, `Prima.\n\n${LEFT}\n\n![[foto.png|100]]\nTesto accanto.\n\n${END}\n\nDopo.`);
	assert.equal(wrapImage(parseDocument(laidOut), parseDocument(laidOut).regions[0]!)?.raw, '![[foto.png|100]]');
	// Text before the image on its line: a paragraph, not an image wrap.
	const inline = add(`Testo ${image} altro`, 2);
	assert.equal(inline, `${LEFT}\n\nTesto ${image} altro\n\n${END}`);
});

test('on an empty line, an empty wrap with the cursor inside, markers on paragraphs of their own', () => {
	for (const eol of ['\n', '\r\n']) {
		const source = ['Sopra.', '', 'Sotto.'].join(eol);
		const edit = addWrap(source, source.indexOf(eol) + eol.length, source.indexOf(eol) + eol.length);
		const wrapped = result(source, edit);
		assert.equal(wrapped, ['Sopra.', '', LEFT, '', '', '', END, '', 'Sotto.'].join(eol));
		assert.equal(wrapped.slice(0, edit.cursor), ['Sopra.', '', LEFT, '', ''].join(eol));
		const model = parseDocument(wrapped);
		assert.equal(model.regions.length, 1);
		// Empty: a region for the commands, nothing to lay out yet.
		assert.equal(wrapImage(model, model.regions[0]!), undefined);
		assert.equal(toggle(wrapped, edit.cursor!), wrapped.replace(LEFT, RIGHT));
	}
	// Between two lines of text with no blank line: blank lines are added.
	assert.equal(add('Uno.\n\nDue.', 5), `Uno.\n\n${LEFT}\n\n\n\n${END}\n\nDue.`);
});

test('adding inside a wrap, or on code and properties, is refused', () => {
	const wrapped = add(text, 0, text.length);
	assert.throws(() => add(wrapped, wrapped.indexOf('Primo')), /già in un wrap/);
	assert.throws(() => add(wrapped, wrapped.indexOf('\n\n') + 1), /già in un wrap/);
	assert.throws(() => add('```\n\n```', 4), /solo testo e immagini/);
	assert.throws(() => add('---\ntitolo: x\n---', 5), /solo testo e immagini/);
});

test('selection through multiple regions or external text cannot merge or unwrap unrelated content', () => {
	const wrapped = add(text, 0, text.length);
	assert.throws(() => center(wrapped + wrapped, 0, (wrapped + wrapped).length));
	assert.equal(toggle(wrapped, 0, wrapped.length), wrapped.replace(LEFT, RIGHT));
	// Every wrap command, a selection going out on either side; the blank lines
	// around the wrap are not text outside it.
	const source = `Prima.\n\n${wrapped}\n\nDopo.`;
	const inside = source.indexOf('Primo');
	for (const [name, command] of Object.entries({ toggleWrapSide, removeWrap, centerImage })) {
		assert.throws(() => command(source, inside, source.indexOf('Dopo') + 2), /attraversa il confine del wrap/, `${name}, out after`);
		assert.throws(() => command(source, 2, inside), /attraversa il confine del wrap/, `${name}, out before`);
		assert.doesNotThrow(() => command(source, source.indexOf(LEFT) - 1, source.indexOf(END) + END.length + 1), name);
	}
});

test('center changes only the chosen region and leaves repeated image occurrences unchanged', () => {
	const wrapped = add(text, 0, text.length);
	const source = wrapped + '\nOutside\n' + wrapped;
	const centered = center(source, source.lastIndexOf('Primo'));
	assert.ok(centered.startsWith(wrapped + '\nOutside\n'));
	assert.equal(parseDocument(centered).regions.length, 1);
});

test('CRLF and text outside the selection survive wrap creation and centering', () => {
	const content = text.replaceAll('\n', '\r\n');
	const source = 'Prima\r\n\r\n' + content + '\r\n\r\nDopo';
	const from = source.indexOf(image);
	const wrapped = add(source, from, from + content.length);
	assert.ok(wrapped.startsWith('Prima\r\n\r\n') && wrapped.endsWith('\r\n\r\nDopo'));
	assert.ok(!/(?<!\r)\n/.test(wrapped));
	const centered = center(wrapped, wrapped.indexOf('Primo'));
	assert.ok(!/(?<!\r)\n/.test(centered));
	assert.ok(centered.endsWith('\r\n\r\nDopo'));
});

test('malformed markers and code examples are never automatically rewritten', () => {
	assert.throws(() => add(START + '\n' + text, 0, START.length + text.length + 1));
	const code = '```\n' + text + '\n```';
	assert.throws(() => center(code, 0, code.length));
});

test('an unrelated unclosed wrap does not disable centering or wrapping a safe image', () => {
	const source = '![[a.png|200]]\n\n[wrap:start]\n\n![[b.png|100]]';
	assert.equal(center(source, 0), source.replace('![[a.png|200]]', '![[a.png|200]] %%iw-row align=center%%'));
	assert.throws(() => center(source, source.indexOf('![[b')));
	const wrapped = add(source, 0);
	assert.ok(wrapped.startsWith(`${LEFT}\n\n![[a.png|200]]`));
	assert.ok(wrapped.endsWith('[wrap:start]\n\n![[b.png|100]]'));
});

test('centering a compact wrap produces a recognized row separated from its text', () => {
	for (const eol of ['\n', '\r\n']) {
		const source = [RIGHT, '![[a.png|200]]', 'Testo.', END].join(eol);
		const centered = center(source, source.indexOf('Testo'));
		assert.ok(centered.includes(`![[a.png|200]] %%iw-row align=center%%${eol}${eol}Testo.`));
	}
});

test('wrapping an image that touches the text above puts the start marker on a paragraph of its own', () => {
	for (const eol of ['\n', '\r\n']) {
		const source = ['Testo sopra.', '![[a.png|200]]', 'Testo sotto.'].join(eol);
		assert.equal(add(source, source.indexOf('![[')), ['Testo sopra.', '', LEFT, '', '![[a.png|200]]', '', END, '', 'Testo sotto.'].join(eol));
	}
	// A blank line already there is not doubled.
	assert.equal(add('Sopra.\n\n![[a.png]]', 8), `Sopra.\n\n${LEFT}\n\n![[a.png]]\n\n${END}\n`);
});

test('adding a wrap leaves exactly one blank line after the end marker', () => {
	// A selection of image and text ending at the end of a line, with a blank
	// line after it, left two before 0.26.47.
	const source = 'Prima.\n\n![[a.png|220]]\n\nTesto.\n\nDopo.\n';
	const expected = `Prima.\n\n${LEFT}\n\n![[a.png|220]]\n\nTesto.\n\n${END}\n\nDopo.\n`;
	const from = source.indexOf('![[');
	assert.equal(add(source, from, source.indexOf('Testo.') + 'Testo.'.length), expected, 'selection to the end of the line');
	assert.equal(add(source, from, source.indexOf('Dopo.') - 1), expected, 'selection with the line break');
	// Text right after the range: one blank line is added.
	const touching = 'Prima.\n\n![[a.png|220]]\nTesto.\nDopo.\n';
	assert.equal(add(touching, touching.indexOf('![['), touching.indexOf('Testo.') + 'Testo.'.length),
		`Prima.\n\n${LEFT}\n\n![[a.png|220]]\nTesto.\n\n${END}\n\nDopo.\n`);
	// The image alone, the cursor on it, a blank line after.
	assert.equal(add('![[a.png|220]]\n\nDopo.', 3), `${LEFT}\n\n![[a.png|220]]\n\n${END}\n\nDopo.`);
});

test('adding a wrap on a selection holding two images is refused: a wrap lays out one image', () => {
	const source = 'Prima.\n\n![[a.png]]\nTesto con ![[b.png]] dentro.\n\nDopo.';
	assert.throws(() => addWrap(source, source.indexOf('![[a'), source.indexOf(' dentro.')), /una sola immagine/);
});
