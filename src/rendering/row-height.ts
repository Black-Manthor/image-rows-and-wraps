import { invertedEffects } from '@codemirror/commands';
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { parseRowText } from '../markdown/row-model';

// CodeMirror reads line heights again only when it redraws something, or when
// its content box changes size outside the few ms after an update. A row that
// changes height right after it appears (images composed or loaded) redraws
// nothing: its line keeps the old height in CodeMirror's height map and the
// line numbers below drift (measured in Obsidian: +23 px until the next click).
// The row reports its height as an attribute of its line: a new value redraws
// that line's attributes, and CodeMirror measures the lines again.
export const rowHeightEffect = StateEffect.define<{ line: number; height: number }>({
	map: ({ line, height }, mapping) => ({ line: mapping.mapPos(line), height }),
});

// The last height reported for the row on the line starting at `line`: a row
// drawn again starts at it, so CodeMirror never measures the empty widget.
export function knownRowHeight(state: EditorState, line: number): number | undefined {
	let height: number | undefined;
	state.field(heightField, false)?.between(line, line, (_from, _to, decoration) => {
		const value = Number((decoration.spec as { attributes?: Record<string, string> }).attributes?.['data-iw-row-height']);
		if (value > 0) height = value;
	});
	return height;
}

// A row moved from the line starting at `from` to the line starting at `to`
// (a position after the move): its known height goes with it, in the move's
// own transaction. Drawn anew there, the row starts at that height instead of
// unlaid out, and reporting the same height redraws nothing. None when unknown.
export function carriedRowHeight(state: EditorState, from: number, to: number): Array<StateEffect<{ line: number; height: number }>> {
	const height = knownRowHeight(state, from);
	return height === undefined ? [] : [rowHeightEffect.of({ line: to, height })];
}

const heightField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		value = value.map(tr.changes);
		// A line that is no longer a row of images (deleted, or edited into text)
		// drops its height. Only on text changes, which redraw those lines anyway:
		// dropping it when the caret enters a row would redraw the row.
		if (tr.docChanged) value = value.update({ filter: from => {
			const line = tr.state.doc.lineAt(from);
			return line.from === from && parseRowText(line.text) !== undefined;
		} });
		for (const effect of tr.effects) {
			if (!effect.is(rowHeightEffect)) continue;
			const { line, height } = effect.value;
			if (line > tr.state.doc.length || tr.state.doc.lineAt(line).from !== line) continue;
			value = value.update({
				filter: from => from !== line,
				add: [Decoration.line({ attributes: { 'data-iw-row-height': String(height) } }).range(line)],
			});
		}
		return value;
	},
	provide: field => EditorView.decorations.from(field),
});

// A change that carries a row's new height (a resize) keeps the old one in the
// history: Undo puts it back with the text, in the same transaction, and Redo
// the new one. Otherwise the row, laid out again at its old size, reported its
// height afterwards, and in Obsidian that redraws the row: its images showed
// for a frame at their unscaled size.
const heightHistory = invertedEffects.of(tr => {
	if (!tr.docChanged) return [];
	const inverse: Array<StateEffect<{ line: number; height: number }>> = [];
	for (const effect of tr.effects) {
		if (!effect.is(rowHeightEffect)) continue;
		const before = knownRowHeight(tr.startState, effect.value.line);
		if (before !== undefined && before !== effect.value.height) inverse.push(rowHeightEffect.of({ line: effect.value.line, height: before }));
	}
	return inverse;
});

export const rowHeightField: Extension = [heightField, heightHistory];
