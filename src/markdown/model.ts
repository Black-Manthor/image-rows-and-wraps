import { EMBED, maskCodeSpans } from './text';
import { t } from '../i18n';

export const START = '[wrap:start]';
export const END = '[wrap:end]';
export type WrapSide = 'left' | 'right';
interface SourceLine { text: string; from: number; to: number; active: boolean }
export interface ImageLink { from: number; to: number; line: number; raw: string; path: string }
// The plugin's comment on the start marker line: `%%iw-wrap side=left%%`.
// Offsets are relative to that line.
export interface WrapComment { from: number; to: number; body: string }
// `first`/`last` are the first and last content lines; an empty wrap has
// first = end and last = start. The side is read from the start marker.
export interface Region { start: number; end: number; first: number; last: number; side: WrapSide; comment?: WrapComment }
interface Diagnostic { line: number; message: string }
export interface DocumentModel {
	lines: SourceLine[]; images: ImageLink[]; regions: Region[]; diagnostics: Diagnostic[];
}

// The start marker, alone or followed by the plugin's comment.
const START_LINE = /^\[wrap:start\](?:[ \t]*(%%iw-wrap(?:[ \t]([^%\n]*))?%%))?$/;

export function markerKind(text: string): 'start' | 'end' | undefined {
	const trimmed = text.trim();
	return trimmed === END ? 'end' : START_LINE.test(trimmed) ? 'start' : undefined;
}

// The start marker line the commands write: the side is always explicit, so
// the source shows which wrap it is. Unknown tokens follow it.
export function startMarker(side: WrapSide, extra: string[] = []): string {
	return `${START} %%iw-wrap ${[`side=${side}`, ...extra].join(' ')}%%`;
}

export function unknownWrapTokens(body: string | undefined): string[] {
	return (body ?? '').split(/\s+/).filter(token => token && !token.startsWith('side='));
}

// Invalid or missing: left, the default. Unknown tokens are kept by the edits.
function parseWrapSide(body: string | undefined): WrapSide {
	let side: WrapSide = 'left';
	for (const token of (body ?? '').split(/\s+/)) if (token === 'side=right') side = 'right'; else if (token === 'side=left') side = 'left';
	return side;
}

function startComment(text: string): WrapComment | undefined {
	const match = START_LINE.exec(text.trim());
	if (!match?.[1]) return undefined;
	const from = text.indexOf(match[1]);
	return { from, to: from + match[1].length, body: (match[2] ?? '').trim() };
}

export function isImagePath(path: string): boolean {
	return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path);
}

