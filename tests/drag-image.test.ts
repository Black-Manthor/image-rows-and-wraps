import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState, Text, type Transaction } from '@codemirror/state';
import { history, isolateHistory, undo, redo, undoDepth } from '@codemirror/commands';
import { moveDraggedImage, moveRowBlock, moveWrapBlock, type ImageDrop } from '../src/markdown/drag-image';
import { parseDocument, startMarker, START, END } from '../src/markdown/model';
import { t } from '../src/i18n';

const plain = '![[folder/a.png|300x200|alias]]';
// The side is on the wrap's start marker: links move unchanged.
const a = plain, b = '![[b.png|250]]', c = '![[c.png]]';
const wrap = (s: string) => `${startMarker('right')}\n\n${s}\n\n${END}`;
const apply = (s: string, from: number, to: ImageDrop) => {
	const edit = moveDraggedImage(s, from, to);
	return edit ? edit.changes.apply(Text.of(s.split('\n'))).toString() : s;
};

test('wrap extraction keeps all text and removes only delimiters and original image line', () => {
	const text = '**Testo** <mark>colore</mark>\n\n- elenco\n\nAltro';
	const s = `${START}\n\n${a}\n\n${text}\n\n${END}\n\nFuori`;
	const result = apply(s, s.indexOf(a), { kind: 'text', position: s.length });
	assert.ok(result.includes(text));
	assert.ok(result.includes('Fuori'));
	assert.equal(parseDocument(result).regions.length, 0);
	// The link is unchanged: size and caption stay.
	assert.equal(parseDocument(result).images[0]?.raw, plain);
});

test('text drops reuse existing blank separators instead of inserting extra empty lines', () => {
	for (const eol of ['\n', '\r\n']) {
		const s = `${a}\n\nPrimo\n\nSecondo`.replaceAll('\n', eol);
		const result = apply(s, 0, { kind: 'text', position: s.indexOf('Secondo') });
		assert.ok(result.includes(`Primo${eol}${eol}${a}${eol}${eol}Secondo`));
		const end = apply(s, 0, { kind: 'text', position: s.length });
		assert.ok(end.endsWith(`Secondo${eol}${eol}${a}`));
		const top = `${'Primo'}${eol}${eol}${a}`;
		assert.equal(apply(top, top.indexOf(a), { kind: 'text', position: 0 }), `${a}${eol}${eol}Primo`);
	}
});

test('no origin may enter a wrap', () => {
	for (const origin of [a, wrap(a)]) {
		const s = `${origin}\n\n${START}\n${b}\nTesto\n${END}`;
		assert.throws(() => moveDraggedImage(s, s.indexOf(a), { kind: 'text', position: s.indexOf('Testo') }), { message: t().imageIntoWrap });
	}
});

test('an image already alone moves between paragraphs like any other; right before or after its place is a no-op', () => {
	const s = `${wrap(a)}\n\nTesto`;
	assert.ok(apply(s, s.indexOf(a), { kind: 'text', position: s.length }).endsWith(plain));
	const isolated = `${b}\n\nParagrafo\n\nAltro`;
	assert.equal(apply(isolated, 0, { kind: 'text', position: isolated.length }), `Paragrafo\n\nAltro\n\n${b}`);
	// Right before or after its own place: nothing to do, no Undo step.
	assert.equal(moveDraggedImage(isolated, 0, { kind: 'text', position: isolated.indexOf('Paragrafo') }), undefined);
	assert.equal(moveDraggedImage(a, 0, { kind: 'text', position: a.length }), undefined);
	assert.equal(moveDraggedImage(a, 0, { kind: 'text', position: 0 }), undefined);
});

test('a one-image row moves with its link; its emptied place keeps only the unknown tokens of its comment', () => {
	const s = `${b} %%iw-row align=center%%\n\nTesto`;
	assert.equal(apply(s, 0, { kind: 'text', position: s.length }).trim(), `Testo\n\n${b}`, 'the settings go with the emptied row');
	// Tokens the plugin does not know belong to someone else: they stay.
	const foreign = `${b} %%iw-row align=center futuro=1%%\n\nTesto`;
	const result = apply(foreign, 0, { kind: 'text', position: foreign.length });
	assert.ok(result.startsWith('%%iw-row futuro=1%%') && result.endsWith(b) && !result.includes('align=center'), result);
});

test('extracting from a row is basic: the rest of the row keeps its comment', () => {
	const many = `${b} ${c} %%iw-row gap=0%%\n\nTesto`;
	const result = apply(many, many.indexOf(c), { kind: 'text', position: many.length });
	assert.equal(result, `${b} %%iw-row gap=0%%\n\nTesto\n\n${c}`);
});

