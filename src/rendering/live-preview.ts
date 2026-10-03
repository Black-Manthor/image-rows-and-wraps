import { rowHeightField } from './row-height';
import { findRows, type ImageRow } from '../markdown/row-model';
import { RowWidget } from './row-widget';
import { imageFeedback } from './image-feedback';
import { imageDrag } from './image-drag';
import { rowDefaults, type ImageSettings } from '../settings';
import { Prec, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField, type Plugin, type TAbstractFile } from 'obsidian';
import { previewInteraction } from './preview-interaction';
import { blockMoves } from './block-drag';
import { clickAnchor } from './click-anchor';
import { remeasureEffect, selectionTouches, wrapModelField, wrapSnapshots, type WrapSnapshot } from './wrap-state';
import { MarkerWidget, WrapWidget } from './wrap-widget';

// Row defaults live in the settings, outside the document: when they change,
// every open editor recomputes its decorations without any edit or click.
const refreshRowsEffect = StateEffect.define<null>();
const openViews = new Set<EditorView>();
const trackViews = ViewPlugin.define(view => {
	openViews.add(view);
	return { destroy: () => { openViews.delete(view); } };
});

// Every open editor, or only those showing `file`.
export function refreshLivePreviews(file?: TAbstractFile): void {
	for (const view of openViews) {
		if (!file || view.state.field(editorInfoField, false)?.file === file) view.dispatch({ effects: refreshRowsEffect.of(null) });
	}
}

export function createLivePreview(plugin: Plugin, getSettings: () => ImageSettings) {
	// A moved or renamed note keeps its editor and its file object, whose path
	// Obsidian changes in place, without a transaction: links now resolve from
	// the new folder. Only the editors showing that file are recomputed.
	plugin.registerEvent(plugin.app.vault.on('rename', file => refreshLivePreviews(file)));
	// Layout candidates depend on the text (and on the row defaults), never on
	// the selection: computed once per change, then only filtered by selection.
	const layoutField = StateField.define<{ snapshots: WrapSnapshot[]; rows: Array<{ row: ImageRow; markdown: string }> }>({
		create: layout,
		update: (value, tr) => tr.docChanged || tr.effects.some(effect => effect.is(refreshRowsEffect)) ? layout(tr.state) : value,
	});
	function layout(state: EditorState) {
		const model = state.field(wrapModelField);
		// Rows and drawn wraps both need an image: without one, nothing to read.
		if (!model.images.length) return { snapshots: [], rows: [] };
		const source = state.doc.toString();
		return { snapshots: wrapSnapshots(model, source),
			rows: findRows(source, model, rowDefaults(getSettings())).map(row => ({ row, markdown: source.slice(row.from, row.to) })) };
	}
	function decorations(state: EditorState): DecorationSet {
		if (!state.field(editorLivePreviewField, false)) return Decoration.none;
		const { snapshots, rows } = state.field(layoutField);
		const sourcePath = state.field(editorInfoField, false)?.file?.path ?? '';
		const ranges: Range<Decoration>[] = [];
		for (const snapshot of snapshots) {
			if (!selectionTouches(state.selection, snapshot.from, snapshot.to)) {
				ranges.push(Decoration.replace({ inclusive: false,
					widget: new WrapWidget(snapshot, sourcePath, plugin, getSettings) }).range(snapshot.from, snapshot.to));
			} else {
				for (const [from, to] of [[snapshot.from, snapshot.startMarkerTo], [snapshot.endMarkerFrom, snapshot.to]] as const) {
					ranges.push(Decoration.line({ class: 'iw-editing-boundary' }).range(from));
					if (!selectionTouches(state.selection, from, to)) {
						ranges.push(Decoration.replace({ widget: new MarkerWidget(from, to, state.sliceDoc(from, to)), inclusive: false }).range(from, to));
					}
				}
			}
		}
		for (const { row, markdown } of rows) {
			if (selectionTouches(state.selection, row.from, row.to)) continue;
			ranges.push(Decoration.replace({ inclusive: false,
				widget: new RowWidget(row, markdown, sourcePath, plugin, getSettings) }).range(row.from, row.to));
		}
		return Decoration.set(ranges, true);
	}
	const field = StateField.define<DecorationSet>({
		create: decorations,
		update(value, tr) {
			return tr.docChanged || tr.selection ||
				tr.effects.some(effect => effect.is(refreshRowsEffect) || effect.is(remeasureEffect)) ||
				tr.state.field(editorLivePreviewField, false) !== tr.startState.field(editorLivePreviewField, false)
				? decorations(tr.state) : value;
		},
		provide: field => EditorView.decorations.from(field),
	});
	// No atomicRanges: keyboard and cross-boundary selections may enter source.
	return [wrapModelField, layoutField, Prec.highest(field), trackViews, imageDrag(getSettings), blockMoves, imageFeedback, previewInteraction, clickAnchor, rowHeightField];
}
