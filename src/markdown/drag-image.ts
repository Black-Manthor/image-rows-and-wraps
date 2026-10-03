import { assertUnambiguous } from './command-zones';
import { ChangeSet, Text } from '@codemirror/state';
import { parseDocument, regionAt, wrapImage, type DocumentModel } from './model';
import { findRows, parseRowText, type ImageRow } from './row-model';
import { foreignRowComment } from './row-edits';
import { eolOf } from './text';
import { t } from '../i18n';

// A drop between two blocks (the image becomes a row of its own), or a slot
// inside a row: `row` is the row's line start, `slot` the index to insert at.
export type ImageDrop = { kind: 'text'; position: number } | { kind: 'row'; row: number; slot: number };

// Track list items and their indented/lazy continuation lines. Empty lines
// between them belong to the list, not to a top-level insertion boundary.
function insideListBoundary(model: DocumentModel, after: number): boolean {
	const membership: boolean[] = [];
	let indent = 0, inList = false, blank = false;
	for (const line of model.lines) {
		const text = line.text.replace(/\t/g, '    ');
		const marker = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(text);
		if (marker && line.active) {
			inList = true;
			indent = marker[0].length;
		} else if (text.trim() && inList && blank && text.search(/\S/) < indent) inList = false;
		membership.push(inList && Boolean(text.trim()));
		blank = !text.trim();
	}
	let before = after - 1, next = after;
	while (before >= 0 && !model.lines[before]!.text.trim()) before--;
	while (next < model.lines.length && !model.lines[next]!.text.trim()) next++;
	return Boolean(membership[before] && membership[next]);
}

// Only actual block boundaries are destinations; never split a sentence, list,
// fenced example or a frontmatter block, even if a UI adapter gives a bad offset.
function textBoundary(model: DocumentModel, length: number, position: number): boolean {
	if (position < 0 || position > length) return false;
	const after = model.lines.findIndex(line => line.from === position);
	if (after < 0) return position === length && Boolean(model.lines[model.lines.length - 1]?.active);
	const line = model.lines[after]!;
	const previous = model.lines[after - 1];
	if (insideListBoundary(model, after)) return false;
	if (!line.active || (previous && !previous.active)) return false;
	if (!previous || !line.text.trim() || !previous.text.trim()) return true;
	return model.regions.some(r => r.start === after || r.end === after - 1);
}

type Change = { from: number; to: number; insert: string };

// The row line rebuilt with other links: the comment (the row's settings) stays.
function rowLine(model: DocumentModel, row: ImageRow, links: string[]): string {
	const comment = row.comment ? model.lines[row.line]!.text.slice(row.comment.from).trim() : '';
	return links.join(' ') + (comment ? ` ${comment}` : '');
}

