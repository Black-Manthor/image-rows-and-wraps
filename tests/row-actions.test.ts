import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowAction, rowSettingsAction, type RowAction } from '../src/markdown/row-actions';
import { t } from '../src/i18n';
import { parseGap } from '../src/ui/row-settings';
import { findRows } from '../src/markdown/row-model';

const run = (source: string, from: number, to: number, action: RowAction) => {
	const edit = rowAction(source, from, to, action);
	return { text: source.slice(0, edit.from) + edit.text + source.slice(edit.to), cursor: edit.cursor };
};
const a = '![[a.png|200]]', b = '![[cartella/b.png|300x100|didascalia]]', c = '![[c.png]]';

test('merge joins the next row, or the previous one when there is none after', () => {
	const source = `Prima.\n\n${a}\n\n\n${b} ${c}\n\nDopo.`;
	assert.equal(run(source, source.indexOf(a), source.indexOf(a), 'row-merge').text, `Prima.\n\n${a} ${b} ${c}\n\nDopo.`);
	const cursor = source.indexOf(c);
	assert.equal(run(source, cursor, cursor, 'row-merge').text, `Prima.\n\n${a} ${b} ${c}\n\nDopo.`);
});

test('merge keeps the comment of the row under the cursor, plus unknown tokens of the others', () => {
	const source = `${a} %%iw-row align=center futuro=1%%\n\n${b} %%iw-row align=right gap=4 altro=2%%`;
	const fromFirst = run(source, 3, 3, 'row-merge').text;
	assert.equal(fromFirst, `${a} ${b} %%iw-row align=center futuro=1 altro=2%%`);
	assert.equal(findRows(fromFirst)[0]!.settings.align, 'center');
	const second = source.indexOf(b) + 3;
	assert.equal(run(source, second, second, 'row-merge').text, `${a} ${b} %%iw-row align=right gap=4 altro=2 futuro=1%%`);
});

test('merge with a selection joins every selected row; text between them is refused', () => {
	const source = `${a}\n\n${b}\n\n${c} %%iw-row align=evenly%%`;
	assert.equal(run(source, 0, source.length, 'row-merge').text, `${a} ${b} ${c}`);
	assert.throws(() => run(`${a}\n\nTesto\n\n${b}`, 0, 30, 'row-merge'), /separate soltanto da righe vuote/);
	assert.throws(() => run(`${a}\n\nTesto.`, 3, 3, 'row-merge'), /subito prima o dopo/);
});

test('separate gives each image its own row with a copy of the comment', () => {
	const source = `Prima.\n\n${a} ${b} %%iw-row align=center%%\n\nDopo.`;
	assert.equal(run(source, source.indexOf(a), source.indexOf(a), 'row-separate').text,
		`Prima.\n\n${a} %%iw-row align=center%%\n\n${b} %%iw-row align=center%%\n\nDopo.`);
	assert.throws(() => run(a, 3, 3, 'row-separate'), /una sola immagine/);
});

test('split before an image makes two rows; the first image is refused', () => {
	const source = `${a} ${b} ${c}`;
	const cursor = source.indexOf(b) + 2;
	const result = run(source, cursor, cursor, 'row-split-before');
	assert.equal(result.text, `${a}\n\n${b} ${c}`);
	assert.equal(result.text.slice(result.cursor!, result.cursor! + b.length), b);
	assert.throws(() => run(source, 3, 3, 'row-split-before'), /prima immagine/);
});

test('move left and right swap exact links and the caret follows the moved image', () => {
	const source = `${a} ${b} ${c} %%iw-row gap=0%%`;
	const cursor = source.indexOf(b) + 5;
	const left = run(source, cursor, cursor, 'row-move-left');
	assert.equal(left.text, `${b} ${a} ${c} %%iw-row gap=0%%`);
	assert.equal(left.cursor, 5);
	const right = run(source, cursor, cursor, 'row-move-right');
	assert.equal(right.text, `${a} ${c} ${b} %%iw-row gap=0%%`);
	assert.equal(right.text.slice(right.cursor! - 5, right.cursor! - 5 + b.length), b);
	assert.throws(() => run(source, 3, 3, 'row-move-left'), /già la prima/);
	const last = source.indexOf(c) + 2;
	assert.throws(() => run(source, last, last, 'row-move-right'), /già l’ultima/);
});

