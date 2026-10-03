import { Component, MarkdownRenderer, type App } from 'obsidian';
import { wrapImage, type DocumentModel, type Region } from '../markdown/model';
import { layoutWrapContent, wrapContainerClasses } from './image-layout';
import { windowOf } from './preview-dom';

// Reading view virtualizes sections: one far from the screen is replaced by a
// spacer as tall as it was measured. A float spanning sections breaks that:
// the image section measures zero, its height lives in the text beside it,
// and removing one section changes the others (the page jumps by the image
// height). So a wrap is drawn whole inside its image section, like the Live
// Preview widget, and the native sections of its text are hidden: every
// section then has a height of its own.

export interface OwnedWrap { region: Region; markdown: string; side: 'iw-left' | 'iw-right' }

const owned = new WeakMap<DocumentModel, OwnedWrap[]>();

// Laid-out wraps whose markers are paragraphs of their own: every native
// section between them belongs to the wrap alone. Compact wraps (a marker
// touching the text) keep the per-section layout.
export function ownedWraps(model: DocumentModel): OwnedWrap[] {
	let wraps = owned.get(model);
	if (wraps) return wraps;
	const blank = (index: number) => !model.lines[index]?.text.trim();
	const isolated = (index: number) => blank(index - 1) && blank(index + 1);
	wraps = [];
	for (const region of model.regions) {
		if (!wrapImage(model, region) || !isolated(region.start) || !isolated(region.end)) continue;
		wraps.push({ region, side: `iw-${region.side}`,
			markdown: model.lines.slice(region.first, region.last + 1).map(line => line.text).join('\n') });
	}
	owned.set(model, wraps);
	return wraps;
}

// The role of a section in an owned wrap: the host draws the whole wrap, the
// other content sections are hidden. Marker sections are handled apart.
export function ownedWrapRole(model: DocumentModel, lineStart: number, lineEnd: number):
	{ wrap: OwnedWrap; role: 'host' | 'hidden' } | undefined {
	const wrap = ownedWraps(model).find(({ region }) => lineStart > region.start && lineEnd < region.end);
	if (!wrap) return undefined;
	return { wrap, role: lineStart <= wrap.region.first && lineEnd >= wrap.region.first ? 'host' : 'hidden' };
}

// Draws the wrap after the section's native content, which CSS hides.
// Returns the cleanup that restores the native section.
export function renderReadingWrap(element: HTMLElement, wrap: OwnedWrap, app: App, sourcePath: string, parent: Component): () => void {
	const root = windowOf(element).createDiv();
	root.addClasses(['iw-preview', 'iw-reading-wrap']);
	root.classList.add(...wrapContainerClasses(wrap.markdown, wrap.side));
	const content = root.createDiv({ cls: 'iw-preview-content' });
	element.classList.add('iw-wrap-host');
	element.appendChild(root);
	const component = parent.addChild(new Component());
	let alive = true;
	const refresh = () => { if (alive) layoutWrapContent(content, wrap.side); };
	// Native embeds become images after rendering: lay them out when they do.
	const observer = new (windowOf(element).MutationObserver)(refresh);
	observer.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
	void MarkdownRenderer.render(app, wrap.markdown, content, sourcePath, component).then(refresh).catch(() => {
		if (!alive) return;
		content.textContent = wrap.markdown;
		content.classList.add('iw-preview-fallback');
	});
	return () => {
		alive = false;
		observer.disconnect();
		parent.removeChild(component);
		root.remove();
		element.classList.remove('iw-wrap-host');
	};
}