// CommonMark HTML blocks that a blank line does not end (types 1, 3, 4, 5):
// their content is raw text, never Markdown. A `<div>` ends at a blank line
// and is not listed: the paragraph after it is ordinary Markdown.
const RAW_HTML_BLOCKS: Array<[RegExp, RegExp]> = [
	[/^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i],
	[/^ {0,3}<\?/, /\?>/],
	[/^ {0,3}<![A-Za-z]/, />/],
	[/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];

// Top-level Markdown only. Code, frontmatter and comments are never command targets.
function scanLines(source: string): SourceLine[] {
	let offset = 0;
	let fence = '';
	let fenceLength = 0;
	let comment = false;
	let htmlEnd: RegExp | undefined;
	let hiddenComment = false;
	let frontmatter = false;
	return source.split('\n').map((raw, index) => {
		const text = raw.replace(/\r$/, '');
		// Recognize fences even in quoted/list examples; never interpret their body.
		const fenceText = text.replace(/^ {0,3}(?:> ?)+/, '')
			.replace(/^ {0,3}(?:[-+*]|\d+[.)]) +/, '');
		const from = offset;
		offset += raw.length + 1;
		let active = true;
		if (hiddenComment) {
			if ((text.match(/%%/g)?.length ?? 0) % 2) hiddenComment = false;
			return { text, from, to: from + text.length, active: false };
		}
		if (index === 0 && text === '---') frontmatter = true;
		if (frontmatter) {
			active = false;
			if (index > 0 && /^(---|\.\.\.)\s*$/.test(text)) frontmatter = false;
		} else if (fence) {
			active = false;
			const close = /^ {0,3}(`+|~+)\s*$/.exec(fenceText)?.[1];
			if (close?.[0] === fence && close.length >= fenceLength) fence = '';
		} else if (comment) {
			active = false;
			if (text.includes('-->')) comment = false;
		} else if (htmlEnd) {
			active = false;
			if (htmlEnd.test(text)) htmlEnd = undefined;
		} else {
			const html = RAW_HTML_BLOCKS.find(([start]) => start.test(text));
			const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(fenceText);
			if (html) {
				// The end condition may already be on the opening line.
				active = false;
				if (!html[1].test(text.replace(html[0], ''))) htmlEnd = html[1];
			} else if (open?.[1] && !(open[1][0] === '`' && open[2]?.includes('`'))) {
				fence = open[1][0] ?? '';
				fenceLength = open[1].length;
				active = false;
			} else if (/^(?: {4}|\t| {0,3}>)/.test(text)) {
				active = false;
			} else if (text.includes('<!--')) {
				active = false;
				comment = text.lastIndexOf('<!--') > text.lastIndexOf('-->');
			}
		}
		if (active) {
			const wasHidden = hiddenComment;
			const visible = maskCodeSpans(text);
			if ((visible.match(/%%/g)?.length ?? 0) % 2) hiddenComment = !hiddenComment;
			if (wasHidden || hiddenComment) active = false;
		}
		return { text, from, to: from + text.length, active };
	});
}

export function parseDocument(source: string): DocumentModel {
	const lines = scanLines(source);
	const images: ImageLink[] = [];
	const regions: Region[] = [];
	const diagnostics: Diagnostic[] = [];
	let start = -1;
	let depth = 0;
	let invalid = false;
	lines.forEach((line, index) => {
		if (!line.active) return;
		const marker = markerKind(line.text);
		if (marker === 'start') {
			if (depth === 0) { start = index; invalid = false; }
			else { invalid = true; diagnostics.push({ line: index, message: t().nestedMarkers }); }
			depth++;
		} else if (marker === 'end') {
			if (depth === 0) diagnostics.push({ line: index, message: t().endWithoutStart });
			else if (--depth === 0 && !invalid) {
				let first = start + 1;
				let last = index - 1;
				while (first < index && !lines[first]?.text.trim()) first++;
				while (last > start && !lines[last]?.text.trim()) last--;
				const comment = startComment(lines[start]!.text);
				regions.push({ start, end: index, first, last, side: parseWrapSide(comment?.body), ...(comment ? { comment } : {}) });
			}
		}
		const visible = maskCodeSpans(line.text).replace(/%%.*?%%/g, match => ' '.repeat(match.length));
		for (const match of visible.matchAll(EMBED)) {
			const indexInLine = match.index;
			const slashes = line.text.slice(0, indexInLine).match(/\\+$/)?.[0].length ?? 0;
			if (slashes % 2) continue;
			// The masked text only locates links (same offsets): what is kept and
			// rewritten comes from the source, or code inside an alias would be lost.
			const raw = line.text.slice(indexInLine, indexInLine + match[0].length);
			const path = raw.slice(3, -2).split('|')[0] ?? '';
			if (!isImagePath(path)) continue;
			images.push({ from: line.from + indexInLine, to: line.from + indexInLine + raw.length, line: index, raw, path });
		}
	});
	if (depth) diagnostics.push({ line: start, message: t().startWithoutEnd });
	return { lines, images, regions, diagnostics };
}

// The image a wrap is laid out with: alone on its line, as the first content
// of the region. Views, commands and dragging share this rule, so none of them
// can touch the text of a region the views do not lay out.

// Indexed once per model: callers ask for every region and image of long notes.
const indexes = new WeakMap<DocumentModel, { alone: Map<number, ImageLink>; regions: Map<number, Region> }>();

function wrapIndex(model: DocumentModel) {
	let index = indexes.get(model);
	if (index) return index;
	const alone = new Map<number, ImageLink>();
	for (const image of model.images) if (model.lines[image.line]?.text.trim() === image.raw) alone.set(image.line, image);
	const regions = new Map<number, Region>();
	for (const region of model.regions) {
		const image = region.first < region.end ? alone.get(region.first) : undefined;
		if (image) regions.set(image.from, region);
	}
	index = { alone, regions };
	indexes.set(model, index);
	return index;
}

export function wrapImage(model: DocumentModel, region: Region): ImageLink | undefined {
	return region.first < region.end ? wrapIndex(model).alone.get(region.first) : undefined;
}

// A marker line with a blank line (or the note's edge) before and after: a
// paragraph of its own, as the commands write it.
export function markerOnOwnParagraph(model: DocumentModel, line: number): boolean {
	const blank = (index: number) => !model.lines[index]?.text.trim();
	return blank(line - 1) && blank(line + 1);
}

// Wraps laid out in Live Preview and Reading whose start or end marker touches
// the text: the old compact form, which PDF export leaves as it is.
export function compactWraps(model: DocumentModel): Region[] {
	return model.regions.filter(region => wrapImage(model, region) &&
		!(markerOnOwnParagraph(model, region.start) && markerOnOwnParagraph(model, region.end)));
}

export function regionForImage(model: DocumentModel, image: ImageLink): Region | undefined {
	return wrapIndex(model).regions.get(image.from);
}

export function imageClass(model: DocumentModel, image: ImageLink): string | undefined {
	const region = regionForImage(model, image);
	return region ? `iw-${region.side}` : undefined;
}

// The wrap containing `position`, markers included.
export function regionAt(model: DocumentModel, position: number): Region | undefined {
	return model.regions.find(region => position >= model.lines[region.start]!.from && position <= model.lines[region.end]!.to);
}

// The wraps a cursor or selection touches.
export function regionsTouching(model: DocumentModel, from: number, to: number): Region[] {
	return model.regions.filter(region => from <= model.lines[region.end]!.to && to >= model.lines[region.start]!.from);
}

// Whether a selection reaches text outside the wrap (blank space around it does not count).
export function selectionLeavesRegion(source: string, model: DocumentModel, region: Region, from: number, to: number): boolean {
	const start = model.lines[region.start]!, end = model.lines[region.end]!;
	return Boolean((from < start.from && source.slice(from, start.from).trim()) || (to > end.to && source.slice(end.to, to).trim()));
}

// The first line with text after the wrap's first content line (its image).
export function firstTextLine(model: DocumentModel, region: Region): number {
	let line = region.first + 1;
	while (line < region.end && !model.lines[line]?.text.trim()) line++;
	return line;
}
