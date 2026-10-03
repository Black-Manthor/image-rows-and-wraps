import { defaultSettings } from '../src/settings';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState, EditorSelection, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorLivePreviewField, Plugin } from 'obsidian';
import { createLivePreview } from '../src/rendering/live-preview';
import { START, END, imageClass, markerKind, parseDocument, regionForImage, startMarker } from '../src/markdown/model';
import { targetImage, wrapRange, type Edit } from '../src/markdown/edits';

import { WrapWidget, MarkerWidget } from '../src/rendering/wrap-widget';
import { RowWidget } from '../src/rendering/row-widget';
import { findRows } from '../src/markdown/row-model';
import { EMPTY_MODEL, previewModel, wrapModelField } from '../src/rendering/wrap-state';
import { PreviewInteraction } from '../src/rendering/preview-interaction';
import { annotateBlocks, annotatePreviewSection, previewPosition, previewTargets, registerPreviewSource } from '../src/rendering/preview-dom';
const livePreview = createLivePreview({ app: { vault: { on: () => ({}) } }, registerEvent() {} } as unknown as Plugin, defaultSettings);

const region = (content: string, side: 'left' | 'right' = 'left') => `${startMarker(side)}\n\n${content}\n\n${END}`;
const apply = (source: string, edit: Edit) => source.slice(0, edit.from) + edit.text + source.slice(edit.to);
const image = '![[cartella/foto.png|300]]';

test('multiple paragraphs belong to one region; following text is excluded', () => {
	const model = parseDocument(region(`${image}\n\nUno.\n\nDue.`) + '\n\nFuori.');
	const { comment, ...bounds } = model.regions[0]!;
	assert.deepEqual(bounds, { start: 0, end: 8, first: 2, last: 6, side: 'left' });
	assert.equal(comment?.body, 'side=left');
	assert.equal(imageClass(model, model.images[0]!), 'iw-left');
});

test('separate regions retain their own side and boundary', () => {
	const model = parseDocument(region(`${image}\n\nA`) + '\n\n' + region(`${image}\n\nB`, 'right'));
	assert.equal(model.regions.length, 2);
	assert.deepEqual(model.images.map(image => imageClass(model, image)), ['iw-left', 'iw-right']);
});

test('the side comes from the start marker: missing or invalid is left, unknown tokens are allowed', () => {
	const side = (marker: string) => parseDocument(`${marker}\n\n${image}\n\n${END}`).regions[0]?.side;
	assert.equal(side(START), 'left');
	assert.equal(side(`${START} %%iw-wrap side=right%%`), 'right');
	assert.equal(side(`${START}%%iw-wrap futuro=1 side=right%%`), 'right');
	assert.equal(side(`${START} %%iw-wrap side=pippo%%`), 'left');
	assert.equal(side(`${START} %%iw-wrap%%`), 'left');
	// Another comment, or other text, is not a start marker.
	assert.equal(markerKind(`${START} %%nota mia%%`), undefined);
	assert.equal(markerKind(`${START} testo`), undefined);
	assert.equal(markerKind(`  ${startMarker('right')}  `), 'start');
	// Old image parameters no longer decide the side.
	assert.equal(imageClass(parseDocument(region('![[a.png|right wrap|300]]')), parseDocument(region('![[a.png|right wrap|300]]')).images[0]!), 'iw-left');
});

test('an empty wrap is a region with nothing to lay out', () => {
	const model = parseDocument(`${startMarker('right')}\n\n\n\n${END}`);
	assert.deepEqual(model.regions.map(({ start, end, first, last, side }) => ({ start, end, first, last, side })),
		[{ start: 0, end: 4, first: 4, last: 0, side: 'right' }]);
	assert.equal(model.diagnostics.length, 0);
});

test('no end means no float, and a diagnostic', () => {
	const model = parseDocument(`${START}\n${image}\nTesto`);
	assert.equal(model.regions.length, 0);
	assert.equal(model.diagnostics.length, 1);
	assert.equal(imageClass(model, model.images[0]!), undefined);
});

