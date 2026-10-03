import { StateEffect, StateField, type EditorSelection } from '@codemirror/state';
import { markerOnOwnParagraph, parseDocument, wrapImage, type DocumentModel } from '../markdown/model';

// Recompute the decorations (and the geometry CodeMirror measures from them)
// without touching the document or the selection.
export const remeasureEffect = StateEffect.define<null>();

// A note with no embed has no row, no wrap to draw and no image to drag: it
// gets this empty model, and typing in a long note costs no parse of every
// line (25 ms per keystroke in 10,000 lines). Its lines are empty too: Live
// Preview reads them only for images, which a note without embeds has none of.
export const EMPTY_MODEL: DocumentModel = Object.freeze({ lines: [], images: [], regions: [], diagnostics: [] });

export function previewModel(source: string): DocumentModel {
	return source.includes('![[') ? parseDocument(source) : EMPTY_MODEL;
}

export const wrapModelField = StateField.define<DocumentModel>({
	create: state => previewModel(state.doc.toString()),
	update: (model, tr) => tr.docChanged ? previewModel(tr.newDoc.toString()) : model,
});

export interface WrapSnapshot {
	from: number;
	to: number;
	contentFrom: number;
	markdown: string;
	side: 'iw-left' | 'iw-right';
	startMarkerTo: number;
	endMarkerFrom: number;
	// A marker touches the text (the old form): its bar offers the fix.
	compact: boolean;
}

export function wrapSnapshots(model: DocumentModel, source: string): WrapSnapshot[] {
	const snapshots: WrapSnapshot[] = [];
	for (const region of model.regions) {
		if (!wrapImage(model, region)) continue;
		const first = model.lines[region.first];
		const last = model.lines[region.last];
		const start = model.lines[region.start];
		const end = model.lines[region.end];
		if (!first || !last || !start || !end) continue;
		snapshots.push({ from: start.from, to: end.to, contentFrom: first.from,
			markdown: source.slice(first.from, last.to),
			side: `iw-${region.side}`,
			startMarkerTo: start.to, endMarkerFrom: end.from,
			compact: !markerOnOwnParagraph(model, region.start) || !markerOnOwnParagraph(model, region.end) });
	}
	return snapshots;
}

// Inclusive edges make keyboard entry and selections touching delimiters editable.
// Checking both ranges also covers a selection whose two ends are OUTSIDE a region.
export function selectionTouches(selection: EditorSelection, from: number, to: number): boolean {
	return selection.ranges.some(range => range.from <= to && range.to >= from);
}
