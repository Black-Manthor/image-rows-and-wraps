import { assertUnambiguous } from './command-zones';
import { END, START, parseDocument, regionAt, regionsTouching, selectionLeavesRegion, startMarker, unknownWrapTokens, type DocumentModel, type Region, type WrapSide } from './model';
import { markerZones } from './row-model';
import { combineChanges, type Change, type Edit } from './edits';
import { eolOf } from './text';
import { t } from '../i18n';

// The one wrap a cursor or selection is in; a selection may include the
// wrap's own lines but no text outside it.
function wrapAt(model: DocumentModel, source: string, from: number, to: number): Region {
	assertUnambiguous(model, from, to);
	const regions = regionsTouching(model, from, to);
	const region = regions[0];
	if (regions.length !== 1 || !region) throw new Error(t().cursorInOneWrap);
	if (selectionLeavesRegion(source, model, region, from, to)) throw new Error(t().selectionCrossesWrap);
	return region;
}

// The start marker line rewritten with the given side, unknown tokens kept.
function startChange(model: DocumentModel, region: Region, side: WrapSide) {
	const line = model.lines[region.start]!;
	const at = line.from + line.text.indexOf(START);
	return { from: at, to: line.to, insert: startMarker(side, unknownWrapTokens(region.comment?.body)) };
}

// Deletes only the two delimiters, with the blank lines that separated them
// from the content: text, formatting and links stay identical.
export function removeWrap(source: string, from: number, to: number): Edit {
	const model = parseDocument(source);
	const region = wrapAt(model, source, from, to);
	const lines = model.lines;
	const start = lines[region.start]!;
	const end = lines[region.end]!;
	const next = lines[region.end + 1];
	if (region.first > region.last) {
		// An empty wrap goes with one of the blank lines around it.
		const after = next && !next.text.trim() ? lines[region.end + 2] : next;
		return { from: start.from, to: after?.from ?? end.to, text: '' };
	}
	const eol = eolOf(source);
	const content = source.slice(lines[region.first]!.from, lines[region.last]!.to);
	return { from: start.from, to: next?.from ?? end.to, text: content + (next ? eol : '') };
}

// Only the side in the start marker's comment changes: the image stays as it is.
export function toggleWrapSide(source: string, from: number, to: number): Edit {
	const model = parseDocument(source);
	const region = wrapAt(model, source, from, to);
	const change = startChange(model, region, region.side === 'left' ? 'right' : 'left');
	return { from: change.from, to: change.to, text: change.insert };
}

// Brings every wrap of the note to the current form, in one edit:
// - a blank line between each marker and the text it touches, so Reading view
//   draws the wrap as one block (reading-wrap.ts);
// - the side in the start marker's comment, written when missing and
//   corrected to left when invalid (unknown tokens are kept).
// Malformed markers are left alone. The caret keeps its character.
export function fixWraps(source: string, caret: number): Edit {
	const model = parseDocument(source);
	const changes = formatChanges(source, model, model.regions);
	if (!changes.length) throw new Error(t().wrapsInOrder);
	return combineChanges(source, changes, caret);
}

// The same, for the one wrap at `position` (its bar in Live Preview, on a
// compact wrap): the rest of the note stays as it is.
export function fixWrap(source: string, position: number): Edit {
	const model = parseDocument(source);
	const region = regionAt(model, position);
	if (!region) throw new Error(t().wrapNotFoundChanged);
	const changes = formatChanges(source, model, [region]);
	if (!changes.length) throw new Error(t().wrapInOrder);
	return combineChanges(source, changes, position);
}

function formatChanges(source: string, model: DocumentModel, regions: Region[]): Change[] {
	const lines = model.lines;
	const blank = (index: number) => !lines[index]?.text.trim();
	const eol = eolOf(source);
	const changes: Change[] = [];
	const breaks = new Set<number>();
	for (const region of regions) {
		for (const index of [region.start, region.end]) {
			if (index > 0 && !blank(index - 1)) breaks.add(lines[index]!.from);
			if (index + 1 < lines.length && !blank(index + 1)) breaks.add(lines[index + 1]!.from);
		}
		const start = startChange(model, region, region.side);
		if (source.slice(start.from, start.to) !== start.insert) changes.push(start);
	}
	for (const at of breaks) changes.push({ from: at, to: at, insert: eol });
	return changes;
}

// Adds only the two delimiters around whole blocks (the one under the cursor,
// or those the selection touches): text, images and their parameters stay
// identical. The wrap is laid out once its first block is an image alone on
// its line; the side is on the start marker (left for a new wrap).
export function addWrapMarkers(source: string, from: number, to: number): Edit {
	const model = parseDocument(source);
	assertUnambiguous(model, from, to);
	const lines = model.lines;
	const lineAt = (position: number) => {
		let found = 0;
		lines.forEach((line, index) => { if (line.from <= position) found = index; });
		return found;
	};
	let first = lineAt(from);
	// A selection ending at the start of a line does not include that line.
	let last = to > from && lines.some(line => line.from === to) ? lineAt(to - 1) : lineAt(to);
	while (first < last && !lines[first]!.text.trim()) first++;
	while (last > first && !lines[last]!.text.trim()) last--;
	if (!lines[first]!.text.trim()) throw new Error(t().placeCursorOnParagraph);
	while (first > 0 && lines[first - 1]!.text.trim()) first--;
	while (last + 1 < lines.length && lines[last + 1]!.text.trim()) last++;
	if (markerZones(model).some(([start, end]) => start <= last && end >= first)) throw new Error(t().alreadyInWrap);
	if (lines.slice(first, last + 1).some(line => !line.active)) {
		throw new Error(t().wrapOnlyTextAndImages);
	}
	const eol = eolOf(source);
	const start = lines[first]!.from, end = lines[last]!.to;
	const prefix = startMarker('left') + eol + eol;
	return { from: start, to: end, text: prefix + source.slice(start, end) + eol + eol + END,
		cursor: Math.max(from, start) + prefix.length };
}
