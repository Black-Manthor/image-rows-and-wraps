import type { Plugin } from 'obsidian';
import { START, END, compactWraps, markerKind, markerOnOwnParagraph, parseDocument, imageClass, type DocumentModel } from '../markdown/model';
import { imageEmbeds, flattenImageParagraph, firstParagraph } from './image-layout';
import { rowDefaults, type ImageSettings } from '../settings';
import { alignBlocks, sourceBlocks, type SectionRange } from '../markdown/blocks';
import { embedPaths, kindOf } from './block-kinds';
import { findRows, type ImageRow, type RowSettings } from '../markdown/row-model';
import { applyRow } from './row-layout';
import { notify } from '../ui/notify';
import { t } from '../i18n';

// Export/print gives the whole rendered document as a single postprocessor
// call, with no section info: Obsidian does not map this element back to a
// source range. Wrap markers survive as isolated children (confirmed
// empirically), so wraps are found here directly from the DOM, in document
// order, paired against a fresh parse of the source. Rows have no markers and
// are found by aligning blocks instead. This is a single static pass.

interface MarkerHit { index: number; kind: 'start' | 'end' }

// A marker line is plain, unformatted text on its own paragraph: wrapped as
// `<div><p>[wrap:start]</p></div>` in the exported note, bare `<p>` in an
// embedded note's content (both confirmed empirically). Matching by
// `textContent` alone would also fire for an example inside inline code or a
// quote (e.g. `` `[wrap:start]` `` or `> [wrap:start]`), which the source
// parser already excludes from being an active marker: require the paragraph
// itself to be the child's only element and to have no formatting of its own,
// so those render as plain text but never satisfy this check.
function findMarkers(children: HTMLElement[]): MarkerHit[] {
	const hits: MarkerHit[] = [];
	children.forEach((child, index) => {
		const paragraph = child.tagName === 'P' ? child : child.children.length === 1 ? child.children[0] : undefined;
		if (paragraph?.tagName !== 'P' || paragraph.children.length !== 0) return;
		const text = paragraph.textContent?.trim();
		if (text === START) hits.push({ index, kind: 'start' });
		else if (text === END) hits.push({ index, kind: 'end' });
	});
	return hits;
}

// One notice per note and export: each export draws the note in a `.print`
// container of its own, where Obsidian may process a note more than once. The
// notes already told about go with that container.
const noticed = new WeakMap<Element, Set<string>>();

// `alive`: false once the plugin is unloaded, which may happen while the note is read.
export async function applyExportLayout(element: HTMLElement, plugin: Plugin, sourcePath: string, settings: ImageSettings,
	alive: () => boolean): Promise<void> {
	const file = plugin.app.vault.getFileByPath(sourcePath);
	if (!file) return;
	const source = await plugin.app.vault.cachedRead(file);
	if (!alive()) return;
	const model = parseDocument(source);
	const compact = compactWraps(model).length;
	const printed = element.closest('.print') ?? element;
	const told = noticed.get(printed) ?? new Set<string>();
	noticed.set(printed, told);
	if (compact && !told.has(sourcePath)) {
		told.add(sourcePath);
		// What the PDF leaves out: the compact wraps of this note.
		notify(settings, t().compactWrapsInPdf(compact, file.basename));
	}
	const sections = plugin.app.metadataCache.getFileCache(file)?.sections?.map(section => ({
		type: section.type, lineStart: section.position.start.line, lineEnd: section.position.end.line }));
	// Rows first, on the untouched children; marker errors only block their own zone.
	applyExportRows(element, source, model, sections, rowDefaults(settings), alive);
	const children = Array.from(element.children) as HTMLElement[];
	const markers = findMarkers(children);
	// The plugin's comment after the start marker is not rendered: the DOM
	// marker is the bare text. Only a marker on a paragraph of its own is a
	// paragraph in the export: a compact wrap (a marker touching its text) is
	// left as it is, without blocking the others.
	const sourceMarkers = model.lines.flatMap((line, index) => {
		const kind = line.active && markerOnOwnParagraph(model, index) ? markerKind(line.text) : undefined;
		return kind ? [{ line: index, kind }] : [];
	});
	// Include malformed markers in the correspondence, but only render valid
	// regions. Validate the complete sequence before changing any wrap.
	if (markers.length !== sourceMarkers.length || markers.some((marker, index) => marker.kind !== sourceMarkers[index]!.kind)) return;
	const byLine = new Map(sourceMarkers.map((marker, index) => [marker.line, markers[index]!]));
	const toRemove: HTMLElement[] = [];
	for (const region of model.regions) {
		const open = byLine.get(region.start);
		const close = byLine.get(region.end);
		// A compact marker, or a pair that does not match, skips only its own wrap.
		if (!open || !close || open.kind !== 'start' || close.kind !== 'end' || close.index <= open.index) continue;
		const body = children.slice(open.index + 1, close.index);
		const embeds = body.flatMap(child => imageEmbeds(child));
		// Same validity rules Reading view uses: the side/embed match is
		// resolved by `imageClass`/`regionForImage`, so a malformed region is
		// left as plain Markdown in both views instead of only in one of them.
		const images = model.images.filter(image => image.line > region.start && image.line < region.end);
		if (!embeds.length || embeds.length !== images.length) continue;
		// Clear floats at the region boundary: short trailing content must
		// start on a fresh line below the floated image.
		body[0]?.classList.add('iw-region-start');
		body[body.length - 1]?.classList.add('iw-region-end');
		// Every block of the wrap: lists, quotes and code beside the image stay
		// whole beside it (styles.css).
		for (const block of body) block.classList.add('iw-export-block');
		// What follows the wrap starts below its image. The clear inside the last
		// block (iw-region-end) is not enough when that block is a formatting
		// context of its own, as a table's container is.
		children[close.index + 1]?.classList.add('iw-after-region');
		images.forEach((image, index) => {
			const cls = imageClass(model, image);
			const embed = embeds[index];
			if (!cls || !embed) return;
			embed.classList.add(cls);
			const paragraph = flattenImageParagraph(embed, (target, name) => target.classList.add(name));
			if (paragraph) {
				const wrapperIndex = body.findIndex(node => node.contains(paragraph));
				const next = body[wrapperIndex + 1] ? firstParagraph(body[wrapperIndex + 1]!) : null;
				if (next && next !== paragraph) next.classList.add('iw-first-paragraph');
			}
		});
		toRemove.push(children[open.index]!, children[close.index]!);
	}
	for (const node of toRemove) node.remove();
}

