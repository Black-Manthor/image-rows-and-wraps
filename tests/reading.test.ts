import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plugin, appListeners } from './obsidian-stub';
import { registerReadingView } from '../src/rendering/reading-view';
import { defaultSettings } from '../src/settings';
import { alignPreviewParagraphs, imageEmbeds } from '../src/rendering/image-layout';
import { ownedWrapRole, ownedWraps } from '../src/rendering/reading-wrap';
import { parseDocument } from '../src/markdown/model';

// Minimal DOM/event stand-ins, not a browser or a CSS/layout test.
class Element {
	parentElement: Element | null = null;
	children: Element[] = [];
	childNodes: { nodeType: number; textContent: string }[] = [];
	classes = new Set<string>();
	classList = {
		contains: (name: string) => this.classes.has(name),
		add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
		remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
	};
	attributes = new Map<string, string>();
	properties = new Map<string, string>();
	style = {
		setProperty: (name: string, value: string) => this.properties.set(name, value),
		getPropertyValue: (name: string) => this.properties.get(name) ?? '',
		removeProperty: (name: string) => this.properties.delete(name),
	};
	// Obsidian's helper: an empty value removes the property.
	setCssProps(props: Record<string, string>) {
		for (const [name, value] of Object.entries(props)) { if (value) this.properties.set(name, value); else this.properties.delete(name); }
	}
	constructor(readonly tagName = 'DIV', classes = '') { for (const name of classes.split(' ').filter(Boolean)) this.classes.add(name); }
	append(element: Element) { element.parentElement = this; this.children.push(element); return element; }
	matches(selector: string): boolean {
		return selector.split(',').some(part => part.trim().startsWith('.') ? this.classes.has(part.trim().slice(1)) : this.tagName.toLowerCase() === part.trim());
	}
	closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
	querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
	querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
	getAttribute(name: string) { return this.attributes.get(name) ?? null; }
	get dom() { return this as unknown as HTMLElement; }
}
class Observer {
	static instances: Observer[] = [];
	disconnected = false;
	constructor(private callback: () => void) { Observer.instances.push(this); }
	observe() {}
	disconnect() { this.disconnected = true; }
	flush() { if (!this.disconnected) this.callback(); }
}
// A compact wrap (the end marker touches the text): laid out section by
// section. Wraps whose markers are paragraphs of their own are drawn whole
// in their image section instead (reading-wrap.ts, tested below).
const markdown = '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|300]]\n\nTesto.\n[wrap:end]\n\nFuori.';
const ownedMarkdown = '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|300]]\n\nTesto.\n\nAltro.\n\n[wrap:end]\n\nFuori.';
function fixture(lineStart = 2, lineEnd = lineStart, element = new Element('DIV', 'el-p'), source = markdown) {
	const original = globalThis.MutationObserver;
	globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
	const plugin = new Plugin();
	plugin.load();
	registerReadingView(plugin as never, defaultSettings);
	const context = { getSectionInfo: () => ({ text: source, lineStart, lineEnd }), addChild: (child: never) => plugin.addChild(child) };
	return { plugin, element, run: () => plugin.postprocessor!(element.dom, context), cleanup: () => { plugin.unload(); globalThis.MutationObserver = original; } };
}

test('Reading view annotates an image inserted after the postprocessor ran', () => {
	const f = fixture();
	try {
		f.run();
		const observer = Observer.instances.at(-1)!;
		const paragraph = f.element.append(new Element('P'));
		const embed = paragraph.append(new Element('SPAN', 'internal-embed image-embed'));
		embed.attributes.set('src', 'foto.png');
		observer.flush();
		assert.ok(embed.classes.has('iw-left'));
		assert.ok(paragraph.classes.has('iw-image-paragraph'));
		observer.flush();
		assert.ok(embed.classes.has('iw-left'));
		f.plugin.unload();
		assert.ok(observer.disconnected);
		assert.ok(!embed.classes.has('iw-left'));
		assert.ok(!paragraph.classes.has('iw-image-paragraph'));
	} finally { f.cleanup(); }
});

