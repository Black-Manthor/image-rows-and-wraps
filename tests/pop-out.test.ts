import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// A note in a pop-out window lives in another document: observers come from
// the observed node's own window (`windowOf`), never from the main window's
// globals. Both work in Electron today, so no behaviour tells them apart: the
// rule is checked on the source.
test('every observer is made from the observed node’s window', async () => {
	const files = (await readdir('src', { recursive: true })).filter(name => name.endsWith('.ts'));
	const found: string[] = [];
	for (const file of files) {
		const text = await readFile(join('src', file), 'utf8');
		text.split('\n').forEach((line, index) => {
			if (/new\s+(?:Mutation|Resize|Intersection)Observer\s*\(/.test(line)) found.push(`src/${file}:${index + 1}`);
		});
	}
	assert.deepEqual(found, []);
});
