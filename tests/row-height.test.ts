import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { moveRowBlock } from '../src/markdown/drag-image';
import { carriedRowHeight, knownRowHeight, rowHeightEffect, rowHeightField } from '../src/rendering/row-height';

const ROW = '![[a.png|100]] ![[b.png|140]]';
const SOURCE = `Primo.\n\nSecondo.\n\n${ROW}\n\nTerzo.`;
const rowFrom = SOURCE.indexOf(ROW);

// The row moved up, before «Secondo.»: the changes and where the row starts after them.
function moveUp(state: EditorState) {
	const move = moveRowBlock(state.doc.toString(), rowFrom, SOURCE.indexOf('Secondo.'));
	assert.ok(move);
	return move;
}

test('a row moved up takes its known height to its new line, in the same transaction', () => {
	const reported = EditorState.create({ doc: SOURCE, extensions: rowHeightField })
		.update({ effects: rowHeightEffect.of({ line: rowFrom, height: 187 }) }).state;
	const { changes, cursor } = moveUp(reported);
	const effects = carriedRowHeight(reported, rowFrom, cursor);
	assert.equal(effects.length, 1);
	const moved = reported.update({ changes, effects }).state;
	assert.equal(moved.sliceDoc(cursor, cursor + ROW.length), ROW, 'the row starts there after the move');
	assert.equal(knownRowHeight(moved, cursor), 187, 'drawn there, it starts at its known height');
});

test('a row whose height was never reported moves with no height: drawn as before', () => {
	const state = EditorState.create({ doc: SOURCE, extensions: rowHeightField });
	const { changes, cursor } = moveUp(state);
	assert.deepEqual(carriedRowHeight(state, rowFrom, cursor), []);
	assert.equal(knownRowHeight(state.update({ changes }).state, cursor), undefined);
});
