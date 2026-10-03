import { imageAtElement, resolveImageDrop } from '../src/rendering/drag-target';
import { pressedImages } from '../src/rendering/image-gesture';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import { ImageDragController } from '../src/rendering/image-drag';
import { restoreTooltipsNow } from '../src/rendering/pointer-gesture';
import { previewTargets, annotateImagePosition } from '../src/rendering/preview-dom';
import { defaultSettings } from '../src/settings';
import { parseDocument } from '../src/markdown/model';
import { t } from '../src/i18n';

class Events {
	listeners = new Map<string, Set<(event: any) => void>>();
	addEventListener(name: string, callback: (event: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(callback); this.listeners.set(name, set); }
	removeEventListener(name: string, callback: (event: any) => void) { this.listeners.get(name)?.delete(callback); }
	fire(name: string, values: Record<string, unknown> = {}) {
		const event = { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 40, defaultPrevented: false,
			preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...values };
		// As in the DOM, a listener added during the dispatch waits for the next event.
		for (const fn of Array.from(this.listeners.get(name) ?? [])) fn(event);
		return event;
	}
}
function fixture() {
	const source = '[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|300]]\n\nTesto\n\n[wrap:end]\n\n[wrap:start] %%iw-wrap side=right%%\n\n![[b.png|200]]\n\nAltro\n\n[wrap:end]\n\nParagrafo';
	const images = parseDocument(source).images;
	const content = new Events() as any;
	const doc = new Events() as any;
	const win = new Events() as any;
	win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
	// Drag feedback waits for a frame: `move()` runs the queued frames at once.
	const frames = new Map<number, () => void>();
	let frameId = 0;
	win.requestAnimationFrame = (callback: () => void) => { frames.set(++frameId, callback); return frameId; };
	win.cancelAnimationFrame = (id: number) => { frames.delete(id); };
	const flush = () => { for (const [id, callback] of Array.from(frames)) { frames.delete(id); callback(); } };
	doc.defaultView = win;
	const classes = new Set<string>();
	const hints: any[] = [];
	// An Obsidian tooltip open when the gesture starts.
	const tooltip = { classList: { contains: (name: string) => name === 'tooltip' }, removed: false, remove() { this.removed = true; } };
	doc.body = { classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)), remove: (...names: string[]) => names.forEach(name => classes.delete(name)) },
		children: [tooltip],
		createDiv: () => { const node = { style: {} as Record<string, string>, removed: false, textContent: '', remove() { this.removed = true; }, setCssProps(props: Record<string, string>) { Object.assign(this.style, props); } }; hints.push(node); return node; } };
	const root: any = { querySelectorAll: () => embeds, classList: { contains: (name: string) => name === 'iw-preview' } };
	previewTargets.set(root, { length: source.length, fallback: images[0]!.from });
	const embeds = images.map((image, i) => {
		const rect = { left: i * 120, right: i * 120 + 100, top: 0, bottom: 100, width: 100, height: 100 };
		const embed: any = { parentElement: root, querySelector: () => null, closest: (sel: string) => sel === '.image-embed' ? embed : root, getBoundingClientRect: () => rect };
		annotateImagePosition(embed, image.from);
		return embed;
	});
	const imgs = embeds.map(embed => ({ tagName: 'IMG', closest: () => embed, getBoundingClientRect: () => embed.getBoundingClientRect() }));
	const img = imgs[0]!;
	// Default destination: the plain paragraph after both wraps.
	const paragraph = { closest: () => null };
	content.contains = (node: unknown) => imgs.includes(node as any) || node === root || embeds.includes(node) || node === paragraph;
	content.ownerDocument = doc;
	content.getBoundingClientRect = () => ({ left: 0, right: 500 });
	doc.elementFromPoint = () => paragraph;
	const extensions = [editorInfoField, editorLivePreviewField, history()];
	const view: any = { dom: { ownerDocument: doc }, contentDOM: content,
		state: EditorState.create({ doc: source, extensions }), focus() {},
		scrollDOM: { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 500 }) },
		posAtCoords: () => source.indexOf('Paragrafo'), posAtDOM: () => 0, coordsAtPos: () => ({ top: 150, bottom: 180 }),
		dispatch(spec: any) { this.state = this.state.update(spec).state; },
	};
	let settings = defaultSettings();
	const controller = new ImageDragController(view, () => settings);
	return { source, view, controller, content, doc, flush, img, imgs, embeds, paragraph, classes, hints, tooltip, set: (value: Partial<typeof settings>) => { settings = { ...settings, ...value }; },
		down: (extra = {}) => content.fire('pointerdown', { target: img, ...extra }),
		move: () => { doc.fire('pointermove', { clientX: 190, clientY: 50 }); flush(); },
		up: () => doc.fire('pointerup', { clientX: 190, clientY: 50 }) };
}