test('reordering inside a row rebuilds only that line; own slots are no-ops', () => {
	const s = `Prima\n\n${a} ${b} ${c} %%iw-row align=right%%\n\nDopo`;
	const row = s.indexOf('![[');
	const first = s.slice(row, s.indexOf(' ', row));
	assert.equal(moveDraggedImage(s, s.indexOf(b), { kind: 'row', row, slot: 1 }), undefined);
	assert.equal(moveDraggedImage(s, s.indexOf(b), { kind: 'row', row, slot: 2 }), undefined);
	assert.equal(apply(s, s.indexOf(c), { kind: 'row', row, slot: 0 }),
		`Prima\n\n${c} ${first} ${b} %%iw-row align=right%%\n\nDopo`);
	const edit = moveDraggedImage(s, row, { kind: 'row', row, slot: 3 })!;
	const result = edit.changes.apply(Text.of(s.split('\n'))).toString();
	assert.equal(result, `Prima\n\n${b} ${c} ${first} %%iw-row align=right%%\n\nDopo`);
	assert.equal(result.slice(edit.cursor, edit.cursor + first.length), first);
});

test('moving to another row keeps the target settings; an emptied origin disappears', () => {
	const s = `${b} %%iw-row align=center%%\n\nTesto\n\n${c} %%iw-row gap=0%%`;
	const target = s.indexOf(c);
	const edit = moveDraggedImage(s, 0, { kind: 'row', row: target, slot: 1 })!;
	const result = edit.changes.apply(Text.of(s.split('\n'))).toString();
	assert.equal(result, `Testo\n\n${c} ${b} %%iw-row gap=0%%`);
	assert.equal(result.slice(edit.cursor, edit.cursor + b.length), b);
	// Backwards, from a row with two images: the origin keeps its comment.
	const two = `${c} %%iw-row gap=0%%\n\nTesto\n\n${b} ${plain} %%iw-row align=right%%`;
	assert.equal(apply(two, two.indexOf(plain), { kind: 'row', row: 0, slot: 0 }),
		`${plain} ${c} %%iw-row gap=0%%\n\nTesto\n\n${b} %%iw-row align=right%%`);
});

test('a wrap image enters a row unchanged; the wrap delimiters go', () => {
	const s = `${wrap(a)}\n\n${b}`;
	const result = apply(s, s.indexOf(a), { kind: 'row', row: s.indexOf(b), slot: 0 });
	assert.equal(parseDocument(result).regions.length, 0);
	assert.ok(result.endsWith(`${plain} ${b}`));
	assert.throws(() => apply(s, s.indexOf(a), { kind: 'row', row: s.indexOf(b), slot: 5 }));
	assert.throws(() => apply(s, s.indexOf(a), { kind: 'row', row: 3, slot: 0 }));
});

test('drag rejects broken markers and sentence/code/list interior', () => {
	assert.throws(() => apply(`${START}\n${a}`, START.length + 1, { kind: 'text', position: 0 }));
	for (const tail of ['Una frase', '```\ncodice\n```', '- prima\n- seconda']) {
		const s = `${a}\n\n${tail}`;
		assert.throws(() => apply(s, 0, { kind: 'text', position: s.indexOf(tail) + 2 }));
	}
});

test('one drag is isolated from preceding typing and supports one-step undo/redo', () => {
	const s = `${wrap(a)}\n\nTesto`;
	let state = EditorState.create({ doc: s, extensions: [history()] });
	const dispatch = (tr: Transaction) => { state = tr.state; };
	state = state.update({ changes: { from: state.doc.length, insert: ' aggiunto' }, userEvent: 'input.type' }).state;
	const before = state.doc.toString();
	const move = moveDraggedImage(before, before.indexOf(a), { kind: 'text', position: before.length })!;
	state = state.update({ changes: move.changes, selection: { anchor: move.cursor }, annotations: isolateHistory.of('full'), userEvent: 'move.image' }).state;
	const after = state.doc.toString();
	assert.equal(undoDepth(state), 2);
	assert.ok(undo({ state, dispatch }));
	assert.equal(state.doc.toString(), before);
	assert.ok(redo({ state, dispatch }));
	assert.equal(state.doc.toString(), after);
});

test('special paths and missing-file links leave a wrap unchanged', () => {
	for (const link of ['![[Immagini/Caffè e tè (prova) 日本.png|320x180|descrizione]]', '![[non-esiste.png|150]]']) {
		const s = `${wrap(link)}\n\nFuori`;
		assert.equal(parseDocument(apply(s, s.indexOf(link), { kind: 'text', position: s.length })).images.at(-1)?.raw, link);
	}
});

