import { ownerDocumentRegression, cursorRegression } from './dom-gesture-regression';
import { defaultSettings, type ImageSettings } from '../src/settings';
import { history, undo, redo, undoDepth } from '@codemirror/commands';
import { EditorState, EditorSelection, Compartment, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, lineNumbers, type DecorationSet } from '@codemirror/view';
import { Plugin, TFile, appListeners, editorLivePreviewField, editorInfoField, notices, runtime } from './obsidian-stub';
import { createLivePreview, refreshLivePreviews } from '../src/rendering/live-preview';
import { registerReadingView } from '../src/rendering/reading-view';
import { START, END } from '../src/markdown/model';
import { remeasureEffect } from '../src/rendering/wrap-state';
import { rowHeightEffect } from '../src/rendering/row-height';
import { createWrapToolbar } from '../src/rendering/wrap-toolbar';
import './browser-dom';
import { setLanguage } from '../src/i18n';

// The page shows the plugin's Italian texts, as the Node tests read them.
setLanguage('it');

document.querySelector('#editor')!.classList.add('markdown-source-view', 'mod-cm6');
// Obsidian shows an image embed after each link while its line is open.
// Opt-in (nativeEmbeds), so other tests keep counting only our own embeds.
class NativeEmbed extends WidgetType {
	constructor(readonly src: string, readonly width: number) { super(); }
	eq(other: NativeEmbed) { return other.src === this.src && other.width === this.width; }
	toDOM() {
		const embed = document.createElement('span');
		embed.className = 'internal-embed image-embed';
		embed.setAttribute('src', this.src);
		const img = embed.appendChild(document.createElement('img'));
		img.width = this.width; img.height = 60;
		img.style.background = '#8ab';
		return embed;
	}
}
const nativeEmbedDecorations = (state: EditorState): DecorationSet => {
	const ranges: Range<Decoration>[] = [];
	for (const match of state.doc.toString().matchAll(/!\[\[([^\]|]+)(?:\|(\d+))?[^\]]*\]\]/g)) {
		ranges.push(Decoration.widget({ widget: new NativeEmbed(match[1]!, Number(match[2] ?? 100)), side: 1 }).range(match.index! + match[0].length));
	}
	return Decoration.set(ranges);
};
const nativeEmbedField = StateField.define<DecorationSet>({
	create: nativeEmbedDecorations,
	update: (value, tr) => tr.docChanged ? nativeEmbedDecorations(tr.state) : value,
	provide: field => EditorView.decorations.from(field),
});
const nativeEmbeds = new Compartment();
// A wrap's bar left in the editor after its wrap is gone: what a click meets
// when the note changes between the bar's drawing and the click.
class StrayWrapBar extends WidgetType {
	eq() { return true; }
	toDOM(view: EditorView) {
		const root = document.createElement('div');
		root.className = 'iw-preview iw-stray-wrap';
		root.style.cssText = 'position:relative;height:40px;';
		createWrapToolbar(root, view, () => liveSettings);
		return root;
	}
}
const strayWrapBar = new Compartment();
const livePreviewMode = StateEffect.define<boolean>();
let other: EditorView | undefined;
const otherDestroy = () => { other?.destroy(); other?.dom.parentElement?.remove(); other = undefined; };
// Transactions that set a selection, counted to prove layout code never sets one.
let selectionTransactions = 0;
// Every transaction, to prove an event left the editor alone.
let transactions = 0;
let remeasures = 0;
let rowHeights = 0;
const text = `Prima.\n\n${START}\n\n![[foto.png|300]]\n\nPrimo paragrafo.\n\nSecondo paragrafo.\n\n${END}\n\nDopo.`;
const plugin = new Plugin();
plugin.load();
let liveSettings: ImageSettings = defaultSettings();
const refreshReading = registerReadingView(plugin as never, () => liveSettings);
const view = new EditorView({ parent: document.querySelector('#editor')!, state: EditorState.create({
	doc: text,
	extensions: [nativeEmbeds.of([]), strayWrapBar.of([]), lineNumbers(), history(), editorLivePreviewField, editorInfoField, createLivePreview(plugin as never, () => liveSettings), EditorView.lineWrapping,
		EditorView.updateListener.of(update => { for (const tr of update.transactions) {
			transactions++;
			if (tr.selection) selectionTransactions++;
			if (tr.effects.some(effect => effect.is(remeasureEffect))) remeasures++;
			if (tr.effects.some(effect => effect.is(rowHeightEffect))) rowHeights++;
		} }),
		EditorView.theme({ '&': { fontSize: '16px' }, '.cm-content': { fontFamily: 'monospace' }, '.cm-line': { lineHeight: '24px' } })],
}) });
// Export/print gives the postprocessor the whole document as one call, with
// no section info (see reading-export.ts). This builds that exact DOM shape
// by hand and lets a test drive it, independent of the live-preview fixture.
// Not loaded: it only stores callbacks/settings here, never tracked as an
// active component, so the shared no-leftover-components check stays valid.
let exportSource = '';
// The document of the last export, to process it again.
let lastExport: HTMLElement | undefined;
// A slow disk: the export's read of the note takes this long.
let exportReadDelay = 0;
let readingSource = '';
const exportPlugin = new Plugin();
(exportPlugin as unknown as { app: unknown }).app = { vault: {
	getFileByPath: (path: string) => new TFile(path), on: () => ({}),
	cachedRead: async () => { if (exportReadDelay) await new Promise(resolve => setTimeout(resolve, exportReadDelay)); return exportSource; },
}, metadataCache: { getFileCache: () => null, on: () => ({}) }, workspace: { on: () => ({}) } };
const exportSettings: ImageSettings = defaultSettings();
registerReadingView(exportPlugin as never, () => exportSettings);