test('managed image gesture delays source editing, blocks native drag, then moves once', () => {
	const f = fixture();
	try {
		assert.equal(f.down().defaultPrevented, true);
		assert.equal(f.view.state.selection.main.head, 0);
		assert.equal(f.doc.fire('dragstart').defaultPrevented, true);
		f.move(); f.up();
		assert.deepEqual(parseDocument(f.view.state.doc.toString()).images.map(i => i.path), ['b.png','a.png']);
		assert.equal(undoDepth(f.view.state), 1);
		assert.equal(f.doc.fire('click').defaultPrevented, true);
	} finally { f.controller.destroy(); }
});

test('disabled gesture, resize edge and modified selection are not intercepted', () => {
	const f = fixture();
	try {
		f.set({ dragImages: false });
		assert.equal(f.down().defaultPrevented, false);
		assert.equal(f.doc.fire('dragstart').defaultPrevented, false);
		f.set({ dragImages: true });
		assert.equal(f.down({ clientX: 99 }).defaultPrevented, false);
		assert.equal(f.down({ shiftKey: true }).defaultPrevented, false);
		assert.equal(f.view.state.doc.toString(), f.source);
	} finally { f.controller.destroy(); }
});

test('click enters source; Escape and outside drops do not alter Markdown/history', () => {
	const click = fixture();
	try { click.down(); click.up(); assert.equal(click.view.state.selection.main.head, click.source.indexOf('![[')); assert.equal(undoDepth(click.view.state), 0); }
	finally { click.controller.destroy(); }
	for (const escape of [false, true]) {
		const f = fixture();
		try {
			f.down(); f.move();
			if (escape) f.doc.fire('keydown', { key: 'Escape' });
			else f.doc.elementFromPoint = () => null;
			f.up();
			assert.equal(f.view.state.doc.toString(), f.source);
			assert.equal(undoDepth(f.view.state), 0);
		} finally { f.controller.destroy(); }
	}
});

test('changed document cancels drop; destroyed controller removes capture listeners', () => {
	const f = fixture();
	try {
		f.down(); f.move();
		f.view.dispatch({ changes: { from: f.source.length, insert: '\nNuovo testo' } });
		const current = f.view.state.doc.toString();
		f.up();
		assert.equal(f.view.state.doc.toString(), current);
		f.controller.destroy();
		assert.equal(f.down().defaultPrevented, false);
		// What waits to bring tooltips back goes too, at the plugin's unload.
		restoreTooltipsNow();
		assert.ok([...f.doc.listeners.values()].every((set: any) => set.size === 0));
		assert.equal(f.classes.size, 0);
	} finally { f.controller.destroy(); }
});

test('pressing B overrides selected A immediately and drags B, not A', () => {
	const f = fixture();
	try {
		const images = parseDocument(f.source).images;
		f.view.dispatch({ selection: { anchor: images[0]!.from } });
		f.down({ target: f.imgs[1], clientX: 150 });
		assert.equal(pressedImages.get(f.view), images[1]!.from);
		// Keep the widget stable under the pointer until release.
		assert.equal(f.view.state.selection.main.head, images[0]!.from);
		f.doc.fire('pointermove', { clientX: 40, clientY: 50 });
		f.doc.fire('pointerup', { clientX: 40, clientY: 50 });
		const result = parseDocument(f.view.state.doc.toString());
		// B leaves its wrap unchanged; the wrap's delimiters go.
		assert.deepEqual(result.images.map(i => i.raw), [images[0]!.raw, '![[b.png|200]]']);
		assert.equal(result.regions.length, 1);
		// Dragged from a drawn wrap: the caret stays on A, B's wrap stays drawn.
		assert.equal(f.view.state.selection.main.head, result.images[0]!.from);
		assert.equal(pressedImages.has(f.view), false);
		assert.equal(undoDepth(f.view.state), 1);
	} finally { f.controller.destroy(); }
});