test('nested/duplicate starts invalidate the whole outer region', () => {
	const model = parseDocument(region(region(image)));
	assert.equal(model.regions.length, 0);
	assert.equal(model.diagnostics.length, 1);
});

test('orphan end is reported; later independent valid region works', () => {
	const model = parseDocument(`${END}\n\n${region(image)}`);
	assert.equal(model.diagnostics.length, 1);
	assert.equal(model.regions.length, 1);
});

test('backtick and tilde fenced examples are untouched, including longer fences', () => {
	for (const fence of ['```', '~~~~', '````']) {
		const source = `${fence}markdown\n${region(image)}\n${fence}\n${image}`;
		const model = parseDocument(source);
		assert.equal(model.regions.length, 0);
		assert.equal(model.images.length, 1);
		assert.throws(() => targetImage(source, source.indexOf(image), source.indexOf(image)));
	}
});

test('short or mismatched closing fences do not expose code', () => {
	assert.equal(parseDocument('````\n```\n' + image + '\n~~~').images.length, 0);
});

test('fenced code inside lists and quotes is also excluded', () => {
	assert.equal(parseDocument('- ```markdown\n  ' + image + '\n  ```').images.length, 0);
	assert.equal(parseDocument('> ```markdown\n> ' + image + '\n> ```\n' + image).images.length, 1);
});

test('frontmatter, inline code, comments, escaped embeds, indentation and quotes are excluded', () => {
	const source = `---\nvalue: ${image}\n---\n\`${image}\`\n<!--\n${image}\n-->\n\\${image}\n    ${image}\n> ${image}`;
	assert.equal(parseDocument(source).images.length, 0);
});

test('note, PDF and audio embeds are never treated as images', () => {
	assert.equal(parseDocument('![[Nota]] ![[documento.pdf]] ![[audio.mp3]]').images.length, 0);
	assert.equal(parseDocument('![[Foto.PNG|center|300]]').images.length, 1);
});

test('ambiguous selections and ambiguous lines are refused', () => {
	const source = image + ' ' + image;
	assert.throws(() => targetImage(source, 0, source.length));
	assert.throws(() => targetImage(source, image.length + 0.5, image.length + 0.5));
});

test('a wrap range expands to whole lines', () => {
	const source = `${image}\n\nTesto **grassetto**.\nFuori.`;
	assert.deepEqual(wrapRange(source, 3, source.indexOf('\nFuori')), { from: 0, to: source.indexOf('\nFuori') });
});

test('whole-line selection ending at next line start excludes that line, also for CRLF', () => {
	for (const eol of ['\n', '\r\n']) {
		const source = `${image}${eol}Testo${eol}Fuori`;
		assert.equal(source.slice(0, wrapRange(source, 0, source.indexOf('Fuori')).to), `${image}${eol}Testo`);
	}
});

test('empty, overlapping and code selections are refused', () => {
	assert.throws(() => wrapRange(image, 0, 0));
	const existing = region(image);
	assert.throws(() => wrapRange(existing, 0, existing.length));
	const code = '```\n' + image + '\n```';
	assert.throws(() => wrapRange(code, 4, code.length));
});

test('links outside a wrap get no side class', () => {
	const model = parseDocument(image + '\n![[foto.png|center|200]]');
	assert.equal(model.images.length, 2);
	assert.equal(imageClass(model, model.images[0]!), undefined);
	assert.equal(imageClass(model, model.images[1]!), undefined);
});

test('only an image alone on the first content line is laid out; other images in the text stay inline', () => {
	for (const source of [region(`Prima ${image}\nTesto`), region(`Testo.\n\n${image}`), region(`${image} ${image}`)]) {
		const model = parseDocument(source);
		assert.ok(model.images.every(image => !regionForImage(model, image)));
	}
	const model = parseDocument(region(`${image}\n\nTesto con ${image} dentro.`));
	assert.deepEqual(model.images.map(image => imageClass(model, image)), ['iw-left', undefined]);
});

