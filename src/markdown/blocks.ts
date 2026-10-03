import { parseDocument } from './model';
import { findRows } from './row-model';
import { EMBED } from './text';

// Source blocks and their alignment with exported top-level children, by order
// and embedded paths. Export has no section info: this is how rows are found.

export interface SectionRange { type: string; lineStart: number; lineEnd: number }
export interface SourceBlock extends SectionRange { paths: string[]; row?: { settings: string | null } }
export interface ExportBlock { kind: string; paths: string[] }

// In tables the alias pipe is escaped as `\|`: drop the escaping backslash.
export function linkPath(inner: string): string {
	return (inner.split('|')[0] ?? '').replace(/\\$/, '').trim();
}

// Used only when the metadata cache has no sections: blank lines separate
// blocks, fenced code stays whole.
export function fallbackSections(lines: string[]): SectionRange[] {
	const sections: SectionRange[] = [];
	let start = -1;
	let fence = '';
	const close = (end: number) => {
		if (start < 0) return;
		const first = lines[start] ?? '';
		const type = /^\s{0,3}(`{3,}|~{3,})/.test(first) ? 'code' : /^\s{0,3}#/.test(first) ? 'heading'
			: /^\s{0,3}>/.test(first) ? 'blockquote' : /^\s{0,3}([-+*]|\d+[.)])\s/.test(first) ? 'list' : 'paragraph';
		sections.push({ type, lineStart: start, lineEnd: end });
		start = -1;
	};
	lines.forEach((line, index) => {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = '';
			return;
		}
		if (marker) { if (start < 0) start = index; fence = marker; return; }
		if (!line.trim()) close(index - 1);
		else if (start < 0) start = index;
	});
	close(lines.length - 1);
	return sections;
}

export function sourceBlocks(source: string, sections?: SectionRange[]): SourceBlock[] {
	const lines = source.split('\n').map(line => line.replace(/\r$/, ''));
	const model = parseDocument(source);
	const rows = new Map(findRows(source, model).map(row => [row.line, row]));
	return (sections ?? fallbackSections(lines)).map(section => {
		const text = lines.slice(section.lineStart, section.lineEnd + 1);
		const paths = ['code', 'yaml', 'comment'].includes(section.type) ? [] : text.flatMap(line =>
			Array.from(line.replace(/(`+)[\s\S]*?\1/g, '').replace(/%%[\s\S]*?%%/g, '').matchAll(EMBED))
				.map(match => linkPath(match[1] ?? '')));
		const row = section.type === 'paragraph' && section.lineStart === section.lineEnd ? rows.get(section.lineStart) : undefined;
		return { ...section, paths, ...(row ? { row: { settings: row.comment?.body ?? null } } : {}) };
	});
}

function score(source: SourceBlock, exported: ExportBlock): number {
	if (source.row && exported.kind !== 'paragraph') return -Infinity;
	if (source.paths.length || exported.paths.length) {
		const same = source.paths.length === exported.paths.length &&
			source.paths.every((path, index) => path === exported.paths[index]);
		return same ? 3 : -Infinity;
	}
	return source.type === exported.kind ? 2 : 1;
}

// Order-preserving alignment that maximizes compatibility. Blocks with embeds
// match only blocks with the same embeds in the same order; identical rows are
// therefore paired by position. Returns [sourceIndex, exportedIndex] pairs.
export function alignBlocks(source: SourceBlock[], exported: ExportBlock[]): Array<[number, number]> {
	const rows = source.length;
	const columns = exported.length;
	const best = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
	for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--) {
		const pair = score(source[i]!, exported[j]!) + best[i + 1]![j + 1]!;
		best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, pair);
	}
	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < columns) {
		const pair = score(source[i]!, exported[j]!);
		if (Number.isFinite(pair) && best[i]![j] === pair + best[i + 1]![j + 1]!) { pairs.push([i, j]); i++; j++; }
		else if (best[i]![j] === best[i + 1]![j]) i++;
		else j++;
	}
	// A chosen optimal path is not evidence of an unambiguous row match.
	// Check all optimal paths: a row that can be skipped or paired elsewhere
	// must remain native rather than receiving another occurrence's settings.
	const prefix = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
	for (let a = 0; a < rows; a++) for (let b = 0; b < columns; b++) {
		prefix[a + 1]![b + 1] = Math.max(prefix[a]![b + 1]!, prefix[a + 1]![b]!,
			prefix[a]![b]! + score(source[a]!, exported[b]!));
	}
	const optimum = best[0]![0]!;
	return pairs.filter(([a, b]) => {
		if (!source[a]!.row) return true;
		for (let k = 0; k <= columns; k++) {
			if (prefix[a]![k]! + best[a + 1]![k]! === optimum) return false;
			if (k !== b && k < columns && prefix[a]![k]! + score(source[a]!, exported[k]!) + best[a + 1]![k + 1]! === optimum) return false;
		}
		return true;
	});
}