test('drag between safe blocks works before an unrelated malformed wrap', () => {
	const source = `${b}\n\nTesto\n\n[wrap:start]\n\n![[bad.png]]`;
	const result = apply(source, 0, { kind: 'text', position: source.indexOf('Testo') });
	assert.ok(result.endsWith('[wrap:start]\n\n![[bad.png]]'));
	assert.equal(parseDocument(result).images.filter(image => image.raw === b).length, 1);
	assert.throws(() => apply(source, 0, { kind: 'text', position: source.length }));
});

test('an image inside a line of text leaves only its link: the text and the wrap stay', () => {
	const outside = `Testo ${b} e altro.\n\nFine.`;
	assert.equal(apply(outside, outside.indexOf(b), { kind: 'text', position: outside.length }), `Testo e altro.\n\nFine.\n\n${b}`);
	// At the end of a sentence, the space before goes; at the start, the one after.
	assert.equal(apply(`Testo ${b}.\n\nFine.`, 6, { kind: 'text', position: 0 }), `${b}\n\nTesto.\n\nFine.`);
	assert.equal(apply(`${b} testo.`, 0, { kind: 'text', position: `${b} testo.`.length }), `testo.\n\n${b}`);
	// Inside the text of a wrap: the wrap keeps its delimiters.
	const inline = `${START}\n\nPrima ${a} dopo\n\n${END}\n\nFuori.\n\n${b}`;
	assert.equal(apply(inline, inline.indexOf(a), { kind: 'row', row: inline.indexOf(b), slot: 1 }),
		`${START}\n\nPrima dopo\n\n${END}\n\nFuori.\n\n${b} ${plain}`);
	// Alone on its line but not the wrap's image: only its line goes.
	const below = `${START}\n\nTesto sopra.\n\n${a}\n\n${END}\n\nFuori.`;
	assert.equal(apply(below, below.indexOf(a), { kind: 'text', position: below.length }),
		`${START}\n\nTesto sopra.\n\n${END}\n\nFuori.\n\n${plain}`);
});

test('a link with code in its alias moves with all its bytes; undo and redo restore them', () => {
	const alias = '![[a.png|`didascalia`|100]]';
	const s = `Prima.\n\n${alias}\n\nTesto.\n\n${b}`;
	assert.equal(parseDocument(s).images[0]?.raw, alias);
	let state = EditorState.create({ doc: s, extensions: [history()] });
	const dispatch = (tr: Transaction) => { state = tr.state; };
	const move = moveDraggedImage(s, s.indexOf(alias), { kind: 'row', row: s.indexOf(b), slot: 1 })!;
	state = state.update({ changes: move.changes, annotations: isolateHistory.of('full') }).state;
	const after = state.doc.toString();
	assert.equal(after, `Prima.\n\nTesto.\n\n${b} ${alias}`);
	assert.ok(undo({ state, dispatch }));
	assert.equal(state.doc.toString(), s);
	assert.ok(redo({ state, dispatch }));
	assert.equal(state.doc.toString(), after);
});

test('a whole wrap moves between paragraphs, markers and text identical, in one ChangeSet', () => {
	const move = (s: string, insertion: number) => {
		const edit = moveWrapBlock(s, s.indexOf('[wrap:start]'), insertion);
		return edit ? edit.changes.apply(Text.of(s.split('\n'))).toString() : s;
	};
	const block = `${startMarker('right')}\n\n${b}\n\nTesto **accanto**.\n\n${END}`;
	for (const eol of ['\n', '\r\n']) {
		const s = ['Uno.', '', block, '', 'Due.', '', 'Tre.'].join('\n').replaceAll('\n', eol);
		const down = move(s, s.indexOf('Tre.'));
		assert.equal(down, ['Uno.', '', 'Due.', '', block, '', 'Tre.'].join('\n').replaceAll('\n', eol));
		const end = move(s, s.length);
		assert.equal(end, ['Uno.', '', 'Due.', '', 'Tre.', '', block].join('\n').replaceAll('\n', eol));
		const up = move(end, 0);
		assert.equal(up, [block, '', 'Uno.', '', 'Due.', '', 'Tre.'].join('\n').replaceAll('\n', eol));
	}
});

