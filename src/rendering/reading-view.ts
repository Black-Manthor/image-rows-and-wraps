import { findRows, type ImageRow } from '../markdown/row-model';
import { watchRow } from './row-layout';
import { MarkdownRenderChild, type MarkdownPostProcessorContext, type Plugin } from 'obsidian';
import { annotatePreviewSection, windowOf } from './preview-dom';
import { firstParagraph, flattenImageParagraph, imageEmbeds } from './image-layout';
import { firstTextLine, imageClass, parseDocument, regionForImage, wrapImage, type DocumentModel } from '../markdown/model';
import { applyExportLayout, stopExportRetries } from './reading-export';
import { ownedWrapRole, renderReadingWrap } from './reading-wrap';
import { rowDefaults, type ImageSettings } from '../settings';

// Export/print gives the whole document as one postprocessor call, with no
// section info: see reading-export.ts for how regions are found in that case.
const isPrintContext = (element: HTMLElement) => Boolean(element.closest('.print'));

// Returns a refresh for changes outside the notes (row defaults in the settings).
export function registerReadingView(plugin: Plugin, getSettings: () => ImageSettings): () => void {
	// A few recent texts, so that sections of notes open side by side do not
	// evict each other. Rows are also keyed by the defaults they were read with.
	const parsed = new Map<string, { model: DocumentModel; rows?: ImageRow[]; defaults?: string }>();
	const entryFor = (text: string) => {
		let entry = parsed.get(text);
		if (!entry) {
			entry = { model: parseDocument(text) };
			parsed.set(text, entry);
			if (parsed.size > 4) parsed.delete(parsed.keys().next().value!);
		}
		return entry;
	};
	const modelFor = (text: string) => entryFor(text).model;
	const rowsFor = (text: string) => {
		const defaults = rowDefaults(getSettings());
		const key = JSON.stringify(defaults);
		const entry = entryFor(text);
		if (!entry.rows || entry.defaults !== key) { entry.rows = findRows(text, entry.model, defaults); entry.defaults = key; }
		return entry.rows;
	};
	// What the source says about one section, relative to its own lines: a
	// change of this key means the section must be processed again.
	const sectionKey = (info: { text: string; lineStart: number; lineEnd: number }) => {
		const { lineStart: start, lineEnd: end } = info;
		const model = modelFor(info.text);
		const row = rowsFor(info.text).find(row => row.line === start && row.line === end);
		const owned = ownedWrapRole(model, start, end);
		return JSON.stringify({
			// A wrap drawn whole in its image section: redrawn when any of its text changes.
			owned: owned ? [owned.role, owned.wrap.side, owned.role === 'host' ? owned.wrap.markdown : ''] : null,
			row: row ? [row.settings, row.images.map(image => [image.path, image.width])] : null,
			regions: model.regions.filter(region => start <= region.end && end >= region.start).map(region => {
				const firstText = firstTextLine(model, region);
				// The side is on the start marker, often in another section.
				return [[region.start, region.first, firstText, region.last, region.end].map(line => line - start),
					region.side, Boolean(wrapImage(model, region))];
			}),
			images: model.images.filter(image => image.line >= start && image.line <= end).map(image => image.line - start),
		});
	};
	const children = new Set<MarkdownRenderChild>();
	// One render child per section for its whole life, added to Obsidian once:
	// processing the section again only empties and refills what it holds, so
	// reprocessing never piles unloaded children up in the section's parent.
	type Host = { child: MarkdownRenderChild; cleanups: Array<() => void> };
	const hosts = new WeakMap<HTMLElement, Host>();
	const clear = (host: Host) => { for (const cleanup of host.cleanups.splice(0).reverse()) cleanup(); };
	const hostFor = (element: HTMLElement, context: MarkdownPostProcessorContext): Host => {
		const existing = hosts.get(element);
		if (existing) return existing;
		const host: Host = { child: new MarkdownRenderChild(element), cleanups: [] };
		host.child.register(() => { clear(host); hosts.delete(element); children.delete(host.child); });
		hosts.set(element, host);
		children.add(host.child);
		context.addChild(host.child);
		return host;
	};
	plugin.register(() => {
		for (const child of children) child.unload();
		children.clear();
	});
	// When an edit leaves a section's HTML identical (a `%%iw-row%%` comment,
	// or a wrap paragraph that is no longer the last one), Obsidian keeps the
	// old section without calling the postprocessor again. Processed sections
	// re-read their source after changes to their own file, or after layout
	// changes (mode switches), twice to follow the renderer's own update.
	// A layout or tab change concerns only the active note: the others are
	// re-read when they change (checking every open note cost 11-46 ms per
	// pass with six notes, measured in Obsidian in 0.26.4).
	const sectionRefreshers = new Map<string, Set<() => void>>();
	const pending = new Set<string>();
	let refreshTimers: number[] = [];
	const runRefreshers = (paths: Iterable<string> | 'all') => {
		const groups = paths === 'all' ? Array.from(sectionRefreshers.values())
			: Array.from(paths, path => sectionRefreshers.get(path)).filter(group => group !== undefined);
		for (const group of groups) for (const refresh of Array.from(group)) refresh();
	};
	const scheduleRefresh = (path: string | undefined) => {
		if (path === undefined) return;
		pending.add(path);
		for (const timer of refreshTimers) window.clearTimeout(timer);
		refreshTimers = [50, 500].map((delay, index) => window.setTimeout(() => {
			runRefreshers(pending);
			if (index === 1) pending.clear();
		}, delay));
	};
	// A section shown again (switching to Reading view, its tab coming back) is
	// checked in the frame that shows it: after layout, before paint. A change
	// that leaves its HTML identical (a row's or a wrap's comment) keeps the old
	// section, and the timers below came 3-5 frames after it was on screen with
	// its old layout. They still catch changes while it is shown. One observer
	// per window for all sections, each with what to do when it is shown.
	const visibility = new WeakMap<Window, ResizeObserver>();
	const onShown = new WeakMap<Element, (shown: boolean) => void>();
	const watchShown = (element: HTMLElement, check: () => void): (() => void) => {
		const win = windowOf(element);
		let observer = visibility.get(win);
		if (!observer) {
			observer = new win.ResizeObserver(entries => { for (const entry of entries) onShown.get(entry.target)?.(entry.contentRect.width > 0); });
			visibility.set(win, observer);
		}
		// No width: hidden (display: none, a view or tab in the background).
		let shown = false;
		onShown.set(element, now => { if (now && !shown) check(); shown = now; });
		observer.observe(element);
		const watching = observer;
		return () => { watching.unobserve(element); onShown.delete(element); };
	};
	const activePath = () => plugin.app.workspace.getActiveFile()?.path;
	// False once unloaded: an export still reading its note then stops there.
	let loaded = true;
	plugin.register(() => { loaded = false; stopExportRetries(); for (const timer of refreshTimers) window.clearTimeout(timer); });
	plugin.registerEvent(plugin.app.vault.on('modify', file => scheduleRefresh(file.path)));
	plugin.registerEvent(plugin.app.metadataCache.on('changed', file => scheduleRefresh(file.path)));
	plugin.registerEvent(plugin.app.workspace.on('layout-change', () => scheduleRefresh(activePath())));
	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => scheduleRefresh(activePath())));
	const process = async (element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> => {
		if (annotatePreviewSection(element, context)) return;
		const previous = hosts.get(element);
		if (previous) clear(previous);
		element.classList.remove('iw-marker-hidden', 'iw-section-hidden');
		const initial = context.getSectionInfo(element);
		if (!initial) {
			if (isPrintContext(element)) await applyExportLayout(element, plugin, context.sourcePath, getSettings(), () => loaded);
			return;
		}
		const host = hostFor(element, context);
		const initialModel = modelFor(initial.text);
		const key = sectionKey(initial);
		const refreshSection = () => {
			const info = context.getSectionInfo(element);
			if (info && sectionKey(info) !== key) void process(element, context);
		};
		const group = sectionRefreshers.get(context.sourcePath) ?? new Set<() => void>();
		sectionRefreshers.set(context.sourcePath, group);
		group.add(refreshSection);
		host.cleanups.push(() => {
			group.delete(refreshSection);
			if (!group.size && sectionRefreshers.get(context.sourcePath) === group) sectionRefreshers.delete(context.sourcePath);
			element.classList.remove('iw-marker-hidden', 'iw-section-hidden');
		});
		// Processed again with the new key when it changed: the timers then find it current.
		host.cleanups.push(watchShown(element, refreshSection));
		// A row is exactly one single-line section: its own paragraph.
		const row = rowsFor(initial.text).find(row => row.line === initial.lineStart && row.line === initial.lineEnd);
		const rowParagraph = row ? firstParagraph(element) : null;
		if (row && rowParagraph) {
			host.cleanups.push(watchRow(rowParagraph, row));
			return;
		}
		// The marker's own line is fixed, single-line text with nothing inside
		// it that can change: hide it once, here, and skip the reactive
		// machinery below entirely rather than mutating an observed element
		// from within its own MutationObserver callback.
		if (initial.lineStart === initial.lineEnd &&
			initialModel.regions.some(region => initial.lineStart === region.start || initial.lineStart === region.end)) {
			element.classList.add('iw-marker-hidden');
			return;
		}
		// A wrap with sections of its own (reading-wrap.ts): its image section
		// draws it whole, its other sections stay in place but hidden.
		const owned = ownedWrapRole(initialModel, initial.lineStart, initial.lineEnd);
		if (owned?.role === 'hidden') {
			element.classList.add('iw-section-hidden');
			return;
		}
		if (owned) {
			host.cleanups.push(renderReadingWrap(element, owned.wrap, plugin.app, context.sourcePath, host.child));
			return;
		}
		// Overlap with the region's own content lines, not containment of the
		// whole call or overlap with its marker lines: a call's range can
		// extend past a region (e.g. bundled with a plain paragraph right
		// after it), and that region's own images still need to be found and
		// laid out — but a call that only reaches past the end marker into
		// unrelated trailing content must not match the region at all.
		const matchesRegion = initialModel.regions.some(region => initial.lineStart <= region.last && initial.lineEnd >= region.first);
		if (!matchesRegion) return;
		const applied = new Map<HTMLElement, Set<string>>();
		let alive = true;
		const refresh = () => {
			if (!alive) return;
			const info = context.getSectionInfo(element);
			if (!info) return;
			const model = modelFor(info.text);
			const wanted = new Map<HTMLElement, Set<string>>();
			const add = (target: HTMLElement, cls: string) => {
				const names = wanted.get(target) ?? new Set<string>();
				names.add(cls);
				wanted.set(target, names);
			};
			const images = model.images.filter(image => image.line >= info.lineStart && image.line <= info.lineEnd);
			const embeds = imageEmbeds(element);
			// Pair by occurrence, never by filename. Retry when native embeds load.
			if (embeds.length === images.length) images.forEach((image, index) => {
				const embed = embeds[index];
				const cls = imageClass(model, image);
				const region = regionForImage(model, image);
				if (embed && cls && region && info.lineStart >= region.start && info.lineEnd <= region.end) {
					add(embed, cls);
					flattenImageParagraph(embed, add);
				}
			});
			for (const region of model.regions) {
				if (!wrapImage(model, region)) continue;
				// Overlap with the region's own content lines (first..last), not its marker lines, so a
				// call reaching only into unrelated trailing content past the
				// end marker is not mistaken for still being part of this wrap.
				if (info.lineEnd < region.first || info.lineStart > region.last) continue;
				add(element, 'iw-reading-section');
				if (info.lineStart <= region.first && info.lineEnd >= region.first) add(element, 'iw-region-start');
				if (info.lineStart <= region.last && info.lineEnd >= region.last) add(element, 'iw-region-end');
				const firstText = firstTextLine(model, region);
				if (info.lineStart <= firstText && info.lineEnd >= firstText) {
					const paragraph = firstParagraph(element);
					if (paragraph && !wanted.get(paragraph)?.has('iw-image-paragraph')) add(paragraph, 'iw-first-paragraph');
				}
			}
			// Only change differing classes: observing native class changes must not loop.
			for (const [target, names] of applied) {
				for (const name of names) if (!wanted.get(target)?.has(name)) target.classList.remove(name);
			}
			applied.clear();
			for (const [target, names] of wanted) {
				for (const name of names) if (!target.classList.contains(name)) target.classList.add(name);
				applied.set(target, names);
			}
		};
		const observer = new (windowOf(element).MutationObserver)(refresh);
		// Local to this rendered section; no vault scan or document-wide observer.
		observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
		host.cleanups.push(() => {
			alive = false;
			observer.disconnect();
			for (const [target, names] of applied) target.classList.remove(...names);
		});
		refresh();
	};
	plugin.registerMarkdownPostProcessor(process);
	return () => runRefreshers('all');
}