// A row whose images are still loading is laid out again on their `load`, until
// `layout` succeeds. One listener per paragraph: processing it again replaces
// it. Those still waiting are removed at unload (stopExportRetries); only weak
// references are kept, so a printed note whose images never load is not held.
const retries = new WeakMap<HTMLElement, () => void>();
let waiting = new Set<WeakRef<HTMLElement>>();

function stopRetry(paragraph: HTMLElement): void {
	const retry = retries.get(paragraph);
	if (!retry) return;
	paragraph.removeEventListener('load', retry, true);
	retries.delete(paragraph);
}

export function retryOnLoad(paragraph: HTMLElement, layout: () => boolean, alive: () => boolean): void {
	stopRetry(paragraph);
	const retry = () => { if (!alive() || layout()) stopRetry(paragraph); };
	retries.set(paragraph, retry);
	paragraph.addEventListener('load', retry, true);
	// Drop the references to paragraphs gone or no longer waiting.
	waiting = new Set([...waiting].filter(ref => { const kept = ref.deref(); return kept !== undefined && retries.has(kept); }));
	waiting.add(new WeakRef(paragraph));
}

export function stopExportRetries(): void {
	for (const ref of waiting) { const paragraph = ref.deref(); if (paragraph) stopRetry(paragraph); }
	waiting.clear();
}

// Export has no section info: rows are found by aligning source blocks with the
// exported top-level children (order plus identical embeds, verified on real
// exports). Only blocks with those embeds are trusted as anchors. Layout is
// applied synchronously; an image still loading is retried on its `load`.
function applyExportRows(element: HTMLElement, source: string, model: DocumentModel,
	sections: SectionRange[] | undefined, defaults: RowSettings | undefined, alive: () => boolean): void {
	const rows = new Map<number, ImageRow>(findRows(source, model, defaults).map(row => [row.line, row]));
	if (!rows.size) return;
	const blocks = sourceBlocks(source, sections);
	const children = Array.from(element.children) as HTMLElement[];
	const exported = children.map(child => ({ kind: kindOf(child), paths: embedPaths(child) }));
	for (const [sourceIndex, exportedIndex] of alignBlocks(blocks, exported)) {
		const block = blocks[sourceIndex]!;
		const row = block.lineStart === block.lineEnd ? rows.get(block.lineStart) : undefined;
		const paragraph = row && block.paths.length ? firstParagraph(children[exportedIndex]!) : null;
		if (!row || !paragraph) continue;
		// A paragraph processed again: its earlier wait, if any, goes.
		stopRetry(paragraph);
		if (!applyRow(paragraph, row)) retryOnLoad(paragraph, () => applyRow(paragraph, row), alive);
	}
}
