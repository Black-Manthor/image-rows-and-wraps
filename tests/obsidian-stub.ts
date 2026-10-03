// Test substitute for Obsidian only. CodeMirror and the browser remain real.
import { StateField } from '@codemirror/state';
import { annotatePreviewSection } from '../src/rendering/preview-dom';
export const editorLivePreviewField = StateField.define({
	create: () => true,
	update: (value, tr) => tr.effects.find(effect => typeof effect.value === 'boolean')?.value ?? value,
});
export const editorInfoField = StateField.define({
	create: () => ({ file: { path: 'folder/note.md' } }), update: value => value,
});
// `imagesLoad` false: images of rows are drawn without a source, as while they load.
// `settle`: as Obsidian, the content is there at once and the promise settles a
// frame later; `replace`: then each paragraph is replaced by a copy of it.
export const runtime = { activeComponents: 0, renders: [] as string[], delay: 0, fail: false, imagesLoad: true, settle: false, replace: false };
export class Component {
	private callbacks: (() => void)[] = [];
	private children = new Set<Component>();
	private loaded = false;
	load() { if (!this.loaded) { this.loaded = true; runtime.activeComponents++; } }
	unload() {
		if (this.loaded) { this.loaded = false; runtime.activeComponents--; }
		for (const child of this.children) child.unload();
		this.children.clear();
		for (const callback of this.callbacks.splice(0)) callback();
	}
	addChild<T extends Component>(child: T): T { this.children.add(child); if (this.loaded) child.load(); return child; }
	removeChild<T extends Component>(child: T): T { child.unload(); this.children.delete(child); return child; }
	register(callback: () => void) { this.callbacks.push(callback); }
	registerDomEvent(element: EventTarget, name: string, callback: EventListener, options?: boolean) {
		element.addEventListener(name, callback, options);
		this.register(() => element.removeEventListener(name, callback, options));
	}
}
export class MarkdownRenderChild extends Component {
	constructor(readonly containerEl: HTMLElement) { super(); }
}
// App events registered by the plugin; tests fire them to simulate file changes.
export const appListeners: Array<{ name: string; callback: (...args: unknown[]) => void }> = [];
const events = { on: (name: string, callback: (...args: unknown[]) => void) => { appListeners.push({ name, callback }); return {}; } };
export class Plugin extends Component {
	app = { vault: { ...events }, metadataCache: { ...events }, workspace: { ...events } };
	registerEvent(_ref: unknown) {}
	postprocessor: ((element: HTMLElement, context: unknown) => void) | undefined;
	registerMarkdownPostProcessor(callback: (element: HTMLElement, context: unknown) => void) { this.postprocessor = callback; }
}
export class MarkdownRenderer {
	static async render(_app: unknown, markdown: string, root: HTMLElement, _path: string, _component: Component): Promise<void> {
		runtime.renders.push(markdown);
		if (runtime.delay) await new Promise(resolve => setTimeout(resolve, runtime.delay));
		if (runtime.fail) throw new Error('Simulated render failure');
		const lines = markdown.split('\n');
		for (let line = 0; line < lines.length; line++) {
			if (!lines[line]) continue;
			const section = root.appendChild(root.ownerDocument.createElement('div'));
			section.className = 'el-p';
			const paragraph = section.appendChild(root.ownerDocument.createElement('p'));
			const image = /^!\[\[([^|\]]+)\|([^|\]]+)\|(\d+)\]\]$/.exec(lines[line]!);
			if (image) {
				const embed = paragraph.appendChild(root.ownerDocument.createElement('span'));
				embed.className = 'internal-embed image-embed';
				const img = embed.appendChild(root.ownerDocument.createElement('img'));
				img.width = Number(image[3]);
				img.height = 200;
				img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="teal"/></svg>');
			} else if (/^!\[\[[^\]]+\]\](\s*!\[\[[^\]]+\]\])*\s*(%%[^%]*%%)?\s*$/.test(lines[line]!)) {
				// Image-only paragraph, as Obsidian renders it: comments are dropped.
				for (const match of lines[line]!.matchAll(/!\[\[([^|\]]+)(?:\|(\d+))?\]\]/g)) {
					const embed = paragraph.appendChild(root.ownerDocument.createElement('span'));
					embed.className = 'internal-embed image-embed';
					embed.setAttribute('src', match[1]!);
					paragraph.append(' ');
					const img = embed.appendChild(root.ownerDocument.createElement('img'));
					if (match[2]) img.width = Number(match[2]);
					img.height = 100;
					if (runtime.imagesLoad) img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>');
				}
			} else paragraph.textContent = lines[line]!;
			annotatePreviewSection(section, { getSectionInfo: () => ({ text: markdown, lineStart: line, lineEnd: line }) } as never);
		}
		if (runtime.settle) await new Promise(resolve => root.ownerDocument.defaultView!.requestAnimationFrame(resolve));
		if (runtime.replace) for (const paragraph of Array.from(root.querySelectorAll('p'))) paragraph.replaceWith(paragraph.cloneNode(true));
	}
}

