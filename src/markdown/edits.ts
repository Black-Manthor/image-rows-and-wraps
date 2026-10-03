import { assertUnambiguous } from './command-zones';
import { markerKind, parseDocument, type ImageLink } from './model';
import { t } from '../i18n';
export interface Change { from: number; to: number; insert: string }
// One replacement from `from` to `to`. `changes`, when present, are the same
// edit as separate changes of the original text (sorted, not overlapping):
// applied as they are, the text between them is left alone.
export interface Edit { from: number; to: number; text: string; cursor?: number; changes?: Change[] }

export function targetImage(source: string, from: number, to: number): ImageLink {
	const model = parseDocument(source);
	const selected = model.images.filter(image => from === to
		? from >= image.from && from <= image.to
		: image.from >= from && image.to <= to);
	if (selected.length === 1 && selected[0]) return selected[0];
	if (from === to && !selected.length) {
		const onLine = model.images.filter(image => {
			const line = model.lines[image.line];
			return line && from >= line.from && from <= line.to;
		});
		if (onLine.length === 1 && onLine[0]) return onLine[0];
	}
	throw new Error(t().placeCursorOnImage);
}

// The whole lines a selection covers, when they are ordinary Markdown outside
// any wrap: what a new wrap will enclose.
export function wrapRange(source: string, from: number, to: number): { from: number; to: number } {
	if (from === to) throw new Error(t().selectImageAndText);
	const model = parseDocument(source);
	const first = model.lines.find(line => from >= line.from && from <= line.to);
	const last = [...model.lines].reverse().find(line => line.from < to);
	if (!first?.active || !last?.active) throw new Error(t().selectionInMarkdown);
	const a = model.lines.indexOf(first);
	const b = model.lines.indexOf(last);
	assertUnambiguous(model, first.from, last.to);
	if (model.regions.some(region => a <= region.end && b >= region.start) ||
		model.lines.slice(a, b + 1).some(line => line.active && markerKind(line.text))) {
		throw new Error(t().fixMarkersOverlap);
	}
	return { from: first.from, to: last.to };
}

// Several changes as one edit (one undo step): the span from the first to the
// last, rebuilt. The caret keeps its character; inside a replaced range it
// goes after the replacement. Changes must not overlap; an insertion may share
// its position with the start of a replacement.
export function combineChanges(source: string, changes: Change[], caret: number): Edit {
	const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
	const from = sorted[0]!.from;
	const to = Math.max(...sorted.map(change => change.to));
	let text = '';
	let position = from;
	let cursor = caret;
	for (const change of sorted) {
		text += source.slice(position, change.from) + change.insert;
		position = change.to;
		if (change.to <= caret) cursor += change.insert.length - (change.to - change.from);
		else if (change.from < caret) cursor += change.from + change.insert.length - caret;
	}
	return { from, to, text, cursor, changes: sorted };
}
