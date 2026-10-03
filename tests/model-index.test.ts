import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument, regionForImage, type DocumentModel, type ImageLink } from '../src/markdown/model';
import { findRows, markerZones, parseRowSettings, parseRowText, type ImageRow } from '../src/markdown/row-model';

// Straightforward implementations, kept as the reference for the indexed ones.
function referenceRegion(model: DocumentModel, image: ImageLink) {
	return model.regions.find(region => region.first < region.end && region.first === image.line &&
		model.lines[image.line]?.text.trim() === image.raw);
}

function referenceRows(model: DocumentModel): ImageRow[] {
	const zones = markerZones(model);
	const blank = (index: number) => !model.lines[index]?.text.trim();
	const rows: ImageRow[] = [];
	model.lines.forEach((line, index) => {
		if (!line.active || !blank(index - 1) || !blank(index + 1) || /^\s/.test(line.text)) return;
		if (zones.some(([start, end]) => index >= start && index <= end)) return;
		const parsed = parseRowText(line.text);
		if (!parsed) return;
		rows.push({ line: index, from: line.from, to: line.to, images: parsed.images,
			...(parsed.comment ? { comment: parsed.comment } : {}),
			settings: parseRowSettings(parsed.comment?.body) });
	});
	return rows;
}

const FRAGMENTS = [
	'[wrap:start]', '[wrap:start] %%iw-wrap side=right%%', '[wrap:end]', '![[a.png|200]]', '![[b.png]]', '![[c.png|100]] ![[d.png]]',
	'![[e.png]] %%iw-row align=center%%', 'Testo ![[f.png]] in mezzo.', 'Testo normale.', '', '', '',
	'```', '![[g.png]]', '%%', '- ![[h.png]]', '> ![[i.png]]',
];

// Deterministic pseudo-random notes: every run checks the same cases.
function note(seed: number): string {
	let state = seed;
	const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
	return Array.from({ length: 5 + Math.floor(next() * 40) }, () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!).join('\n');
}

test('indexed wrap regions and rows match the reference implementations', () => {
	for (let seed = 1; seed <= 3000; seed++) {
		const source = note(seed);
		const model = parseDocument(source);
		for (const image of model.images) assert.equal(regionForImage(model, image), referenceRegion(model, image), `seed ${seed}`);
		assert.deepEqual(findRows(source, model), referenceRows(model), `seed ${seed}`);
	}
});