function decorations(state: EditorState) {
	const result: { from: number; cls: string; widget: unknown }[] = [];
	for (const value of state.facet(EditorView.decorations)) {
		if (typeof value === 'function') continue;
		value.between(0, state.doc.length, (from, _to, decoration) => {
			result.push({ from, cls: decoration.spec.class, widget: decoration.spec.widget });
		});
	}
	return result;
}


const source = 'Prima.\n\n' + region(`${image}\n\nTesto.\n\nSecondo.`) + '\n\nDopo.';
function stateAt(anchor = 0, head = anchor) {
	return EditorState.create({ doc: source, selection: { anchor, head },
		extensions: [editorLivePreviewField, livePreview, EditorState.allowMultipleSelections.of(true)] });
}
const previews = (state: EditorState) => decorations(state).filter(d => d.widget instanceof WrapWidget);
const markers = (state: EditorState) => decorations(state).filter(d => d.widget instanceof MarkerWidget);

test('outside selection renders a block widget covering both delimiters, without changing Markdown', () => {
	const state = stateAt();
	assert.equal(previews(state).length, 1);
	assert.equal(previews(state)[0]!.from, source.indexOf(START));
	assert.equal((previews(state)[0]!.widget as WrapWidget).snapshot.to, source.indexOf(END) + END.length);
	assert.equal(state.doc.toString(), source);
});

test('entering text removes preview, exposes markers, and leaving renders updated content', () => {
	let state = stateAt().update({ selection: { anchor: source.indexOf('Testo.') } }).state;
	assert.equal(previews(state).length, 0);
	assert.equal(markers(state).length, 2);
	state = state.update({ changes: { from: source.indexOf('Testo.'), insert: 'Nuovo ' } }).state;
	assert.equal(previews(state).length, 0);
	state = state.update({ selection: { anchor: 0 } }).state;
	assert.equal(previews(state).length, 1);
	assert.ok((previews(state)[0]!.widget as WrapWidget).snapshot.markdown.includes('Nuovo Testo.'));
});

test('selection-only changes reuse the computed rows; text changes recompute them', () => {
	const doc = 'Prima.\n\n![[a.png]] ![[b.png]]\n\nDopo.';
	const rowOf = (state: EditorState) => (decorations(state).find(d => d.widget instanceof RowWidget)!.widget as RowWidget).row;
	let state = EditorState.create({ doc, extensions: [editorLivePreviewField, livePreview] });
	const first = rowOf(state);
	state = state.update({ selection: { anchor: doc.length } }).state;
	assert.equal(rowOf(state), first, 'moving the caret does not re-read the note');
	state = state.update({ changes: { from: doc.length, insert: '!' } }).state;
	assert.notEqual(rowOf(state), first, 'editing the text re-reads it');
});

test('a note without embeds is not parsed at each keystroke; typing a row draws it at once, deleting it goes back', () => {
	const doc = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\nSolo testo.\n\n[wrap:end]\n\nDopo.';
	let state = EditorState.create({ doc, extensions: [editorLivePreviewField, livePreview] });
	assert.equal(state.field(wrapModelField), EMPTY_MODEL, 'no embed: the empty model, no parse');
	assert.deepEqual(decorations(state), [], 'nothing drawn');
	const row = '![[a.png|100]] ![[b.png|120]]';
	state = state.update({ changes: { from: doc.length, insert: `\n\n${row}` } }).state;
	assert.notEqual(state.field(wrapModelField), EMPTY_MODEL, 'an embed: the note is read');
	assert.equal(decorations(state).filter(d => d.widget instanceof RowWidget).length, 1, 'the new row is drawn at once');
	state = state.update({ changes: { from: doc.length, to: state.doc.length } }).state;
	assert.equal(state.field(wrapModelField), EMPTY_MODEL, 'the row deleted: back to the empty model');
	assert.deepEqual(decorations(state), []);
	// A note embed alone is read, but has nothing to draw.
	assert.notEqual(previewModel('![[Nota]]'), EMPTY_MODEL);
	assert.equal(previewModel('![[Nota]]').images.length, 0);
});

