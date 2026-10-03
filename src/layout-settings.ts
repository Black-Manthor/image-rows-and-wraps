import type { Plugin } from 'obsidian';
import { normalizeSettings, type ImageSettings } from './settings';

export function layoutVariables(settings: ImageSettings): Record<string, string> {
	const value = normalizeSettings(settings);
	return { '--iw-wrap-gap': `${value.wrapGap}em`, '--iw-wrap-max': `${value.wrapMaxPercent}%` };
}

// The wrap preferences are CSS variables on the body of every window (main and
// pop-outs), removed when a window closes or the plugin unloads.
export function registerLayoutSettings(plugin: Plugin, getSettings: () => ImageSettings): () => void {
	const bodies = new Set<HTMLElement>();
	// A refresh queued for layout-ready may run after unload: it must not
	// put the variables back.
	let alive = true;
	const attach = (doc: Document) => {
		if (!alive) return;
		bodies.add(doc.body);
		doc.body.setCssProps(layoutVariables(getSettings()));
	};
	const detach = (body: HTMLElement) => {
		body.setCssProps(Object.fromEntries(Object.keys(layoutVariables(getSettings())).map(name => [name, ''])));
		bodies.delete(body);
	};
	const refresh = () => {
		if (!alive) return;
		attach(document);
		plugin.app.workspace.iterateAllLeaves(leaf => attach(leaf.view.containerEl.doc));
		for (const body of bodies) body.setCssProps(layoutVariables(getSettings()));
	};
	plugin.registerEvent(plugin.app.workspace.on('window-open', (_workspaceWindow, win) => attach(win.document)));
	plugin.registerEvent(plugin.app.workspace.on('window-close', (_workspaceWindow, win) => detach(win.document.body)));
	plugin.register(() => { alive = false; for (const body of Array.from(bodies)) detach(body); });
	refresh();
	// Pop-outs restored at startup exist only once the layout is ready.
	plugin.app.workspace.onLayoutReady(refresh);
	return refresh;
}
