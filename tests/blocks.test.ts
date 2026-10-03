import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignBlocks, blockStarts, fallbackSections, linkPath, sourceBlocks, type ExportBlock } from '../src/markdown/blocks';

test('fallback sections keep fenced code whole and split on blank lines', () => {
	const lines = ['# T', '', 'uno', 'due', '', '```', 'a', '', 'b', '```', '', '![[a.png]]'];
	assert.deepEqual(fallbackSections(lines).map(s => [s.type, s.lineStart, s.lineEnd]),
		[['heading', 0, 0], ['paragraph', 2, 3], ['code', 5, 9], ['paragraph', 11, 11]]);
});

test('rows inside wraps, code and multi-line paragraphs are not rows', () => {
	const source = ['[wrap:start]', '', '![[a.png|200]]', '', '[wrap:end]', '', '![[a.png]] ![[b.png]]',
		'![[c.png]] ![[d.png]]', '', '```', '![[a.png]] ![[b.png]]', '```', '', '![[a.png]] ![[b.png]] %%iw-row align=left%%'].join('\n');
	const rows = sourceBlocks(source).filter(block => block.row).map(block => [block.lineStart, block.row!.settings]);
	assert.deepEqual(rows, [[13, 'align=left']]);
});

test('identical rows are paired by position, around omitted and added blocks', () => {
	const source = sourceBlocks([
		'ATTESO', '', '![[a.png]] ![[b.png]] %%iw-row align=left%%', '', '![[a.png]] ![[b.png]] %%iw-row align=right%%',
		'', '%%solo commento%%', '', 'Testo', '', '![[a.png]] ![[b.png]]',
	].join('\n'), [
		{ type: 'paragraph', lineStart: 0, lineEnd: 0 }, { type: 'paragraph', lineStart: 2, lineEnd: 2 },
		{ type: 'paragraph', lineStart: 4, lineEnd: 4 }, { type: 'comment', lineStart: 6, lineEnd: 6 },
		{ type: 'paragraph', lineStart: 8, lineEnd: 8 }, { type: 'paragraph', lineStart: 10, lineEnd: 10 },
	]);
	const row = { kind: 'paragraph', paths: ['a.png', 'b.png'] };
	const exported: ExportBlock[] = [{ kind: 'yaml', paths: [] }, { kind: 'paragraph', paths: [] }, row, row,
		{ kind: 'paragraph', paths: [] }, row, { kind: 'footnoteDefinition', paths: [] }];
	assert.deepEqual(alignBlocks(source, exported), [[0, 1], [1, 2], [2, 3], [4, 4], [5, 5]]);
});

test('blocks with different embeds never match', () => {
	const source = sourceBlocks('![[a.png]] ![[b.png]]', [{ type: 'paragraph', lineStart: 0, lineEnd: 0 }]);
	assert.deepEqual(alignBlocks(source, [{ kind: 'paragraph', paths: ['b.png', 'a.png'] }]), []);
});

test('escaped pipe inside a table keeps the plain path', () => {
	assert.equal(linkPath('foto-1.png\\|80'), 'foto-1.png');
	assert.equal(linkPath('cartella/foto.png|200'), 'cartella/foto.png');
});

test('an omitted identical row cannot steal another rows settings', () => {
	const source = sourceBlocks('![[a.png]] %%iw-row align=left%%\n\n![[a.png]] %%iw-row align=right%%');
	assert.deepEqual(alignBlocks(source, [{ kind: 'paragraph', paths: ['a.png'] }]), []);
});

test('a duplicated exported row is ambiguous and stays unassigned', () => {
	const source = sourceBlocks('![[a.png]] %%iw-row align=right%%');
	const row = { kind: 'paragraph', paths: ['a.png'] };
	assert.deepEqual(alignBlocks(source, [row, row]), []);
	assert.deepEqual(alignBlocks(source, [{ kind: 'callout', paths: ['a.png'] }]), []);
});

test('block starts: every kind of block in a wrap, list items included', () => {
	const markdown = [
		'![[a.png|200]]', '', '### Titolo', '', 'Paragrafo.', '',
		'- uno', '  - due', '- [ ] tre', '', '- quattro (elenco largo)', '',
		'> Citazione.', '> - voce', '', '> [!note] Callout', '> testo', '',
		'```js', 'const x = 1;', '', 'const y = 2;', '```', '', '| A | B |', '| --- | --- |', '| 1 | 2 |',
	].join('\n');
	// Where the text of a line starts: after its Markdown marks.
	const line = (text: string) => markdown.indexOf(text);
	const starts = blockStarts(markdown, [
		{ kind: 'paragraph', paths: ['a.png'] }, { kind: 'heading', paths: [] }, { kind: 'paragraph', paths: [] },
		{ kind: 'list', paths: [], items: 4 }, { kind: 'blockquote', paths: [] }, { kind: 'callout', paths: [] },
		{ kind: 'code', paths: [] }, { kind: 'table', paths: [], items: 2 },
	]);
	assert.deepEqual(starts.map(start => start?.from), [0, line('Titolo'), line('Paragrafo.'), line('uno'),
		line('Citazione.'), line('Callout'), line('const x'), line('A | B |')]);
	assert.deepEqual(starts[3]?.items, [line('uno'), line('due'), line('tre'), line('quattro')], 'after the mark and the checkbox');
	assert.deepEqual(starts[7]?.items, [line('A | B |'), line('1 | 2 |')], 'table rows, not the delimiter row');
	// Blocks that do not agree stay without a position; items only when counts match.
	const unsure = blockStarts('> Citazione.\n\n- uno\n- due', [{ kind: 'paragraph', paths: [] }, { kind: 'list', paths: [], items: 3 }]);
	assert.equal(unsure[0], undefined);
	assert.deepEqual(unsure[1], { from: '> Citazione.\n\n- '.length });
});