test('each delimiter becomes normal editable source when reached by the caret', () => {
	for (const text of [START, END]) {
		const state = stateAt(source.indexOf(text) + 5);
		assert.equal(previews(state).length, 0);
		assert.equal(markers(state).length, 1);
		assert.ok(markers(state).every(marker => marker.from !== source.indexOf(text)));
	}
});

test('forward and backward selections crossing either boundary or the whole region expose source', () => {
	for (const [a, b] of [[0, source.indexOf('Testo.')], [source.indexOf('Testo.'), source.length], [0, source.length]]) {
		for (const [anchor, head] of [[a!, b!], [b!, a!]]) {
			const state = stateAt(anchor, head);
			assert.equal(previews(state).length, 0);
			assert.equal(state.selection.main.anchor, anchor);
			assert.equal(state.selection.main.head, head);
		}
	}
});

test('select-all exposes both delimiters with no replacing widgets', () => {
	assert.ok(decorations(stateAt(0, source.length)).every(decoration => !decoration.widget));
});

test('exact range edges enter editing; neighboring characters outside do not', () => {
	for (const at of [source.indexOf(START), source.indexOf(END) + END.length]) assert.equal(previews(stateAt(at)).length, 0);
	for (const at of [source.indexOf(START) - 1, source.indexOf(END) + END.length + 1]) assert.equal(previews(stateAt(at)).length, 1);
});

test('secondary cursors activate a region even when the main cursor is outside', () => {
	const state = stateAt().update({ selection: EditorSelection.create([
		EditorSelection.cursor(0), EditorSelection.cursor(source.indexOf('Testo.')),
	], 0) }).state;
	assert.equal(previews(state).length, 0);
});

test('independent regions switch independently, and a selection spanning both exposes both', () => {
	const doc = source + '\n\n' + region(`${image}\n\nAltro.`) + '\n\nFine.';
	let state = EditorState.create({ doc, extensions: [editorLivePreviewField, livePreview] });
	assert.equal(previews(state).length, 2);
	state = state.update({ selection: { anchor: doc.indexOf('Testo.') } }).state;
	assert.equal(previews(state).length, 1);
	state = state.update({ selection: { anchor: 0, head: doc.length } }).state;
	assert.equal(previews(state).length, 0);
});

test('editing before a region updates widget offsets and source content', () => {
	const state = stateAt().update({ changes: { from: 0, insert: 'Prefisso\n' } }).state;
	assert.equal(previews(state)[0]!.from, source.indexOf(START) + 9);
	assert.equal((previews(state)[0]!.widget as WrapWidget).snapshot.contentFrom, source.indexOf(image) + 9);
});

test('deleting an end marker removes the preview and restoring it restores the preview', () => {
	let state = stateAt().update({ changes: { from: source.indexOf(END), to: source.indexOf(END) + END.length } }).state;
	assert.equal(previews(state).length, 0);
	state = state.update({ changes: { from: source.indexOf(END), insert: END } }).state;
	assert.equal(previews(state).length, 1);
});

test('source mode disables all decorations without changing the document', () => {
	const toggle = StateEffect.define<boolean>();
	const plain = stateAt().update({ effects: toggle.of(false) }).state;
	assert.deepEqual(decorations(plain), []);
	assert.equal(plain.doc.toString(), source);
	assert.equal(previews(plain.update({ effects: toggle.of(true) }).state).length, 1);
});

// Exercise the real interaction controller with DOM event targets and CodeMirror
// state, without pretending that this is a browser layout/caret integration test.

function pointer(type: string, target: unknown, properties = {}) {
	const event = new Event(type, { cancelable: true });
	Object.defineProperty(event, 'target', { value: target });
	return Object.assign(event, { button: 0, pointerId: 1, clientX: 0, clientY: 0,
		shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...properties }) as unknown as PointerEvent;
}

