import { setLanguage } from '../src/i18n';

// Obsidian's DOM additions (obsidian.d.ts: Node.doc, Node.win, Node.instanceOf)
// for the Node tests, whose elements are plain objects. Loaded before every
// test file (tests/run.mjs). The browser suites have their own, on the real DOM
// (tests/browser-fixture.ts).
const scope = globalThis as unknown as Record<string, unknown> & { document?: unknown };
if (typeof scope.HTMLElement === 'undefined') scope.HTMLElement = class HTMLElement {};
// No layout here: an observer of sizes that never reports (the browser suites
// test it on a real DOM).
if (typeof scope.ResizeObserver === 'undefined') scope.ResizeObserver = class ResizeObserver { observe() {} unobserve() {} disconnect() {} };
const define = (name: string, descriptor: PropertyDescriptor) =>
	Object.defineProperty(Object.prototype, name, { configurable: true, enumerable: false, ...descriptor });
// Assigning the name gives the object its own property (CodeMirror's
// EditorState has a `doc`): the getters below only answer when there is none.
const own = (name: string) => function (this: object, value: unknown) {
	Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
};
// The document and window of an object, or the global ones, as in Obsidian.
define('doc', { get(this: { ownerDocument?: unknown }) { return this.ownerDocument ?? scope.document; }, set: own('doc') });
define('win', { get(this: { ownerDocument?: { defaultView?: unknown } }) { return this.ownerDocument?.defaultView ?? scope; }, set: own('win') });
// An object that can be searched like an element counts as an HTMLElement.
define('instanceOf', { writable: true, value(this: { closest?: unknown; tagName?: unknown }, type: unknown) {
	return type === scope.HTMLElement ? typeof this.closest === 'function' || typeof this.tagName === 'string' : this instanceof (type as never);
} });

// The tests read the plugin's Italian texts, unless one chooses another language.
setLanguage('it');
