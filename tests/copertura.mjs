// Which lines of src/ the test suites run, and which none does: Node, Chromium
// and the real app, each on its own and together. The suites' results count
// too: a failing suite is reported, its coverage is still read.
//
//   npm run test:copertura              all three suites
//   npm run test:copertura -- --senza-app   Node and Chromium only
//
// The report goes to the terminal and to .copertura/rapporto.md.
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deserialize, mergeLines } from './copertura-mappa.mjs';
import { currentRun, record } from './registro.mjs';

const dir = resolve('.copertura');
const withApp = !process.argv.includes('--senza-app');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const env = { ...process.env, IW_COPERTURA: dir };

const run = (label, command, args) => {
	console.log(`\n▸ ${label}`);
	const result = spawnSync(command, args, { stdio: 'inherit', env });
	return result.status === 0 ? undefined : label;
};
const failed = [
	run('Node', process.execPath, ['tests/run.mjs']),
	run('Chromium', process.execPath, ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./tests/registro-reporter.mjs', '--test-reporter-destination=stderr', 'tests/browser.mjs']),
	// The npm script itself: its reporters record the results and the run's end.
	run('Chromium, righe', 'npm', ['run', '-s', 'test:rows']),
	...(withApp ? [
		run('Build per la copertura', process.execPath, ['esbuild.config.mjs', 'copertura', join(dir, 'app', 'main.js')]),
		run('App reale', process.execPath, ['--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
			'--test-reporter=./tests/registro-reporter.mjs', '--test-reporter-destination=stderr', 'tests/obsidian.mjs']),
	] : []),
].filter(Boolean);

// --- Report ---------------------------------------------------------------
const read = async names => mergeLines(...await Promise.all(names.map(async name => deserialize(JSON.parse(await readFile(join(dir, name), 'utf8'))))));
const saved = await readdir(dir);
const suites = {
	Node: await read(saved.filter(name => name === 'node.json')),
	Chromium: await read(saved.filter(name => /^(browser-\d+|righe)\.json$/.test(name))),
	...(withApp ? { App: await read(saved.filter(name => name === 'app.json')) } : {}),
};
const together = mergeLines(...Object.values(suites));
const sources = (await readdir('src', { recursive: true })).filter(name => name.endsWith('.ts')).map(name => `src/${name.replaceAll('\\', '/')}`).sort();

const percent = entry => {
	if (!entry) return '—';
	const total = entry.covered.size + entry.uncovered.size;
	return total ? `${Math.floor(100 * entry.covered.size / total)}%` : '—';
};
// 3, 4, 5, 9 -> "3-5, 9"
const spans = lines => {
	const sorted = [...lines].sort((a, b) => a - b), out = [];
	for (const line of sorted) {
		const last = out[out.length - 1];
		if (last && line === last[1] + 1) last[1] = line; else out.push([line, line]);
	}
	return out.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(', ');
};

const names = Object.keys(suites);
const rows = sources.map(file => [file, ...names.map(name => percent(suites[name][file])), together[file] ? percent(together[file]) : 'mai caricato',
	together[file] ? spans(together[file].uncovered) : '']);
const totals = entries => {
	let covered = 0, all = 0;
	for (const entry of entries) { covered += entry.covered.size; all += entry.covered.size + entry.uncovered.size; }
	return all ? `${Math.floor(100 * covered / all)}%` : '—';
};
rows.push(['Totale', ...names.map(name => totals(Object.values(suites[name]))), totals(Object.values(together)), '']);

const header = ['File', ...names, 'Insieme', 'Righe mai eseguite'];
const markdown = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
await writeFile(join(dir, 'rapporto.md'), `# Copertura dei test\n\n${new Date().toISOString()}${withApp ? '' : ', senza l’app reale'}\n\n${markdown}\n`);

const width = Math.max(...sources.map(file => file.length), 6);
console.log(`\n▸ Copertura (righe di codice eseguite)\n`);
console.log(`${'File'.padEnd(width)}  ${[...names, 'Insieme'].map(name => name.padStart(10)).join('')}  Righe mai eseguite`);
for (const row of rows) {
	const [file, ...rest] = row;
	const lines = rest.pop();
	console.log(`${file.padEnd(width)}  ${rest.map(value => value.padStart(10)).join('')}  ${lines}`);
}
console.log(`\nRapporto in ${join(dir, 'rapporto.md')}`);
// The totals in the registry, so the coverage can be followed over time.
currentRun('copertura');
record({ kind: 'coverage', ...Object.fromEntries([...names.map(name => [name, totals(Object.values(suites[name]))]), ['together', totals(Object.values(together))]]),
	neverRun: Object.fromEntries(Object.entries(together).filter(([, entry]) => entry.uncovered.size).map(([file, entry]) => [file, spans(entry.uncovered)])),
	...(withApp ? {} : { withoutApp: true }), ...(failed.length ? { failedSuites: failed } : {}) });
if (failed.length) {
	console.log(`\n✗ Suite con errori: ${failed.join(', ')} (la copertura letta è quella dei test eseguiti).`);
	process.exitCode = 1;
}
