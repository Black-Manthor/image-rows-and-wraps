import { isImagePath, markerKind, parseDocument, type DocumentModel } from './model';
import { EMBED } from './text';

// Image rows: a top-level paragraph made only of image wikilinks, optionally
// followed by the plugin's `%%iw-row …%%` comment. Shared by Live Preview,
// Reading view and PDF export.

export const REFERENCE_WIDTH = 700;

export type RowAlign = 'left' | 'center' | 'right' | 'between' | 'evenly';
export type RowValign = 'top' | 'center' | 'bottom';
export interface RowSettings { align: RowAlign; valign: RowValign; gap: number }
export const DEFAULT_ROW_SETTINGS: RowSettings = { align: 'left', valign: 'top', gap: 12 };

const ALIGNS: readonly string[] = ['left', 'center', 'right', 'between', 'evenly'];
const VALIGNS: readonly string[] = ['top', 'center', 'bottom'];
export const ROW_ALIGNS = ALIGNS as readonly RowAlign[];
export const ROW_VALIGNS = VALIGNS as readonly RowValign[];

export interface RowImage { raw: string; path: string; params: string[]; width?: number; from: number; to: number }
export interface RowComment { from: number; to: number; body: string }
export interface ImageRow {
	line: number; from: number; to: number;
	images: RowImage[]; comment?: RowComment; settings: RowSettings;
}

const COMMENT = /%%iw-row(?:[ \t]([^%\n]*))?%%[ \t]*$/;

// Invalid or unknown values fall back to the default of that key only.
export function parseRowSettings(body: string | undefined, defaults: RowSettings = DEFAULT_ROW_SETTINGS): RowSettings {
	const settings = { ...defaults };
	for (const token of (body ?? '').split(/\s+/)) {
		const [key, value = ''] = token.split('=', 2);
		if (key === 'align' && ALIGNS.includes(value)) settings.align = value as RowAlign;
		else if (key === 'valign' && VALIGNS.includes(value)) settings.valign = value as RowValign;
		else if (key === 'gap' && /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value))) settings.gap = Number(value);
	}
	return settings;
}

// Obsidian's size parameter: `|300` or `|300x200`; the width is what matters.
export function desiredWidth(params: string[]): number | undefined {
	for (const param of params) {
		const width = Number(/^(\d+)(?:x\d+)?$/.exec(param)?.[1]);
		if (width > 0 && Number.isFinite(width)) return width;
	}
	return undefined;
}

// Offsets are relative to the line. The comment may be attached to the last link.
export function parseRowText(text: string): { images: RowImage[]; comment?: RowComment } | undefined {
	const match = COMMENT.exec(text);
	const end = match ? match.index : text.length;
	const images: RowImage[] = [];
	let cursor = 0;
	for (const embed of text.slice(0, end).matchAll(EMBED)) {
		if (text.slice(cursor, embed.index).trim()) return undefined;
		const [path = '', ...rest] = (embed[1] ?? '').split('|').map(part => part.trim());
		if (!isImagePath(path)) return undefined;
		images.push({ raw: embed[0], path, params: rest, width: desiredWidth(rest),
			from: embed.index, to: embed.index + embed[0].length });
		cursor = embed.index + embed[0].length;
	}
	if (!images.length || text.slice(cursor, end).trim()) return undefined;
	return { images, ...(match ? { comment: { from: match.index, to: text.length, body: (match[1] ?? '').trim() } } : {}) };
}

// Wrap regions, plus ambiguous zones around malformed markers: an opening
// without its end blocks everything after it, a stray end everything back to
// the previous closed region. Rows are never recognized inside these zones.
export function markerZones(model: DocumentModel): Array<[number, number]> {
	const zones: Array<[number, number]> = [];
	const open: number[] = [];
	let boundary = 0;
	model.lines.forEach((line, index) => {
		if (!line.active) return;
		const marker = markerKind(line.text);
		if (marker === 'start') open.push(index);
		else if (marker === 'end') {
			const start = open[0] ?? boundary;
			open.pop();
			if (!open.length) { zones.push([start, index]); boundary = index + 1; }
		}
	});
	if (open.length) zones.push([open[0]!, model.lines.length - 1]);
	return zones;
}

export function findRows(source: string, model: DocumentModel = parseDocument(source),
	defaults: RowSettings = DEFAULT_ROW_SETTINGS): ImageRow[] {
	// One pass over the zones, not one per line: long notes have many wraps.
	const zoned = new Uint8Array(model.lines.length);
	for (const [start, end] of markerZones(model)) zoned.fill(1, start, end + 1);
	const blank = (index: number) => !model.lines[index]?.text.trim();
	const rows: ImageRow[] = [];
	model.lines.forEach((line, index) => {
		// A dedicated top-level paragraph: blank lines around it, no indentation
		// (which could make it a list continuation), no code, quote or comment.
		if (!line.active || !blank(index - 1) || !blank(index + 1) || /^\s/.test(line.text)) return;
		if (zoned[index]) return;
		// Other parameters (for example a leftover `center`) are ignored.
		const parsed = parseRowText(line.text);
		if (!parsed) return;
		rows.push({ line: index, from: line.from, to: line.to, images: parsed.images,
			...(parsed.comment ? { comment: parsed.comment } : {}),
			settings: parseRowSettings(parsed.comment?.body, defaults) });
	});
	return rows;
}