test('CRLF notes keep their line endings', () => {
	const source = `${a} ${b}\r\n\r\nDopo.`;
	const result = run(source, 3, 3, 'row-separate').text;
	assert.equal(result, `${a}\r\n\r\n${b}\r\n\r\nDopo.`);
	assert.ok(!/(?<!\r)\n/.test(result));
});

test('commands never act inside wraps, code, raw HTML or ambiguous marker zones', () => {
	const cases = [
		`[wrap:start]\n\n![[a.png|200]]\n\nTesto\n\n[wrap:end]`,
		'```\n![[a.png]] ![[b.png]]\n```',
		'<pre>\n\n![[a.png]] ![[b.png]]\n\n</pre>',
		`[wrap:start]\n\n![[a.png]] ![[b.png]]`,
		`Testo ![[a.png]] ![[b.png]]`,
	];
	for (const source of cases) {
		const cursor = source.indexOf('![[a.png') + 3;
		for (const action of ['row-merge', 'row-separate', 'row-split-before', 'row-move-left', 'row-move-right'] as const) {
			assert.throws(() => rowAction(source, cursor, cursor, action), Error, `${action}: ${source}`);
		}
	}
});

test('row settings change only the chosen key, omit defaults and keep unknown tokens', () => {
	const source = `Prima.\n\n${a} ${b} %%iw-row gap=4 futuro=1%%\n\nDopo.`;
	const at = source.indexOf(a) + 3;
	const apply = (patch: Parameters<typeof rowSettingsAction>[2]) => {
		const edit = rowSettingsAction(source, at, patch);
		return source.slice(0, edit.from) + edit.text + source.slice(edit.to);
	};
	assert.equal(apply({ align: 'center' }), source.replace('%%iw-row gap=4 futuro=1%%', '%%iw-row align=center gap=4 futuro=1%%'));
	assert.equal(apply({ gap: 12 }), source.replace('%%iw-row gap=4 futuro=1%%', '%%iw-row futuro=1%%'));
	const plain = `${a} ${b}`;
	const edit = rowSettingsAction(plain, 3, { valign: 'top' });
	assert.equal(plain.slice(0, edit.from) + edit.text + plain.slice(edit.to), plain);
	assert.throws(() => rowSettingsAction('Testo.', 2, { align: 'center' }), /riga di immagini/);
});

test('gap input accepts non-negative numbers up to the 700 px reference', () => {
	assert.equal(parseGap('16'), 16);
	assert.equal(parseGap(' 7.5 '), 7.5);
	assert.equal(parseGap('0'), 0);
	for (const value of ['', '-2', 'abc', '1e3', '701']) assert.equal(parseGap(value), undefined, value);
});

test('a settings choice is refused when the row changed after the menu opened', () => {
	const row = '![[a.png]] ![[b.png]] %%iw-row gap=0%%';
	const source = `Testo.\n\n${row}`;
	const at = source.indexOf(row) + 2;
	const edit = rowSettingsAction(source, at, { align: 'center' }, undefined, row);
	assert.equal(source.slice(0, edit.from) + edit.text + source.slice(edit.to), `Testo.\n\n![[a.png]] ![[b.png]] %%iw-row align=center gap=0%%`);
	// Another row now sits at the old position, or the row was edited.
	const other = `Testo.\n\n![[c.png]] ![[d.png]]`;
	assert.throws(() => rowSettingsAction(other, at, { align: 'center' }, undefined, row), { message: t().rowChangedWhileChoosing });
	assert.throws(() => rowSettingsAction(source.replace('gap=0', 'gap=6'), at, { align: 'center' }, undefined, row), { message: t().rowChangedWhileChoosing });
	assert.throws(() => rowSettingsAction('Testo.\n\nNiente.', at, { align: 'center' }, undefined, row), { message: t().rowChangedWhileChoosing });
});
