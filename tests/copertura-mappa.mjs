// Coverage of the plugin's sources from V8 coverage of a bundle (Node,
// Chromium, the real app): which lines of src/ ran, and which never did.
// Only lines the bundle has code for count: imports, types and comments
// have no mapping and are left out. No dependency: the source map is read here.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

// Where each suite leaves its raw coverage, when `npm run test:copertura` runs it.
export const coverageDir = process.env.IW_COPERTURA ? resolve(process.env.IW_COPERTURA) : undefined;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// The source map's segments: [generated line, generated column, source, line].
export function segments(map) {
	const out = [];
	let source = 0, line = 0;
	map.mappings.split(';').forEach((group, generatedLine) => {
		let column = 0;
		for (const segment of group.split(',')) {
			if (!segment) continue;
			const values = [];
			let value = 0, shift = 0;
			for (const char of segment) {
				const digit = BASE64.indexOf(char);
				value += (digit & 31) << shift;
				if (digit & 32) shift += 5;
				else { values.push(value & 1 ? -(value >> 1) : value >> 1); value = 0; shift = 0; }
			}
			column += values[0];
			if (values.length < 4) continue;
			source += values[1]; line += values[2];
			out.push([generatedLine, column, source, line]);
		}
	});
	return out;
}

export function inlineMap(code) {
	const match = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code);
	if (!match) throw new Error('Copertura: il file compilato non ha la source map in linea.');
	return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

// V8 coverage of one script run -> { 'src/x.ts': { covered: Set, uncovered: Set } } (1-based lines).
// `bundleDir`: the folder the bundle was written to, which the map's paths are relative to.
// `offset`: where the bundle starts in the script V8 ran (Obsidian wraps a
// plugin's code in a function of its own).
export function sourceLines(code, functions, bundleDir, offset = 0, root = process.cwd()) {
	const counts = new Int32Array(code.length + 1).fill(-1);
	const ranges = functions.flatMap(fn => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
	// Outer ranges first: a nested block's count overrides its function's.
	for (const range of ranges) {
		counts.fill(range.count, Math.max(0, range.startOffset - offset), Math.max(0, Math.min(range.endOffset - offset, code.length)));
	}
	const lineStarts = [0];
	for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
	const map = inlineMap(code);
	const files = map.sources.map(source => relative(root, resolve(bundleDir, map.sourceRoot ?? '', source)).replaceAll('\\', '/'));
	const result = {};
	for (const [generatedLine, column, source, line] of segments(map)) {
		const file = files[source];
		if (!file?.startsWith('src/')) continue;
		const count = counts[(lineStarts[generatedLine] ?? 0) + column];
		if (count < 0) continue;
		const entry = result[file] ??= { covered: new Set(), uncovered: new Set() };
		(count > 0 ? entry.covered : entry.uncovered).add(line + 1);
	}
	for (const entry of Object.values(result)) for (const line of entry.covered) entry.uncovered.delete(line);
	return result;
}

// Several runs of the same sources together: a line ran if it ran in any of them.
export function mergeLines(...results) {
	const merged = {};
	for (const result of results) for (const [file, { covered, uncovered }] of Object.entries(result)) {
		const entry = merged[file] ??= { covered: new Set(), uncovered: new Set() };
		for (const line of covered) entry.covered.add(line);
		for (const line of uncovered) entry.uncovered.add(line);
	}
	for (const entry of Object.values(merged)) for (const line of entry.covered) entry.uncovered.delete(line);
	return merged;
}

export const serialize = result => Object.fromEntries(Object.entries(result)
	.map(([file, { covered, uncovered }]) => [file, { covered: [...covered].sort((a, b) => a - b), uncovered: [...uncovered].sort((a, b) => a - b) }]));
export const deserialize = data => Object.fromEntries(Object.entries(data)
	.map(([file, { covered, uncovered }]) => [file, { covered: new Set(covered), uncovered: new Set(uncovered) }]));

// Chromium pages (browser suites, the real app): coverage starts with the page
// and is saved, already mapped to src/, under `name` when the page is done.
export async function startPageCoverage(page) {
	if (coverageDir) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
}

// `code`: the bundle the page ran; `pick` tells its scripts apart from the others.
export async function savePageCoverage(page, name, code, bundleDir, pick) {
	if (!coverageDir) return;
	const entries = (await page.coverage.stopJSCoverage()).filter(pick);
	const results = entries.map(entry => {
		const offset = (entry.source ?? code).indexOf(code.slice(0, 2000));
		if (offset < 0) throw new Error(`Copertura: script ${entry.url} diverso dal file compilato.`);
		return sourceLines(code, entry.functions, bundleDir, offset);
	});
	await mkdir(coverageDir, { recursive: true });
	await writeFile(join(coverageDir, `${name}.json`), JSON.stringify(serialize(mergeLines(...results))));
}