// Moves one image. Origins: an image of a row (the row keeps its comment while
// it has images; once empty it disappears, keeping only unknown comment tokens),
// the image of a wrap (its delimiters are removed), an image alone on its line
// (the line goes), or an image inside a line of text (only the link goes, with
// one space next to it: the text stays). Destinations: a slot in a row, or a boundary between
// blocks where it becomes a row of its own. Wraps are never entered. One
// ChangeSet, so one undo step.
export function moveDraggedImage(source: string, imageFrom: number, drop: ImageDrop,
	model: DocumentModel = parseDocument(source)) {
	assertUnambiguous(model, imageFrom, imageFrom);
	assertUnambiguous(model, drop.kind === 'text' ? drop.position : drop.row, drop.kind === 'text' ? drop.position : drop.row);
	const image = model.images.find(image => image.from === imageFrom);
	if (!image) throw new Error(t().imageNotFound);
	const rows = findRows(source, model);
	const line = model.lines[image.line]!;
	const next = model.lines[image.line + 1]?.from ?? source.length;
	const originRow = rows.find(row => row.line === image.line);
	const originRegion = originRow ? undefined : regionAt(model, imageFrom);
	// Only the image a wrap is laid out with takes the wrap's delimiters away.
	const originWrap = originRegion && wrapImage(model, originRegion)?.from === image.from ? originRegion : undefined;
	const inline = !originRow && line.text.trim() !== image.raw;
	const index = originRow ? originRow.images.findIndex(item => originRow.from + item.from === imageFrom) : 0;
	// The side is on the wrap's start marker: the link moves unchanged.
	const link = image.raw;
	const eol = eolOf(source);

	// What the origin becomes once the image has left.
	const originChanges: Change[] = [];
	if (inline) {
		// The link and one space next to it: "Prima ![[a]] dopo" -> "Prima dopo".
		const before = source[image.from - 1], after = source[image.to];
		const space = (char: string | undefined) => char === ' ' || char === '\t';
		const from = space(after) || !space(before) ? image.from : image.from - 1;
		const to = space(after) ? image.to + 1 : image.to;
		originChanges.push({ from, to, insert: '' });
	} else if (originRow && originRow.images.length > 1) {
		originChanges.push({ from: originRow.from, to: originRow.to,
			insert: rowLine(model, originRow, originRow.images.filter((_, i) => i !== index).map(item => item.raw)) });
	} else {
		const foreign = foreignRowComment(parseRowText(line.text)?.comment?.body);
		// The blank lines that separated the block go with it.
		const removal = !originWrap && !foreign ? blockRemoval(model, source, image.line, image.line) : { from: line.from, to: next, insert: '' };
		originChanges.push({ ...removal, insert: foreign ? foreign + eol : '' });
		// Leaving a wrap also removes its delimiters, keeping the text.
		if (originWrap) for (const at of [originWrap.start, originWrap.end]) {
			originChanges.push({ from: model.lines[at]!.from, to: model.lines[at + 1]?.from ?? source.length, insert: '' });
		}
	}
	originChanges.sort((a, b) => a.from - b.from);

	if (drop.kind === 'row') {
		const target = rows.find(row => row.from === drop.row);
		if (!target || drop.slot < 0 || drop.slot > target.images.length) throw new Error(t().chooseSlotInRow);
		const links = target.images.map(item => item.raw);
		let slot = drop.slot;
		if (target === originRow) {
			// Reordering: dropping on either side of itself changes nothing.
			if (slot === index || slot === index + 1) return undefined;
			links.splice(index, 1);
			if (slot > index) slot--;
			links.splice(slot, 0, link);
			const insert = rowLine(model, target, links);
			const cursor = target.from + links.slice(0, slot).reduce((length, item) => length + item.length + 1, 0);
			return { changes: ChangeSet.of({ from: target.from, to: target.to, insert }, source.length), cursor };
		}
		links.splice(slot, 0, link);
		const targetChange = { from: target.from, to: target.to, insert: rowLine(model, target, links) };
		const changes = ChangeSet.of([...originChanges, targetChange].sort((a, b) => a.from - b.from), source.length);
		const start = ChangeSet.of(originChanges, source.length).mapPos(target.from, -1);
		return { changes, cursor: start + links.slice(0, slot).reduce((length, item) => length + item.length + 1, 0) };
	}

	const insertion = drop.position;
	const region = regionAt(model, insertion);
	if (region && insertion !== model.lines[region.start]!.from) throw new Error(t().imageIntoWrap);
	if (!textBoundary(model, source.length, insertion)) throw new Error(t().dropBetweenBlocks);
	const alone = !originWrap && !inline && (!originRow || originRow.images.length === 1);
	if (alone && (insertion === line.from || insertion === next)) return undefined;
	return placeBlock(source, originChanges, insertion, link, eol);
}

