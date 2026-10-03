import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Plugin } from './obsidian-stub';
import { installBrowserDOM } from './browser-dom';
import { RowWidget } from '../src/rendering/row-widget';
import { MarkerWidget, WrapWidget } from '../src/rendering/wrap-widget';
import { ownedWraps, renderReadingWrap } from '../src/rendering/reading-wrap';
import { wrapSnapshots } from '../src/rendering/wrap-state';
import { parseDocument } from '../src/markdown/model';
import { findRows } from '../src/markdown/row-model';
import { defaultSettings } from '../src/settings';
import { startGesture, restoreTooltipsNow } from '../src/rendering/pointer-gesture';
import { DropFeedback } from '../src/rendering/drop-feedback';

// A separate realm catches helpers that accidentally use the main document.
export async function ownerDocumentRegression() {
 const frame = document.body.appendChild(document.createElement('iframe'));
 const win = frame.contentWindow as typeof window;
 installBrowserDOM(win);
 const doc = win.document;
 const plugin = new Plugin(); plugin.load();
 const created: { tag: string; owner: boolean; detached: boolean }[] = [];
 const div = win.createDiv, span = win.createSpan;
 const observe = (element: HTMLElement) => {
  created.push({ tag: element.tagName, owner: element.ownerDocument === doc, detached: element.parentNode === null && !element.isConnected });
  return element;
 };
 win.createDiv = ((...args: Parameters<typeof createDiv>) => observe(div(...args))) as typeof createDiv;
 win.createSpan = ((...args: Parameters<typeof createSpan>) => observe(span(...args))) as typeof createSpan;
 const source = 'Prima.\n\n![[a.png|200]] ![[b.png|100]]\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|120]]\n\nTesto.\n\n[wrap:end]\n\nFine.';
 const model = parseDocument(source);
 const host = doc.createElement('div');
 const view = { dom: host, state: EditorState.create({ doc: source }), requestMeasure() {}, dispatch() {} } as unknown as EditorView;
 const row = new RowWidget(findRows(source)[0]!, '![[a.png|200]] ![[b.png|100]]', 'note.md', plugin as never, defaultSettings);
 const wrap = new WrapWidget(wrapSnapshots(model, source)[0]!, 'note.md', plugin as never, defaultSettings);
 try {
  const roots = [row.toDOM(view), wrap.toDOM(view), new MarkerWidget(0, 5, 'Start').toDOM(view), new MarkerWidget(6, 9, 'End').toDOM(view)];
  const returned = roots.map(root => ({ owner: root.ownerDocument === doc, detached: root.parentNode === null && !root.isConnected }));
  const readingHost = doc.body.appendChild(doc.createElement('div'));
  const cleanup = renderReadingWrap(readingHost, ownedWraps(model)[0]!, plugin.app as never, 'note.md', plugin as never);
  const readingOwner = readingHost.querySelector('.iw-reading-wrap')?.ownerDocument === doc;
  cleanup();
  row.destroy(roots[0]!); wrap.destroy(roots[1]!);
  await Promise.resolve();
  return { created, returned, readingOwner, readingClean: readingHost.childNodes.length === 0 && !readingHost.classList.contains('iw-wrap-host'), editorChildren: host.childNodes.length };
 } finally { plugin.unload(); frame.remove(); }
}

// Exercise production gesture/feedback cleanup and the production CSS cascade.
// Synthetic blur verifies event handling; real OS focus is verified manually.
export function cursorRegression() {
 const competitor = document.body.appendChild(document.createElement('style'));
 competitor.textContent = '.tree-item-self.is-clickable { cursor: pointer }';
 const button = document.body.createEl('button', { cls: 'iw-block-toolbar-button mod-move' });
 const sidebar = document.body.createDiv({ cls: 'tree-item-self is-clickable' });
 const states = ['iw-image-dragging', 'iw-block-moving', 'iw-block-moving forbidden', 'iw-row-resizing', 'iw-wrap-resizing'];
 const results = [];
 try {
  for (const state of states) for (const end of ['release', 'escape', 'blur', 'cleanup']) {
   const feedback = new DropFeedback(document);
   const ended: boolean[] = [];
   const event = new PointerEvent('pointerdown', { pointerId: 17, clientX: 30, clientY: 30, bubbles: true });
   const cancel = startGesture({ event, doc: document, win: window, bodyClass: state.split(' ')[0], onEnd: result => { feedback.clear(); ended.push(result.commit); } });
   if (state.includes('forbidden') || state === 'iw-image-dragging') feedback.reject('Refused', 30, 30);
   const during = [getComputedStyle(button).cursor, getComputedStyle(sidebar).cursor];
   if (end === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
   if (end === 'blur') window.dispatchEvent(new Event('blur'));
   if (end === 'cleanup') cancel();
   document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 17, clientX: 30, clientY: 30, bubbles: true }));
   // No forced restore before the assertion: pointer movement must clean up.
   document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 17, clientX: 100, clientY: 100, bubbles: true }));
   cancel();
   results.push({ state, end, during, ended, after: [getComputedStyle(button).cursor, getComputedStyle(sidebar).cursor], classes: Array.from(document.body.classList).filter(name => name.startsWith('iw-')), overlays: document.querySelectorAll('.iw-drop-indicator,.iw-drop-rejection').length });
  }
  return results;
 } finally { restoreTooltipsNow(); competitor.remove(); button.remove(); sidebar.remove(); }
}
