import type { EditorView } from '@codemirror/view';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { blockStarts } from '../markdown/blocks';
import { embedPaths } from './block-kinds';

// Every position stored here is an offset from the start of its preview root
// (a widget). The start itself is asked to CodeMirror when it is needed, so a
// widget kept across edits above it (same Markdown) still maps correctly.
interface PreviewTarget { length: number; fallback: number }
export const previewTargets = new WeakMap<HTMLElement, PreviewTarget>();

// The window a node belongs to (Obsidian's `win`), typed with its own
// constructors: observers must come from the node's window (pop-outs).
export function windowOf(node: Node): typeof window {
	return node.win as typeof window;
}

// The element an event happened on, when it is one. `instanceOf` (Obsidian)
// is also right for an editor in a pop-out window, where `instanceof` is not.
export function eventElement(event: Event): HTMLElement | null {
	const target = event.target as Node | null;
	return target?.instanceOf(HTMLElement) ? target : null;
}

export function previewStart(view: EditorView, root: HTMLElement): number | undefined {
	try { return view.posAtDOM(root); } catch { return undefined; }
}
const sources = new WeakMap<HTMLElement, { markdown: string; from: number }>();
const positions = new WeakMap<HTMLElement, number>();
const imagePositions = new WeakMap<HTMLElement, number>();

export function registerPreviewSource(root: HTMLElement, markdown: string, from: number): void {
	sources.set(root, { markdown, from });
}

// Called by our Markdown postprocessor while MarkdownRenderer builds the widget.
export function annotatePreviewSection(element: HTMLElement, context: MarkdownPostProcessorContext): boolean {
	const root = element.closest<HTMLElement>('.iw-preview-content');
	if (!root) return false;
	const source = sources.get(root);
	const info = context.getSectionInfo(element);
	if (source && info && info.text === source.markdown) {
		const lines = source.markdown.split('\n');
		if (info.lineStart >= 0 && info.lineStart < lines.length) {
			const prefix = lines.slice(0, info.lineStart);
			positions.set(element, source.from + prefix.reduce((length, line) => length + line.length + 1, 0));
		}
	}
	return true;
}

// The kind of a drawn top-level block, from the block itself (Obsidian wraps it
// in an `el-*` container), never from what it contains: a quote holding a list
// is a quote.
function renderedKind(element: Element): string {
	const shown = /(^|\s)el-/.test(element.className) && element.firstElementChild ? element.firstElementChild : element;
	const is = (selector: string) => shown.matches(selector);
	// A table may sit in a wrapper of its own.
	return is('.callout') ? 'callout' : is('h1, h2, h3, h4, h5, h6') ? 'heading' : is('pre') ? 'code'
		: is('table') || shown.querySelector(':scope > table') ? 'table'
		: is('ul, ol') ? 'list' : is('blockquote') ? 'blockquote' : is('p') ? 'paragraph' : 'other';
}

// The items of a drawn list or table, in source order.
function itemsOf(element: Element, kind: string): HTMLElement[] {
	return kind === 'list' ? Array.from(element.querySelectorAll<HTMLElement>('li'))
		: kind === 'table' ? Array.from(element.querySelectorAll<HTMLElement>('tr')) : [];
}

// Fragment renderers may not provide section metadata: each drawn block (and
// each item of a list, each row of a table) gets the source position of its
// own line, when the blocks pair for sure with the source (blockStarts).
// Without it a click on a list, a quote or code in a wrap went to the wrap's
// image, so pointer placement can use the corresponding source line.
export function annotateBlocks(root: HTMLElement): void {
	const source = sources.get(root);
	if (!source) return;
	const elements = Array.from(root.children) as HTMLElement[];
	const starts = blockStarts(source.markdown, elements.map(element => {
		const kind = renderedKind(element);
		return { kind, paths: embedPaths(element), items: itemsOf(element, kind).length || undefined };
	}));
	starts.forEach((start, index) => {
		const element = elements[index]!;
		if (!start) return;
		if (!positions.has(element)) positions.set(element, source.from + start.from);
		if (start.items) itemsOf(element, renderedKind(element)).forEach((item, k) => {
			if (!positions.has(item)) positions.set(item, source.from + start.items![k]!);
		});
	});
}

export function previewPosition(target: HTMLElement, root: HTMLElement, fallback: number): number {
	return positions.get(previewElement(target, root)) ?? fallback;
}

// The element whose source position a click on `target` uses: the nearest one
// with a position, or the preview root itself (its fallback).
export function previewElement(target: HTMLElement, root: HTMLElement): HTMLElement {
	for (let element: HTMLElement | null = target; element && element !== root; element = element.parentElement) {
		if (positions.has(element)) return element;
	}
	return root;
}

// A preview updated in place (updateDOM) keeps its elements, and with them the
// positions stored when it was drawn: `map` turns each into the new source's.
export function remapPreviewPositions(root: HTMLElement, map: (position: number) => number): void {
	for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
		const position = positions.get(element);
		if (position !== undefined) positions.set(element, map(position));
		const image = imagePositions.get(element);
		if (image !== undefined) imagePositions.set(element, map(image));
	}
}

export function annotateImagePosition(embed: HTMLElement, from: number): void {
	positions.set(embed, from);
	imagePositions.set(embed, from);
}

export function sourceImagePosition(embed: HTMLElement): number | undefined { return imagePositions.get(embed); }