// The origin removed and `block` inserted at `insertion` (an offset of the
// original text) as its own paragraph, in one ChangeSet. New blank lines are
// outside the block, whose bytes are kept. Undefined when the text would not
// change (next to its own place): no edit and no empty undo step.
function placeBlock(source: string, removal: Change[], insertion: number, block: string, eol: string) {
	const deletion = ChangeSet.of(removal, source.length);
	const position = deletion.mapPos(insertion, -1);
	const remaining = deletion.apply(Text.of(source.split('\n'))).toString();
	const before = remaining.slice(0, position), after = remaining.slice(position);
	const separator = (side: string, atEnd: boolean) => {
		if (!side) return '';
		const breaks = (atEnd ? side.match(/(?:\r?\n[\t ]*)+$/) : side.match(/^(?:[\t ]*\r?\n)+/))?.[0].match(/\n/g)?.length ?? 0;
		return eol.repeat(Math.max(0, 2 - breaks));
	};
	const prefix = separator(before, true);
	const suffix = separator(after, false);
	const changes = deletion.compose(ChangeSet.of({ from: position, insert: prefix + block + suffix }, deletion.newLength, '\n'));
	if (changes.apply(Text.of(source.split('\n'))).toString() === source) return undefined;
	return { changes, cursor: position + prefix.length };
}

// The lines of a block and the blank lines that separated it from what
// follows (from what precedes, at the end of the note): what leaves with it.
function blockRemoval(model: DocumentModel, source: string, first: number, last: number): Change {
	let from = model.lines[first]!.from, to = model.lines[last + 1]?.from ?? source.length;
	let after = last + 1;
	while (model.lines[after] && !model.lines[after]!.text.trim()) after++;
	if (model.lines[after]) to = model.lines[after]!.from;
	else {
		let before = first;
		while (before > 0 && !model.lines[before - 1]!.text.trim()) before--;
		from = before > 0 ? model.lines[before - 1]!.to : 0;
		to = source.length;
	}
	return { from, to, insert: '' };
}


// Moves the whole block on lines first..last to a boundary between blocks, in
// one ChangeSet. Its text and the note's other text stay identical; blank lines
// keep it a paragraph apart. Undefined on itself or right next to itself.
function moveBlock(source: string, model: DocumentModel, first: number, last: number, insertion: number, intoWrap: string, boundary: string) {
	const start = model.lines[first]!, end = model.lines[last]!;
	if (insertion >= start.from && insertion <= (model.lines[last + 1]?.from ?? source.length)) return undefined;
	const target = regionAt(model, insertion);
	if (target && insertion !== model.lines[target.start]!.from) throw new Error(intoWrap);
	if (!textBoundary(model, source.length, insertion)) throw new Error(boundary);
	const eol = eolOf(source);
	return placeBlock(source, [blockRemoval(model, source, first, last)], insertion, source.slice(start.from, end.to), eol);
}

// A whole wrap, markers included. `wrapFrom` is the start of its start marker line.
export function moveWrapBlock(source: string, wrapFrom: number, insertion: number, model: DocumentModel = parseDocument(source)) {
	assertUnambiguous(model, wrapFrom, wrapFrom);
	assertUnambiguous(model, insertion, insertion);
	const region = model.regions.find(candidate => model.lines[candidate.start]!.from === wrapFrom);
	if (!region) throw new Error(t().wrapNotFound);
	return moveBlock(source, model, region.start, region.end, insertion, t().wrapIntoWrap, t().dropWrapBetweenBlocks);
}

// A whole row of images, with its comment (its settings). `rowFrom` is the start of its line.
export function moveRowBlock(source: string, rowFrom: number, insertion: number, model: DocumentModel = parseDocument(source)) {
	assertUnambiguous(model, rowFrom, rowFrom);
	assertUnambiguous(model, insertion, insertion);
	const row = findRows(source, model).find(candidate => candidate.from === rowFrom);
	if (!row) throw new Error(t().rowNotFound);
	return moveBlock(source, model, row.line, row.line, insertion, t().rowIntoWrap, t().dropRowBetweenBlocks);
}
