// Obsidian's DOM additions used by the plugin (obsidian.d.ts), on the real DOM
// of the browser suites (tests/browser-fixture.ts, tests/fixtures/row-layout.ts).
// The Node tests have their own, on plain objects (tests/node-dom.ts).
Object.defineProperty(Node.prototype, 'doc', { configurable: true, get(this: Node) { return this.ownerDocument ?? document; } });
Object.defineProperty(Node.prototype, 'win', { configurable: true, get(this: Node) { return this.ownerDocument?.defaultView ?? window; } });
Node.prototype.instanceOf = function <T>(this: Node, type: { new (): T }): this is T {
	// Across windows: compare with the same constructor of the node's own window.
	const own = (this.ownerDocument?.defaultView as unknown as Record<string, unknown> | null)?.[(type as unknown as { name: string }).name];
	return this instanceof (type as never) || (typeof own === 'function' && this instanceof (own as never));
};
HTMLElement.prototype.addClass = function(...classes: string[]) { this.classList.add(...classes); };
HTMLElement.prototype.addClasses = function(classes: string[]) { this.classList.add(...classes); };
// Every helper the plugin calls must be here: one missing stops the plugin
// half way in Chromium only (a wrap resize did, with `removeClass`), and the
// suites fail on the page error when a test goes that way.
Element.prototype.removeClass = function(...classes: string[]) { this.classList.remove(...classes); };
HTMLElement.prototype.setText = function(text: string | DocumentFragment) { this.textContent = typeof text === 'string' ? text : text.textContent; };
HTMLElement.prototype.createEl = function(this: HTMLElement, tag: string, options?: DomElementInfo | string) {
	const element = this.ownerDocument.createElement(tag);
	const info = typeof options === 'string' ? { cls: options } : options ?? {};
	if (info.cls) element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
	if (info.type) element.setAttribute('type', info.type);
	if (info.text !== undefined) element.textContent = String(info.text);
	for (const [name, value] of Object.entries(info.attr ?? {})) if (value !== null && value !== false) element.setAttribute(name, String(value));
	this.appendChild(element); return element;
} as HTMLElement['createEl'];
HTMLElement.prototype.createDiv = function(options?: DomElementInfo | string) { return this.createEl('div', options); };
HTMLElement.prototype.createSpan = function(options?: DomElementInfo | string) { return this.createEl('span', options); };
HTMLElement.prototype.setCssProps = function(props) {
	for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
};