function interactionFixture() {
	const doc = Object.assign(new EventTarget(), { defaultView: new EventTarget() });
	// On screen 100 px below the scroller's top: the click keeps it there.
	const root = { getBoundingClientRect: () => ({ top: 140 }) } as unknown as HTMLElement;
	const target = { closest: (selector: string) => ['.image-embed', '.iw-block-toolbar'].includes(selector) ? null : root, parentElement: root } as unknown as HTMLElement;
	let nextPosition = source.length;
	let focused = false;
	// Effects dispatched with the transactions, in order.
	const effects: unknown[] = [];
	const view = {
		state: stateAt(),
		dom: { ownerDocument: doc },
		contentDOM: { contains: (element: unknown) => element === root },
		scrollDOM: { getBoundingClientRect: () => ({ top: 40 }) },
		dispatch(spec: Parameters<EditorState['update']>[0]) { this.state = this.state.update(spec).state; effects.push(...[(spec as { effects?: unknown }).effects ?? []].flat()); },
		focus() { focused = true; },
		posAtCoords() { return nextPosition; },
		// The widget starts at the region; stored positions are relative to it.
		posAtDOM() { return source.indexOf(START); },
	};
	previewTargets.set(root, { length: source.indexOf(END) + END.length - source.indexOf(START), fallback: source.indexOf('Testo.') - source.indexOf(START) });
	const controller = new PreviewInteraction(view as unknown as EditorView);
	return { controller, view, target, root, doc, effects, focused: () => focused, destination: (pos: number) => { nextPosition = pos; } };
}

test('rendered-section mapping places a click at the corresponding source line, with safe fallback', () => {
	const root = {} as HTMLElement;
	const section = { closest: () => root, parentElement: root } as unknown as HTMLElement;
	const child = { parentElement: section } as unknown as HTMLElement;
	const markdown = 'Immagine\n\nParagrafo.';
	registerPreviewSource(root, markdown, 100);
	assert.equal(annotatePreviewSection(section, { getSectionInfo: () => ({ text: markdown, lineStart: 2, lineEnd: 2 }) } as never), true);
	assert.equal(previewPosition(child, root, 100), 110);
	assert.equal(previewPosition(root, root, 100), 100);
	const unmapped = { closest: () => root, parentElement: root } as unknown as HTMLElement;
	annotatePreviewSection(unmapped, { getSectionInfo: () => null } as never);
	assert.equal(previewPosition(unmapped, root, 100), 100);
});

test('drawn blocks without section metadata get their source line only when they pair for sure', () => {
	// A drawn block as Obsidian gives it: an `el-*` container around one element.
	const drawn = (tag: string, parent: HTMLElement, src?: string) => ({
		className: `el-${tag}`, parentElement: parent, matches: () => false, querySelector: () => null,
		querySelectorAll: (selector: string) => src && selector === '.internal-embed' ? [{ getAttribute: () => src }] : [],
		firstElementChild: { matches: (selector: string) => selector.split(',').map(part => part.trim()).includes(tag), querySelector: () => null },
	}) as unknown as HTMLElement;
	const root = { children: [] as HTMLElement[] } as unknown as HTMLElement;
	const image = drawn('p', root, 'a.png'), text = drawn('p', root);
	(root as unknown as { children: HTMLElement[] }).children = [image, text];
	registerPreviewSource(root, '![[a.png]]\n\nParagrafo.', 100);
	annotateBlocks(root);
	assert.equal(previewPosition(image, root, 100), 100);
	assert.equal(previewPosition(text, root, 100), 112);
	// A quote in the source drawn as a paragraph: no pairing, the fallback stays.
	const mismatched = { children: [] as HTMLElement[] } as unknown as HTMLElement;
	const other = drawn('p', mismatched);
	(mismatched as unknown as { children: HTMLElement[] }).children = [other];
	registerPreviewSource(mismatched, '> Citazione.', 100);
	annotateBlocks(mismatched);
	assert.equal(previewPosition(other, mismatched, 7), 7);
});

test('enter on a focused preview activates source, without consuming enter from its descendants', () => {
	const { controller, view, root, target } = interactionFixture();
	(root as unknown as { closest: () => HTMLElement }).closest = () => root;
	try {
		assert.equal(controller.keydown(Object.assign(pointer('keydown', target), { key: 'Enter' }) as unknown as KeyboardEvent), false);
		assert.equal(controller.keydown(Object.assign(pointer('keydown', root), { key: 'Enter' }) as unknown as KeyboardEvent), true);
		assert.equal(view.state.selection.main.head, source.indexOf('Testo.'));
	} finally { controller.destroy(); }
});

