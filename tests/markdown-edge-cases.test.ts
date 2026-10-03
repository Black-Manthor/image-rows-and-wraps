import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRows } from '../src/markdown/row-model';
import { moveDraggedImage } from '../src/markdown/drag-image';
import { parseDocument } from '../src/markdown/model';

// HTML block termination depends on the block type, as verified in a real
// Obsidian PDF export: a blank line ends a div
// block, so the image after it is a row; a pre block keeps its content as text.
test('a div separated by blank lines does not exclude a row', () => {
	assert.equal(findRows('<div>\n\n![[a.png]]\n\n</div>').length, 1);
});

test('raw HTML blocks that a blank line does not end never contain rows', () => {
	for (const [open, close] of [['<pre>', '</pre>'], ['<script>', '</script>'], ['<STYLE type="x">', '</style>'],
		['<textarea>', '</textarea>'], ['<?php', '?>'], ['<!DOCTYPE x', '>'], ['<![CDATA[', ']]>']]) {
		const source = `${open}\n\n![[a.png|200]]\n\n${close}\n\n![[b.png]]`;
		assert.deepEqual(findRows(source).map(row => row.images[0]!.path), ['b.png'], open);
	}
	// Opened and closed on the same line: Markdown resumes right after it.
	assert.equal(findRows('<pre>codice</pre>\n\n![[a.png]]').length, 1);
	// A wrap marker written inside a pre block is text, not a region.
	const model = parseDocument('<pre>\n[wrap:start]\n\n![[a.png|200]]\n\n[wrap:end]\n</pre>');
	assert.equal(model.regions.length, 0);
	assert.equal(model.diagnostics.length, 0);
});

test('blank lines between list items are not top-level drop boundaries', () => {
	for (const list of ['- primo\n\n- secondo', '1. primo\n\n2. secondo', '- [ ] primo\n\n- [x] secondo', '- primo\n  continuazione\n\n- secondo', '- primo\n\n  continuazione']) {
		const source = '![[a.png|100]]\n\n' + list + '\n\nDopo.';
		const gap = source.indexOf('\n\n', source.indexOf(list));
		for (const position of [gap + 1, gap + 2]) {
			assert.throws(() => moveDraggedImage(source, 0, { kind: 'text', position }));
		}
		assert.doesNotThrow(() => moveDraggedImage(source, 0, { kind: 'text', position: source.indexOf(list) }));
		assert.ok(moveDraggedImage(source, 0, { kind: 'text', position: source.indexOf('Dopo.') }));
	}
});