test('a wrap next to its own place does not move; never into another wrap, a list or code', () => {
	const other = `${startMarker('left')}\n\n${c}\n\nAltro.\n\n${END}`;
	const s = `Uno.\n\n${wrap(b)}\n\nDue.\n\n${other}\n\n- voce\n- voce\n\n\`\`\`\ncodice\n\n\`\`\`\n\nFine.`;
	const from = s.indexOf('[wrap:start]');
	assert.equal(moveWrapBlock(s, from, from), undefined);
	assert.equal(moveWrapBlock(s, from, s.indexOf('Due.')), undefined);
	assert.equal(moveWrapBlock(s, from, s.indexOf('Uno.')) !== undefined, true);
	// Right before another wrap is a boundary; inside it is not.
	assert.ok(moveWrapBlock(s, from, s.lastIndexOf('[wrap:start]')));
	assert.throws(() => moveWrapBlock(s, from, s.indexOf('Altro.')), { message: t().wrapIntoWrap });
	assert.throws(() => moveWrapBlock(s, from, s.lastIndexOf('- voce')), /tra due blocchi/);
	assert.throws(() => moveWrapBlock(s, from, s.indexOf('\n\n```\n', s.indexOf('codice')) + 2), /tra due blocchi/);
	assert.throws(() => moveWrapBlock(s, s.indexOf('Uno.'), s.length), /non trovato/);
});

test('a whole row of images moves between paragraphs with its comment, in one ChangeSet', () => {
	const row = `${b} ${c} %%iw-row align=center gap=20%%`;
	const move = (s: string, insertion: number) => {
		const edit = moveRowBlock(s, s.indexOf(b), insertion);
		return edit ? edit.changes.apply(Text.of(s.split('\n'))).toString() : s;
	};
	for (const eol of ['\n', '\r\n']) {
		const s = ['Uno.', '', row, '', 'Due.', '', 'Tre.'].join('\n').replaceAll('\n', eol);
		assert.equal(move(s, s.indexOf('Tre.')), ['Uno.', '', 'Due.', '', row, '', 'Tre.'].join('\n').replaceAll('\n', eol));
		const end = move(s, s.length);
		assert.equal(end, ['Uno.', '', 'Due.', '', 'Tre.', '', row].join('\n').replaceAll('\n', eol));
		assert.equal(move(end, 0), [row, '', 'Uno.', '', 'Due.', '', 'Tre.'].join('\n').replaceAll('\n', eol));
	}
});

test('a row next to its own place does not move; before or after another row or a wrap; never inside a wrap, a list or code', () => {
	const other = `${c} %%iw-row align=right%%`;
	const s = `Uno.\n\n${b}\n\nDue.\n\n${other}\n\n${wrap(c)}\n\n- voce\n- voce\n\n\`\`\`\ncodice\n\n\`\`\`\n\nFine.`;
	const from = s.indexOf(b);
	assert.equal(moveRowBlock(s, from, from), undefined);
	assert.equal(moveRowBlock(s, from, s.indexOf('Due.')), undefined);
	assert.ok(moveRowBlock(s, from, s.indexOf('Uno.')));
	// Before or after another row: the rows stay separate (merging is a command of its own).
	const before = moveRowBlock(s, from, s.indexOf(other))!.changes.apply(Text.of(s.split('\n'))).toString();
	assert.ok(before.includes(`Due.\n\n${b}\n\n${other}`));
	assert.ok(moveRowBlock(s, from, s.indexOf('[wrap:start]')), 'right before a wrap is a boundary');
	assert.throws(() => moveRowBlock(s, from, s.indexOf(c, s.indexOf('[wrap:start]'))), { message: t().rowIntoWrap });
	assert.throws(() => moveRowBlock(s, from, s.lastIndexOf('- voce')), /tra due blocchi/);
	assert.throws(() => moveRowBlock(s, from, s.indexOf('\n\n```\n', s.indexOf('codice')) + 2), /tra due blocchi/);
	assert.throws(() => moveRowBlock(s, s.indexOf('Uno.'), s.length), /non trovata/);
});

test('an image dropped right before or right after a compact wrap becomes a row of its own there', () => {
	// The markers touch the text: the boundary is the wrap's own, with no blank line.
	const s = `Testo.\n${startMarker('left')}\n![[w.png|100]]\nAccanto.\n${END}\nDopo.\n\n${c}`;
	const compact = `${startMarker('left')}\n![[w.png|100]]\nAccanto.\n${END}`;
	assert.equal(apply(s, s.indexOf(c), { kind: 'text', position: s.indexOf(START) }), `Testo.\n\n${c}\n\n${compact}\nDopo.`);
	assert.equal(apply(s, s.indexOf(c), { kind: 'text', position: s.indexOf('Dopo.') }), `Testo.\n${compact}\n\n${c}\n\nDopo.`);
	assert.throws(() => apply(s, s.indexOf(c), { kind: 'text', position: s.indexOf('Accanto.') }), { message: t().imageIntoWrap });
});