// A top-level block as drawn: its kind (as `kindOf` in rendering/block-kinds.ts,
// but of the block itself), its embeds, and how many items it shows: a list's
// items, nested ones included, or a table's rows.
export interface RenderedBlock { kind: string; paths: string[]; items?: number }

// Markdown marks before the text of a line, by the kind of its block: the caret
// goes after them, at the start of the text.
const MARKS: Record<string, RegExp> = {
	list: /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/, blockquote: /^\s*(?:>\s?)+/,
	callout: /^\s*(?:>\s?)+(?:\[![^\]]*\][+-]?\s*)?/, heading: /^\s*#{1,6}\s+/, table: /^\s*\|?\s*/,
};

// Where each drawn block of `markdown` starts in it, as an offset; undefined
// when it cannot be told for sure. The offset is the start of the block's
// text, after its Markdown marks (for code, its first line of code). Blocks
// pair only with source blocks of the same kind and the same embeds, in order
// (alignBlocks). A list's items map to its item lines when their count
// matches, a loose list continuing over the next list sections; a table's rows
// to its lines but the delimiter row. Used to place a click inside a wrap
// This keeps clicks and selections aligned with the source block text.
export function blockStarts(markdown: string, rendered: RenderedBlock[]): Array<{ from: number; items?: number[] } | undefined> {
	const lines = markdown.split('\n');
	const offsets: number[] = [];
	lines.reduce((offset, line) => { offsets.push(offset); return offset + line.length + 1; }, 0);
	const text = (line: number, type: string) => offsets[line]! + ((MARKS[type] ?? /^\s*/).exec(lines[line]!)?.[0].length ?? 0);
	// Tables and callouts are paragraphs and quotes for fallbackSections.
	const blocks = sourceBlocks(markdown).map(block => {
		const first = lines[block.lineStart]!.trimStart();
		const type = block.type === 'blockquote' && /^>\s*\[!/.test(first) ? 'callout'
			: block.type === 'paragraph' && first.startsWith('|') ? 'table' : block.type;
		return { ...block, type };
	});
	const result: Array<{ from: number; items?: number[] } | undefined> = rendered.map(() => undefined);
	const pairs = alignBlocks(blocks, rendered).filter(([s, r]) => blocks[s]!.type === rendered[r]!.kind);
	const paired = new Set(pairs.map(([s]) => s));
	for (const [s, r] of pairs) {
		const block = blocks[s]!;
		const entry: { from: number; items?: number[] } = { from: block.type === 'code' && block.lineEnd > block.lineStart + 1
			? offsets[block.lineStart + 1]! : text(block.lineStart, block.type) };
		const count = rendered[r]!.items;
		if (block.type === 'list' && count) {
			let last = s;
			while (blocks[last + 1]?.type === 'list' && !paired.has(last + 1)) last++;
			const items: number[] = [];
			for (let line = block.lineStart; line <= blocks[last]!.lineEnd; line++) {
				if (/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[line]!)) items.push(text(line, 'list'));
			}
			if (items.length === count) entry.items = items;
		}
		if (block.type === 'table' && count) {
			const rows: number[] = [];
			for (let line = block.lineStart; line <= block.lineEnd; line++) {
				if (!/^\s*\|?\s*:?-{3,}/.test(lines[line]!)) rows.push(text(line, 'table'));
			}
			if (rows.length === count) entry.items = rows;
		}
		result[r] = entry;
	}
	return result;
}