test('Reading view hides the marker\'s own line without observing it, content lines stay visible', () => {
	// Markers are plain visible text in the source (they must survive into
	// exported DOMs, see reading-export.ts): Reading view hides only that one
	// rendered block, and never wires a MutationObserver for it, since a
	// marker line never contains anything that can change.
	for (const line of [0, 5]) {
		const before = Observer.instances.length;
		const f = fixture(line, line);
		try {
			f.run();
			assert.ok(f.element.classes.has('iw-marker-hidden'));
			assert.equal(Observer.instances.length, before);
			f.plugin.unload();
			assert.ok(!f.element.classes.has('iw-marker-hidden'), 'unload restores the native marker');
		} finally { f.cleanup(); }
	}
	for (const line of [2, 4]) {
		const f = fixture(line, line);
		try {
			f.run();
			assert.ok(!f.element.classes.has('iw-marker-hidden'));
		} finally { f.cleanup(); }
	}
});

test('Reading view recognizes a placeholder and restores classes after native embed conversion', () => {
	const f = fixture();
	try {
		const embed = f.element.append(new Element('SPAN', 'internal-embed'));
		embed.attributes.set('src', 'foto.png');
		f.run();
		assert.ok(embed.classes.has('iw-left'));
		embed.classes = new Set(['internal-embed', 'image-embed']);
		Observer.instances.at(-1)!.flush();
		assert.ok(embed.classes.has('iw-left'));
	} finally { f.cleanup(); }
});

test('image discovery includes the root itself and excludes PDF/note placeholders', () => {
	const embed = new Element('SPAN', 'image-embed');
	assert.deepEqual(imageEmbeds(embed.dom), [embed]);
	const root = new Element();
	const note = root.append(new Element('SPAN', 'internal-embed'));
	note.attributes.set('src', 'Nota');
	const pdf = root.append(new Element('SPAN', 'internal-embed'));
	pdf.attributes.set('src', 'documento.pdf');
	assert.deepEqual(imageEmbeds(root.dom), []);
});

test('Reading view marks the first text paragraph and clears floats at the region end only', () => {
	const f = fixture(4);
	try {
		const text = f.element.append(new Element('P'));
		f.run();
		assert.ok(text.classes.has('iw-first-paragraph'));
		assert.ok(f.element.classes.has('iw-region-end'));
	} finally { f.cleanup(); }
	const outside = fixture(7);
	try {
		const count = Observer.instances.length;
		outside.run();
		assert.equal(Observer.instances.length, count);
		assert.ok(!outside.element.classes.has('iw-reading-section'));
	} finally { outside.cleanup(); }
});

test('reprocessing a section, once or many times: old observers disconnected, one child, the layout applied again', () => {
	const f = fixture();
	try {
		const embed = f.element.append(new Element('SPAN', 'image-embed'));
		const count = () => (f.plugin as unknown as { children: Set<unknown> }).children.size;
		const first = Observer.instances.length;
		f.run();
		const once = count();
		for (let i = 0; i < 5; i++) f.run();
		const own = Observer.instances.slice(first);
		assert.equal(own.length, 6, 'one observer per processing');
		assert.ok(own.slice(0, -1).every(observer => observer.disconnected), 'the old ones disconnected');
		assert.ok(!own.at(-1)!.disconnected, 'the last one still watching');
		assert.equal(count(), once, 'one child in the parent, not one per processing');
		assert.ok(embed.classes.has('iw-left'), 'the layout applied again');
	} finally { f.cleanup(); }
});

test('Preview removes only the image-only paragraph box and the first text top margin', () => {
	const root = new Element();
	const imageParagraph = root.append(new Element('P'));
	const embed = imageParagraph.append(new Element('SPAN', 'image-embed'));
	const first = root.append(new Element('P'));
	const second = root.append(new Element('P'));
	alignPreviewParagraphs(root.dom, embed.dom, (element, cls) => element.classList.add(cls));
	assert.ok(imageParagraph.classes.has('iw-image-paragraph'));
	assert.ok(first.classes.has('iw-first-paragraph'));
	assert.ok(!second.classes.has('iw-first-paragraph'));
	imageParagraph.classes.clear();
	imageParagraph.childNodes.push({ nodeType: 3, textContent: 'Caption to preserve' });
	alignPreviewParagraphs(root.dom, embed.dom, (element, cls) => element.classList.add(cls));
	assert.ok(!imageParagraph.classes.has('iw-image-paragraph'));
});


