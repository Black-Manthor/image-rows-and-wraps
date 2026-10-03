import type { EditorView } from '@codemirror/view';
import { parseDocument, regionAt, type ImageLink, type DocumentModel } from '../markdown/model';
import type { ImageDrop } from '../markdown/drag-image';
import { parseRowText } from '../markdown/row-model';
import { previewStart, sourceImagePosition, previewTargets } from './preview-dom';
import { t } from '../i18n';

export function imageAtElement(view: EditorView, target: HTMLElement, model: DocumentModel = parseDocument(view.state.doc.toString())): ImageLink | undefined {
	const embed = target.closest<HTMLElement>('.image-embed');
	if (!embed || !view.contentDOM.contains(embed)) return;
	const widget = embed.closest<HTMLElement>('.iw-preview');
	let position: number;
	if (widget) {
		const offset = previewTargets.has(widget) ? sourceImagePosition(embed) : undefined;
		const start = offset === undefined ? undefined : previewStart(view, widget);
		if (offset === undefined || start === undefined) return;
		position = start + offset;
	} else {
		try { position = view.posAtDOM(embed); } catch { return; }
	}
	return model.images.find(image => position >= image.from && position <= image.to) ??
		model.images.filter(image => {
			const line = model.lines[image.line]!;
			return position >= line.from && position <= line.to && line.text.trim() === image.raw;
		})[0];
}

export function resolveImageDrop(view: EditorView, x: number, y: number,
	model: DocumentModel = parseDocument(view.state.doc.toString())): { drop: ImageDrop; rect: DOMRect; vertical: boolean; after: boolean } {
	const found = view.dom.doc.elementFromPoint(x, y);
	const target = found?.instanceOf(HTMLElement) ? found : null;
	if (!target || !view.contentDOM.contains(target)) throw new Error(t().dropInSameEditor);
	const widget = target.closest<HTMLElement>('.iw-preview');
	const start = widget && previewTargets.has(widget) ? previewStart(view, widget) : undefined;
	if (widget && start === undefined) throw new Error(t().dropPositionUnavailable);
	if (widget && start !== undefined && widget.classList.contains('iw-row-preview')) return rowDrop(widget, start, x);
	if (!widget) {
		const open = openRowDrop(view, target, x, y, model);
		if (open) return open;
	}
	const position = start ?? view.posAtCoords({ x, y }, false);
	if (position === null) throw new Error(t().dropPositionUnavailable);
	const region = regionAt(model, position);
	if (region) throw new Error(t().imageIntoWrap);
	const line = view.state.doc.lineAt(position);
	let first = line.number - 1, last = first;
	if (model.lines[first]!.text.trim()) {
		while (first > 0 && model.lines[first - 1]!.text.trim()) first--;
		while (last + 1 < model.lines.length && model.lines[last + 1]!.text.trim()) last++;
	}
	if (model.lines.slice(first, last + 1).some(line => !line.active)) throw new Error(t().dropOutsideCode);
	const top = view.coordsAtPos(model.lines[first]!.from);
	const bottom = view.coordsAtPos(model.lines[last]!.to);
	if (!top || !bottom) throw new Error(t().dropOnVisibleBlock);
	const after = y > (top.top + bottom.bottom) / 2;
	const bounds = view.contentDOM.getBoundingClientRect();
	const rect = { left: bounds.left, right: bounds.right, top: top.top, bottom: bottom.bottom } as DOMRect;
	return { drop: { kind: 'text', position: after ? model.lines[last + 1]?.from ?? view.state.doc.length : model.lines[first]!.from }, rect, vertical: false, after };
}

type RowTarget = { drop: ImageDrop; rect: DOMRect; vertical: boolean; after: boolean };

// The slot before or after the nearest image box (by its horizontal midpoint),
// marked by a vertical bar along that image. `slots[i]` is the image index of box i.
function nearestSlot(row: number, boxes: DOMRect[], slots: number[], x: number, y = NaN): RowTarget {
	if (!boxes.length) throw new Error(t().rowNotReady);
	const gap = (low: number, high: number, value: number) => value < low ? low - value : value > high ? value - high : 0;
	// An open row may wrap on several screen lines: the vertical distance counts too.
	const distance = (box: DOMRect) => Math.hypot(gap(box.left, box.right, x), Number.isNaN(y) ? 0 : gap(box.top, box.bottom, y));
	let index = 0;
	boxes.forEach((box, i) => { if (distance(box) < distance(boxes[index]!)) index = i; });
	const rect = boxes[index]!;
	const after = x > (rect.left + rect.right) / 2;
	return { drop: { kind: 'row', row, slot: slots[index]! + (after ? 1 : 0) }, rect, vertical: true, after };
}

// Over a closed row (our widget): its embeds are in link order.
function rowDrop(widget: HTMLElement, row: number, x: number): RowTarget {
	const embeds = Array.from(widget.querySelectorAll<HTMLElement>('p.iw-row > .internal-embed'));
	return nearestSlot(row, embeds.map(embed => (embed.querySelector('img') ?? embed).getBoundingClientRect()), embeds.map((_, i) => i), x);
}

// Over an open row (cursor inside, Markdown shown): Obsidian's own embeds sit
// on the source line; each is matched to its link by source position.
function openRowDrop(view: EditorView, target: HTMLElement, x: number, y: number, model: DocumentModel): RowTarget | undefined {
	const lineElement = target.closest<HTMLElement>('.cm-line');
	if (!lineElement || !view.contentDOM.contains(lineElement)) return;
	let start: number;
	try { start = view.posAtDOM(lineElement, 0); } catch { return; }
	const line = view.state.doc.lineAt(start);
	const row = parseRowText(line.text);
	if (!row || !model.lines[line.number - 1]?.active) return;
	const boxes: DOMRect[] = [], slots: number[] = [];
	for (const embed of Array.from(lineElement.querySelectorAll<HTMLElement>('.image-embed'))) {
		let position: number;
		try { position = view.posAtDOM(embed) - line.from; } catch { continue; }
		const slot = row.images.findIndex(image => position >= image.from && position <= image.to);
		if (slot < 0 || slots.includes(slot)) continue;
		boxes.push((embed.querySelector('img') ?? embed).getBoundingClientRect());
		slots.push(slot);
	}
	// Images not shown yet: fall back to the text rules below.
	if (!boxes.length) return;
	return nearestSlot(line.from, boxes, slots, x, y);
}
