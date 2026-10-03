import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ROW_SETTINGS, desiredWidth, findRows, parseRowSettings, parseRowText } from '../src/markdown/row-model';
import { composeRow } from '../src/rendering/row-layout';

const lines = (rows: ReturnType<typeof findRows>) => rows.map(row => row.line);

test('row settings: valid values override defaults key by key', () => {
	assert.deepEqual(parseRowSettings('align=center valign=bottom gap=24'), { align: 'center', valign: 'bottom', gap: 24 });
	assert.deepEqual(parseRowSettings('align=pippo gap=-3 valign=center extra=1'), { ...DEFAULT_ROW_SETTINGS, valign: 'center' });
	assert.deepEqual(parseRowSettings(''), DEFAULT_ROW_SETTINGS);
	assert.equal(parseRowSettings('gap=0').gap, 0);
	assert.equal(parseRowSettings('gap=1e3').gap, DEFAULT_ROW_SETTINGS.gap);
});

test('desired width comes from the size parameter only', () => {
	assert.equal(desiredWidth(['300']), 300);
	assert.equal(desiredWidth(['300x200']), 300);
	assert.equal(desiredWidth(['didascalia', '250']), 250);
	assert.equal(desiredWidth(['0']), undefined);
	assert.equal(desiredWidth([]), undefined);
});

test('row text: images only, comment last, attached comment tolerated', () => {
	const parsed = parseRowText('![[a.png|200]] ![[b.png]] %%iw-row align=right%%')!;
	assert.deepEqual(parsed.images.map(image => [image.path, image.width]), [['a.png', 200], ['b.png', undefined]]);
	assert.deepEqual(parsed.comment, { from: 26, to: 48, body: 'align=right' });
	assert.equal(parseRowText('![[a.png]]%%iw-row%%')?.comment?.body, '');
	assert.equal(parseRowText('![[a.png]] testo'), undefined);
	assert.equal(parseRowText('![[a.png]] %%iw-row%% testo'), undefined);
	assert.equal(parseRowText('![[a.png]] %%altro%%'), undefined);
	assert.equal(parseRowText('![[nota]] ![[a.png]]'), undefined);
	assert.equal(parseRowText('%%iw-row%%'), undefined);
});

test('rows are dedicated top-level paragraphs, single images included', () => {
	const source = ['![[a.png]]', '', '![[a.png]] ![[b.png]]', '', 'Testo', '![[a.png]]', '', '![[a.png]]', '![[b.png]]',
		'', '- ![[a.png]]', '', '  ![[a.png]]', '', '> ![[a.png]]', '', '```', '![[a.png]]', '```', '', '![[a.png|center|200]]'].join('\n');
	// A leftover `center` parameter is ignored: the image is an ordinary row.
	assert.deepEqual(lines(findRows(source)), [0, 2, 20]);
	assert.equal(findRows(source).at(-1)?.images[0]?.width, 200);
});

test('wrap regions never contain rows; old group markers are plain text', () => {
	const source = ['[wrap:start]', '', '![[a.png|200]]', '', '![[b.png]]', '', '[wrap:end]', '',
		'![[c.png]]', '', '[image-row:start]', '', '![[a.png]]', '', '[image-row:end]', '', '![[d.png]]'].join('\n');
	assert.deepEqual(lines(findRows(source)), [8, 12, 16]);
});

test('row defaults come from the settings when the comment omits a key', () => {
	const defaults = { align: 'right' as const, valign: 'bottom' as const, gap: 4 };
	assert.deepEqual(findRows('![[a.png]] %%iw-row align=center%%', undefined, defaults)[0]?.settings,
		{ align: 'center', valign: 'bottom', gap: 4 });
});

test('marker errors block only their own zone', () => {
	const unclosed = ['![[a.png]]', '', '[wrap:start]', '', '![[b.png]]', '', '![[c.png]]'].join('\n');
	assert.deepEqual(lines(findRows(unclosed)), [0]);
	const stray = ['![[a.png]]', '', '[wrap:start]', '', 'x', '', '[wrap:end]', '', '![[b.png]]', '', '[wrap:end]', '', '![[c.png]]'].join('\n');
	assert.deepEqual(lines(findRows(stray)), [0, 12]);
});

test('composition: fits unchanged, overflows by one common factor', () => {
	const fits = composeRow([200, 300], 12)!;
	assert.deepEqual(fits.widths.map(w => +(w * 7).toFixed(6)), [200, 300]);
	assert.equal(+(fits.gap * 7).toFixed(6), 12);
	const over = composeRow([200, 300, 200], 12)!;
	const factor = 700 / 724;
	assert.deepEqual(over.widths.map(w => +(w * 7).toFixed(3)), [200, 300, 200].map(w => +(w * factor).toFixed(3)));
	assert.equal(+(over.gap * 7).toFixed(3), +(12 * factor).toFixed(3));
	const total = over.widths.reduce((a, b) => a + b, 0) + 2 * over.gap;
	assert.ok(Math.abs(total - 100) < 1e-9);
});

test('composition: single wide image fills the band, unknown widths wait', () => {
	assert.deepEqual(composeRow([1536], 12), { widths: [100], gap: 0 });
	assert.equal(composeRow([200, undefined], 12), undefined);
	assert.equal(composeRow([], 12), undefined);
	assert.equal(composeRow([0], 12), undefined);
});

test('numeric overflow cannot become row CSS or desired widths', () => {
	const huge = '9'.repeat(400);
	assert.equal(parseRowSettings(`gap=${huge}`).gap, 12);
	assert.equal(desiredWidth([huge]), undefined);
	for (const gap of [Infinity, NaN, -1]) assert.equal(composeRow([100, 200], gap), undefined);
	assert.equal(composeRow([1e308, 1e308], 12), undefined);
});

test('Obsidian multiline comments never expose rows or wrap markers', () => {
	const source = '%%\n\n![[hidden.png]]\n\n[wrap:start]\n\n%%\n\n![[visible.png]]';
	assert.deepEqual(findRows(source).map(row => row.images[0]?.path), ['visible.png']);
});

test('a fence written inside an Obsidian comment does not hide following content', () => {
	assert.equal(findRows('%%\n```\n%%\n\n![[a.png]]').length, 1);
});
