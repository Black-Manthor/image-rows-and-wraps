import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN_WRAP_WIDTH, wrapResizeWidth } from '../src/rendering/wrap-resize';

test('wrap image resize: within the minimum and the maximum share of the column', () => {
	// 700 px column, 45%: at most 315 px.
	assert.deepEqual(wrapResizeWidth(200, 60, 700, 45), { width: 260, over: false });
	assert.deepEqual(wrapResizeWidth(200, 115, 700, 45), { width: 315, over: false });
	assert.deepEqual(wrapResizeWidth(200, 400, 700, 45), { width: 315, over: true }, 'stops at the limit and says so');
	assert.deepEqual(wrapResizeWidth(200, -500, 700, 45), { width: MIN_WRAP_WIDTH, over: false }, 'never below the minimum');
	assert.equal(wrapResizeWidth(200, 30.6, 700, 45).width, 231, 'whole pixels');
	// A column so narrow that the share is below the minimum: the minimum wins.
	assert.deepEqual(wrapResizeWidth(60, 10, 100, 10), { width: MIN_WRAP_WIDTH, over: true });
});