export class MarkdownView {}
// Every notice shown, by message.
export const notices: string[] = [];
// Obsidian's language, as main.ts reads it at load.
export function getLanguage() { return 'it'; }
export class Notice { constructor(message: string) { notices.push(message); } }
// Same contract as Obsidian's: `run` calls a pending call now, `cancel` drops it.
export function debounce<T extends unknown[]>(callback: (...args: T) => unknown, timeout = 0, resetTimer = false) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let args: T | undefined;
	const fire = () => { timer = undefined; const pending = args!; args = undefined; callback(...pending); };
	const debounced = (...next: T) => {
		args = next;
		if (timer !== undefined && !resetTimer) return debounced;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(fire, timeout);
		return debounced;
	};
	debounced.cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; args = undefined; return debounced; };
	debounced.run = () => { if (timer === undefined) return; clearTimeout(timer); fire(); };
	return debounced;
}
export class TFile {
	constructor(readonly path: string = '') {}
	get basename() { return this.path.split('/').pop()!.replace(/\.[^.]*$/, ''); }
}

// UI helpers used by the row bar. The menu is real DOM, so browser tests can
// open it and click an item; dialogs only record that they were opened.
export function setIcon(element: HTMLElement, icon: string) { element.dataset.icon = icon; }
type MenuEntry = { title: string; checked: boolean; icon?: string; label?: boolean; separatorBefore?: boolean; action?: () => void };
// The last menu shown, readable without a DOM (Node tests).
export const shownMenus: MenuEntry[][] = [];
export class Menu {
	private items: MenuEntry[] = [];
	private separator = false;
	addItem(build: (item: { setTitle(t: string): unknown; setChecked(c: boolean): unknown; setIcon(i: string): unknown; setIsLabel(l: boolean): unknown; onClick(a: () => void): unknown }) => void) {
		const entry: MenuEntry = { title: '', checked: false, separatorBefore: this.separator };
		this.separator = false;
		const item = { setTitle(t: string) { entry.title = t; return item; }, setChecked(c: boolean) { entry.checked = c; return item; },
			setIcon(i: string) { entry.icon = i; return item; }, setIsLabel(l: boolean) { entry.label = l; return item; },
			onClick(a: () => void) { entry.action = a; return item; } };
		build(item);
		this.items.push(entry);
		return this;
	}
	addSeparator() { this.separator = true; return this; }
	showAtMouseEvent(event: { clientX?: number; clientY?: number }) { this.showAtPosition({ x: event.clientX ?? 0, y: event.clientY ?? 0 }); }
	showAtPosition(position: { x: number; y: number }) {
		shownMenus.push(this.items);
		if (typeof document === 'undefined') return;
		document.querySelector('.menu')?.remove();
		const menu = document.body.appendChild(document.createElement('div'));
		menu.className = 'menu';
		menu.style.cssText = `position:fixed;left:${position.x}px;top:${position.y}px;z-index:100;background:white`;
		for (const entry of this.items) {
			const node = menu.appendChild(document.createElement('div'));
			node.className = 'menu-item' + (entry.checked ? ' mod-checked' : '');
			node.textContent = entry.title;
			node.addEventListener('click', () => { menu.remove(); entry.action?.(); });
		}
	}
}
// Every dialog opened, the last one last: a test makes the choice on it as the user would.
export const openedModals: ModalBase[] = [];
class ModalBase { constructor(readonly app: unknown) {} setPlaceholder(_text: string) {} open() { openedModals.push(this); } close() {} onClose() {} }
export class SuggestModal<T> extends ModalBase { declare _item?: T; }
export class FuzzySuggestModal<T> extends ModalBase { declare _item?: T; }
// Declarative settings tab (1.13): records the re-render calls the tab asks for.
export class PluginSettingTab {
	updates = 0; domRefreshes = 0;
	constructor(readonly app: unknown, readonly plugin: unknown) {}
	update() { this.updates++; }
	refreshDomState() { this.domRefreshes++; }
}