test('selected A does not change which image is extracted when pressing and dragging B', () => {
	const f = fixture();
	try {
		const images = parseDocument(f.source).images;
		f.view.dispatch({ selection: { anchor: images[0]!.from } });
		f.down({ target: f.imgs[1], clientX: 150 });
		f.doc.fire('pointermove', { clientX: 40, clientY: 190 });
		f.doc.fire('pointerup', { clientX: 40, clientY: 190 });
		const result = parseDocument(f.view.state.doc.toString());
		assert.equal(result.images[0]!.raw, images[0]!.raw);
		assert.ok(result.images[0]!.line < result.regions[0]!.end);
		assert.equal(result.images[1]!.raw, '![[b.png|200]]');
		assert.ok(result.images[1]!.line > result.regions[0]!.end);
		assert.equal(f.view.state.selection.main.head, result.images[0]!.from, 'the caret stays where it was, not in the moved image');
		assert.equal(undoDepth(f.view.state), 1);
	} finally { f.controller.destroy(); }
});

test('rejected drop explains destination, keeps B active and creates no undo step', () => {
	const f = fixture();
	try {
		const images = parseDocument(f.source).images;
		f.view.dispatch({ selection: { anchor: images[0]!.from } });
		f.down({ target: f.imgs[1], clientX: 150 });
		f.doc.elementFromPoint = () => null;
		f.move(); f.move();
		assert.equal(f.hints.length, 1);
		assert.match(f.hints[0].textContent, /stessa nota/);
		assert.ok(f.classes.has('iw-drag-forbidden'));
		f.up();
		assert.equal(f.view.state.selection.main.head, images[0]!.from, 'refused from a drawn wrap: the caret stays, no Markdown opened');
		assert.equal(f.view.state.doc.toString(), f.source);
		assert.equal(undoDepth(f.view.state), 0);
		assert.deepEqual([...f.classes], ['iw-gesture']);
		assert.ok(f.hints[0].removed);
	} finally { f.controller.destroy(); }
});

test('rejection feedback clears on valid destination and Escape', () => {
	const f = fixture();
	try {
		f.down();
		f.doc.elementFromPoint = () => null;
		f.move();
		assert.ok(f.classes.has('iw-drag-forbidden'));
		f.doc.elementFromPoint = () => f.paragraph;
		f.move();
		assert.deepEqual([...f.classes].sort(), ['iw-gesture', 'iw-image-dragging']);
		assert.equal(f.tooltip.removed, false);
		assert.ok(f.hints[0].removed);
		f.doc.elementFromPoint = () => null;
		f.move();
		f.doc.fire('keydown', { key: 'Escape' });
		assert.ok(f.hints.every(node => node.removed));
		// Tooltips stay away while the pointer rests where the gesture ended
		// (Obsidian takes the element under it for a new hover), back once it moves.
		assert.deepEqual([...f.classes], ['iw-gesture']);
		f.doc.fire('pointermove', { clientX: 193, clientY: 53 });
		assert.deepEqual([...f.classes], ['iw-gesture'], 'a few pixels are not a move');
		assert.equal(f.tooltip.removed, false);
		f.doc.fire('pointermove', { clientX: 230, clientY: 50 });
		assert.equal(f.classes.size, 0);
		assert.ok(f.tooltip.removed, 'the tooltip does not come back after the gesture');
		assert.equal(f.view.state.doc.toString(), f.source);
	} finally { f.controller.destroy(); }
});


test('an image inside a wrap preview is never a drop destination', () => {
	const f = fixture();
	try {
		f.doc.elementFromPoint = () => f.embeds[1];
		assert.throws(() => resolveImageDrop(f.view, 150, 50), { message: t().imageIntoWrap });
	} finally { f.controller.destroy(); }
});

test('an image alone on its line is found even when Obsidian points past its link; an image in text only on the link', () => {
	// Outside a widget the position comes from CodeMirror (posAtDOM): after the
	// link, for example with spaces behind it, it is still that image's line.
	const source = 'Prima.\n\n![[a.png|100]]   \n\nTesto con ![[b.png]] dentro.';
	const model = parseDocument(source);
	const find = (position: number) => {
		const embed = { closest: () => null };
		const target = { closest: (selector: string) => selector === '.image-embed' ? embed : null };
		const view = { contentDOM: { contains: () => true }, posAtDOM: () => position };
		return imageAtElement(view as never, target as never, model)?.raw;
	};
	assert.equal(find(source.indexOf('![[a') + 3), '![[a.png|100]]', 'on the link');
	assert.equal(find(source.indexOf('\n\nTesto')), '![[a.png|100]]', 'at the end of its line, after the spaces');
	assert.equal(find(source.indexOf('![[b') + 3), '![[b.png]]', 'a link in text: on the link');
	assert.equal(find(source.indexOf('dentro')), undefined, 'the text beside it is not the image');
});
