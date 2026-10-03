import { assertUnambiguous } from './command-zones';
import type { Edit } from './edits';
import { parseDocument, type DocumentModel } from './model';
import { DEFAULT_ROW_SETTINGS, findRows, type ImageRow, type RowImage, type RowSettings } from './row-model';
import { formatRowComment, rowSettingsEdit, unknownTokens } from './row-edits';
import { eolOf } from './text';
import { t } from '../i18n';

// Composition commands for image rows: text-only edits, one replacement each.

export type RowAction = 'row-merge' | 'row-separate' | 'row-split-before' | 'row-move-left' | 'row-move-right';

function commentOf(tokens: string[]): string {
	const comment = formatRowComment(tokens);
	return comment ? ` ${comment}` : '';
}

function tokensOf(row: ImageRow): string[] {
	return (row.comment?.body ?? '').split(/\s+/).filter(Boolean);
}

// A row keeps its comment exactly as written, attached after one space.
function rowText(images: RowImage[], tokens: string[]): string {
	return images.map(image => image.raw).join(' ') + commentOf(tokens);
}

// Only blank lines between two rows: they are neighbouring blocks.
function adjacent(model: DocumentModel, first: ImageRow, second: ImageRow): boolean {
	return model.lines.slice(first.line + 1, second.line).every(line => !line.text.trim());
}

function rowAt(rows: ImageRow[], position: number): ImageRow | undefined {
	return rows.find(row => position >= row.from && position <= row.to);
}

function imageIndexAt(row: ImageRow, from: number, to: number): number {
	const matches = row.images.map((image, index) => ({ image, index })).filter(({ image }) => from === to
		? from >= row.from + image.from && from <= row.from + image.to
		: from >= row.from + image.from && to <= row.from + image.to);
	if (matches.length !== 1) throw new Error(t().placeCursorOnRowImage);
	return matches[0]!.index;
}

function merge(model: DocumentModel, rows: ImageRow[], from: number, to: number): Edit {
	let group: ImageRow[];
	if (from === to) {
		const row = rowAt(rows, from);
		if (!row) throw new Error(t().placeCursorOnRow);
		const index = rows.indexOf(row);
		const next = rows[index + 1];
		const previous = rows[index - 1];
		if (next && adjacent(model, row, next)) group = [row, next];
		else if (previous && adjacent(model, previous, row)) group = [previous, row];
		else throw new Error(t().noNearbyRow);
	} else {
		group = rows.filter(row => row.from <= to && row.to >= from);
		const firstLine = model.lines.findIndex(line => from >= line.from && from <= line.to);
		const lastLine = model.lines.findIndex(line => to >= line.from && to <= line.to);
		const covered = model.lines.slice(firstLine, lastLine + 1);
		const rowLines = new Set(group.map(row => row.line));
		if (group.length < 2 || covered.some((line, offset) => line.text.trim() && !rowLines.has(firstLine + offset))) {
			throw new Error(t().selectTwoRows);
		}
	}
	// The row under the cursor (or where the selection starts) keeps its settings;
	// from the other rows only unknown tokens survive.
	const keeper = rowAt(group, from) ?? group[0]!;
	const tokens = tokensOf(keeper);
	for (const row of group) if (row !== keeper) {
		for (const token of unknownTokens(row.comment?.body)) if (!tokens.includes(token)) tokens.push(token);
	}
	const first = group[0]!;
	const last = group[group.length - 1]!;
	return { from: first.from, to: last.to, text: rowText(group.flatMap(row => row.images), tokens), cursor: first.from };
}

function separate(source: string, row: ImageRow): Edit {
	if (row.images.length < 2) throw new Error(t().rowHasOneImage);
	const eol = eolOf(source);
	return { from: row.from, to: row.to, cursor: row.from,
		text: row.images.map(image => rowText([image], tokensOf(row))).join(eol + eol) };
}

function splitBefore(source: string, row: ImageRow, index: number): Edit {
	if (index === 0) throw new Error(t().splitAtFirstImage);
	const eol = eolOf(source);
	const before = rowText(row.images.slice(0, index), tokensOf(row));
	return { from: row.from, to: row.to, cursor: row.from + before.length + eol.length * 2,
		text: before + eol + eol + rowText(row.images.slice(index), tokensOf(row)) };
}

function move(source: string, row: ImageRow, index: number, direction: -1 | 1, from: number): Edit {
	const neighbour = index + direction;
	if (neighbour < 0) throw new Error(t().alreadyFirst);
	if (neighbour >= row.images.length) throw new Error(t().alreadyLast);
	const image = row.images[index]!;
	const left = row.images[Math.min(index, neighbour)]!;
	const right = row.images[Math.max(index, neighbour)]!;
	const between = source.slice(row.from + left.to, row.from + right.from);
	// Keep the caret at the same place inside the moved link.
	const offset = Math.max(0, Math.min(from - (row.from + image.from), image.raw.length));
	const movedStart = direction < 0 ? row.from + left.from : row.from + left.from + right.raw.length + between.length;
	return { from: row.from + left.from, to: row.from + right.to, text: right.raw + between + left.raw, cursor: movedStart + offset };
}

export function rowAction(source: string, from: number, to: number, action: RowAction,
	defaults: RowSettings = DEFAULT_ROW_SETTINGS): Edit {
	const model = parseDocument(source);
	assertUnambiguous(model, from, to);
	const rows = findRows(source, model, defaults);
	if (action === 'row-merge') return merge(model, rows, from, to);
	const row = rowAt(rows, from);
	if (!row || to > row.to) throw new Error(t().placeCursorOnRow);
	if (action === 'row-separate') return separate(source, row);
	const index = imageIndexAt(row, from, to);
	if (action === 'row-split-before') return splitBefore(source, row, index);
	return move(source, row, index, action === 'row-move-left' ? -1 : 1, from);
}

// Changes some settings of the row at `position`; the other keys and unknown
// tokens are kept, keys equal to the defaults are omitted (row-edits.ts).
// `expected` is the row text when the choice started (a menu or dialog stays
// open while the note may change): a different row there means no edit.
export function rowSettingsAction(source: string, position: number, patch: Partial<RowSettings>,
	defaults: RowSettings = DEFAULT_ROW_SETTINGS, expected?: string): Edit {
	const model = parseDocument(source);
	assertUnambiguous(model, position, position);
	const row = rowAt(findRows(source, model, defaults), position);
	if (expected !== undefined && (!row || source.slice(row.from, row.to) !== expected)) throw new Error(t().rowChangedWhileChoosing);
	if (!row) throw new Error(t().placeCursorOnRow);
	return rowSettingsEdit(row, { ...row.settings, ...patch }, defaults);
}

export function rowAtPosition(source: string, position: number, defaults: RowSettings = DEFAULT_ROW_SETTINGS): ImageRow | undefined {
	return rowAt(findRows(source, parseDocument(source), defaults), position);
}