test('primary click activates source at mapped position without changing Markdown', () => {
	const { controller, view, target, focused, effects } = interactionFixture();
	try {
		const event = pointer('pointerdown', target);
		assert.equal(controller.pointerdown(event), true);
		assert.equal(event.defaultPrevented, true);
		assert.equal(view.state.selection.main.head, source.indexOf('Testo.'));
		assert.equal(previews(view.state).length, 0);
		assert.equal(view.state.doc.toString(), source);
		assert.ok(focused());
		// The clicked line goes back where the clicked element was: 100 px below
		// the scroller's top.
		const scroll = (effects[0] as { value: { range: { head: number }; y: string; yMargin: number } }).value;
		assert.deepEqual([scroll.range.head, scroll.y, scroll.yMargin], [source.indexOf('Testo.'), 'start', 100]);
	} finally { controller.destroy(); }
});

test('clicks in the row and wrap bars never enter the source', () => {
	const { controller, view, root } = interactionFixture();
	const bar = { closest: (selector: string) => selector.includes('.iw-block-toolbar') ? {} : root, parentElement: root } as unknown as HTMLElement;
	const before = view.state.selection.main.head;
	assert.equal(controller.pointerdown(pointer('pointerdown', bar) as unknown as PointerEvent), false);
	assert.equal(view.state.selection.main.head, before);
	const widget = new RowWidget(findRows('![[a.png]]')[0]!, '![[a.png]]', 'nota.md', {} as never, defaultSettings);
	assert.equal(widget.ignoreEvent({ target: bar } as unknown as Event), true);
	assert.equal(widget.ignoreEvent({ target: { closest: () => null } } as unknown as Event), false);
	const snapshot = { from: 0, to: 1, contentFrom: 0, markdown: image, side: 'iw-left' as const, startMarkerTo: 0, endMarkerFrom: 1, compact: false };
	const wrap = new WrapWidget(snapshot, 'nota.md', {} as never, defaultSettings);
	assert.equal(wrap.ignoreEvent({ target: bar } as unknown as Event), true);
	assert.equal(wrap.ignoreEvent({ target: { closest: () => null } } as unknown as Event), false);
});

test('shift-click preserves the previous anchor; modified/right clicks remain native', () => {
	const { controller, view, target } = interactionFixture();
	try {
		for (const modifiers of [{ button: 2 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
			assert.equal(controller.pointerdown(pointer('pointerdown', target, modifiers)), false);
			assert.equal(view.state.selection.main.head, 0);
		}
		controller.pointerdown(pointer('pointerdown', target, { shiftKey: true }));
		assert.equal(view.state.selection.main.anchor, 0);
		assert.equal(view.state.selection.main.head, source.indexOf('Testo.'));
	} finally { controller.destroy(); }
});

test('drag initiated in a widget extends beyond either region boundary and stops on pointerup', () => {
	for (const destination of [0, source.length]) {
		const { controller, view, target, doc, destination: setDestination } = interactionFixture();
		try {
			controller.pointerdown(pointer('pointerdown', target));
			setDestination(destination);
			doc.dispatchEvent(pointer('pointermove', target, { clientX: 20 }));
			assert.equal(view.state.selection.main.anchor, source.indexOf('Testo.'));
			assert.equal(view.state.selection.main.head, destination);
			doc.dispatchEvent(pointer('pointerup', target));
			setDestination(5);
			doc.dispatchEvent(pointer('pointermove', target, { clientX: 40 }));
			assert.equal(view.state.selection.main.head, destination);
		} finally { controller.destroy(); }
	}
});

test('destroying the controller removes drag listeners and ignores later pointer events', () => {
	const { controller, view, target, doc } = interactionFixture();
	controller.pointerdown(pointer('pointerdown', target));
	controller.destroy();
	doc.dispatchEvent(pointer('pointermove', target, { clientX: 20 }));
	assert.equal(view.state.selection.main.head, source.indexOf('Testo.'));
});