test('Reading view leaves former group markers as ordinary text', () => {
	const source = '[image-row:start]\n\nTesto\n\n[image-row:end]';
	for (const line of [0, 4]) {
		const f = fixture(line, line, new Element('DIV', 'el-p'), source);
		try {
			f.run();
			assert.ok(!f.element.classes.has('iw-marker-hidden'));
			assert.ok(!f.element.classes.has('iw-reading-section'));
		} finally { f.cleanup(); }
	}
});

test('Reading view reprocesses a reused section whose role in the wrap changed', async () => {
	// Obsidian keeps a section whose HTML is unchanged without calling the
	// postprocessor: here "Testo." stays identical but stops being the last
	// wrap paragraph, so its float-clearing class must go.
	appListeners.length = 0;
	const original = globalThis.MutationObserver;
	globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
	const globals = globalThis as unknown as { window?: unknown };
	const hadWindow = 'window' in globals;
	if (!hadWindow) globals.window = globalThis;
	const plugin = new Plugin();
	plugin.load();
	registerReadingView(plugin as never, defaultSettings);
	let text = markdown;
	const element = new Element('DIV', 'el-p');
	const context = { sourcePath: 'nota.md', getSectionInfo: () => ({ text, lineStart: 4, lineEnd: 4 }), addChild: (child: never) => plugin.addChild(child) };
	const modify = (path: string) => { for (const { name, callback } of appListeners) if (name === 'modify') callback({ path }); };
	try {
		await plugin.postprocessor!(element.dom, context);
		assert.ok(element.classes.has('iw-region-end'));
		text = markdown.replace('Testo.', 'Testo.\n\nAltro.');
		// A change to another file never touches this note's sections.
		modify('altra.md');
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(element.classes.has('iw-region-end'));
		modify('nota.md');
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(!element.classes.has('iw-region-end'));
		assert.ok(element.classes.has('iw-reading-section'));
	} finally {
		plugin.unload();
		globalThis.MutationObserver = original;
		if (!hadWindow) delete globals.window;
	}
});

test('a tab or layout change re-reads only the active note, not every open one', async () => {
	appListeners.length = 0;
	const original = globalThis.MutationObserver;
	globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
	const globals = globalThis as unknown as { window?: unknown };
	const hadWindow = 'window' in globals;
	if (!hadWindow) globals.window = globalThis;
	const plugin = new Plugin();
	let active: string | undefined = 'nota.md';
	Object.assign(plugin.app.workspace, { getActiveFile: () => active === undefined ? null : { path: active } });
	plugin.load();
	registerReadingView(plugin as never, defaultSettings);
	const texts: Record<string, string> = { 'nota.md': markdown, 'altra.md': markdown };
	const section = (path: string) => {
		const element = new Element('DIV', 'el-p');
		return { element, context: { sourcePath: path, getSectionInfo: () => ({ text: texts[path]!, lineStart: 4, lineEnd: 4 }), addChild: (child: never) => plugin.addChild(child) } };
	};
	const nota = section('nota.md'), altra = section('altra.md');
	const fire = (name: string) => { for (const listener of appListeners) if (listener.name === name) listener.callback(); };
	try {
		await plugin.postprocessor!(nota.element.dom, nota.context);
		await plugin.postprocessor!(altra.element.dom, altra.context);
		// Both notes change behind Reading view's back: their sections are reused as they are.
		for (const path of Object.keys(texts)) texts[path] = markdown.replace('Testo.', 'Testo.\n\nAltro.');
		fire('active-leaf-change');
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(!nota.element.classes.has('iw-region-end'), 'the active note is re-read');
		assert.ok(altra.element.classes.has('iw-region-end'), 'the other note is left alone');
		active = 'altra.md';
		fire('layout-change');
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(!altra.element.classes.has('iw-region-end'));
		// No active note (for example an empty tab): nothing to re-read.
		active = undefined;
		fire('layout-change');
	} finally {
		plugin.unload();
		globalThis.MutationObserver = original;
		if (!hadWindow) delete globals.window;
	}
});

