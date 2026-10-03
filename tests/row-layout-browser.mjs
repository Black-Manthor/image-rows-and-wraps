// Real Chromium geometry for image rows: CSS from styles.css, layout from the
// plugin's own modules. Not Obsidian: the DOM mimics its rendered paragraphs.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { coverageDir, savePageCoverage, startPageCoverage } from './copertura-mappa.mjs';
import { record } from './registro.mjs';

const bundle = await build({ entryPoints: ['tests/fixtures/row-layout.ts'], bundle: true, write: false,
	format: 'iife', globalName: 'rows', ...(coverageDir ? { sourcemap: 'inline' } : {}) });
let browser, page;

before(async () => {
	browser = await chromium.launch({ headless: true });
	record({ kind: 'environment', chromium: browser.version(), build: 'fixture' });
	page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
	await startPageCoverage(page);
	await page.addStyleTag({ content: await readFile('styles.css', 'utf8') });
	await page.addScriptTag({ content: bundle.outputFiles[0].text });
});

after(async () => {
	if (page) await savePageCoverage(page, 'righe', bundle.outputFiles[0].text, process.cwd(), entry => entry.source === bundle.outputFiles[0].text);
	await browser?.close();
});

const measure = async (width, line, naturals, media = 'screen', floatBefore = 0) => {
	await page.emulateMedia({ media });
	return page.evaluate(async ({ width, line, naturals, floatBefore }) => {
		document.body.replaceChildren();
		document.body.style.margin = '0';
		const host = document.body.appendChild(document.createElement('div'));
		host.style.width = `${width}px`;
		if (floatBefore) {
			const float = host.appendChild(document.createElement('div'));
			float.style.cssText = `float:left;width:200px;height:${floatBefore}px`;
		}
		const p = host.appendChild(document.createElement('p'));
		const [row] = rows.findRows(line);
		const loads = row.images.map((image, index) => {
			const span = p.appendChild(document.createElement('span'));
			span.className = 'internal-embed image-embed';
			p.append(document.createTextNode(' '));
			const img = span.appendChild(document.createElement('img'));
			const [w, h] = naturals[index];
			img.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`);
			if (image.width) img.setAttribute('width', String(image.width));
			return img.decode();
		});
		await Promise.all(loads);
		const applied = rows.applyRow(p, row);
		const box = host.getBoundingClientRect();
		const rects = Array.from(p.children).map(child => child.getBoundingClientRect());
		const pBox = p.getBoundingClientRect();
		return { applied, top: pBox.top - box.top, band: [pBox.left - box.left, pBox.width],
			images: rects.map(r => [+(r.left - box.left).toFixed(1), +r.width.toFixed(1), +(r.bottom - pBox.top).toFixed(1), +(r.top - pBox.top).toFixed(1)]) };
	}, { width, line, naturals, floatBefore });
};
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} ≠ ${expected}`);
const square = [[100, 100], [100, 100], [100, 100]];

test('righe: composizione base e responsive', async () => {
	let r = await measure(1000, '![[a.png|200]] ![[b.png|300]]', square);
	assert.equal(r.applied, true);
	near(r.band[1], 700, 'band'); near(r.images[0][1], 200, 'w1'); near(r.images[1][1], 300, 'w2');
	near(r.images[1][0] - (r.images[0][0] + r.images[0][1]), 12, 'gap'); near(r.images[0][0], 0, 'left');
	r = await measure(1000, '![[a.png|200]] ![[b.png|300]] ![[c.png|200]]', square);
	const f = 700 / 724;
	[200, 300, 200].forEach((w, i) => near(r.images[i][1], w * f, `over${i}`));
	near(r.images[2][0] + r.images[2][1], 700, 'fills band');
	r = await measure(560, '![[a.png|200]] ![[b.png|300]]', square);
	near(r.band[1], 560, 'band 560'); near(r.images[0][1], 160, 'w1 80%'); near(r.images[1][1], 240, 'w2 80%');
	r = await measure(1400, '![[a.png|200]] ![[b.png|300]] %%iw-row align=center%%', square);
	near(r.band[1], 700, 'band 1400'); near(r.images[0][1], 200, 'no upscale');
	r = await measure(560, '![[a.png|100]] ![[b.png|100]] %%iw-row gap=1000%%', square);
	near(r.images[0][1], 560 / 12, 'large gap image'); near(r.images[1][0] - r.images[0][1], 560 * 1000 / 1200, 'large gap scaled');
});

test('righe: allineamento e distribuzione orizzontale', async () => {
	let r = await measure(1400, '![[a.png|200]] ![[b.png|300]] %%iw-row align=center%%', square);
	near(r.band[0], 350, 'band centered'); near(r.images[0][0], 350 + (700 - 512) / 2, 'images centered');
	r = await measure(1000, '![[a.png|200]] ![[b.png|300]] %%iw-row align=right%%', square);
	near(r.images[1][0] + r.images[1][1], 1000, 'right edge');
	r = await measure(700, '![[a.png|100]] ![[b.png|100]] ![[c.png|100]] %%iw-row align=between gap=0%%', square);
	near(r.images[0][0], 0, 'between first'); near(r.images[2][0] + r.images[2][1], 700, 'between last'); near(r.images[1][0], 300, 'between middle');
	for (const align of ['between', 'evenly']) {
		r = await measure(1400, `![[a.png|100]] %%iw-row align=${align}%%`, square);
		near(r.images[0][0], 650, `single ${align} centered in wide column`);
	}
});

test('righe: allineamento verticale e dimensioni naturali', async () => {
	let r = await measure(700, '![[a.png|100]] ![[b.png|100]] %%iw-row valign=bottom%%', [[100, 200], [100, 100]]);
	near(r.images[0][2], r.images[1][2], 'bottom aligned');
	r = await measure(700, '![[a.png|100]] ![[b.png|100]]', [[100, 200], [100, 100]]);
	near(r.images[0][3], r.images[1][3], 'top aligned');
	r = await measure(700, '![[a.png|100]] ![[b.png|100]] %%iw-row valign=center%%', [[100, 200], [100, 100]]);
	near(r.images[1][3], 50, 'vertical center');
	r = await measure(700, '![[a.png]] ![[b.png|100]]', [[1536, 1024], [100, 100]]);
	near(r.images[0][1] + r.images[1][1] + r.images[1][0] - r.images[0][0] - r.images[0][1], 700, 'natural fits band');
	near(r.images[0][1] / r.images[1][1], 1536 / 100, 'natural ratio');
});

test('righe: contesto esterno e stampa', async () => {
	let r = await measure(700, '![[a.png|300]] ![[b.png|300]]', square, 'screen', 400);
	near(r.top, 400, 'below float'); near(r.band[1], 700, 'full band after float');
	r = await measure(560, '![[a.png|200]] ![[b.png|300]]', square, 'print');
	near(r.images[0][1], 160, 'print w1'); near(r.images[1][1], 240, 'print w2');
});

test('righe: caricamento tardivo e cleanup', async () => {
	try {
		const late = await page.evaluate(async () => {
			document.body.replaceChildren();
			const p = document.body.appendChild(document.createElement('p'));
			p.innerHTML = '<span class="internal-embed image-embed"><img></span>';
			const img = p.querySelector('img');
			window.iwStopLateRow = rows.watchRow(p, rows.findRows('![[late.png]]')[0]);
			const before = p.classList.contains('iw-row');
			img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="140" height="70"/>');
			await img.decode();
			await new Promise(resolve => setTimeout(resolve, 20));
			return { before, applied: p.classList.contains('iw-row'), width: img.getBoundingClientRect().width };
		});
		assert.equal(late.before, false); assert.equal(late.applied, true); near(late.width, 140, 'late natural width');
	} finally {
		await page.evaluate(() => { window.iwStopLateRow?.(); delete window.iwStopLateRow; });
	}
	const cleaned = await page.evaluate(() => {
		const p = document.querySelector('p');
		const img = p.querySelector('img');
		img.dispatchEvent(new Event('load'));
		return { cleaned: !p.classList.contains('iw-row'), value: p.firstElementChild.style.getPropertyValue('--iw-row-width') };
	});
	assert.equal(cleaned.cleaned, true); assert.equal(cleaned.value, '');
});
