import { longNote } from './long-note.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { inlineMap, savePageCoverage, startPageCoverage } from './copertura-mappa.mjs';
import { mkdir } from 'node:fs/promises';
import { ourFrames, record, sourceMapper } from './registro.mjs';

const { outputFiles } = await build({ entryPoints: ['tests/browser-fixture.ts'], bundle: true, write: false, format: 'iife',
	// A map back to the sources: the errors in the registry, and the coverage.
	sourcemap: 'inline',
	plugins: [{ name: 'obsidian-test', setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(process.cwd(), 'tests/obsidian-stub.ts') }));
	} }],
});
// Named, so that the page's stack traces say which script: mapped to src/ and tests/.
const code = outputFiles[0].text.replace('//# sourceMappingURL=', '//# sourceURL=iw-fixture.js\n//# sourceMappingURL=');
const bundles = [{ url: 'iw-fixture.js', map: sourceMapper(inlineMap(code), process.cwd()) }];
const css = await readFile('styles.css', 'utf8');
const browser = await chromium.launch({ headless: true });
record({ kind: 'environment', chromium: browser.version(), build: 'fixture' });
// A failed test's page, kept (never overwritten) and named in the registry.
const failures = join('.obsidian-test', 'screenshots', 'chromium', 'fallimenti');
let pages = 0;
const run = async (name, action, delayedCSS = false, options = {}) => test(name, options, async () => {
	const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
	await startPageCoverage(page);
	// An error in the page fails the test, thrown or only logged: CodeMirror
	// logs (console.error) what an extension throws, and goes on. Warnings are
	// recorded. Each with where it comes from, in src/ or tests/.
	const errors = [];
	const note = (level, text, stack, where = '') => {
		const frames = ourFrames(stack, bundles);
		if (level === 'error') errors.push(`${text}${frames.length ? ` (${frames.join(' ← ')})` : ''}`);
		record({ kind: 'console', level, source: frames[0]?.startsWith('src/') ? 'plugin' : 'pagina', test: name, text, where, ...(frames.length ? { frames } : {}) });
	};
	page.on('pageerror', error => note('error', error.message, error.stack));
	page.on('console', message => {
		const level = message.type();
		if (level !== 'error' && level !== 'warning') return;
		const { url = '', lineNumber = 0, columnNumber = 0 } = message.location() ?? {};
		// The text may hold a stack of its own (CodeMirror logs the error it caught): its frames first.
		const [first, ...stack] = message.text().split('\n');
		note(level, first, `${stack.join('\n')}\nat (${url}:${lineNumber + 1}:${columnNumber + 1})`, url);
	});
	try {
		await page.setContent('<style>body{margin:30px;--text-muted:#666;--interactive-accent:#7655dd;--text-error:#c33;--background-primary:white;--text-normal:#222}#editor{width:600px}p{margin:0 0 16px}</style><div id="editor"></div>');
		if (!delayedCSS) await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: code });
		// The code failed while loading (thrown at import): nothing will be drawn, say why now.
		if (errors.length) throw new Error(`the page did not load: ${errors.join('; ')}`);
		await page.locator('.iw-preview img').waitFor();
		await action(page);
		await page.evaluate(() => window.fixture.destroy());
		assert.equal(await page.evaluate(() => window.fixture.counts().components), 0);
		assert.deepEqual(errors, []);
	} catch (error) {
		const path = join(failures, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 80)}.png`);
		try {
			await mkdir(failures, { recursive: true });
			await page.screenshot({ path });
			record({ kind: 'screenshot', test: name, path });
		} catch (failure) {
			record({ kind: 'screenshot', test: name, missing: true, reason: String(failure?.message ?? failure).split('\n')[0] });
		}
		throw error;
	} finally {
		await savePageCoverage(page, `browser-${++pages}`, code, process.cwd(), entry => entry.source === code);
		await page.close();
	}
});
const select = (page, a, b = a) => page.evaluate(([a, b]) => window.fixture.select(a, b), [a, b]);
// Classes checked with, on failure, the ones the element has.
const expectClasses = async (locator, has = [], not = [], label = '') => {
	const classes = (await locator.evaluate(el => el.className)).split(/\s+/).filter(Boolean);
	for (const name of has) assert.ok(classes.includes(name), `${label}manca la classe ${name}; ha: ${classes.join(' ')}`);
	for (const name of not) assert.ok(!classes.includes(name), `${label}ha ancora la classe ${name}; ha: ${classes.join(' ')}`);
};

try {
 await run('owner-window helpers return detached widget roots and clean the Reading host', async page => {
  const result = await page.evaluate(() => window.fixture.ownerDocumentRegression());
  assert.deepEqual(result.created.map(item => item.tag), ['DIV', 'DIV', 'SPAN', 'SPAN', 'DIV']);
  assert.ok(result.created.every(item => item.owner && item.detached));
  assert.ok(result.returned.every(item => item.owner && item.detached));
  assert.equal(result.editorChildren, 0);
  assert.equal(result.readingOwner, true);
  assert.equal(result.readingClean, true);
 });
 await run('gesture cursor feedback wins competing cursors and cleans release Escape blur and teardown', async page => {
  const results = await page.evaluate(() => window.fixture.cursorRegression());
  assert.equal(results.length, 20);
  for (const result of results) {
   const cursor = result.state.includes('forbidden') || result.state === 'iw-image-dragging' ? 'not-allowed' : result.state === 'iw-block-moving' ? 'grabbing' : 'ew-resize';
   assert.deepEqual(result.during, [cursor, cursor], JSON.stringify(result));
   assert.deepEqual(result.ended, [result.end === 'release'], JSON.stringify(result));
   assert.deepEqual(result.after, ['grab', 'pointer'], JSON.stringify(result));
   assert.deepEqual(result.classes, [], JSON.stringify(result));
   assert.equal(result.overlays, 0, JSON.stringify(result));
  }
 });
	await run('image row renders with its comment settings and releases its preview on source selection', async page => {
		const source = 'Before\n\n![[a.png|200]] ![[b.png|300]] %%iw-row align=center%%\n\nAfter';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-row-preview p.iw-row.iw-row-align-center').waitFor();
		assert.equal(await page.locator('.iw-row-preview .image-embed').count(), 2);
		await select(page, source.indexOf('![['));
		assert.equal(await page.locator('.iw-row-preview').count(), 0);
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
	});
	await run('moving the open note draws its rows and wraps again: links resolve against the new folder', async page => {
		const source = 'Prima.\n\n![[a.png|200]] ![[b.png|300]]\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-row-preview .image-embed').first().waitFor();
		await page.locator('.iw-preview:not(.iw-row-preview) img').waitFor();
		await page.locator('.iw-preview').evaluateAll(els => els.forEach(el => { el.dataset.kept = '1'; }));
		// Same note, only a size changed: the row is kept (0.26.13).
		await page.evaluate(at => window.fixture.insert(at, '1'), source.indexOf('|200') + 1);
		assert.equal(await page.locator('.iw-row-preview[data-kept]').count(), 1);
		// Another file renamed: this editor is left alone.
		assert.equal(await page.evaluate(() => window.fixture.renameOther()), 0);
		const renders = await page.evaluate(() => window.fixture.counts().renders);
		await page.evaluate(() => window.fixture.moveNote('altra/nota.md'));
		assert.equal(await page.locator('.iw-preview[data-kept]').count(), 0, 'nothing kept from the other note');
		assert.equal(await page.evaluate(() => window.fixture.counts().renders), renders + 2);
	});
	await run('Reading reused paragraph updates comment and clears layout when no longer a row', async page => {
		const source = 'Prima.\n\n![[a.png|100]] %%iw-row align=right%%\n\nDopo.';
		await page.evaluate(source => window.fixture.runReadingSection(source, 2, [{ width: 100, src: 'a.png' }]), source);
		const p = page.locator('.iw-reading-test p');
		await expectClasses(p, ['iw-row-align-right']);
		await page.evaluate(source => window.fixture.setReadingSource(source.replace('align=right', 'align=center')), source);
		await expectClasses(p, ['iw-row-align-center'], ['iw-row-align-right']);
		await page.evaluate(source => window.fixture.setReadingSource(source.replace('![[a.png', 'Testo ![[a.png')), source);
		assert.equal(await p.evaluate(el => el.classList.contains('iw-row')), false);
		assert.equal(await p.locator('.image-embed').evaluate(el => el.style.getPropertyValue('--iw-row-width')), '');
	});
	await run('Reading: a section shown again whose source changed silently is redrawn before its first frame; unchanged, it is not; the timers then find it current', async page => {
		// Observations of the sections (ResizeObserver): connected and disconnected, per element.
		await page.evaluate(() => {
			window.observed = new Map();
			const { observe, unobserve } = ResizeObserver.prototype;
			const count = (target, key) => { if (!target.matches?.('.iw-reading-test, .iw-reading-note > div')) return; const entry = window.observed.get(target) ?? { observe: 0, unobserve: 0 }; entry[key]++; window.observed.set(target, entry); };
			ResizeObserver.prototype.observe = function (target, options) { if (!this.test) count(target, 'observe'); return observe.call(this, target, options); };
			ResizeObserver.prototype.unobserve = function (target) { if (!this.test) count(target, 'unobserve'); return unobserve.call(this, target); };
		});
		const frames = n => page.evaluate(n => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(n); }), n);
		// What the frame that shows `selector` again lays out, read after the plugin's own observer (created before), before paint.
		const shownWith = (selector, read) => page.evaluate(([selector, read]) => new Promise(resolve => {
			const target = document.querySelector(selector);
			const observer = new ResizeObserver(entries => { if (entries.at(-1).contentRect.width > 0) { observer.disconnect(); resolve(eval(`(${read})`)(target)); } });
			observer.test = true;
			target.style.display = '';
			observer.observe(target);
		}), [selector, read.toString()]);
		// Class changes on the row's paragraph: the section processed again.
		const reprocessed = async action => {
			await page.evaluate(() => { window.changes = 0; window.watch = new MutationObserver(list => { window.changes += list.length; }); window.watch.observe(document.querySelector('.iw-reading-test p'), { attributes: true, attributeFilter: ['class', 'style'] }); });
			await action();
			await frames(3);
			return page.evaluate(() => { window.watch.disconnect(); return window.changes; });
		};

		// A. A row, its comment changed while the section was hidden: the first frame that shows it has the new gap.
		const row = 'Prima.\n\n![[a.png|100]] ![[b.png|140]] %%iw-row gap=8%%\n\nDopo.';
		await page.evaluate(source => window.fixture.runReadingSection(source, 2, [{ width: 100, src: 'a.png' }, { width: 140, src: 'b.png' }]), row);
		const gap = () => page.evaluate(() => document.querySelector('.iw-reading-test p').style.getPropertyValue('--iw-row-gap'));
		assert.equal(await gap(), `${8 / 700 * 100}%`);
		await page.evaluate(() => { document.querySelector('.iw-reading-test').style.display = 'none'; });
		await frames(2);
		await page.evaluate(source => window.fixture.changeReadingSourceQuietly(source.replace('gap=8', 'gap=24')), row);
		assert.equal(await shownWith('.iw-reading-test', section => section.querySelector('p').style.getPropertyValue('--iw-row-gap')), `${24 / 700 * 100}%`, 'A: the new gap in the first frame that shows it');
		// D. The timers after it find the section current: not processed again.
		assert.equal(await reprocessed(() => page.evaluate(source => window.fixture.setReadingSource(source.replace('gap=8', 'gap=24')), row)), 0, 'D: no second processing');
		// F. Processed again, its old observation went with its old processing: one left.
		assert.deepEqual(await page.evaluate(() => window.observed.get(document.querySelector('.iw-reading-test'))), { observe: 2, unobserve: 1 }, 'F: one observation of the section');
		// C. Hidden and shown again, unchanged: nothing processed again.
		assert.equal(await reprocessed(async () => {
			await page.evaluate(() => { document.querySelector('.iw-reading-test').style.display = 'none'; });
			await frames(2);
			await page.evaluate(() => { document.querySelector('.iw-reading-test').style.display = ''; });
		}), 0, 'C: no processing for an unchanged section');
		// E. Shown all along: a change is caught by the timers as before.
		await page.evaluate(source => window.fixture.setReadingSource(source.replace('gap=8', 'gap=40')), row);
		assert.equal(await gap(), `${40 / 700 * 100}%`, 'E: caught while shown');

		// B. A wrap whose side changed while hidden: the first frame that shows it has it on the new side.
		const wrap = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.runReadingNote(source), wrap);
		assert.equal(await page.evaluate(() => document.querySelector('.iw-reading-note .iw-reading-wrap').classList.contains('iw-layout-iw-left')), true);
		await page.evaluate(() => { document.querySelector('.iw-reading-note').style.display = 'none'; });
		await frames(2);
		await page.evaluate(source => window.fixture.changeReadingSourceQuietly(source.replace('side=left', 'side=right')), wrap);
		assert.deepEqual(await shownWith('.iw-reading-note', note => Array.from(note.querySelectorAll('.iw-reading-wrap')).map(wrap => wrap.className.match(/iw-layout-iw-\w+/)[0])),
			['iw-layout-iw-right'], 'B: on its new side in the first frame that shows it, and only one');
	});

	await run('Reading leaves a row whose images are not all drawn as Obsidian drew it', async page => {
		// Two links, one embed on screen (a broken link, for example): pairing them could lay out the wrong image.
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]] %%iw-row align=right%%\n\nDopo.';
		await page.evaluate(source => window.fixture.runReadingSection(source, 2, [{ width: 100, src: 'a.png' }]), source);
		const p = page.locator('.iw-reading-test p');
		assert.equal(await p.evaluate(el => el.classList.contains('iw-row')), false);
		assert.equal(await p.locator('.image-embed').evaluate(el => el.style.getPropertyValue('--iw-row-width')), '');
	});

	await run('export refuses an ambiguous missing occurrence instead of assigning wrong settings', async page => {
		const source = '![[a.png|100]] %%iw-row align=left%%\n\n![[a.png|100]] %%iw-row align=right%%';
		await page.evaluate(source => window.fixture.runExport(source, [{ embedWidth: 100, src: 'a.png' }]), source);
		assert.equal(await page.locator('.iw-export-test p.iw-row').count(), 0);
	});
	await run('Reading draws a wrap whole in its image section: removing any section moves nothing below', async page => {
		const source = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|300]]\n\nTesto breve.\n\nAltro testo.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.runReadingNote(source), source);
		await page.locator('.iw-reading-wrap img').waitFor();
		const layout = await page.evaluate(() => {
			const note = document.querySelector('.iw-reading-note');
			const img = note.querySelector('.iw-reading-wrap img').getBoundingClientRect();
			// The line box, not the paragraph box: only lines shorten beside a float.
			const range = document.createRange();
			range.selectNodeContents(Array.from(note.querySelectorAll('.iw-reading-wrap p')).find(p => p.textContent === 'Testo breve.'));
			const text = range.getBoundingClientRect();
			const host = note.querySelector('.iw-wrap-host').getBoundingClientRect();
			const hidden = Array.from(note.querySelectorAll('.iw-section-hidden')).map(el => el.getBoundingClientRect().height);
			const after = Array.from(note.children).find(el => el.textContent === 'Dopo.').getBoundingClientRect();
			return { beside: text.left >= img.right && text.top < img.bottom, contained: host.bottom >= img.bottom,
				below: after.top >= img.bottom, hidden };
		});
		assert.deepEqual(layout, { beside: true, contained: true, below: true, hidden: [1, 1] });
		// Virtualization: a section far from the screen becomes a spacer as tall
		// as it was measured. Whichever section goes, "Dopo." stays in place.
		const shifts = await page.evaluate(() => {
			const note = document.querySelector('.iw-reading-note');
			const sections = Array.from(note.children);
			const after = sections.find(el => el.textContent === 'Dopo.');
			const top = () => after.getBoundingClientRect().top;
			const reference = top();
			return sections.filter(section => section !== after).map(section => {
				const next = section.nextElementSibling;
				const spacer = document.createElement('div');
				spacer.style.height = `${next.getBoundingClientRect().top - section.getBoundingClientRect().top}px`;
				section.replaceWith(spacer);
				const shift = Math.round(top() - reference);
				spacer.replaceWith(section);
				return shift;
			});
		});
		assert.deepEqual(shifts, shifts.map(() => 0));
		// Editing the wrap text redraws the host, even when its own line is unchanged.
		await page.evaluate(source => window.fixture.setReadingSource(source.replace('Testo breve.', 'Testo cambiato.')), source);
		await page.locator('.iw-reading-wrap p').filter({ hasText: 'Testo cambiato.' }).waitFor();
		assert.equal(await page.locator('.iw-reading-wrap').count(), 1);
		// Unload restores the native sections.
		await page.evaluate(() => window.fixture.destroy());
		assert.equal(await page.locator('.iw-reading-wrap, .iw-wrap-host, .iw-section-hidden, .iw-marker-hidden').count(), 0);
	});

	await run('Reading marker sections retain a measurable box without visible text', async page => {
		const result = await page.evaluate(() => {
			const host = document.createElement('div');
			host.className = 'markdown-reading-view';
			host.innerHTML = '<div class="markdown-preview-view"><div class="el-p iw-marker-hidden"><p>[wrap:start]</p></div><p>After</p></div>';
			document.body.append(host);
			const marker = host.querySelector('.iw-marker-hidden');
			const box = marker.getBoundingClientRect();
			const after = marker.nextElementSibling.getBoundingClientRect();
			const values = { height: box.height, below: after.top >= box.bottom,
				visibility: getComputedStyle(marker).visibility,
				childBoxes: marker.firstElementChild.getClientRects().length };
			host.remove();
			return values;
		});
		assert.deepEqual(result, { height: 1, below: true, visibility: 'hidden', childBoxes: 0 });
	});
	await run('clicking a rendered paragraph opens source at that paragraph; edits render on exit', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		await page.locator('.iw-preview p').filter({ hasText: 'Secondo paragrafo.' }).click();
		assert.equal(await page.locator('.iw-preview').count(), 0);
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, text.indexOf('Secondo'));
		assert.equal(await page.locator('.iw-marker').count(), 2);
		await page.keyboard.type('Nuovo ');
		await select(page, 0);
		await page.locator('.iw-preview p').filter({ hasText: 'Nuovo Secondo' }).waitFor();
		assert.equal(await page.evaluate(() => window.fixture.doc()), text.replace('Secondo', 'Nuovo Secondo'));
	});
	await run('a wrap updated in place (longer link, other side) still maps a paragraph click to its source', async page => {
		const source = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|99]]\n\nPrimo.\n\nSecondo.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-preview img').waitFor();
		await page.locator('.iw-preview').evaluate(el => { el.dataset.kept = '1'; });
		// Resize (99 → 199 px), then the side: both change the source's length.
		await page.evaluate(at => window.fixture.insert(at, '1'), source.indexOf('|99') + 1);
		await page.locator('.iw-preview').hover();
		await page.locator('.iw-wrap-toolbar button[aria-label="Cambia lato del wrap"]').click();
		const changed = source.replace('|99', '|199').replace('side=left', 'side=right');
		assert.equal(await page.evaluate(() => window.fixture.doc()), changed);
		assert.equal(await page.locator('.iw-preview[data-kept]').count(), 1, 'updated in place, not redrawn');
		await page.locator('.iw-preview p').filter({ hasText: 'Secondo.' }).click();
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, changed.indexOf('Secondo.'));
	});
	await run('clicking the image opens its original link, without rewriting the document', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		await page.locator('.iw-preview img').click();
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, text.indexOf('![['));
		assert.equal(await page.evaluate(() => window.fixture.doc()), text);
	});
	await run('shift-click preserves the external anchor and selects across the start delimiter', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		await page.locator('.iw-preview p').filter({ hasText: 'Secondo paragrafo.' }).click({ modifiers: ['Shift'] });
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), { anchor: 0, head: text.indexOf('Secondo') });
		assert.equal(await page.locator('.iw-preview').count(), 0);
	});
	await run('a displayed delimiter opens as editable source at its own position', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		await select(page, text.indexOf('Primo'));
		await page.locator('.iw-marker').filter({ hasText: 'wrap:end' }).click();
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, text.indexOf('[wrap:end'));
		assert.equal(await page.locator('.iw-marker').filter({ hasText: 'wrap:end' }).count(), 0);
	});
	await run('select-all and backward cross-boundary selections expose complete source', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		for (const [a, b] of [[0, text.length], [text.length, 0]]) {
			await select(page, a, b);
			assert.equal(await page.locator('.iw-preview, .iw-marker').count(), 0);
			assert.deepEqual(await page.evaluate(() => window.fixture.selection()), { anchor: a, head: b });
		}
	});
	await run('drag starting in the preview continues into text after the region', async page => {
		const box = await page.locator('.iw-preview p').filter({ hasText: 'Primo paragrafo.' }).boundingBox();
		await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
		await page.mouse.down();
		const text = await page.evaluate(() => window.fixture.text);
		const end = await page.evaluate(() => window.fixture.coords(window.fixture.text.indexOf('Dopo') + 3));
		await page.mouse.move(end.left, (end.top + end.bottom) / 2, { steps: 12 });
		await page.mouse.up();
		const selection = await page.evaluate(() => window.fixture.selection());
		assert.equal(selection.anchor, text.indexOf('Primo'));
		assert.ok(selection.head >= text.indexOf('Dopo'), `selezione ${selection.anchor}-${selection.head}, «Dopo.» a ${text.indexOf('Dopo')}`);
		assert.equal(await page.locator('.iw-preview').count(), 0);
	});
	await run('native drag from before to after a preview selects its Markdown rather than skipping it', async page => {
		const start = await page.evaluate(() => window.fixture.coords(0));
		const end = await page.evaluate(() => window.fixture.coords(window.fixture.text.length));
		await page.mouse.move(start.left + 1, (start.top + start.bottom) / 2);
		await page.mouse.down();
		await page.mouse.move(end.left, (end.top + end.bottom) / 2, { steps: 20 });
		const adjusted = await page.evaluate(() => window.fixture.coords(window.fixture.text.length));
		await page.mouse.move(adjusted.left, (adjusted.top + adjusted.bottom) / 2, { steps: 10 });
		await page.mouse.up();
		const text = await page.evaluate(() => window.fixture.text);
		const selection = await page.evaluate(() => window.fixture.selection());
		assert.ok(selection.anchor <= text.indexOf('[wrap:start') && selection.head >= text.indexOf('Dopo'), `selezione ${selection.anchor}-${selection.head}, attesa da ${text.indexOf('[wrap:start')} a ${text.indexOf('Dopo')} o oltre`);
		assert.equal(await page.locator('.iw-preview').count(), 0);
	});
	await run('keyboard activation of the focused preview enters the image line', async page => {
		await page.locator('.iw-preview').focus();
		await page.keyboard.press('Enter');
		const text = await page.evaluate(() => window.fixture.text);
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, text.indexOf('![['));
		assert.equal(await page.locator('.iw-preview').count(), 0);
	});
	await run('a short rendered region contains its float, including after resizing the editor', async page => {
		for (const width of [600, 340, 760]) {
			await page.locator('#editor').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
			await page.waitForTimeout(60);
			const box = await page.locator('.iw-preview').boundingBox();
			const img = await page.locator('.iw-preview img').boundingBox();
			const after = await page.evaluate(() => window.fixture.coords(window.fixture.text.indexOf('Dopo')));
			assert.ok(box.y + box.height >= img.y + img.height - 1, `larghezza ${width}: il wrap finisce a ${box.y + box.height}, l’immagine a ${img.y + img.height}`);
			assert.ok(after.top >= box.y + box.height - 1, `larghezza ${width}: «Dopo.» a ${after.top}, sopra la fine del wrap (${box.y + box.height})`);
		}
	});
	await run('equal-widget reuse and repeated entry/exit release all render components', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		for (let i = 0; i < 5; i++) {
			await select(page, 1);
			await select(page, 2);
			await select(page, text.indexOf('Primo'));
			await select(page, 0);
		}
		assert.equal(await page.evaluate(() => window.fixture.counts().components), 4); // plugin, interaction, image drag, preview
	});
	await run('late asynchronous renders cannot resurrect a preview after editing starts', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		await select(page, text.indexOf('Primo'));
		await page.evaluate(() => window.fixture.renderDelay(80));
		await select(page, 0);
		await select(page, text.indexOf('Secondo'));
		await page.waitForTimeout(150);
		assert.equal(await page.locator('.iw-preview').count(), 0);
		assert.equal(await page.evaluate(() => window.fixture.counts().components), 3);
	});
	await run('a render failure leaves readable Markdown and a working route into editing', async page => {
		const text = await page.evaluate(() => window.fixture.text);
		await select(page, text.indexOf('Primo'));
		await page.evaluate(() => window.fixture.renderFail(true));
		await select(page, 0);
		await page.locator('.iw-preview-fallback').waitFor();
		await page.locator('.iw-preview-fallback').click();
		assert.equal(await page.locator('.iw-preview').count(), 0);
		assert.equal(await page.evaluate(() => window.fixture.doc()), text);
	});

	await run('a render failure of a row, or of a wrap in Reading, leaves its Markdown readable', async page => {
		const row = '![[a.png|100]] ![[b.png|140]]';
		await page.evaluate(() => window.fixture.renderFail(true));
		await page.evaluate(source => window.fixture.setDoc(source), `Prima.\n\n${row}\n\nDopo.`);
		const preview = page.locator('.iw-row-preview');
		await page.waitForFunction(text => document.querySelector('.iw-row-preview')?.textContent === text, row);
		assert.equal(await preview.evaluate(el => el.classList.contains('iw-row-pending')), false, 'not left waiting for a drawing');
		await preview.click();
		assert.equal(await page.locator('.iw-row-preview').count(), 0, 'a click still opens the Markdown');
		const wrap = '![[foto.png|300]]\n\nTesto.';
		await page.evaluate(source => window.fixture.runReadingNote(source), `Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n${wrap}\n\n[wrap:end]\n\nDopo.`);
		const fallback = page.locator('.iw-reading-wrap .iw-preview-fallback');
		await fallback.waitFor();
		assert.equal(await fallback.textContent(), wrap);
	});

	await run('a wrap image changing height realigns line numbers without any selection transaction', async page => {
		const source = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|300]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-preview img').first().waitFor();
		await page.waitForTimeout(200);
		const before = await page.evaluate(() => window.fixture.selectionTransactions());
		await page.locator('.iw-preview img').first().evaluate(img => { img.style.height = '520px'; });
		const lineNumber = source.split('\n').length;
		await page.waitForFunction(n => {
			const label = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).find(el => el.textContent === String(n) && el.getBoundingClientRect().height > 0);
			const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Dopo.');
			return label && line && Math.abs(label.getBoundingClientRect().top - line.getBoundingClientRect().top) < 2;
		}, lineNumber, { timeout: 3000 });
		assert.equal(await page.evaluate(() => window.fixture.selectionTransactions()), before);
	});

	await run('a wrap measures again only when its height changes, at most once per frame', async page => {
		const source = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|300]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-preview img').first().waitFor();
		await page.waitForTimeout(200);
		const before = await page.evaluate(() => window.fixture.remeasures());
		// Class changes inside the wrap (feedback, native embeds) keep its height.
		await page.locator('.iw-preview-content p').last().evaluate(async p => {
			for (let i = 0; i < 20; i++) { p.classList.toggle('iw-test-class'); await new Promise(r => requestAnimationFrame(r)); }
		});
		await page.waitForTimeout(100);
		assert.equal(await page.evaluate(() => window.fixture.remeasures()), before);
		// A burst of height changes in one frame: one measure.
		await page.locator('.iw-preview img').first().evaluate(img => { for (const h of [400, 450, 520]) { img.style.height = `${h}px`; img.getBoundingClientRect(); } });
		await page.waitForTimeout(200);
		assert.equal(await page.evaluate(() => window.fixture.remeasures()), before + 1);
	});

	await run('row bar: hidden until hover, a menu choice edits only the comment, undo restores', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const row = page.locator('.iw-row-preview');
		await row.locator('p.iw-row').waitFor();
		const bar = row.locator('.iw-row-toolbar');
		assert.equal(await bar.evaluate(el => getComputedStyle(el).opacity), '0');
		const height = (await row.boundingBox()).height;
		await row.hover();
		assert.equal(await bar.evaluate(el => getComputedStyle(el).opacity), '1');
		assert.equal((await row.boundingBox()).height, height, 'the bar never takes space');
		const selection = await page.evaluate(() => window.fixture.selection());
		// The first button is the handle that moves the row; the menus follow.
		await expectClasses(bar.locator('button').first(), ['mod-move'], [], 'primo pulsante: ');
		await bar.locator('button').nth(1).click();
		await page.locator('.menu .menu-item', { hasText: 'Centro' }).click();
		const edited = 'Prima.\n\n![[a.png|100]] ![[b.png|140]] %%iw-row align=center%%\n\nDopo.';
		assert.equal(await page.evaluate(() => window.fixture.doc()), edited);
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), selection, 'the caret did not enter the row');
		assert.equal(await page.evaluate(() => window.fixture.hasFocus()), true, 'the editor has the keyboard again, for Undo');
		await page.locator('.iw-row-preview p.iw-row.iw-row-align-center').waitFor();
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
	});

	await run('wrap bar whose wrap is gone at the click: a notice, and the note stays as it is', async page => {
		const source = 'Testo senza wrap.\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.evaluate(() => window.fixture.strayWrapBar(0));
		const stray = page.locator('.iw-stray-wrap');
		for (const label of ['Cambia lato del wrap', 'Rimuovi wrap mantenendo il contenuto']) {
			await stray.hover();
			await stray.locator(`.iw-wrap-toolbar button[aria-label="${label}"]`).click();
			assert.equal(await page.evaluate(() => window.fixture.doc()), source, label);
			assert.equal((await page.evaluate(() => window.fixture.notices())).at(-1), 'Posiziona il cursore dentro un solo wrap.', label);
		}
		assert.equal(await page.evaluate(() => window.fixture.undoDepth()), 1, 'only the setup is in the history');
	});

	await run('wrap bar: hidden until hover, changes side and removes the wrap, each undoable, without entering the source', async page => {
		const source = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const wrap = page.locator('.iw-preview:not(.iw-row-preview)');
		await wrap.locator('img').waitFor();
		const bar = wrap.locator('.iw-wrap-toolbar');
		assert.equal(await bar.evaluate(el => getComputedStyle(el).opacity), '0');
		const height = (await wrap.boundingBox()).height;
		await wrap.hover();
		assert.equal(await bar.evaluate(el => getComputedStyle(el).opacity), '1');
		assert.equal((await wrap.boundingBox()).height, height, 'the bar never takes space');
		// On a left wrap the bar is in the right corner, away from the image.
		const [barBox, wrapBox] = [await bar.boundingBox(), await wrap.boundingBox()];
		assert.ok(barBox.x + barBox.width > wrapBox.x + wrapBox.width - 10, `barra che finisce a ${barBox.x + barBox.width}, wrap a ${wrapBox.x + wrapBox.width}: non nell’angolo destro`);
		const selection = await page.evaluate(() => window.fixture.selection());
		await bar.locator('button[aria-label="Cambia lato del wrap"]').click();
		const right = source.replace('side=left', 'side=right');
		assert.equal(await page.evaluate(() => window.fixture.doc()), right);
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), selection, 'the caret did not enter the wrap');
		assert.equal(await page.evaluate(() => window.fixture.hasFocus()), true, 'the editor has the keyboard again, for Undo');
		await page.locator('.iw-preview.iw-layout-iw-right').waitFor();
		// On a right wrap, the left corner.
		await page.locator('.iw-preview.iw-layout-iw-right').hover();
		const [rightBar, rightWrap] = [await page.locator('.iw-wrap-toolbar').boundingBox(), await page.locator('.iw-preview.iw-layout-iw-right').boundingBox()];
		assert.ok(rightBar.x < rightWrap.x + 10, `barra da ${rightBar.x}, wrap da ${rightWrap.x}: non nell’angolo sinistro`);
		await page.locator('.iw-wrap-toolbar button[aria-label="Rimuovi wrap mantenendo il contenuto"]').click();
		assert.equal(await page.evaluate(() => window.fixture.doc()), 'Prima.\n\n![[foto.png|100]]\n\nTesto.\n\nDopo.');
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), right);
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
	});

	await run('wrap bar: a compact wrap offers «Correggi il formato del wrap», which fixes that wrap only, in one undo step', async page => {
		const compact = side => `[wrap:start] %%iw-wrap side=${side}%%\n![[foto.png|100]]\nTesto ${side}.\n[wrap:end]`;
		const well = '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto in ordine.\n\n[wrap:end]';
		const source = `Prima.\n\n${well}\n\n${compact('left')}\n\nMezzo.\n\n${compact('right')}\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const wraps = page.locator('.iw-preview:not(.iw-row-preview)');
		await wraps.nth(2).locator('img').waitFor();
		const fixButtons = () => page.locator('.iw-wrap-toolbar button[aria-label="Correggi il formato del wrap"]');
		assert.equal(await fixButtons().count(), 2, 'only the two compact wraps');
		assert.equal(await page.locator('.iw-wrap-toolbar.mod-compact').count(), 2);
		// Bars are tinted, not the page's white; a compact wrap's bar in another color.
		const backgrounds = await page.evaluate(() => ['.iw-wrap-toolbar:not(.mod-compact)', '.iw-wrap-toolbar.mod-compact']
			.map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
		assert.ok(!backgrounds.includes('rgb(255, 255, 255)') && backgrounds[0] !== backgrounds[1], backgrounds.join(' / '));
		const selection = await page.evaluate(() => window.fixture.selection());
		await wraps.nth(1).hover();
		await wraps.nth(1).locator('button[aria-label="Correggi il formato del wrap"]').click();
		const fixed = source.replace(compact('left'), '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\nTesto left.\n\n[wrap:end]');
		assert.equal(await page.evaluate(() => window.fixture.doc()), fixed);
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), selection, 'the caret did not enter the wrap');
		await page.waitForFunction(() => document.querySelectorAll('.iw-wrap-toolbar button[aria-label="Correggi il formato del wrap"]').length === 1);
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		await page.waitForFunction(() => document.querySelectorAll('.iw-wrap-toolbar button[aria-label="Correggi il formato del wrap"]').length === 2);
	});
	await run('wrap bar: text typed right after the end marker makes the wrap compact, and its bar offers the fix at once', async page => {
		// The wrap itself does not change (same range, same content): only its
		// form does, and the bar depends on it.
		const source = 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-preview:not(.iw-row-preview) img').waitFor();
		const fixButtons = () => page.evaluate(() => document.querySelectorAll('.iw-wrap-toolbar button[aria-label="Correggi il formato del wrap"]').length);
		assert.equal(await fixButtons(), 0);
		await page.evaluate(position => window.fixture.insert(position, '\nAttaccato.'), source.indexOf('[wrap:end]') + '[wrap:end]'.length);
		await page.waitForFunction(() => document.querySelectorAll('.iw-wrap-toolbar button[aria-label="Correggi il formato del wrap"]').length === 1);
		assert.equal(await fixButtons(), 1, 'the fix appears without redrawing the wrap by other means');
		await page.evaluate(() => window.fixture.undo());
		await page.waitForFunction(() => document.querySelectorAll('.iw-wrap-toolbar button[aria-label="Correggi il formato del wrap"]').length === 0);
		assert.equal(await fixButtons(), 0, 'and goes away when the wrap is in order again');
	});
	await run('wrap bar: the move handle drags the whole wrap between paragraphs, in one undo step; never into another wrap', async page => {
		const wrap = '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]';
		const other = '[wrap:start] %%iw-wrap side=right%%\n\n![[b.png|100]]\n\nAltro.\n\n[wrap:end]';
		const source = `Prima.\n\n${wrap}\n\nDopo.\n\n${other}\n\nFine.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const preview = page.locator('.iw-preview.iw-layout-iw-left');
		await preview.locator('img').waitFor();
		await page.locator('.iw-preview.iw-layout-iw-right img').waitFor();
		await preview.hover();
		const handle = preview.locator('.iw-wrap-toolbar .mod-move');
		const box = await handle.boundingBox();
		const selection = await page.evaluate(() => window.fixture.selection());
		const lineBox = async text => page.evaluate(text => {
			const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === text);
			const r = line.getBoundingClientRect();
			return { x: r.left + 20, top: r.top, bottom: r.bottom };
		}, text);
		// Over the other wrap: refused, with the reason.
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		const target = await page.locator('.iw-preview.iw-layout-iw-right').boundingBox();
		await page.mouse.move(target.x + 60, target.y + target.height / 2, { steps: 10 });
		await page.locator('.iw-drop-rejection').waitFor();
		assert.match(await page.locator('.iw-drop-rejection').textContent(), /dentro un altro wrap/);
		// Below "Fine.": allowed, a horizontal bar marks the place.
		const fine = await lineBox('Fine.');
		await page.mouse.move(fine.x, fine.bottom - 2, { steps: 10 });
		await page.locator('.iw-drop-indicator').waitFor();
		assert.equal(await page.locator('.iw-drop-rejection').count(), 0);
		await page.mouse.up();
		const moved = `Prima.\n\nDopo.\n\n${other}\n\nFine.\n\n${wrap}`;
		assert.equal(await page.evaluate(() => window.fixture.doc()), moved);
		assert.equal(await page.locator('.iw-drop-indicator').count(), 0);
		assert.equal(await page.evaluate(() => document.body.classList.contains('iw-block-moving')), false);
		assert.equal(await page.evaluate(() => window.fixture.hasFocus()), true, 'the editor has the keyboard again, for Undo');
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		// Escape cancels a move in progress.
		await page.locator('.iw-preview.iw-layout-iw-left').hover();
		const again = await page.locator('.iw-preview.iw-layout-iw-left .mod-move').boundingBox();
		await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
		await page.mouse.down();
		const dopo = await lineBox('Dopo.');
		await page.mouse.move(dopo.x, dopo.bottom - 2, { steps: 8 });
		await page.keyboard.press('Escape');
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), selection, 'the caret never entered a wrap');
	});

	// A move held while the note scrolls far from the block: CodeMirror drops
	// the block's widget (here after about 900 px; in Obsidian farther), and the
	// move must go on. Rows and wraps share the handle.
	const farBlocks = {
		row: '![[foto.png|100]] ![[b.png|100]] %%iw-row gap=8%%',
		wrap: '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]',
	};
	const farNote = block => `Prima.\n\n${block}\n\n${Array.from({ length: 150 }, (_, i) =>
		`Paragrafo ${i + 1}, abbastanza lungo da occupare una riga intera del testo di prova.`).join('\n\n')}\n\nFine.`;
	const pressBlockHandle = async (page, scope = '#editor') => {
		const preview = page.locator(`${scope} .iw-preview`).first();
		await preview.locator('img').first().waitFor();
		await preview.hover();
		const handle = await preview.locator('.mod-move').boundingBox();
		await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
		await page.mouse.down();
		await page.mouse.move(handle.x + 40, handle.y + 150, { steps: 6 });
	};
	const wheel = async (page, total) => {
		for (let done = 0; done < Math.abs(total); done += 100) { await page.mouse.wheel(0, Math.sign(total) * 100); await page.waitForTimeout(20); }
		await page.waitForTimeout(150);
	};
	const moveState = page => page.evaluate(() => ({ moving: document.body.classList.contains('iw-block-moving'),
		blocks: document.querySelectorAll('#editor .iw-preview').length, scrollerHasPointer: document.querySelector('#editor .cm-scroller').hasPointerCapture(1) }));
	// The gesture's listeners on the document and the window, counted from now:
	// none may be left once it has ended and the pointer has moved on. The
	// pointer moves first, so a previous gesture's wait for tooltips is over.
	const countGestureListeners = async page => {
		await page.mouse.move(150, 150, { steps: 3 });
		await page.mouse.move(170, 170, { steps: 3 });
		await page.evaluate(() => {
		const types = ['pointermove', 'pointerup', 'pointercancel', 'pointerdown', 'keydown', 'dragstart', 'lostpointercapture', 'blur'];
		const live = window.gestureListeners = new Map();
		for (const target of [document, window]) {
			const add = target.addEventListener, remove = target.removeEventListener;
			target.addEventListener = function (type, listener, options) {
				if (types.includes(type)) { const key = `${target === window ? 'window' : 'document'} ${type}`; live.set(key, (live.get(key) ?? 0) + 1); }
				return add.call(this, type, listener, options);
			};
			target.removeEventListener = function (type, listener, options) {
				if (types.includes(type)) { const key = `${target === window ? 'window' : 'document'} ${type}`; live.set(key, (live.get(key) ?? 0) - 1); }
				return remove.call(this, type, listener, options);
			};
		}
		});
	};
	const leftListeners = page => page.evaluate(() => Object.fromEntries(Array.from(window.gestureListeners).filter(([, count]) => count !== 0)));
	const paragraphLine = (page, number) => page.evaluate(number => {
		const line = Array.from(document.querySelectorAll('#editor .cm-line')).find(el => el.textContent.startsWith(`Paragrafo ${number},`));
		const r = line?.getBoundingClientRect();
		return r && { x: r.left + 20, top: r.top, bottom: r.bottom };
	}, number);
	// The first paragraph line fully in view.
	const visibleParagraph = page => page.evaluate(() => {
		const box = document.querySelector('#editor .cm-scroller').getBoundingClientRect();
		const line = Array.from(document.querySelectorAll('#editor .cm-line')).find(el => {
			const r = el.getBoundingClientRect();
			return /^Paragrafo \d+,/.test(el.textContent) && r.top > box.top + 60 && r.bottom < box.bottom - 60;
		});
		return Number(/^Paragrafo (\d+),/.exec(line.textContent)[1]);
	});

	await run('block bar: a move goes on while the wheel scrolls far from the block, and drops there (rows and wraps)', async page => {
		await page.addStyleTag({ content: '.cm-editor { height: 500px; }' });
		for (const [kind, block] of Object.entries(farBlocks)) {
			const source = farNote(block);
			await page.evaluate(source => window.fixture.setDoc(source), source);
			await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; });
			const depth = await page.evaluate(() => window.fixture.undoDepth());
			await pressBlockHandle(page);
			await wheel(page, 3000);
			// The block is no longer in the page; the move holds, the scroller has the pointer.
			assert.deepEqual(await moveState(page), { moving: true, blocks: 0, scrollerHasPointer: true }, kind);
			const number = await visibleParagraph(page);
			const target = await paragraphLine(page, number);
			await page.mouse.move(target.x, target.bottom - 2, { steps: 6 });
			await page.locator('.iw-drop-indicator').waitFor();
			await page.mouse.up();
			const paragraph = `Paragrafo ${number}, abbastanza lungo da occupare una riga intera del testo di prova.`;
			assert.equal(await page.evaluate(() => window.fixture.doc()),
				source.replace(`\n\n${block}`, '').replace(paragraph, `${paragraph}\n\n${block}`), `${kind} after paragraph ${number}`);
			assert.equal((await moveState(page)).moving, false, kind);
			assert.equal(await page.evaluate(() => window.fixture.hasFocus()), true, `${kind}: the editor has the keyboard, for Undo`);
			await page.evaluate(() => window.fixture.undo());
			assert.equal(await page.evaluate(() => window.fixture.doc()), source, `${kind}: one undo step`);
			assert.equal(await page.evaluate(() => window.fixture.undoDepth()), depth, kind);
		}
	});

	await run('block bar: back over the block, drawn again, nothing moves; Escape still ends the move; no listener left behind', async page => {
		await page.addStyleTag({ content: '.cm-editor { height: 500px; }' });
		for (const [kind, block] of Object.entries(farBlocks)) {
			const source = farNote(block);
			await page.evaluate(source => window.fixture.setDoc(source), source);
			await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; });
			await countGestureListeners(page);
			// Far and back: the block is drawn anew, and dropping over it changes nothing.
			await pressBlockHandle(page);
			await wheel(page, 3000);
			await wheel(page, -3000);
			const again = await page.locator('#editor .iw-preview').first().boundingBox();
			await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2, { steps: 4 });
			await page.waitForTimeout(100);
			assert.equal(await page.locator('.iw-drop-indicator').count(), 0, `${kind}: over itself, no destination`);
			await page.mouse.up();
			assert.equal(await page.evaluate(() => window.fixture.doc()), source, `${kind}: dropped over itself`);
			// Escape after scrolling far: the move ends, nothing changes.
			await pressBlockHandle(page);
			await wheel(page, 3000);
			await page.keyboard.press('Escape');
			assert.equal((await moveState(page)).moving, false, `${kind}: Escape`);
			await page.mouse.up();
			assert.equal(await page.evaluate(() => window.fixture.doc()), source, `${kind}: Escape changes nothing`);
			// The pointer moves on: the tooltips' wait ends too.
			await page.mouse.move(200, 200, { steps: 4 });
			assert.deepEqual(await leftListeners(page), {}, kind);
		}
	});

	await run('block bar: a move ends with Live Preview and with its own editor, never with another one', async page => {
		await page.addStyleTag({ content: '#editor .cm-editor { height: 500px; }' });
		const block = farBlocks.row;
		const source = farNote(block);
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; });
		await page.evaluate(block => window.fixture.otherEditor(`Altra nota.\n\n${block}\n\n${'Testo dell’altra nota.\n\n'.repeat(80)}Fine.`), block);
		await page.locator('#other .iw-preview img').first().waitFor();
		// Another editor scrolled, edited and closed meanwhile: this move goes on.
		await pressBlockHandle(page);
		await page.evaluate(() => window.fixture.otherScroll(2000));
		await page.evaluate(() => window.fixture.otherInsert('Nuova riga.\n\n'));
		await page.waitForTimeout(100);
		assert.equal((await moveState(page)).moving, true, 'another editor scrolled and edited');
		await page.evaluate(() => window.fixture.otherDestroy());
		assert.equal((await moveState(page)).moving, true, 'another editor closed');
		const target = await paragraphLine(page, 3);
		await page.mouse.move(target.x, target.bottom - 2, { steps: 6 });
		await page.mouse.up();
		const paragraph = 'Paragrafo 3, abbastanza lungo da occupare una riga intera del testo di prova.';
		assert.equal(await page.evaluate(() => window.fixture.doc()), source.replace(`\n\n${block}`, '').replace(paragraph, `${paragraph}\n\n${block}`));
		await page.evaluate(() => window.fixture.undo());
		// Leaving Live Preview ends it, with no edit and no error.
		await page.evaluate(() => { document.querySelector('#editor .cm-scroller').scrollTop = 0; });
		await countGestureListeners(page);
		await pressBlockHandle(page);
		await page.evaluate(() => window.fixture.livePreview(false));
		assert.equal((await moveState(page)).moving, false, 'Live Preview left');
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		await page.evaluate(() => window.fixture.livePreview(true));
		// Its own editor closed during the move: it ends, with no error.
		await page.evaluate(block => window.fixture.otherEditor(`Altra nota.\n\n${block}\n\nFine.`), block);
		await pressBlockHandle(page, '#other');
		await page.evaluate(() => window.fixture.otherDestroy());
		assert.equal((await moveState(page)).moving, false, 'its editor closed');
		await page.mouse.up();
		await page.mouse.move(200, 200, { steps: 4 });
		assert.deepEqual(await leftListeners(page), {});
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
	});

	await run('wrap bar: after a move down the view keeps still what follows the destination, not the caret', async page => {
		await page.addStyleTag({ content: '.cm-editor { height: 500px; }' });
		const paragraphs = from => Array.from({ length: 12 }, (_, i) => `Paragrafo ${from + i}.`).join('\n\n');
		const wrap = '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]';
		const source = `Inizio.\n\n${paragraphs(1)}\n\n${paragraphs(13)}\n\n${wrap}\n\n${paragraphs(25)}`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		// The caret at the start of the note, the view scrolled down to the wrap.
		await page.evaluate(() => window.fixture.select(0));
		await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 100000; });
		const preview = page.locator('.iw-preview');
		await preview.locator('img').waitFor();
		await preview.evaluate(el => el.scrollIntoView({ block: 'start' }));
		await preview.hover();
		const handle = await preview.locator('.mod-move').boundingBox();
		await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
		await page.mouse.down();
		const target = await page.evaluate(() => {
			const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Paragrafo 28.');
			const r = line.getBoundingClientRect();
			return { x: r.left + 20, y: r.bottom - 2 };
		});
		await page.mouse.move(target.x, target.y, { steps: 10 });
		const following = () => page.evaluate(() => Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Paragrafo 29.').getBoundingClientRect().top);
		const still = await following();
		await page.mouse.up();
		const moved = await page.evaluate(() => window.fixture.doc());
		assert.ok(moved.includes(`Paragrafo 28.\n\n${wrap}\n\nParagrafo 29.`), `wrap non fra «Paragrafo 28.» e «Paragrafo 29.»: ${JSON.stringify(moved.slice(Math.max(0, moved.indexOf('[wrap:start]') - 40), moved.indexOf('[wrap:start]') + 20))}`);
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const after = await page.locator('.iw-preview').boundingBox();
		const now = await following();
		assert.ok(Math.abs(now - still) <= 1.5, `«Paragrafo 29.» stays where it was on screen: ${still} before, ${now} after`);
		assert.ok(after && after.y + after.height <= now + 1, `the wrap right above «Paragrafo 29.»: wrap ${after?.y}..${after && after.y + after.height}`);
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, 0, 'the caret did not move');
	});

	await run('row and wrap bars: moved down, what follows the destination stays still; moved up, what precedes it; the edge scroll stays', async page => {
		const paragraph = n => `P${String(n).padStart(2, '0')} paragrafo.`;
		const paragraphs = Array.from({ length: 40 }, (_, i) => paragraph(i + 1));
		// A scroller of its own, as in Obsidian: the view scrolls, not the page.
		await page.addStyleTag({ content: '.cm-editor { height: 500px; } .cm-scroller { overflow: auto; }' });
		const line = text => page.evaluate(text => {
			const element = Array.from(document.querySelectorAll('.cm-line')).find(candidate => candidate.textContent === text);
			if (!element) return null;
			const box = element.getBoundingClientRect();
			return { top: box.top, bottom: box.bottom, x: box.left + 20 };
		}, text);
		const scrollTop = () => page.evaluate(() => document.querySelector('.cm-scroller').scrollTop);
		const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		// [case, paragraph dropped on, its half, paragraph next to the destination, the order after]
		const cases = [
			['a few down', 23, 'lower', 24, [23, 'row', 24]],
			['far down, past the edge', 38, 'lower', 39, [38, 'row', 39]],
			['a few up', 18, 'upper', 17, [17, 'row', 18]],
			['far up, past the edge', 3, 'upper', 2, [2, 'row', 3]],
			['down to the end of the note', 40, 'lower', 40, [40, 'row']],
		];
		const blocks = [
			['row', '![[a.png|100]] ![[b.png|140]] %%iw-row gap=8%%', '.iw-row-preview', 'p.iw-row'],
			['wrap', '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto accanto.\n\n[wrap:end]', '.iw-preview:not(.iw-row-preview)', 'img'],
		];
		for (const [kind, block, selector, drawn] of blocks) for (const [label, target, half, anchor, order] of cases.map(([name, ...rest]) => [`${kind}, ${name}`, ...rest])) {
			const source = [...paragraphs.slice(0, 20), block, ...paragraphs.slice(20)].join('\n\n');
			await page.evaluate(source => window.fixture.setDoc(source), source);
			const preview = page.locator(selector);
			await preview.locator(drawn).first().waitFor();
			// The block 160 px from the top of the view; the caret stays at the start of the note.
			await page.evaluate(selector => {
				const scroller = document.querySelector('.cm-scroller');
				scroller.scrollTop += document.querySelector(selector).getBoundingClientRect().top - scroller.getBoundingClientRect().top - 160;
			}, selector);
			await settle();
			await preview.hover();
			const handle = await preview.locator('.mod-move').boundingBox();
			await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
			await page.mouse.down();
			const view = await page.evaluate(() => { const box = document.querySelector('.cm-scroller').getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; });
			const start = await scrollTop();
			// At the edge, the gesture scrolls until the destination is well inside the view.
			for (let step = 0; step < 300; step++) {
				const box = await line(paragraph(target));
				if (box && box.top > view.top + 60 && box.bottom < view.bottom - 60) break;
				await page.mouse.move(handle.x + 20, half === 'lower' ? view.bottom - 8 - step % 2 : view.top + 8 + step % 2);
			}
			const box = await line(paragraph(target));
			await page.mouse.move(box.x, half === 'lower' ? box.bottom - 4 : box.top + 4, { steps: 5 });
			await settle();
			const reached = await scrollTop();
			const still = await line(paragraph(anchor));
			const bar = await page.locator('.iw-drop-indicator').boundingBox();
			await page.mouse.up();
			await settle();
			await page.waitForTimeout(200);
			const moved = await page.evaluate(() => window.fixture.doc());
			const expected = order.map(item => item === 'row' ? block : paragraph(item)).join('\n\n');
			assert.ok(moved.includes(expected) && moved.length === source.length, `${label}: ${JSON.stringify(expected)} not in the note`);
			const after = await line(paragraph(anchor));
			const rowBox = await preview.boundingBox();
			const scrolled = await scrollTop();
			const shift = after.top - still.top;
			if (label.includes('past the edge')) assert.ok(Math.abs(reached - start) > 200, `${label}: the edge scrolled the view (${start} → ${reached})`);
			if (half === 'lower' && order.at(-1) !== 'row') {
				// Down: what follows the destination stays still, the row right above it,
				// and the scroll the gesture reached stays (no jump of a row's height).
				assert.ok(Math.abs(shift) <= 1.5, `${label}: «${paragraph(anchor)}» moved by ${shift} px on screen`);
				assert.ok(rowBox.y + rowBox.height <= after.top + 1, `${label}: the row right above «${paragraph(anchor)}»`);
				assert.ok(Math.abs(scrolled - reached) <= 1.5, `${label}: scroll ${reached} at the release, ${scrolled} after`);
			} else {
				// Up, and down to the end of the note (nothing follows): unchanged, the
				// row where it was dropped. What precedes it does not jump by a row; at
				// the end of the note the view scrolls for that, moving up it does not.
				assert.ok(Math.abs(rowBox.y - bar.y) < 3, `${label}: row at ${rowBox.y}, dropped at ${bar.y}`);
				assert.ok(Math.abs(shift) < rowBox.height / 2, `${label}: «${paragraph(anchor)}» moved by ${shift} px on screen`);
				if (half === 'upper') assert.ok(Math.abs(scrolled - reached) < rowBox.height / 2, `${label}: scroll ${reached} at the release, ${scrolled} after`);
			}
			assert.equal((await page.evaluate(() => window.fixture.selection())).head, 0, `${label}: the caret did not move`);
		}
	});

	await run('row bar: moved up, the row is drawn anew once, at once at its known height; moved down, as before', async page => {
		const paragraph = n => `P${String(n).padStart(2, '0')} paragrafo.`;
		const row = '![[a.png|100]] ![[b.png|140]] %%iw-row gap=8%%';
		const paragraphs = Array.from({ length: 30 }, (_, i) => paragraph(i + 1));
		const source = [...paragraphs.slice(0, 15), row, ...paragraphs.slice(15)].join('\n\n');
		await page.addStyleTag({ content: '.cm-editor { height: 500px; } .cm-scroller { overflow: auto; }' });
		for (const [label, target, half] of [['up', 13, 'upper'], ['down', 18, 'lower']]) {
			await page.evaluate(source => window.fixture.setDoc(source), source);
			const preview = page.locator('.iw-row-preview');
			await preview.locator('p.iw-row').waitFor();
			await page.evaluate(() => {
				const scroller = document.querySelector('.cm-scroller');
				scroller.scrollTop += document.querySelector('.iw-row-preview').getBoundingClientRect().top - scroller.getBoundingClientRect().top - 200;
			});
			// Its height reported (row-height.ts) before the move, as a drawn row has it.
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const height = await preview.evaluate(el => { el.dataset.kept = '1'; return Math.round(el.getBoundingClientRect().height); });
			await preview.hover();
			const handle = await preview.locator('.mod-move').boundingBox();
			await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
			await page.mouse.down();
			const box = await page.evaluate(text => {
				const line = Array.from(document.querySelectorAll('.cm-line')).find(element => element.textContent === text).getBoundingClientRect();
				return { x: line.left + 20, top: line.top, bottom: line.bottom };
			}, paragraph(target));
			await page.mouse.move(box.x, half === 'upper' ? box.top + 4 : box.bottom - 4, { steps: 5 });
			// Each row drawn anew (not the kept drawing CodeMirror only moves), as it
			// appears; then the moved row's height, frame by frame.
			await page.evaluate(() => {
				window.drawn = [];
				window.observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) {
					const rows = node.nodeType === 1 ? [node, ...node.querySelectorAll('.iw-row-preview')].filter(el => el.matches('.iw-row-preview') && !el.dataset.kept) : [];
					for (const el of rows) window.drawn.push({ pending: el.classList.contains('iw-row-pending'), height: Math.round(el.getBoundingClientRect().height) });
				} });
				window.observer.observe(document.querySelector('.cm-content'), { childList: true, subtree: true });
			});
			await page.mouse.up();
			const heights = await page.evaluate(() => new Promise(resolve => {
				const seen = [];
				const sample = () => {
					const el = document.querySelector('.iw-row-preview');
					seen.push(Math.round(el.getBoundingClientRect().height));
					if (seen.length < 20) requestAnimationFrame(sample); else { window.observer.disconnect(); resolve(seen); }
				};
				requestAnimationFrame(sample);
			}));
			const drawn = await page.evaluate(() => window.drawn);
			const moved = await page.evaluate(() => window.fixture.doc());
			const expected = half === 'upper' ? `${paragraph(target - 1)}\n\n${row}\n\n${paragraph(target)}` : `${paragraph(target)}\n\n${row}\n\n${paragraph(target + 1)}`;
			assert.ok(moved.includes(expected), `${label}: the row not where it was dropped`);
			if (label === 'up') {
				// Drawn anew once, waiting at its known height: no unlaid-out row,
				// no second drawing when it reports that same height.
				assert.equal(drawn.length, 1, `${label}: drawn ${drawn.length} times: ${JSON.stringify(drawn)}`);
				assert.deepEqual(drawn[0], { pending: true, height }, `${label}: as it appears`);
			} else {
				// Down nothing is carried: Obsidian keeps the drawing (measured there);
				// this CodeMirror draws it anew, not waiting at a height.
				assert.ok(drawn.every(entry => !entry.pending), `${label}: ${JSON.stringify(drawn)}`);
			}
			assert.ok(heights.every(value => Math.abs(value - height) <= 1), `${label}: its height ${height} before, ${JSON.stringify(heights)} after`);
		}
	});

	await run('a row drawn anew is laid out as soon as its paragraph is there, watched once; a later or replaced paragraph, or a width still unknown, as before', async page => {
		// Every watch of a row's paragraph (row-layout.ts): observers connected and disconnected, per paragraph.
		await page.evaluate(() => {
			window.watches = new Map();
			const observers = new Map();
			const { observe, disconnect } = MutationObserver.prototype;
			MutationObserver.prototype.observe = function (target, options) {
				if (target.matches?.('.iw-row-preview p') && options?.attributeFilter?.includes('src')) {
					const entry = window.watches.get(target) ?? { connected: 0, disconnected: 0 };
					entry.connected++; window.watches.set(target, entry); observers.set(this, target);
				}
				return observe.call(this, target, options);
			};
			MutationObserver.prototype.disconnect = function () {
				const target = observers.get(this);
				if (target) { window.watches.get(target).disconnected++; observers.delete(this); }
				return disconnect.call(this);
			};
		});
		const paragraph = () => document.querySelector('.iw-row-preview p');
		const state = () => page.evaluate(() => {
			const p = document.querySelector('.iw-row-preview p');
			const watch = p && window.watches.get(p);
			return { p: Boolean(p), row: Boolean(p?.classList.contains('iw-row')), widths: Array.from(p?.children ?? []).map(child => child.style.getPropertyValue('--iw-row-width')),
				connected: watch?.connected ?? 0, active: watch ? watch.connected - watch.disconnected : 0 };
		});
		const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
		const reset = () => page.evaluate(() => { window.fixture.renderSettlesAfterFrame(false); window.fixture.renderReplacesParagraph(false); window.fixture.renderDelay(0); window.fixture.imagesLoad(true); });
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';

		// A. As Obsidian: the paragraph at once, the promise a frame later. Laid
		// out in the same task, before any frame; then the same paragraph stays,
		// watched once.
		await page.evaluate(() => window.fixture.renderSettlesAfterFrame(true));
		const atOnce = await page.evaluate(([source, paragraph]) => {
			window.fixture.setDoc(source);
			const p = eval(`(${paragraph})`)();
			return { row: Boolean(p?.classList.contains('iw-row')), pending: p?.closest('.iw-row-preview').classList.contains('iw-row-pending') };
		}, [source, paragraph.toString()]);
		assert.equal(atOnce.row, true, 'A: laid out as a row before the first frame');
		await settled();
		assert.deepEqual(await state(), { p: true, row: true, widths: ['14.285714285714285%', '20%'], connected: 1, active: 1 }, 'A and C: the same paragraph, watched once');
		assert.equal(await page.locator('.iw-row-preview .iw-row-toolbar').count(), 1, 'its bar, once the rendering settled');

		// B. The paragraph only later: laid out then, as before.
		await reset();
		await page.evaluate(() => window.fixture.renderDelay(80));
		const later = await page.evaluate(([source, paragraph]) => { window.fixture.setDoc(source); return Boolean(eval(`(${paragraph})`)()); }, [source, paragraph.toString()]);
		assert.equal(later, false, 'B: no paragraph at once');
		await page.locator('.iw-row-preview p.iw-row').waitFor();
		assert.deepEqual(await state(), { p: true, row: true, widths: ['14.285714285714285%', '20%'], connected: 1, active: 1 }, 'B: laid out once there, watched once');

		// D. Replaced when the rendering settles: the new paragraph is laid out
		// and watched, the first one is no longer watched nor laid out.
		await reset();
		await page.evaluate(() => { window.fixture.renderSettlesAfterFrame(true); window.fixture.renderReplacesParagraph(true); });
		const first = await page.evaluateHandle(([source, paragraph]) => { window.fixture.setDoc(source); return eval(`(${paragraph})`)(); }, [source, paragraph.toString()]);
		await settled();
		assert.deepEqual(await state(), { p: true, row: true, widths: ['14.285714285714285%', '20%'], connected: 1, active: 1 }, 'D: the new paragraph');
		assert.deepEqual(await first.evaluate(p => ({ attached: p.isConnected, row: p.classList.contains('iw-row'), watch: window.watches.get(p) })),
			{ attached: false, row: false, watch: { connected: 1, disconnected: 1 } }, 'D: the first paragraph, let go');

		// E. A width known only once its image loads: no layout made up at once;
		// laid out when the image loads.
		await reset();
		await page.evaluate(() => { window.fixture.renderSettlesAfterFrame(true); window.fixture.imagesLoad(false); });
		const unknown = await page.evaluate(([paragraph]) => {
			window.fixture.setDoc('Prima.\n\n![[a.png]] ![[b.png|140]]\n\nDopo.');
			const p = eval(`(${paragraph})`)();
			return { row: p.classList.contains('iw-row'), widths: Array.from(p.children).map(child => child.style.getPropertyValue('--iw-row-width')) };
		}, [paragraph.toString()]);
		assert.deepEqual(unknown, { row: false, widths: ['', ''] }, 'E: not laid out while a width is unknown');
		await settled();
		assert.equal((await state()).row, false, 'E: still not, once the rendering settled');
		await page.evaluate(() => { document.querySelector('.iw-row-preview img').src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>'); });
		await page.locator('.iw-row-preview p.iw-row').waitFor();
		const loaded = await state();
		assert.equal(loaded.connected, 1, 'E: watched once');
		assert.ok(loaded.widths.every(width => width.endsWith('%')), `E: laid out once loaded: ${JSON.stringify(loaded.widths)}`);
		await reset();
	});

	await run('row bar: a choice made after the row changed is refused and says why, row drawn anew or updated in place', async page => {
		// While the menu is open the row changes (sync, another pane): another
		// image (the row is drawn anew), or only its comment (updated in place).
		const cases = [
			['another image', 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.', source => [source.indexOf('![[b'), '![[c.png]] '], false],
			['the comment', 'Prima.\n\n![[a.png|100]] ![[b.png|140]] %%iw-row gap=0%%\n\nDopo.', source => [source.indexOf('gap=0') + 4, '6'], true],
		];
		for (const [label, source, change, kept] of cases) {
			await page.evaluate(source => window.fixture.setDoc(source), source);
			const row = page.locator('.iw-row-preview');
			await row.locator('p.iw-row').waitFor();
			await row.evaluate(el => { el.dataset.kept = '1'; });
			await row.hover();
			await row.locator('.iw-row-toolbar button').nth(1).click();
			await page.evaluate(([at, text]) => window.fixture.insert(at, text), change(source));
			const changed = await page.evaluate(() => window.fixture.doc());
			assert.equal(await page.locator('.iw-row-preview[data-kept]').count(), kept ? 1 : 0, `${label}: ${kept ? 'the same row on screen' : 'drawn anew'}`);
			await page.locator('.menu .menu-item', { hasText: 'Centro' }).click();
			assert.equal(await page.evaluate(() => window.fixture.doc()), changed, `${label}: nothing written`);
			assert.equal((await page.evaluate(() => window.fixture.notices())).at(-1), 'La riga di immagini è cambiata mentre sceglievi: nessuna modifica.', label);
		}
	});

	await run('a wrap dropped over a row of images goes before or after it, by the half under the pointer', async page => {
		const wrap = '[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]';
		const row = '![[a.png|100]] ![[b.png|140]]';
		const source = `Prima.\n\n${wrap}\n\nMezzo.\n\n${row}\n\nFine.`;
		for (const [half, expected] of [['lower', `Prima.\n\nMezzo.\n\n${row}\n\n${wrap}\n\nFine.`], ['upper', `Prima.\n\nMezzo.\n\n${wrap}\n\n${row}\n\nFine.`]]) {
			await page.evaluate(source => window.fixture.setDoc(source), source);
			const preview = page.locator('.iw-preview:not(.iw-row-preview)');
			await preview.locator('img').waitFor();
			await page.locator('.iw-row-preview p.iw-row').waitFor();
			await preview.hover();
			const handle = await preview.locator('.iw-wrap-toolbar .mod-move').boundingBox();
			const target = await page.locator('.iw-row-preview').boundingBox();
			await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
			await page.mouse.down();
			await page.mouse.move(target.x + 60, half === 'lower' ? target.y + target.height - 6 : target.y + 6, { steps: 10 });
			await page.locator('.iw-drop-indicator').waitFor();
			const bar = await page.locator('.iw-drop-indicator').boundingBox();
			await page.mouse.up();
			assert.equal(await page.evaluate(() => window.fixture.doc()), expected, `${half} half`);
			assert.ok(bar.width > bar.height, `${half} half: a horizontal bar, a block goes between blocks`);
		}
	});

	await run('row bar: text typed above while the menu is open does not block the choice', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const row = page.locator('.iw-row-preview');
		await row.locator('p.iw-row').waitFor();
		await row.hover();
		await row.locator('.iw-row-toolbar button').nth(1).click();
		await page.evaluate(() => window.fixture.insert(0, 'Titolo.\n\n'));
		await page.locator('.menu .menu-item', { hasText: 'Centro' }).click();
		assert.equal(await page.evaluate(() => window.fixture.doc()), 'Titolo.\n\n' + source.replace('![[b.png|140]]', '![[b.png|140]] %%iw-row align=center%%'));
	});

	await run('row bar: the current value is checked, the gap menu applies presets, keyboard focus shows the bar', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]] %%iw-row valign=bottom gap=24%%\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const row = page.locator('.iw-row-preview');
		await row.locator('p.iw-row').waitFor();
		await row.hover();
		await row.locator('.iw-row-toolbar button').nth(2).click();
		assert.equal(await page.locator('.menu .menu-item.mod-checked').textContent(), 'In basso');
		await page.locator('.menu .menu-item', { hasText: 'In alto' }).click();
		// Top is the default: the key disappears, the other ones stay.
		assert.equal(await page.evaluate(() => window.fixture.doc()), source.replace('valign=bottom gap=24', 'gap=24'));
		// The edit recreates the widget under a still pointer: the bar returns on the next move.
		await page.locator('.iw-row-preview').hover({ position: { x: 20, y: 20 } });
		await page.locator('.iw-row-preview .iw-row-toolbar button').nth(3).click();
		await page.locator('.menu .menu-item', { hasText: /^0 px/ }).click();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source.replace(' %%iw-row valign=bottom gap=24%%', ' %%iw-row gap=0%%'));
		await page.mouse.move(5, 5);
		await page.locator('.iw-row-preview').focus();
		await page.keyboard.press('Tab');
		assert.equal(await page.locator('.iw-row-preview .iw-row-toolbar').evaluate(el => getComputedStyle(el).opacity), '1');
		assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('iw-block-toolbar-button')), true);
	});

	await run('resize handle: live preview equals the saved result, undo restores, the source stays closed', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const row = page.locator('.iw-row-preview');
		await row.locator('p.iw-row').waitFor();
		const image = row.locator('.image-embed').first();
		const handle = image.locator('.iw-row-handle');
		await image.hover();
		assert.equal(await handle.evaluate(el => getComputedStyle(el, '::after').opacity), '1');
		const box = await handle.boundingBox();
		const band = (await row.locator('p.iw-row').boundingBox()).width;
		const selection = await page.evaluate(() => window.fixture.selection());
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 8 });
		const during = (await image.boundingBox()).width;
		assert.equal(await row.count(), 1, 'the row stays rendered during the gesture');
		await page.mouse.up();
		const saved = await page.evaluate(() => window.fixture.doc());
		const width = Number(/!\[\[a\.png\|(\d+)\]\]/.exec(saved)[1]);
		// Screen width 100·band/700 plus 50 px, back to the 700 px reference.
		const expected = Math.round((100 * band / 700 + 50) * 700 / band);
		assert.ok(Math.abs(width - expected) <= 1, `${width} vs ${expected} (band ${band})`);
		assert.equal(saved, source.replace('a.png|100', `a.png|${width}`));
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), selection);
		assert.equal(await page.evaluate(() => window.fixture.hasFocus()), true, 'the editor has the keyboard again, for Undo');
		await page.locator('.iw-row-preview p.iw-row').waitFor();
		const after = (await page.locator('.iw-row-preview .image-embed').first().boundingBox()).width;
		assert.ok(Math.abs(after - during) < 1, `no jump on release: ${during} → ${after}`);
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
	});

	await run('resize handle: no native drag and no height report during the gesture; one report at the end', async page => {
		// The first image is the tallest: resizing it changes the row height. In
		// Obsidian a transaction then redraws the widget and ends the gesture, and
		// its draggable embeds start a native drag that cancels it.
		const source = 'Prima.\n\n![[a.png|300]] ![[b.png|100]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const row = page.locator('.iw-row-preview');
		await row.locator('p.iw-row').waitFor();
		const image = row.locator('.image-embed').first();
		await image.hover();
		const handle = image.locator('.iw-row-handle');
		await handle.waitFor();
		const box = await handle.boundingBox();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		const before = await page.evaluate(() => window.fixture.rowHeights());
		const height = (await row.boundingBox()).height;
		await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 10 });
		await page.waitForFunction(height => document.querySelector('.iw-row-preview').getBoundingClientRect().height < height - 10, height);
		assert.ok((await row.boundingBox()).height < height - 10, 'the row got lower during the gesture');
		assert.equal(await page.evaluate(() => window.fixture.rowHeights()), before, 'no height report during the gesture');
		const dragPrevented = await image.evaluate(embed => {
			const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true });
			embed.dispatchEvent(drag);
			return drag.defaultPrevented;
		});
		assert.equal(dragPrevented, true, 'a native drag cannot start during the gesture');
		await page.mouse.up();
		await page.waitForFunction(before => window.fixture.rowHeights() > before && /!\[\[a\.png\|2\d\d\]\]/.test(window.fixture.doc()), before);
		assert.ok(await page.evaluate(() => window.fixture.rowHeights()) > before, 'the height is reported once the gesture is over');
		assert.match(await page.evaluate(() => window.fixture.doc()), /!\[\[a\.png\|2\d\d\]\]/);
		// Outside a gesture, a native drag is not blocked by the handle.
		assert.equal(await page.locator('.iw-row-preview .image-embed').first().evaluate(embed => {
			const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true });
			embed.dispatchEvent(drag);
			return drag.defaultPrevented;
		}), false);
	});

	await run('resize handle: Escape cancels, and enlarging stops before another image goes under 35 px', async page => {
		const source = 'Prima.\n\n![[a.png|200]] ![[b.png|300]] ![[c.png|200]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const row = page.locator('.iw-row-preview');
		await row.locator('p.iw-row').waitFor();
		const handle = row.locator('.image-embed').nth(1).locator('.iw-row-handle');
		let box = await handle.boundingBox();
		const widthBefore = (await row.locator('.image-embed').nth(1).boundingBox()).width;
		await page.mouse.move(box.x + 5, box.y + 20);
		await page.mouse.down();
		await page.mouse.move(box.x + 60, box.y + 20, { steps: 5 });
		await page.keyboard.press('Escape');
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		const widthAfter = (await row.locator('.image-embed').nth(1).boundingBox()).width;
		assert.ok(Math.abs(widthAfter - widthBefore) < 1, `dopo Esc larga ${widthAfter}, prima ${widthBefore}`);
		box = await handle.boundingBox();
		await page.mouse.move(box.x + 5, box.y + 20);
		await page.mouse.down();
		await page.mouse.move(box.x + 2000, box.y + 20, { steps: 10 });
		const scale = (await row.locator('p.iw-row').boundingBox()).width / 700;
		for (const index of [0, 2]) {
			const shown = (await row.locator('.image-embed').nth(index).boundingBox()).width;
			assert.ok(shown >= 35 * scale - 0.5, `immagine ${index}: ${shown} px, sotto il minimo di ${35 * scale}`);
		}
		await page.mouse.up();
		const saved = await page.evaluate(() => window.fixture.doc());
		const width = Number(/!\[\[b\.png\|(\d+)\]\]/.exec(saved)[1]);
		assert.ok(Number.isFinite(width) && width > 300 && width < 5000, String(width));
	});

	await run('resize handle: images still loading, the handle waits and says so', async page => {
		await page.evaluate(() => window.fixture.imagesLoad(false));
		await page.evaluate(() => window.fixture.setDoc('Prima.\n\n![[a.png]] ![[b.png]]\n\nDopo.'));
		const handle = page.locator('.iw-row-preview .iw-row-handle').first();
		await handle.waitFor({ state: 'attached' });
		await handle.dispatchEvent('pointerdown', { button: 0, pointerId: 1, isPrimary: true });
		assert.equal((await page.evaluate(() => window.fixture.notices())).at(-1), 'Attendi il caricamento delle immagini prima di ridimensionare.');
		assert.equal(await page.evaluate(() => document.body.classList.contains('iw-row-resizing')), false, 'no gesture started');
		await page.evaluate(() => window.fixture.imagesLoad(true));
	});

	await run('row and wrap bars are named toolbars with no tooltip of their own: over their edges and gaps no «click to edit»; the buttons keep theirs', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nMezzo.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-row-preview .iw-row-toolbar button').first().waitFor({ state: 'attached' });
		await page.locator('.iw-preview:not(.iw-row-preview) .iw-wrap-toolbar button').first().waitFor({ state: 'attached' });
		// --no-tooltip as Obsidian reads it, on the element it shows the tooltip of.
		const state = () => page.evaluate(() => {
			const off = element => getComputedStyle(element).getPropertyValue('--no-tooltip').trim();
			return Array.from(document.querySelectorAll('.iw-preview')).map(root => {
				const bar = root.querySelector(':scope > .iw-block-toolbar');
				return { root: root.getAttribute('aria-label'), rootTooltip: off(root), role: bar.getAttribute('role'), bar: bar.getAttribute('aria-label'), barTooltip: off(bar),
					buttons: Array.from(bar.querySelectorAll('button')).map(button => off(button)) };
			});
		});
		assert.deepEqual(await state(), [
			{ root: 'Riga di immagini. Fai clic per modificare.', rootTooltip: '', role: 'toolbar', bar: 'Comandi della riga di immagini', barTooltip: 'true', buttons: ['', '', '', ''] },
			{ root: 'Regione wrap. Fai clic per modificare.', rootTooltip: '', role: 'toolbar', bar: 'Comandi del wrap', barTooltip: 'true', buttons: ['', '', ''] },
		]);
		// During a gesture no tooltip at all, the buttons' included (pointer-gesture.ts).
		await page.evaluate(() => document.body.classList.add('iw-gesture'));
		assert.ok((await state()).every(block => block.barTooltip === 'true' && block.buttons.every(value => value === 'true')), 'no button tooltip during a gesture');
		await page.evaluate(() => document.body.classList.remove('iw-gesture'));
	});

	await run('resize handles: during a resize only the pressed handle shows its bar; the body keeps the cursor; pointerup, pointercancel and Escape clear it', async page => {
		const row = n => `![[a.png|${100 + n}]] ![[b.png|${120 + n}]]`;
		const wrap = n => `[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|${90 + n}]]\n\nTesto ${n}.\n\n[wrap:end]`;
		const source = ['Inizio.', row(1), 'Uno.', row(2), 'Due.', row(3), 'Tre.', wrap(1), 'Quattro.', wrap(2), 'Cinque.', wrap(3), 'Fine.'].join('\n\n');
		// Every handle's bar (::after), by block and image, and the pressed one's class.
		const bars = () => page.evaluate(() => Array.from(document.querySelectorAll('.iw-row-handle, .iw-wrap-handle')).map(handle => {
			const block = handle.closest('.iw-preview');
			const kind = block.classList.contains('iw-row-preview') ? 'row' : 'wrap';
			const same = Array.from(document.querySelectorAll(kind === 'row' ? '.iw-row-preview' : '.iw-preview:not(.iw-row-preview)'));
			const images = Array.from(block.querySelectorAll(kind === 'row' ? '.iw-row-handle' : '.iw-wrap-handle'));
			return `${kind} ${same.indexOf(block) + 1}.${images.indexOf(handle) + 1} ${getComputedStyle(handle, '::after').opacity}${handle.classList.contains('iw-resizing') || handle.parentElement.classList.contains('iw-resizing') ? ' resizing' : ''}`;
		}));
		const ends = { pointerup: () => page.mouse.up(), Escape: async () => { await page.keyboard.press('Escape'); await page.mouse.up(); },
			pointercancel: async () => { await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))); await page.mouse.up(); } };
		const cases = [['row', '.iw-row-preview', 0, 1, 'row 1.2', 'iw-row-resizing'], ['wrap', '.iw-preview:not(.iw-row-preview)', 0, 0, 'wrap 1.1', 'iw-wrap-resizing']];
		for (const [kind, selector, block, image, pressed, bodyClass] of cases) for (const [end, finish] of Object.entries(ends)) {
			const label = `${kind}, ${end}`;
			await page.evaluate(source => window.fixture.setDoc(source), source);
			await page.locator('.iw-row-preview').nth(2).locator('.iw-row-handle').nth(1).waitFor({ state: 'attached' });
			await page.locator('.iw-preview:not(.iw-row-preview)').nth(2).locator('img').waitFor();
			const embed = page.locator(selector).nth(block).locator('.image-embed').nth(image);
			await embed.hover();
			const handle = await embed.locator(kind === 'row' ? '.iw-row-handle' : '.iw-wrap-handle').boundingBox();
			await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
			await page.mouse.down();
			// Away from every image, so that no bar shows for a hover.
			await page.mouse.move(handle.x + handle.width / 2 + 8, 5, { steps: 3 });
			const during = await bars();
			assert.deepEqual(during.filter(bar => !bar.endsWith(' 0')), [`${pressed} 1 resizing`], `${label}: only the pressed handle shows its bar: ${JSON.stringify(during)}`);
			assert.equal(during.length, 9, `${label}: every handle measured (2 per row, 1 per wrap)`);
			assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).cursor), 'ew-resize', `${label}: the cursor, everywhere, from the body`);
			assert.ok(await page.evaluate(bodyClass => document.body.classList.contains(bodyClass), bodyClass), `${label}: ${bodyClass} on the body`);
			await finish();
			const after = await bars();
			assert.deepEqual(after.filter(bar => !bar.endsWith(' 0')), [], `${label}: no bar, nothing resizing left: ${JSON.stringify(after)}`);
			assert.equal(await page.evaluate(bodyClass => document.body.classList.contains(bodyClass), bodyClass), false, `${label}: ${bodyClass} gone`);
		}
	});

	await run('resize handles: a row or a wrap whose link changed during the gesture is not written, and says why', async page => {
		const cases = [
			['row', 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.', '.iw-row-preview .image-embed', '.iw-row-handle', 'La riga di immagini è cambiata durante il ridimensionamento: nessuna modifica.'],
			['wrap', 'Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.', '.iw-preview:not(.iw-row-preview) .image-embed', '.iw-wrap-handle', 'Il wrap è cambiato durante il ridimensionamento: nessuna modifica.'],
		];
		for (const [kind, source, imageSelector, handleSelector, message] of cases) {
			await page.evaluate(source => window.fixture.setDoc(source), source);
			const image = page.locator(imageSelector).first();
			await image.locator('img').waitFor();
			await image.hover();
			const handle = image.locator(handleSelector);
			await handle.waitFor();
			const box = await handle.boundingBox();
			const y = box.y + box.height / 2;
			await page.mouse.move(box.x + box.width / 2, y);
			await page.mouse.down();
			await page.mouse.move(box.x + 30, y, { steps: 5 });
			// Meanwhile the same link gets another size (sync, another pane): drawn in place.
			await page.evaluate(at => window.fixture.insert(at, '0'), source.indexOf('|100') + 4);
			await page.mouse.move(box.x + 40, y, { steps: 2 });
			await page.mouse.up();
			assert.equal(await page.evaluate(() => window.fixture.doc()), source.replace('|100', '|1000'), `${kind}: only the other change`);
			assert.equal((await page.evaluate(() => window.fixture.notices())).at(-1), message, kind);
		}
	});

	await run('resize handle: in a right-aligned row the handle is on the left edge and dragging left enlarges', async page => {
		const source = 'Prima.\n\n![[a.png|120]] %%iw-row align=right%%\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const handle = page.locator('.iw-row-preview .iw-row-handle.mod-left');
		await handle.waitFor({ state: 'attached' });
		const box = await handle.boundingBox();
		await page.mouse.move(box.x + 5, box.y + 20);
		await page.mouse.down();
		await page.mouse.move(box.x - 35, box.y + 20, { steps: 5 });
		await page.mouse.up();
		const width = Number(/a\.png\|(\d+)/.exec(await page.evaluate(() => window.fixture.doc()))[1]);
		assert.ok(width > 150, String(width));
		assert.ok((await page.evaluate(() => window.fixture.doc())).includes('%%iw-row align=right%%'), 'il commento della riga non deve cambiare');
	});

	await run('changing the row defaults updates a visible row in Live Preview without a click', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-preview p.iw-row.iw-row-align-left').waitFor();
		const selection = await page.evaluate(() => window.fixture.selection());
		await page.evaluate(() => window.fixture.setLiveSettings({ rowAlign: 'center', rowGap: 30 }));
		const row = page.locator('.iw-preview p.iw-row.iw-row-align-center');
		await row.waitFor();
		assert.equal(await row.evaluate(el => el.style.getPropertyValue('--iw-row-gap')), `${30 / 7}%`);
		assert.deepEqual(await page.evaluate(() => window.fixture.selection()), selection);
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		// A row with its own choice keeps it.
		await page.evaluate(() => window.fixture.setDoc('Prima.\n\n![[a.png|100]] %%iw-row align=right%%\n\nDopo.'));
		await page.locator('.iw-preview p.iw-row.iw-row-align-right').waitFor();
	});

	await run('changing the row defaults updates an already rendered Reading section', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';
		await page.evaluate(source => window.fixture.runReadingSection(source, 2, [{ width: 100, src: 'a.png' }, { width: 140, src: 'b.png' }]), source);
		const row = page.locator('.iw-reading-test p.iw-row');
		await expectClasses(row, ['iw-row-align-left']);
		await page.evaluate(() => window.fixture.setLiveSettings({ rowAlign: 'evenly', rowValign: 'bottom' }));
		await expectClasses(row, ['iw-row-align-evenly', 'iw-row-valign-bottom'], [], 'nuovi predefiniti: ');
		await page.evaluate(() => window.fixture.setLiveSettings({ rowAlign: 'left', rowValign: 'top' }));
		await expectClasses(row, ['iw-row-align-left'], ['iw-row-align-evenly'], 'predefiniti di nuovo: ');
	});

	await run('real mouse drag moves the pressed image out of its wrap and supports undo/redo', async page => {
		const a = '![[a.png|100]]';
		const source = `Prima.\n\n[wrap:start] %%iw-wrap side=left%%\n\n${a}\n\nTesto.\n\n[wrap:end]\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const image = page.locator('.iw-preview img').first();
		await image.waitFor();
		await image.hover();
		assert.equal(await image.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
		const box = await image.boundingBox();
		const after = await page.evaluate(() => window.fixture.coords(window.fixture.doc().indexOf('Dopo')));
		await page.mouse.move(box.x + box.width / 2, box.y + 30);
		await page.mouse.down();
		await page.mouse.move(box.x + 20, after.bottom - 2, { steps: 10 });
		await page.locator('.iw-drop-indicator').waitFor();
		await page.mouse.up();
		const result = await page.evaluate(() => window.fixture.doc());
		// The wrap's markers go, the start one with its comment; the link leaves unchanged.
		assert.ok(!/\[wrap:(start|end)\]|iw-wrap/.test(result) && result.includes('Testo.') && result.trimEnd().endsWith('![[a.png|100]]'), JSON.stringify(result));
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		await page.evaluate(() => window.fixture.redo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), result);
	});
	const dragBetween = async (page, from, x, y) => {
		const box = await from.boundingBox();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(x, y, { steps: 10 });
		await page.locator('.iw-drop-indicator').waitFor();
		const marker = await page.locator('.iw-drop-indicator').evaluate(el => ({ width: getComputedStyle(el).width, left: parseFloat(getComputedStyle(el).left) }));
		await page.mouse.up();
		return marker;
	};
	const undoRedo = async (page, source, result) => {
		await page.evaluate(() => window.fixture.undo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		await page.evaluate(() => window.fixture.redo());
		assert.equal(await page.evaluate(() => window.fixture.doc()), result);
	};
	await run('dragging inside a row reorders its links and keeps the row comment', async page => {
		const [a, b, c] = ['![[a.png|100]]', '![[b.png|120]]', '![[c.png|140]]'];
		const source = `Prima.\n\n${a} ${b} ${c} %%iw-row gap=24%%\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const images = page.locator('.iw-row-preview img');
		await images.nth(2).waitFor();
		const first = await images.nth(0).boundingBox();
		// Pressing an image to move it hides the resize handles until release.
		const third = await images.nth(2).boundingBox();
		await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
		assert.equal(await page.locator('.iw-row-handle').first().evaluate(el => getComputedStyle(el).display), 'block');
		await page.mouse.down();
		assert.equal(await page.locator('.iw-row-handle').first().evaluate(el => getComputedStyle(el).display), 'none');
		await page.keyboard.press('Escape');
		await page.mouse.up();
		assert.equal(await page.evaluate(() => document.body.classList.contains('iw-image-dragging')), false);
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		await page.locator('.iw-row-preview img').nth(2).waitFor();
		const marker = await dragBetween(page, images.nth(2), first.x + 10, first.y + first.height / 2);
		assert.equal(marker.width, '3px');
		assert.ok(Math.abs(marker.left - first.x) < 2, `indicatore a ${marker.left}, prima immagine a ${first.x}`);
		const result = await page.evaluate(() => window.fixture.doc());
		assert.equal(result, `Prima.\n\n${c} ${a} ${b} %%iw-row gap=24%%\n\nDopo.`);
		await undoRedo(page, source, result);
	});
	await run('dragging inside an open row (Markdown shown) reorders its links too', async page => {
		const [a, b, c] = ['![[a.png|100]]', '![[b.png|120]]', '![[c.png|140]]'];
		const source = `Prima.\n\n${a} ${b} ${c} %%iw-row gap=24%%\n\nDopo.`;
		await page.evaluate(source => { window.fixture.nativeEmbeds(true); window.fixture.setDoc(source); }, source);
		// Cursor inside the row: our widget gives way to the source line and Obsidian's embeds.
		await select(page, source.indexOf(b) + 3);
		assert.equal(await page.locator('.iw-row-preview').count(), 0);
		const images = page.locator('.cm-line .image-embed img');
		assert.equal(await images.count(), 3);
		const first = await images.nth(0).boundingBox();
		await dragBetween(page, images.nth(2), first.x + 10, first.y + first.height / 2);
		const result = await page.evaluate(() => window.fixture.doc());
		assert.equal(result, `Prima.\n\n${c} ${a} ${b} %%iw-row gap=24%%\n\nDopo.`);
		// Started from open Markdown: the caret follows the image, the row stays open.
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, result.indexOf(c), 'the caret on the moved image');
		assert.equal(await page.locator('.iw-row-preview').count(), 0, 'the row still shown as Markdown');
		await undoRedo(page, source, result);
		await page.evaluate(() => window.fixture.nativeEmbeds(false));
	});
	await run('an image dragged from a drawn row or wrap leaves the Markdown closed wherever it goes, refused or not; a click enters it', async page => {
		const [a, b, c, d, e, w] = ['![[a.png|100]]', '![[b.png|120]]', '![[c.png|140]]', '![[d.png|90]]', '![[e.png|110]]', '![[w.png|100]]'];
		const row = `${a} ${b} ${c} %%iw-row gap=24%%`;
		const wrap = `[wrap:start] %%iw-wrap side=left%%\n\n${w}\n\nTesto.\n\n[wrap:end]`;
		const source = `Prima.\n\n${row}\n\nMezzo.\n\n${d} ${e}\n\n${wrap}\n\nDopo.`;
		// The caret outside every block, at the start of the note; both rows and the wrap drawn.
		const start = async () => {
			await page.evaluate(source => window.fixture.setDoc(source), source);
			await select(page, 0);
			await page.locator('.iw-row-preview').nth(1).locator('img').nth(1).waitFor();
			await page.locator('.iw-preview:not(.iw-row-preview) img').waitFor();
		};
		// Where the caret is, and which blocks are drawn (none of them opened as Markdown).
		const after = async label => {
			const state = await page.evaluate(() => ({ head: window.fixture.selection().head, focus: window.fixture.hasFocus(),
				rows: document.querySelectorAll('.iw-row-preview').length, wraps: document.querySelectorAll('.iw-preview:not(.iw-row-preview)').length,
				open: Array.from(document.querySelectorAll('.cm-line')).filter(line => /!\[\[/.test(line.textContent)).map(line => line.textContent) }));
			assert.equal(state.head, 0, `${label}: the caret stays where it was`);
			assert.equal(state.focus, true, `${label}: the keyboard back to the editor`);
			assert.deepEqual(state.open, [], `${label}: no block opened as Markdown`);
			return state;
		};
		const rowImages = page.locator('.iw-row-preview').first().locator('img');
		const center = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };

		// A. Reordered inside its drawn row.
		await start();
		const first = await rowImages.nth(0).boundingBox();
		await dragBetween(page, rowImages.nth(2), first.x + 10, first.y + first.height / 2);
		assert.equal(await page.evaluate(() => window.fixture.doc()), source.replace(row, `${c} ${a} ${b} %%iw-row gap=24%%`), 'A: reordered');
		assert.deepEqual(await after('A'), { head: 0, focus: true, rows: 2, wraps: 1, open: [] });

		// E. Dragged, then released where it was: nothing written, nothing opened.
		await start();
		const third = await center(rowImages.nth(2));
		await page.mouse.move(third.x, third.y);
		await page.mouse.down();
		await page.mouse.move(third.x + 20, third.y, { steps: 4 });
		await page.mouse.move(third.x, third.y, { steps: 4 });
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source, 'E: nothing written');
		assert.equal((await after('E')).rows, 2, 'E: the row still drawn');

		// G. Refused (outside the editor): said why, nothing written, nothing opened.
		await start();
		const notices = (await page.evaluate(() => window.fixture.notices())).length;
		await page.mouse.move(third.x, third.y);
		await page.mouse.down();
		await page.mouse.move(870, third.y, { steps: 10 });
		await page.locator('.iw-drop-rejection').waitFor();
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source, 'G: nothing written');
		assert.ok((await page.evaluate(() => window.fixture.notices())).length > notices, 'G: the refusal said');
		assert.equal((await after('G')).rows, 2, 'G: the row still drawn');

		// F. To another block: the other row, which it joins.
		await start();
		const other = await page.locator('.iw-row-preview').nth(1).locator('img').nth(1).boundingBox();
		await dragBetween(page, rowImages.nth(0), other.x + other.width - 10, other.y + other.height / 2);
		assert.equal(await page.evaluate(() => window.fixture.doc()), source.replace(row, `${b} ${c} %%iw-row gap=24%%`).replace(`${d} ${e}`, `${d} ${e} ${a}`), 'F: joined the other row');
		assert.equal((await after('F')).rows, 2, 'F: both rows drawn');

		// B. From the drawn wrap to the end of the note: the wrap's markers go, nothing opens.
		await start();
		const end = await page.evaluate(() => window.fixture.coords(window.fixture.doc().indexOf('Dopo')));
		await dragBetween(page, page.locator('.iw-preview:not(.iw-row-preview) img'), end.left + 20, end.bottom - 2);
		const moved = await page.evaluate(() => window.fixture.doc());
		assert.ok(!moved.includes('[wrap:start]') && moved.trimEnd().endsWith(w), `B: ${JSON.stringify(moved)}`);
		const state = await page.evaluate(() => ({ head: window.fixture.selection().head, rows: document.querySelectorAll('.iw-row-preview').length }));
		// The image alone at the end is a row of one: drawn too, not opened.
		assert.deepEqual(state, { head: 0, rows: 3 }, 'B: the caret stays, the rows (and the new one) drawn');

		// D. A click without a move enters the Markdown at the image, as before.
		await start();
		await rowImages.nth(1).click();
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, source.indexOf(b), 'D: the caret at the clicked image');
		assert.equal(await page.locator('.iw-row-preview').count(), 1, 'D: that row opened as Markdown');
	});
	await run('typing above keeps row and wrap widgets; clicks and drags still map to the right source', async page => {
		const [a, b] = ['![[a.png|100]]', '![[b.png|140]]'];
		const source = `Prima.\n\n${a} ${b}\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[c.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-row-preview p.iw-row').waitFor();
		await page.locator('.iw-preview:not(.iw-row-preview) img').waitFor();
		const before = await page.evaluate(() => {
			window.keptRow = document.querySelector('.iw-row-preview');
			window.keptWrap = document.querySelector('.iw-preview:not(.iw-row-preview)');
			return window.fixture.counts().renders;
		});
		// A long insertion: offsets stored as absolute positions would land far away.
		const typed = 'Titolo. '.repeat(40);
		await page.evaluate(typed => window.fixture.insert(0, typed), typed);
		const kept = await page.evaluate(() => ({
			row: document.querySelector('.iw-row-preview') === window.keptRow && window.keptRow.isConnected,
			wrap: document.querySelector('.iw-preview:not(.iw-row-preview)') === window.keptWrap && window.keptWrap.isConnected,
			renders: window.fixture.counts().renders,
		}));
		assert.deepEqual(kept, { row: true, wrap: true, renders: before });
		// A click on the wrap text enters the source inside the region.
		const doc = await page.evaluate(() => window.fixture.doc());
		await page.locator('.iw-preview:not(.iw-row-preview) p', { hasText: 'Testo.' }).click();
		const caret = (await page.evaluate(() => window.fixture.selection())).head;
		assert.ok(caret >= doc.indexOf('[wrap:start]') && caret <= doc.indexOf('[wrap:end]'), `caret ${caret}`);
		// Back outside, the row is shown again: dragging b before a moves the right link.
		await select(page, 0);
		const images = page.locator('.iw-row-preview img');
		await images.nth(1).waitFor();
		const first = await images.nth(0).boundingBox();
		await dragBetween(page, images.nth(1), first.x + 10, first.y + first.height / 2);
		assert.equal(await page.evaluate(() => window.fixture.doc()), doc.replace(`${a} ${b}`, `${b} ${a}`));
	});
	await run('dragging to another row joins it; the emptied row disappears with its comment', async page => {
		const [a, b] = ['![[a.png|100]]', '![[b.png|120]]'];
		const source = `Prima.\n\n${a} %%iw-row align=center%%\n\nTesto.\n\n${b} %%iw-row align=right%%`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const rows = page.locator('.iw-row-preview');
		await rows.nth(1).locator('img').waitFor();
		const target = await rows.nth(1).locator('img').boundingBox();
		await dragBetween(page, rows.nth(0).locator('img'), target.x + target.width - 10, target.y + target.height / 2);
		const result = await page.evaluate(() => window.fixture.doc());
		assert.equal(result, `Prima.\n\nTesto.\n\n${b} ${a} %%iw-row align=right%%`);
		await undoRedo(page, source, result);
	});
	await run('dragging an image out of a line of text leaves the text and moves only the link', async page => {
		const image = '![[a.png|100]]';
		const source = `Prima.\n\nTesto ${image} altro.\n\nDopo.`;
		await page.evaluate(source => { window.fixture.nativeEmbeds(true); window.fixture.setDoc(source); }, source);
		const img = page.locator('.cm-line .image-embed img');
		await img.waitFor();
		const end = await page.evaluate(() => window.fixture.coords(window.fixture.doc().indexOf('Dopo')));
		await dragBetween(page, img, end.left + 5, end.bottom - 2);
		const result = await page.evaluate(() => window.fixture.doc());
		assert.equal(result, `Prima.\n\nTesto altro.\n\nDopo.\n\n${image}`);
		await undoRedo(page, source, result);
		await page.evaluate(() => window.fixture.nativeEmbeds(false));
	});
	await run('dragging a row image to a text boundary extracts it in basic mode', async page => {
		const [a, b] = ['![[a.png|100]]', '![[b.png|120]]'];
		const source = `Prima.\n\n${a} ${b} %%iw-row gap=0%%\n\nTesto.\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const images = page.locator('.iw-row-preview img');
		await images.nth(1).waitFor();
		const end = await page.evaluate(() => window.fixture.coords(window.fixture.doc().indexOf('Dopo')));
		await dragBetween(page, images.nth(1), end.left + 5, end.bottom - 2);
		const result = await page.evaluate(() => window.fixture.doc());
		assert.equal(result, `Prima.\n\n${a} %%iw-row gap=0%%\n\nTesto.\n\nDopo.\n\n${b}`);
		await undoRedo(page, source, result);
	});
	await run('forbidden mouse drop shows one explanation and leaves the caret, and the pressed image drawn, as they were', async page => {
		const link = '![[b.png|140]]';
		const source = `Prima.\n\n${link}\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const img = page.locator('.iw-preview img').first();
		await img.waitFor();
		const box = await img.boundingBox();
		const target = await page.locator('.iw-preview').nth(1).boundingBox();
		const depth = await page.evaluate(() => window.fixture.undoDepth());
		await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
		await page.mouse.move(target.x + 40, target.y + 30, { steps: 10 });
		await page.locator('.iw-drop-rejection').waitFor();
		assert.equal(await page.locator('.iw-drop-rejection').count(), 1);
		assert.match(await page.locator('.iw-drop-rejection').textContent(), /una sola immagine/);
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		// Dragged from a drawn row: refused, it opens no Markdown.
		assert.equal((await page.evaluate(() => window.fixture.selection())).head, 0);
		assert.equal(await page.locator('.iw-row-preview').count(), 1, 'the row of the pressed image still drawn');
		assert.equal(await page.evaluate(() => window.fixture.undoDepth()), depth);
		assert.equal(await page.locator('.iw-drop-rejection').count(), 0);
	});
	for (const kind of ['wrap', 'row']) {
		await run(`${kind} hover outlines only the region or image, without layout shifts`, async page => {
			if (kind === 'row') {
				await page.evaluate(() => window.fixture.setDoc('Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.'));
			}
			const region = page.locator('.iw-preview');
			const img = region.locator('img').first();
			await img.waitFor();
			if (kind === 'row') await page.locator('.iw-preview p.iw-row').waitFor();
			const before = await region.boundingBox();
			await page.mouse.move(before.x + before.width - 3, before.y + 4);
			assert.equal(await region.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
			assert.equal(await region.evaluate(el => getComputedStyle(el).outlineOffset), '-1px');
			assert.deepEqual(await region.boundingBox(), before);
			await img.hover();
			assert.equal(await region.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
			assert.equal(await img.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
			await page.mouse.move(5, 5);
			assert.equal(await region.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
			const source = await page.evaluate(() => window.fixture.doc());
			await region.click({ position: { x: before.width - 3, y: 4 } });
			assert.equal(await region.count(), 0);
			assert.equal(await page.evaluate(() => window.fixture.doc()), source);
		});
	}

	for (const count of [10, 50, 100]) {
		await run(`long note with ${count} image rows supports distant editing`, async page => {
			const source = longNote(count);
			const started = Date.now();
			await page.evaluate(source => window.fixture.setDoc(source), source);
			await page.locator('.iw-preview p.iw-row').first().waitFor();
			const loaded = Date.now();
			const last = source.lastIndexOf('![[');
			await select(page, last - 2);
			await page.keyboard.type('X');
			const edited = source.slice(0, last - 2) + 'X' + source.slice(last - 2);
			assert.equal(await page.evaluate(() => window.fixture.doc()), edited);
			await select(page, 0);
			const row = page.locator('.iw-preview p.iw-row').first();
			await row.scrollIntoViewIfNeeded();
			await expectClasses(row, ['iw-row-align-center']);
			await page.evaluate(() => window.fixture.undo());
			assert.equal(await page.evaluate(() => window.fixture.doc()), source);
			console.log(`  ${count} rows: initial visible render ${loaded - started}ms, scenario ${Date.now() - started}ms (fixture, not Obsidian)`);
		});
	}

	for (const kind of ['wrap', 'row']) {
		await run(`${kind} line numbers follow asynchronous height changes without a second click`, async page => {
			const body = '![[foto.png|300]]\n\n' + Array.from({ length: 12 }, (_, i) => `Paragrafo ${i}.`).join('\n\n');
			const row = Array.from({ length: 8 }, (_, i) => `![[foto${i}.png|100]]`).join(' ');
			const source = kind === 'wrap' ? `Prima.\n\n[wrap:start]\n\n${body}\n\n[wrap:end]\n\nDopo.` : `Prima.\n\n${row}\n\nDopo.`;
			await page.evaluate(source => window.fixture.setDoc(source), source);
			const lineNumber = source.split('\n').length;
			const historyBefore = await page.evaluate(() => window.fixture.undoDepth());
			for (let i = 0; i < 3; i++) {
				await select(page, source.indexOf('![['));
				await page.evaluate(() => window.fixture.renderDelay(50));
				await select(page, source.indexOf('Dopo.'));
				await page.locator('.iw-preview img').first().waitFor();
				await page.locator('.iw-preview img').first().evaluate((img, iteration) => { img.style.height = `${350 + iteration * 70}px`; }, i);
				const gutter = page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${lineNumber}$`) });
				await gutter.waitFor();
				await page.waitForFunction(n => {
					const label = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).find(el => el.textContent === String(n) && el.getBoundingClientRect().height > 0);
					const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Dopo.');
					return label && line && Math.abs(label.getBoundingClientRect().top - line.getBoundingClientRect().top) < 2;
				}, lineNumber, { timeout: 3000 }).catch(async error => { console.log(await page.evaluate(() => ({ gutter: Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).map(el => [el.textContent, el.getBoundingClientRect().top]), lines: Array.from(document.querySelectorAll('.cm-line')).map(el => [el.textContent, el.getBoundingClientRect().top]) }))); throw error; });
				assert.equal(await page.evaluate(() => window.fixture.doc()), source);
				assert.equal(await page.evaluate(() => window.fixture.undoDepth()), historyBefore);
				assert.equal((await page.evaluate(() => window.fixture.selection())).head, source.indexOf('Dopo.'));
			}
		});
	}

	await run('a row that shrinks right after appearing is measured again: line numbers stay aligned', async page => {
		const row = '![[a.png|200]] ![[b.png|200]]';
		const source = `Prima.\n\n${row}\n\nDopo.`;
		await page.evaluate(source => window.fixture.setDoc(source), source);
		await page.locator('.iw-row-preview .image-embed').first().waitFor();
		for (let i = 0; i < 3; i++) {
			await select(page, source.indexOf(row));
			// As in Obsidian: the laid-out row changes height a few ms after it appears,
			// within the window in which CodeMirror ignores its own resize signal.
			await page.evaluate(([at, i]) => new Promise(resolve => {
				window.fixture.select(at);
				const shrink = () => {
					const images = document.querySelectorAll('.iw-row-preview img');
					if (!images.length) { requestAnimationFrame(shrink); return; }
					requestAnimationFrame(() => setTimeout(() => {
						for (const img of images) img.style.height = `${120 - i * 10}px`;
						resolve(null);
					}, 8));
				};
				shrink();
			}), [source.indexOf('Dopo.'), i]);
			await page.waitForFunction(at => {
				const geometry = window.fixture.lineGeometry(at);
				const root = document.querySelector('.iw-row-preview');
				return geometry.heightmap === geometry.dom && root?.closest('.cm-line')?.getAttribute('data-iw-row-height') === String(Math.round(root.getBoundingClientRect().height));
			}, source.indexOf(row));
			const geometry = await page.evaluate(at => window.fixture.lineGeometry(at), source.indexOf(row));
			assert.equal(geometry.heightmap, geometry.dom, `round ${i}`);
			// The row's final height is reported on its line, which makes CodeMirror measure again.
			const reported = await page.evaluate(() => {
				const root = document.querySelector('.iw-row-preview');
				return [root.closest('.cm-line').getAttribute('data-iw-row-height'), String(Math.round(root.getBoundingClientRect().height))];
			});
			assert.equal(reported[0], reported[1], `round ${i}`);
		}
	});

	await run('a row not laid out (editor hidden, or no width) reports no height: shown again it keeps its drawing; a real change is still reported', async page => {
		const source = 'Prima.\n\n![[a.png|100]] ![[b.png|140]]\n\nDopo.';
		await page.evaluate(source => window.fixture.setDoc(source), source);
		const frames = n => page.evaluate(n => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(n); }), n);
		// A. Drawn, its height reported on its line; its drawing marked.
		await page.waitForFunction(() => {
			const root = document.querySelector('.iw-row-preview');
			return root?.querySelector('p.iw-row') && root.closest('.cm-line')?.getAttribute('data-iw-row-height') === String(Math.round(root.getBoundingClientRect().height));
		});
		await frames(3);
		const state = () => page.evaluate(() => {
			const root = document.querySelector('.iw-row-preview');
			return { kept: Boolean(root?.dataset.kept), reports: window.fixture.rowHeights(), attribute: root?.closest('.cm-line')?.getAttribute('data-iw-row-height'), height: String(Math.round(root.getBoundingClientRect().height)) };
		});
		await page.evaluate(() => { document.querySelector('.iw-row-preview').dataset.kept = '1'; });
		const drawn = await state();
		assert.equal(drawn.attribute, drawn.height, 'A: its real height reported');
		const editor = (property, value) => page.evaluate(([property, value]) => { document.querySelector('#editor').style[property] = value; }, [property, value]);
		// As in the move to another window: the row's line with no width, its padding left (0×8).
		const noWidth = on => page.evaluate(on => {
			if (on) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'no-width', textContent: '.cm-line:has(> .iw-row-preview) { width: 0 !important; padding: 0 !important; }' }));
			else document.querySelector('#no-width')?.remove();
		}, on);
		for (const [label, hide, show] of [['B, editor hidden', () => editor('display', 'none'), () => editor('display', '')], ['C, no width', () => noWidth(true), () => noWidth(false)]]) {
			await hide();
			await frames(4);
			const away = await page.evaluate(() => ({ reports: window.fixture.rowHeights(), attribute: document.querySelector('.iw-row-preview')?.closest('.cm-line')?.getAttribute('data-iw-row-height'),
				box: (({ width, height }) => `${Math.round(width)}x${Math.round(height)}`)(document.querySelector('.iw-row-preview').getBoundingClientRect()) }));
			assert.equal(away.reports, drawn.reports, `${label}: no height reported (${away.box})`);
			assert.equal(away.attribute, drawn.attribute, `${label}: the last real height kept`);
			if (label.startsWith('C')) assert.match(away.box, /^0x[1-9]/, `C: a row with no width but some height (${away.box})`);
			await show();
			await frames(4);
			assert.deepEqual(await state(), drawn, `${label}: shown again, the same drawing, nothing reported`);
		}
		// D. A real change of width, and so of height: reported as before.
		await editor('width', '300px');
		await page.waitForFunction(before => window.fixture.rowHeights() > before, drawn.reports);
		await frames(3);
		const narrow = await state();
		assert.notEqual(narrow.height, drawn.height, 'D: a new height');
		assert.equal(narrow.attribute, narrow.height, 'D: the new height reported');
		await editor('width', '');
	});

	for (const kind of ['wrap', 'row']) {
	await run(`${kind}: late stylesheet preserves startup alignment with fixed content height`, async page => {
		if (kind === 'row') {
			await page.evaluate(() => window.fixture.setDoc('Prima.\n\n![[a.png|100]] ![[b.png|100]] ![[c.png|100]] %%iw-row align=center%%\n\nDopo.'));
			await page.locator('.iw-preview p.iw-row').waitFor();
		}
		await page.waitForFunction(() => {
			const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Dopo.');
			const n = window.fixture.doc().split('\n').length;
			const label = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).find(el => el.textContent === String(n) && el.getBoundingClientRect().height > 0);
			return line && label && Math.abs(label.getBoundingClientRect().top - line.getBoundingClientRect().top) < 2;
		});
		const sample = () => page.evaluate(() => {
			const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Dopo.');
			const n = window.fixture.doc().split('\n').length;
			const label = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).find(el => el.textContent === String(n) && el.getBoundingClientRect().height > 0);
			return { height: document.querySelector('.iw-preview').getBoundingClientRect().height,
				gap: label.getBoundingClientRect().top - line.getBoundingClientRect().top };
		});
		const before = await sample();
		assert.ok(Math.abs(before.gap) < 2, `già prima dello stile tardivo il numero di riga è a ${before.gap} px dalla riga`);
		await page.locator('.cm-content').evaluate(el => { el.style.height = `${el.getBoundingClientRect().height}px`; });
		await page.addStyleTag({ content: css });
		await page.waitForFunction(beforeHeight => {
			const preview = document.querySelector('.iw-preview');
			const line = Array.from(document.querySelectorAll('.cm-line')).find(el => el.textContent === 'Dopo.');
			const n = window.fixture.doc().split('\n').length;
			const label = Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).find(el => el.textContent === String(n) && el.getBoundingClientRect().height > 0);
			return preview && line && label && Math.abs(preview.getBoundingClientRect().height - beforeHeight) > 1
				&& Math.abs(label.getBoundingClientRect().top - line.getBoundingClientRect().top) < 2;
		}, before.height);
		const after = await sample();
		console.log('  delayed stylesheet:', { before, after });
		// The widgets change height when styles.css arrives (no copy of it any more
		// since 0.26.12): they are measured again and the line numbers follow.
		assert.ok(Math.abs(after.gap) < 2, 'late stylesheet keeps geometry aligned');
	}, true);
	}

	for (const side of ['left', 'right']) {
		await run(`${side} wrap layout is active before embed annotation`, async page => {
			await page.evaluate(side => window.fixture.setDoc(`Prima.\n\n[wrap:start] %%iw-wrap side=${side}%%\n\n![[foto.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.`), side);
			await page.locator('.iw-preview img').waitFor();
			const result = await page.locator('.iw-preview').evaluate(root => {
				// Remove callback annotations and read synchronously, before observers can restore them.
				const embed = root.querySelector('.image-embed');
				embed.classList.remove('iw-left', 'iw-right');
				for (const p of root.querySelectorAll('p')) p.classList.remove('iw-image-paragraph', 'iw-first-paragraph');
				return { float: getComputedStyle(embed).cssFloat, paragraph: getComputedStyle(embed.parentElement).display };
			});
			assert.equal(result.float, side);
			assert.equal(result.paragraph, 'contents');
		});
	}
	await run('export: wrap layout is applied and markers are removed from the printed output', async page => {
		const source = '[wrap:start] %%iw-wrap side=right%%\n\n![[a.png|100]]\n\nTesto wrap.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: '[wrap:start]' }, { embedWidth: 100 }, { text: 'Testo wrap.' }, { text: '[wrap:end]' }, { text: 'Dopo.' },
		]), source);
		const root = page.locator('.iw-export-test');
		assert.equal(await root.locator(':scope > div').count(), 3, 'both marker paragraphs were removed');
		assert.equal(await root.evaluate(el => el.textContent.includes('wrap:start')), false);
		const embed = root.locator('.image-embed');
		await expectClasses(embed, ['iw-right']);
		await expectClasses(embed.locator('xpath=..'), ['iw-image-paragraph'], [], 'paragrafo dell’immagine: ');
		const next = root.locator(':scope > div').nth(1).locator('p');
		await expectClasses(next, ['iw-first-paragraph']);
		// The last block inside the region must clear the float, or trailing
		// content with little height can still overlap the floated image.
		await expectClasses(root.locator(':scope > div').nth(1), ['iw-region-end'], [], 'ultimo blocco del wrap: ');
	});

	await run('export: an embedded note (bare paragraphs) gets its wrap and its row', async page => {
		const source = '# Nota\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\nTesto accanto.\n\n[wrap:end]\n\n![[b.png|120]] %%iw-row align=right%%\n\nDopo.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: 'Nota' }, { text: '[wrap:start]' }, { embedWidth: 100, src: 'a.png' }, { text: 'Testo accanto.' },
			{ text: '[wrap:end]' }, { embedWidth: 120, src: 'b.png' }, { text: 'Dopo.' },
		], false, true), source);
		const root = page.locator('.iw-export-test');
		assert.equal(await root.evaluate(el => el.textContent.includes('wrap:')), false, 'markers removed');
		await expectClasses(root.locator('.image-embed').first(), ['iw-left']);
		const geometry = await root.evaluate(el => {
			const [image, row] = Array.from(el.querySelectorAll('img')).map(img => img.getBoundingClientRect());
			const text = Array.from(el.querySelectorAll('p')).find(p => p.textContent === 'Testo accanto.').getBoundingClientRect();
			return { beside: text.top < image.bottom, rowBelow: row.top >= image.bottom - 1 };
		});
		assert.deepEqual(geometry, { beside: true, rowBelow: true });
		await expectClasses(root.locator('p.iw-row'), ['iw-row-align-right']);
	});

	await run('export: a row gets its comment settings, found by its embeds', async page => {
		const source = 'Prima.\n\n![[a.png|100]] %%iw-row align=center%%\n\nDopo.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: 'Prima.' }, { embedWidth: 100, src: 'a.png' }, { text: 'Dopo.' },
		]), source);
		const paragraph = page.locator('.iw-export-test p.iw-row');
		await expectClasses(paragraph, ['iw-row-align-center']);
		const width = await paragraph.locator('.image-embed').evaluate(el => el.style.getPropertyValue('--iw-row-width'));
		assert.ok(Math.abs(parseFloat(width) - 100 / 7) < 1e-6, width);
	});

	await run('export: a marker example inside inline code does not disable layout elsewhere', async page => {
		// The source parser already treats this as inactive (the backticks are
		// literal characters, so the trimmed line never equals the marker
		// text) — but Obsidian's rendered DOM strips the backticks, leaving a
		// paragraph whose plain textContent does equal the marker. Matching
		// markers by textContent alone would count it, making the total not
		// match the model's region count and disabling export layout for the
		// whole document.
		const source = '[wrap:start] %%iw-wrap side=right%%\n\n![[a.png|100]]\n\nTesto wrap.\n\n[wrap:end]\n\n`[wrap:start]`\n\nDopo.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: '[wrap:start]' }, { embedWidth: 100 }, { text: 'Testo wrap.' }, { text: '[wrap:end]' },
			{ code: '[wrap:start]' }, { text: 'Dopo.' },
		]), source);
		const root = page.locator('.iw-export-test');
		const embed = root.locator('.image-embed');
		assert.ok(await embed.evaluate(el => el.classList.contains('iw-right')), 'the real wrap region is still laid out');
		assert.equal(await root.locator('code', { hasText: '[wrap:start]' }).count(), 1, 'the inline-code example is left untouched');
	});

	await run('a stray marker does not disable an independent valid wrap in PDF', async page => {
		const source = '[wrap:end]\n\n[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\nTesto.\n\n[wrap:end]';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: '[wrap:end]' }, { text: '[wrap:start]' }, { embedWidth: 100, src: 'a.png' }, { text: 'Testo.' }, { text: '[wrap:end]' },
		]), source);
		await expectClasses(page.locator('.iw-export-test .image-embed'), ['iw-left']);
	});

	await run('export: mismatched marker counts or order leave all wraps untouched', async page => {
		const source = '[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\nTesto.\n\n[wrap:end]';
		for (const markers of [['[wrap:start]'], ['[wrap:end]', '[wrap:start]']]) {
			await page.locator('.iw-export-test').evaluateAll(nodes => nodes.forEach(node => node.parentElement.remove()));
			await page.evaluate(({ source, markers }) => window.fixture.runExport(source, [
				{ text: markers[0] }, { embedWidth: 100, src: 'a.png' }, { text: 'Testo.' },
				...(markers[1] ? [{ text: markers[1] }] : []),
			]), { source, markers });
			assert.equal(await page.locator('.iw-export-test .iw-left').count(), 0);
			assert.equal(await page.locator('.iw-export-test > div').count(), markers.length + 2);
		}
	});

	await run('export: a compact wrap (markers touching its text) does not block the other wraps', async page => {
		const source = '[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\nTesto.\n\n[wrap:end]\n\n' +
			'[wrap:start] %%iw-wrap side=right%%\n![[b.png|100]]\nWrap compatto.\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: '[wrap:start]' }, { embedWidth: 100, src: 'a.png' }, { text: 'Testo.' }, { text: '[wrap:end]' },
			// One paragraph: Obsidian joins the compact wrap's lines.
			{ text: '[wrap:start] Wrap compatto. [wrap:end]' }, { text: 'Dopo.' },
		]), source);
		const root = page.locator('.iw-export-test');
		assert.ok(await root.locator('.image-embed').first().evaluate(el => el.classList.contains('iw-left')), 'the other wrap is laid out');
		assert.equal(await root.evaluate(el => (el.textContent.match(/\[wrap:(start|end)\]/g) ?? []).length), 2, 'only the compact wrap keeps its markers');
		// Said once per export, even when Obsidian processes the note again; a
		// new export says it again, however soon.
		const said = 'Nel PDF 1 wrap di «export» non è impaginato: ha i marcatori attaccati al testo. Usa «Correggi il formato dei wrap della nota» e riesporta.';
		assert.deepEqual(await page.evaluate(() => window.fixture.notices()), [said]);
		await page.evaluate(() => window.fixture.reprocessExport());
		assert.deepEqual(await page.evaluate(() => window.fixture.notices()), [said]);
		await page.evaluate(source => window.fixture.runExport(source, [{ text: 'Dopo.' }]), source);
		assert.deepEqual(await page.evaluate(() => window.fixture.notices()), [said, said]);
	});
	await run('export: unloaded while the note is read, the plugin leaves the printed note alone', async page => {
		const source = '[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\nTesto.\n\n[wrap:end]\n\n' +
			'[wrap:start] %%iw-wrap side=right%%\n![[b.png|100]]\nWrap compatto.\n[wrap:end]';
		await page.evaluate(source => window.fixture.unloadDuringExport(source, [
			{ text: '[wrap:start]' }, { embedWidth: 100, src: 'a.png' }, { text: 'Testo.' }, { text: '[wrap:end]' },
			{ text: '[wrap:start] Wrap compatto. [wrap:end]' },
		]), source);
		const root = page.locator('.iw-export-test');
		assert.equal(await root.locator('.iw-left, .iw-right, .iw-region-start').count(), 0, 'no layout');
		assert.equal(await root.evaluate(el => (el.textContent.match(/\[wrap:(start|end)\]/g) ?? []).length), 4, 'no marker removed');
		assert.deepEqual(await page.evaluate(() => window.fixture.notices()), [], 'no notice');
	});
	await run('export: an unclosed wrap marker blocks only its own zone', async page => {
		const source = '![[a.png|100]]\n\n[wrap:start]\n\n![[b.png|100]]\n\nTesto.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ embedWidth: 100, src: 'a.png' }, { text: '[wrap:start]' }, { embedWidth: 100, src: 'b.png' }, { text: 'Testo.' },
		]), source);
		const paragraphs = page.locator('.iw-export-test p');
		await expectClasses(paragraphs.nth(0), ['iw-row'], [], 'riga fuori dalla zona: ');
		assert.equal(await paragraphs.nth(2).evaluate(el => el.classList.contains('iw-row')), false);
	});

	await run('export: only the first image of a wrap floats; a later one stays in the text', async page => {
		const source = '[wrap:start] %%iw-wrap side=left%%\n\n![[a.png|100]]\n\n![[b.png|100]]\n\nTesto.\n\n[wrap:end]\n\nDopo.';
		await page.evaluate(source => window.fixture.runExport(source, [
			{ text: '[wrap:start]' }, { embedWidth: 100 }, { embedWidth: 100 }, { text: 'Testo.' }, { text: '[wrap:end]' }, { text: 'Dopo.' },
		]), source);
		const embeds = page.locator('.iw-export-test .image-embed');
		assert.equal(await embeds.count(), 2);
		assert.equal(await embeds.nth(0).evaluate(el => el.classList.contains('iw-left')), true);
		assert.equal(await embeds.nth(1).evaluate(el => el.classList.contains('iw-left') || el.classList.contains('iw-right')), false);
	});

} finally { await browser.close(); }
