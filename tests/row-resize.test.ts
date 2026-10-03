import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composedWidths, desiredForComposed, MIN_COMPOSED_WIDTH, resizedWidth, resizeLimits, withWidth } from '../src/rendering/row-resize';

const composedAfter = (widths: number[], gap: number, index: number, width: number) => {
	const next = [...widths]; next[index] = width;
	return composedWidths(next, gap)!;
};

test('inverse: fitting rows save what is shown, overflowing rows use d·S/(R−d)', () => {
	const context = { widths: [200, 300], gap: 12, index: 0 };
	assert.equal(desiredForComposed(context, 250), 250);
	const w = desiredForComposed(context, 500);
	assert.ok(Math.abs(composedAfter([200, 300], 12, 0, w)[0]! - 500) < 1e-9);
	assert.equal(desiredForComposed(context, 700), Infinity);
});

test('one image alone goes from 35 to 700 px', () => {
	const context = { widths: [300], gap: 12, index: 0 };
	assert.deepEqual(resizeLimits(context), { min: MIN_COMPOSED_WIDTH, max: 700 });
	assert.equal(resizedWidth(context, 5000), 700);
	assert.equal(resizedWidth(context, 3), 35);
	assert.equal(resizedWidth(context, 420.4), 420);
});

test('enlarging stops before another image goes below 35 px, with gaps counted', () => {
	const widths = [200, 300, 200];
	for (const index of [0, 1, 2]) {
		const context = { widths, gap: 12, index };
		const width = resizedWidth(context, 10_000)!;
		assert.ok(Number.isFinite(width) && width > 0);
		const composed = composedAfter(widths, 12, index, width);
		composed.forEach((value, i) => { if (i !== index) assert.ok(value >= MIN_COMPOSED_WIDTH - 1e-9, `${index}:${i} ${value}`); });
		// One more pixel would break the minimum for some other image.
		const beyond = composedAfter(widths, 12, index, width + 1);
		assert.ok(beyond.some((value, i) => i !== index && value < MIN_COMPOSED_WIDTH));
	}
});

test('the resized image never goes below 35 px composed, even in an overflowing row', () => {
	const widths = [100, 900, 900];
	const context = { widths, gap: 12, index: 0 };
	const width = resizedWidth(context, 0)!;
	assert.ok(composedAfter(widths, 12, 0, width)[0]! >= MIN_COMPOSED_WIDTH - 1e-9);
	assert.ok(composedAfter(widths, 12, 0, width - 1)[0]! < MIN_COMPOSED_WIDTH);
});

test('an image already below the minimum may stay there but not shrink further', () => {
	// 25 images of 100 px: each is 28 px composed, below the minimum.
	const widths = Array.from({ length: 25 }, () => 100);
	const start = composedWidths(widths, 0)!;
	assert.ok(start[3]! < MIN_COMPOSED_WIDTH);
	const context = { widths, gap: 0, index: 3 };
	assert.equal(resizedWidth(context, 10_000), 100, 'enlarging would shrink the others below their start');
	assert.equal(resizedWidth(context, 1), 100, 'shrinking below its own start is refused');
	const other = composedAfter(widths, 0, 3, 100);
	assert.ok(other.every((value, i) => value >= start[i]! - 1e-9));
});

test('many images and very different sizes always give finite whole pixels', () => {
	for (const widths of [[1, 5000], [5000, 1, 1], Array.from({ length: 30 }, (_, i) => 10 + i * 97)]) {
		for (let index = 0; index < widths.length; index++) {
			for (const target of [0, 1, 35, 350, 699, 700, 1e9]) {
				const width = resizedWidth({ widths, gap: 24, index }, target);
				assert.ok(width !== undefined && Number.isInteger(width) && width >= 1 && Number.isFinite(width), `${widths} ${index} ${target}`);
			}
		}
	}
	assert.equal(resizedWidth({ widths: [0, 100], gap: 0, index: 1 }, 50), undefined);
	assert.equal(resizedWidth({ widths: [100], gap: 0, index: 0 }, NaN), undefined);
});

test('the link keeps its other parameters; WxH keeps its proportion', () => {
	assert.equal(withWidth('![[a.png|200]]', 350), '![[a.png|350]]');
	assert.equal(withWidth('![[a.png|didascalia|300x200|altro]]', 150), '![[a.png|didascalia|150x100|altro]]');
	assert.equal(withWidth('![[cartella/a b.png]]', 90), '![[cartella/a b.png|90]]');
	assert.equal(withWidth('![[a.png|didascalia]]', 90), '![[a.png|didascalia|90]]');
	// No proportion from a zero size: only the width is saved.
	assert.equal(withWidth('![[a.png|0x100]]', 200), '![[a.png|200]]');
	assert.equal(withWidth('![[a.png|100x0]]', 200), '![[a.png|200]]');
});