(window as unknown as { fixture: unknown }).fixture = {
	text,
	ownerDocumentRegression, cursorRegression,
	setDoc(doc: string) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: 0 } }); },
	nativeEmbeds(on: boolean) { view.dispatch({ effects: nativeEmbeds.reconfigure(on ? nativeEmbedField : []) }); },
	strayWrapBar(position: number) {
		view.dispatch({ effects: strayWrapBar.reconfigure(EditorView.decorations.of(Decoration.set([
			Decoration.widget({ widget: new StrayWrapBar(), block: true, side: -1 }).range(position)]))) });
	},
	undo() { undo(view); },
	redo() { redo(view); },
	undoDepth() { return undoDepth(view.state); },
	select(anchor: number, head = anchor) { view.dispatch({ selection: EditorSelection.single(anchor, head), scrollIntoView: true }); view.focus(); },
	selection() { return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }; },
	doc() { return view.state.doc.toString(); },
	selectionTransactions() { return selectionTransactions; },
	remeasures() { return remeasures; },
	rowHeights() { return rowHeights; },
	hasFocus() { return view.hasFocus; },
	coords(position: number) { return view.coordsAtPos(position); },
	// Height CodeMirror believes a line has (its height map) against the line's real box.
	lineGeometry(position: number) {
		const block = view.lineBlockAt(position);
		const node = view.domAtPos(position).node;
		const line = (node.nodeType === 1 ? node as HTMLElement : node.parentElement)!.closest('.cm-line')!;
		return { heightmap: Math.round(block.height), dom: Math.round(line.getBoundingClientRect().height) };
	},
	// As Obsidian moves or renames the open note: the file's path changes in
	// place, with no transaction, then the vault reports the rename.
	moveNote(path: string) {
		const file = view.state.field(editorInfoField).file;
		const old = file.path;
		file.path = path;
		for (const listener of appListeners) if (listener.name === 'rename') listener.callback(file, old);
	},
	// Another file of the vault renamed: not the one this editor shows. Returns
	// the transactions the rename itself caused, counted synchronously: the
	// widgets' own height reports (next frame) cannot fall in between.
	renameOther() {
		const before = transactions;
		for (const listener of appListeners) if (listener.name === 'rename') listener.callback({ path: 'altra/cosa.md' }, 'cosa.md');
		return transactions - before;
	},
	insert(position: number, insert: string) { view.dispatch({ changes: { from: position, insert } }); },
	notices() { return notices.slice(); },
	// The plugin is unloaded while the export still reads the note.
	async unloadDuringExport(source: string, blocks: { text?: string; embedWidth?: number; src?: string }[]) {
		exportReadDelay = 50;
		const running = (this as { runExport: (source: string, blocks: unknown[]) => Promise<void> }).runExport(source, blocks);
		exportPlugin.unload();
		await running;
		exportReadDelay = 0;
	},
	counts() { return { components: runtime.activeComponents, renders: runtime.renders.length }; },
	renderDelay(ms: number) { runtime.delay = ms; },
	renderFail(fail: boolean) { runtime.fail = fail; },
	imagesLoad(load: boolean) { runtime.imagesLoad = load; },
	renderSettlesAfterFrame(on: boolean) { runtime.settle = on; },
	renderReplacesParagraph(on: boolean) { runtime.replace = on; },
	// Mirrors the `rows` effect of settings-store.ts: new settings, then refresh both views without edits.
	setLiveSettings(partial: Partial<ImageSettings>) { liveSettings = { ...liveSettings, ...partial }; refreshLivePreviews(); refreshReading(); },
	setReadingSource(source: string) { readingSource = source; refreshReading(); },
	// As Obsidian after a change that leaves a section's HTML identical (a
	// comment): the source changes, the section is kept, nothing is called.
	changeReadingSourceQuietly(source: string) { readingSource = source; },
	// One Reading section holding exactly one source line, as getSectionInfo reports it.
	runReadingSection(source: string, line: number, embeds: { width: number; src: string }[]) {
		readingSource = source;
		const section = document.body.appendChild(document.createElement('div'));
		section.className = 'markdown-reading-view iw-reading-test';
		const p = section.appendChild(document.createElement('p'));
		for (const item of embeds) {
			const embed = p.appendChild(document.createElement('span'));
			embed.className = 'internal-embed image-embed';
			embed.setAttribute('src', item.src);
			const img = embed.appendChild(document.createElement('img'));
			img.width = item.width; img.height = 80;
			p.append(' ');
		}
		return (plugin as unknown as { postprocessor: (el: HTMLElement, ctx: unknown) => Promise<void> }).postprocessor(section,
			{ getSectionInfo: () => ({ text: readingSource, lineStart: line, lineEnd: line }), sourcePath: 'lettura.md', addChild: (child: never) => plugin.addChild(child) });
	},
	// A whole note in Reading view: one native section per block of lines
	// separated by blank lines, processed in order as Obsidian does.
	async runReadingNote(source: string) {
		readingSource = source;
		const view = document.body.appendChild(document.createElement('div'));
		view.className = 'markdown-reading-view';
		view.style.cssText = 'width:600px;';
		const preview = view.appendChild(document.createElement('div'));
		preview.className = 'markdown-preview-view iw-reading-note';
		const lines = source.split('\n');
		for (let start = 0; start < lines.length; start++) {
			if (!lines[start]!.trim()) continue;
			let end = start;
			while (end + 1 < lines.length && lines[end + 1]!.trim()) end++;
			const section = preview.appendChild(document.createElement('div'));
			section.className = 'el-p';
			const p = section.appendChild(document.createElement('p'));
			const image = /^!\[\[[^|\]]+(?:\|[^\]]*?)?\|(\d+)\]\]$/.exec(lines[start]!);
			if (start === end && image) {
				const embed = p.appendChild(document.createElement('span'));
				embed.className = 'internal-embed image-embed';
				const img = embed.appendChild(document.createElement('img'));
				img.width = Number(image[1]); img.height = 200;
			} else p.textContent = lines.slice(start, end + 1).join(' ');
			const lineStart = start, lineEnd = end;
			await (plugin as unknown as { postprocessor: (el: HTMLElement, ctx: unknown) => Promise<void> }).postprocessor(section,
				{ getSectionInfo: () => ({ text: readingSource, lineStart, lineEnd }), sourcePath: 'lettura.md', addChild: (child: never) => plugin.addChild(child) });
			start = end;
		}
	},
	// Leaving Live Preview (the stub's field follows any boolean effect).
	livePreview(on: boolean) { view.dispatch({ effects: livePreviewMode.of(on) }); },
	// A second editor with the plugin, as another pane: its own scroll, edits and end.
	otherEditor(doc: string) {
		const parent = document.body.appendChild(document.createElement('div'));
		parent.id = 'other';
		parent.classList.add('markdown-source-view', 'mod-cm6');
		parent.style.cssText = 'width:600px;';
		other = new EditorView({ parent, state: EditorState.create({ doc, extensions: [history(), editorLivePreviewField, editorInfoField,
			createLivePreview(plugin as never, () => liveSettings), EditorView.lineWrapping, EditorView.theme({ '&': { height: '300px' } })] }) });
	},
	otherScroll(top: number) { if (other) other.scrollDOM.scrollTop = top; },
	otherInsert(text: string) { other?.dispatch({ changes: { from: 0, insert: text } }); },
	otherDoc() { return other?.state.doc.toString(); },
	otherDestroy,
	destroy() { otherDestroy(); view.destroy(); plugin.unload(); },
	// Builds the exact DOM shape Obsidian gives the postprocessor during
	// export/print (whole document, no section info) and runs it for real.
	// `bare`: blocks are paragraphs without a wrapper, as in an embedded note's content.
	async runExport(source: string, blocks: { text?: string; code?: string; embedWidth?: number; src?: string }[], reading = false, bare = false) {
		exportSource = source;
		const wrapper = document.body.appendChild(document.createElement('div'));
		wrapper.className = reading ? 'markdown-reading-view' : 'print';
		wrapper.style.cssText = 'position:fixed;top:0;left:0;width:600px;';
		const root = wrapper.appendChild(document.createElement('div'));
		root.className = 'iw-export-test markdown-preview-view';
		for (const block of blocks) {
			const p = (bare ? root : root.appendChild(document.createElement('div'))).appendChild(document.createElement('p'));
			if (block.embedWidth) {
				const embed = p.appendChild(document.createElement('span'));
				embed.className = 'internal-embed image-embed';
				if (block.src) embed.setAttribute('src', block.src);
				const img = embed.appendChild(document.createElement('img'));
				img.width = block.embedWidth; img.height = 80;
			} else if (block.code !== undefined) {
				p.appendChild(document.createElement('code')).textContent = block.code;
			} else {
				p.textContent = block.text ?? '';
			}
		}
		lastExport = root;
		await ((reading ? plugin : exportPlugin) as unknown as { postprocessor: (el: HTMLElement, ctx: unknown) => Promise<void> })
			.postprocessor(root, { getSectionInfo: () => reading ? { text: source, lineStart: 0, lineEnd: source.split('\n').length - 1 } : null, sourcePath: 'export.md', addChild: (child: never) => plugin.addChild(child) });
	},
	// The same export processed again, as Obsidian may do.
	async reprocessExport() {
		await (exportPlugin as unknown as { postprocessor: (el: HTMLElement, ctx: unknown) => Promise<void> })
			.postprocessor(lastExport!, { getSectionInfo: () => null, sourcePath: 'export.md', addChild: (child: never) => plugin.addChild(child) });
	},
};