test('changing the side on the start marker, another section, moves the image of an already processed section', async () => {
	appListeners.length = 0;
	const original = globalThis.MutationObserver;
	globalThis.MutationObserver = Observer as unknown as typeof MutationObserver;
	const globals = globalThis as unknown as { window?: unknown };
	const hadWindow = 'window' in globals;
	if (!hadWindow) globals.window = globalThis;
	const plugin = new Plugin();
	plugin.load();
	registerReadingView(plugin as never, defaultSettings);
	let text = '[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|300]]\n\nTesto.\n[wrap:end]';
	const element = new Element('DIV', 'el-p');
	const embed = element.append(new Element('SPAN', 'image-embed'));
	const context = { sourcePath: 'nota.md', getSectionInfo: () => ({ text, lineStart: 2, lineEnd: 2 }), addChild: (child: never) => plugin.addChild(child) };
	const modify = () => { for (const { name, callback } of appListeners) if (name === 'modify') callback({ path: 'nota.md' }); };
	try {
		await plugin.postprocessor!(element.dom, context);
		assert.ok(embed.classes.has('iw-left'));
		// Only another section changes: this one's own text stays identical.
		text = text.replace('side=left', 'side=right');
		modify();
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(!embed.classes.has('iw-left'));
		assert.ok(embed.classes.has('iw-right'));
	} finally {
		plugin.unload();
		globalThis.MutationObserver = original;
		if (!hadWindow) delete globals.window;
	}
});

test('a wrap with marker paragraphs of its own is owned: image section hosts it, text sections hide', () => {
	const model = parseDocument(ownedMarkdown);
	assert.deepEqual(ownedWraps(model).map(wrap => [wrap.side, wrap.markdown]), [['iw-left', '![[foto.png|300]]\n\nTesto.\n\nAltro.']]);
	assert.equal(ownedWrapRole(model, 2, 2)?.role, 'host');
	assert.equal(ownedWrapRole(model, 4, 4)?.role, 'hidden');
	assert.equal(ownedWrapRole(model, 6, 6)?.role, 'hidden');
	for (const line of [0, 8, 10]) assert.equal(ownedWrapRole(model, line, line), undefined);
	// Compact or not laid out: the per-section layout stays.
	assert.deepEqual(ownedWraps(parseDocument(markdown)), []);
	assert.deepEqual(ownedWraps(parseDocument('[wrap:start]\n![[a.png]]\n\nTesto.\n\n[wrap:end]')), []);
	assert.deepEqual(ownedWraps(parseDocument(ownedMarkdown.replace('![[foto.png|300]]', 'Testo prima dell’immagine.'))), []);
	assert.equal(ownedWraps(parseDocument(ownedMarkdown.replace('side=left', 'side=right')))[0]?.side, 'iw-right');
});

test('Reading view hides a text section of an owned wrap without observing it', () => {
	const f = fixture(4, 4, new Element('DIV', 'el-p'), ownedMarkdown);
	try {
		const before = Observer.instances.length;
		f.run();
		assert.ok(f.element.classes.has('iw-section-hidden'));
		assert.equal(Observer.instances.length, before);
		f.plugin.unload();
		assert.ok(!f.element.classes.has('iw-section-hidden'), 'unload restores the native section');
	} finally { f.cleanup(); }
});

test('PDF: one wait per paragraph for its images, removed at unload', async () => {
	const { retryOnLoad, stopExportRetries } = await import('../src/rendering/reading-export');
	// A paragraph that counts its `load` listeners.
	const listeners = new Set<() => void>();
	const paragraph = {
		addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
		removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
	} as unknown as HTMLElement;
	let loaded = false;
	retryOnLoad(paragraph, () => loaded, () => true);
	assert.equal(listeners.size, 1, 'first processing');
	retryOnLoad(paragraph, () => loaded, () => true);
	assert.equal(listeners.size, 1, 'processed again: still one');
	stopExportRetries();
	assert.equal(listeners.size, 0, 'removed at unload, with no load needed');
	retryOnLoad(paragraph, () => loaded, () => true);
	loaded = true;
	for (const listener of [...listeners]) listener();
	assert.equal(listeners.size, 0, 'removed once the row is laid out');
});
