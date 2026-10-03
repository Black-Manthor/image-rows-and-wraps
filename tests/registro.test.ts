import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeState, describeError, manualCheckProblem, UNKNOWN } from './registro.mjs';
import { analyze, parseRegistry, RUNNING_FOR, sameCode } from './registro-analisi.mjs';
import { consoleOutcome, consoleReviewLabel, consoleSource, TEARDOWN_WINDOW_MS, windowTeardownError } from './console-policy.mjs';

// The registry must never turn missing or ambiguous data into a firm
// conclusion: these are the cases where it could.

test('the Git state follows every change, accented file names included; unknown without git', () => {
	const dir = mkdtempSync(join(tmpdir(), 'iw-registro-'));
	try {
		const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
		git('init', '-q');
		git('commit', '-q', '--allow-empty', '-m', 'inizio');
		const clean = codeState(dir).state;
		// A new file with an accented name (git quotes it in text output).
		writeFileSync(join(dir, 'prova è.js'), 'uno');
		const first = codeState(dir);
		assert.deepEqual(first.changed, ['prova è.js'], 'the path as on disk');
		writeFileSync(join(dir, 'prova è.js'), 'due');
		const second = codeState(dir).state;
		assert.ok(clean !== first.state && first.state !== second, `three different states: ${clean}, ${first.state}, ${second}`);
		// A tracked file changed.
		git('add', '.');
		git('commit', '-q', '-m', 'file');
		const committed = codeState(dir).state;
		writeFileSync(join(dir, 'prova è.js'), 'tre');
		assert.notEqual(codeState(dir).state, committed);
	} finally { rmSync(dir, { recursive: true, force: true }); }
	const outside = mkdtempSync(join(tmpdir(), 'iw-senza-git-'));
	try { assert.equal(codeState(outside).state, UNKNOWN, 'no repository: no Git state'); }
	finally { rmSync(outside, { recursive: true, force: true }); }
});

test('the content identity is the working tree: a commit of the same files keeps it, any other change moves it', () => {
	const dir = mkdtempSync(join(tmpdir(), 'iw-contenuto-test-'));
	try {
		const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
		git('init', '-q');
		mkdirSync(join(dir, 'note'));
		mkdirSync(join(dir, 'scripts'));
		writeFileSync(join(dir, '.gitignore'), 'main.js\nlocale/\n');
		writeFileSync(join(dir, 'a.ts'), 'uno');
		writeFileSync(join(dir, 'note', 'nota.md'), 'nota');
		writeFileSync(join(dir, 'scripts', 'prova.mjs'), 'prova');
		git('add', '-A');
		git('commit', '-q', '-m', 'inizio');
		const base = codeState(dir);
		assert.match(base.content, /^[0-9a-f]{40}$/, 'a Git tree id');
		assert.equal(base.content, git('rev-parse', 'HEAD^{tree}').trim(), 'clean: the commit\'s own tree');
		assert.notEqual(base.state, UNKNOWN, 'the Git identity stays');
		const index = () => git('ls-files', '--stage');
		const indexBefore = index();

		// Ignored files (the build, local data) are not content.
		writeFileSync(join(dir, 'main.js'), 'build');
		mkdirSync(join(dir, 'locale'));
		writeFileSync(join(dir, 'locale', 'dati.json'), '{}');
		assert.equal(codeState(dir).content, base.content, 'ignored files change nothing');

		// A new file not ignored is content; committing exactly it keeps the content, not the state.
		writeFileSync(join(dir, 'nuovo.ts'), 'nuovo');
		const dirty = codeState(dir);
		assert.notEqual(dirty.content, base.content, 'an untracked file');
		assert.equal(index(), indexBefore, 'the real index is not touched');
		assert.equal(git('status', '--porcelain', '--untracked-files=all').trim(), '?? nuovo.ts', 'nor the files');
		git('add', '-A');
		git('commit', '-q', '-m', 'nuovo');
		const committed = codeState(dir);
		assert.notEqual(committed.state, dirty.state, 'the commit moves the Git identity');
		assert.equal(committed.content, dirty.content, 'but not the content');
		assert.equal(committed.content, git('rev-parse', 'HEAD^{tree}').trim());

		// Every real change moves it, and undoing the change brings it back.
		const changed = (what: string, change: () => void, undo: () => void) => {
			change();
			assert.notEqual(codeState(dir).content, committed.content, what);
			undo();
			assert.equal(codeState(dir).content, committed.content, `${what}, undone`);
		};
		changed('a tracked file', () => writeFileSync(join(dir, 'a.ts'), 'due'), () => writeFileSync(join(dir, 'a.ts'), 'uno'));
		changed('a document', () => writeFileSync(join(dir, 'note', 'nota.md'), 'altra'), () => writeFileSync(join(dir, 'note', 'nota.md'), 'nota'));
		changed('a script', () => writeFileSync(join(dir, 'scripts', 'prova.mjs'), 'altro'), () => writeFileSync(join(dir, 'scripts', 'prova.mjs'), 'prova'));
		changed('a deletion', () => rmSync(join(dir, 'a.ts')), () => writeFileSync(join(dir, 'a.ts'), 'uno'));
		// File modes count where the file system keeps them (not on Windows).
		if (git('config', '--bool', 'core.fileMode').trim() === 'true') {
			changed('a file mode', () => chmodSync(join(dir, 'a.ts'), 0o755), () => chmodSync(join(dir, 'a.ts'), 0o644));
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
	const outside = mkdtempSync(join(tmpdir(), 'iw-senza-git-'));
	try { assert.equal(codeState(outside).content, UNKNOWN, 'no repository: no content either'); }
	finally { rmSync(outside, { recursive: true, force: true }); }
});

test('whatever a test throws is described, never lost', () => {
	assert.deepEqual(describeError('lanciato come stringa'), { error: 'lanciato come stringa', frames: [] });
	for (const [thrown, text] of [[undefined, 'undefined'], [null, 'null'], [42, '42'], [{ message: 3 }, '{"message":3}'], [Object.create(null), '{}']] as const) {
		assert.equal(describeError(thrown).error, text);
	}
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(typeof describeError(circular).error, 'string', 'a circular object still gives a text');
	try { assert.equal(1, 2); } catch (error) {
		const described = describeError(new Error('test fallito', { cause: error }));
		assert.equal(described.expected, '2');
		assert.equal(described.actual, '1');
		assert.ok(described.frames.some((frame: string) => frame.startsWith('tests/registro.test.ts:')), JSON.stringify(described.frames));
	}
});

test('unreadable registry lines are counted by file and line, the others read', () => {
	const { entries, unreadable } = parseRegistry([{ name: '2026-09-28.jsonl',
		text: '{"time":"2026-09-28T10:00:00Z","kind":"result"}\n{"time":"2026-09-28T10:00:01Z","ki\n\n42\n{"time":"2026-09-28T10:00:02Z","kind":"end"}\n' }]);
	assert.equal(entries.length, 2);
	assert.deepEqual(unreadable, [{ file: '2026-09-28.jsonl', line: 2 }, { file: '2026-09-28.jsonl', line: 4 }]);
});

test('console attribution uses structural evidence and never warning text', () => {
	assert.equal(consoleSource({ frames: ['src/rendering/wrap.ts:2:3'] }), 'plugin');
	assert.equal(consoleSource({ where: 'app://obsidian.md/main.js', stack: 'at app://obsidian.md/main.js:1:2' }), 'external');
	assert.equal(consoleSource({ where: '', stack: '', pluginId: 'image-flow' }), 'uncertain');
	assert.equal(consoleSource({ where: 'app://obsidian.md/main.js', stack: '', pluginId: 'image-flow' }), 'external',
		'mentioning the plugin only in message text cannot affect this API');
	assert.equal(consoleSource({ where: 'app://obsidian.md/plugins/image-flow/main.js', pluginId: 'image-flow' }), 'plugin');
});

test('console policy blocks errors and plugin warnings, while external and uncertain warnings remain reviewable', () => {
	const error = { source: 'external', text: 'boom' };
	const pluginWarning = { source: 'plugin', text: 'plugin warning' };
	const externalWarning = { source: 'external', text: 'external warning' };
	const uncertainWarning = { source: 'uncertain', text: 'uncertain warning' };
	assert.equal(consoleOutcome([], []).state, 'passed-clean');
	assert.deepEqual(consoleOutcome([error], []).blocking, [error]);
	assert.deepEqual(consoleOutcome([], [pluginWarning]).blocking, [pluginWarning]);
	const review = consoleOutcome([], [externalWarning, uncertainWarning]);
	assert.equal(review.state, 'passed-with-review-warnings');
	assert.deepEqual(review.blocking, []);
	assert.deepEqual(review.reviewWarnings, [externalWarning, uncertainWarning]);
	assert.equal(consoleReviewLabel(review), '⚠ 2 avvisi esterni/incerti da revisionare');
	assert.equal(consoleReviewLabel(consoleOutcome([], [])), 'console pulita');
});

test('a green run retains review warnings in its derived final state', () => {
	const entries = [
		...run('green-with-warning', 1, [['probe', 'superato']]),
		{ time: at(1), kind: 'console', run: 'green-with-warning', suite: 'app', level: 'warning', source: 'uncertain', test: 'probe', text: 'needs review' },
	];
	const analyzed = analyze(entries, { now: NOW, state: 'aaa' }).runs[0];
	assert.equal(analyzed.status, 'superata');
	assert.equal(analyzed.consoleOutcome.state, 'passed-with-review-warnings');
	assert.equal(consoleReviewLabel(analyzed.consoleOutcome), '⚠ 1 avvisi esterni/incerti da revisionare');
});

// Registry lines of one run: its `run` line, results, optionally its end.
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 28, 10, minutes)).toISOString();
const NOW = Date.parse(at(60));
function run(id: string, minute: number, results: Array<[string, 'superato' | 'fallito' | 'saltato']>,
	{ state = 'aaa', content, end = true, obsidian = '1.13.7', filter, environment = true, coverage = false,
		totals }: { state?: string; content?: string; end?: boolean; obsidian?: string; filter?: string[]; environment?: boolean; coverage?: boolean;
		totals?: { superato: number; fallito: number; saltato: number } } = {}) {
	const actual = { superato: results.filter(r => r[1] === 'superato').length, fallito: results.filter(r => r[1] === 'fallito').length,
		saltato: results.filter(r => r[1] === 'saltato').length };
	return [
		{ time: at(minute), kind: 'run', run: id, suite: 'app', state, ...(content ? { content } : {}), commit: 'c', platform: 'linux x64', node: 'v24', ...(filter ? { filter } : {}), ...(coverage ? { coverage: true } : {}) },
		...(environment ? [{ time: at(minute), kind: 'environment', run: id, suite: 'app', obsidian, mainHash: 'h', build: 'produzione' }] : []),
		...results.map(([test, result]) => ({ time: at(minute), kind: 'result', run: id, suite: 'app', test, result, error: result === 'fallito' ? `${test} rotto` : undefined })),
		...(end ? [{ time: at(minute), kind: 'end', run: id, suite: 'app', ...(totals ?? actual) }] : []),
	];
}

test('a run without an end is interrupted, or still running when recent; without a code line, undetermined', () => {
	const report = analyze([
		...run('finita', 1, [['a', 'superato']]),
		...run('interrotta', 2, [['a', 'superato']], { end: false }),
		...run('in-corso', 59, [['a', 'superato']], { end: false }),
		...run('senza-test', 3, []),
		...run('fallita', 4, [['a', 'fallito']]),
		{ time: at(5), kind: 'result', test: 'a', result: 'superato' },
	], { now: NOW, state: 'zzz' });
	const status = Object.fromEntries(report.runs.map((item: { id: string; status: string }) => [item.id, item.status]));
	assert.equal(status.finita, 'superata');
	assert.equal(status.interrotta, 'interrotta', 'no end, silent for more than RUNNING_FOR: never green');
	assert.equal(status['in-corso'], 'in corso');
	assert.equal(status['senza-test'], 'fallita (nessun test eseguito)');
	assert.equal(status.fallita, 'fallita');
	assert.equal(report.runs.find((item: { info?: unknown }) => !item.info).status, 'non determinabile');
	assert.ok(RUNNING_FOR >= 5 * 60000);
	// Stopped with Ctrl+C (its end says so), or killed and followed by a later run of its suite.
	const stopped = analyze([
		...run('ctrl-c', 57, [['a', 'superato']], { end: false }), { time: at(57), kind: 'end', run: 'ctrl-c', suite: 'app', interrupted: 'SIGINT' },
		...run('ucciso', 58, [['a', 'superato']], { end: false }),
		...run('dopo', 59, [['a', 'superato']]),
	], { now: NOW, state: 'aaa' });
	assert.deepEqual(stopped.runs.map((item: { id: string; status: string }) => [item.id, item.status]),
		[['ctrl-c', 'interrotta'], ['ucciso', 'interrotta'], ['dopo', 'superata']]);
});

test('command records finish their own runs without becoming tests or external checks', () => {
	const base = run('command-ok', 1, [], { end: false }); base[0]!.suite = 'comando:build';
	const failed = run('command-failed', 2, [], { end: false }); failed[0]!.suite = 'comando:lint';
	const interrupted = run('command-interrupted', 3, [], { end: false }); interrupted[0]!.suite = 'comando:check:latest';
	const unfinished = run('command-unfinished', 4, [], { end: false }); unfinished[0]!.suite = 'comando:build';
	const report = analyze([
		...base, { time: at(1), kind: 'command', run: 'command-ok', suite: 'comando:build', command: 'build', phase: 'bundle', ok: true, exitCode: 0, status: 'completed' },
		...failed, { time: at(2), kind: 'command', run: 'command-failed', suite: 'comando:lint', command: 'lint', phase: 'lint', ok: false, exitCode: 1, status: 'completed' },
		...interrupted, { time: at(3), kind: 'command', run: 'command-interrupted', suite: 'comando:check:latest', command: 'check:latest', phase: 'type-check latest', ok: false, exitCode: null, signal: 'SIGTERM', status: 'interrupted', interrupted: true },
		...unfinished,
	], { now: NOW, state: 'aaa' });
	assert.deepEqual(report.runs.map((item: { status: string }) => item.status), ['superata', 'fallita', 'interrotta', 'interrotta']);
	assert.equal(report.commands.length, 3);
	assert.equal(report.runs.every((item: { results: unknown[]; checks: unknown[] }) => !item.results.length && !item.checks.length), true);
});

test('failures many tests share stay in the judgement on the code of now, marked as correlated', () => {
	const tests = ['a', 'b', 'c', 'd', 'e', 'f'];
	const report = analyze([
		...run('prima', 1, tests.map(test => [test, 'superato'] as [string, 'superato'])),
		// One regression breaks them all on the code of now.
		...run('dopo', 2, tests.map(test => [test, 'fallito'] as [string, 'fallito']), { state: 'nuovo' }),
	], { now: NOW, state: 'nuovo' });
	assert.equal(report.correlated.length, 1);
	assert.deepEqual(report.brokenNow.map((item: { key: string; correlated: boolean }) => [item.key, item.correlated]), tests.map(test => [`app · ${test}`, true]));
});

test('unstable only with the same code in the same conditions; without a code identity, only discordant', () => {
	const report = analyze([
		// Same code, same conditions: passed then failed.
		...run('r1', 1, [['instabile', 'superato'], ['altra-versione', 'superato']]),
		...run('r2', 2, [['instabile', 'fallito']]),
		// Same code, another Obsidian: not comparable.
		...run('r3', 3, [['altra-versione', 'fallito']], { obsidian: '1.13.8' }),
		// Before code identities were recorded: a failure then a pass may be a fix.
		{ time: at(4), kind: 'result', run: 'vecchia-1', test: 'storico', result: 'fallito', error: 'x' },
		{ time: at(5), kind: 'result', run: 'vecchia-2', test: 'storico', result: 'superato' },
	], { now: NOW, state: 'aaa' });
	assert.deepEqual(report.unstable.map((item: { key: string }) => item.key), ['app · instabile']);
	assert.deepEqual(report.discordant.map((item: { key: string }) => item.key), ['app · storico']);
});

test('completion, scope and counts distinguish full, filtered, empty, interrupted and inconsistent runs', () => {
	const report = analyze([
		...run('full-pass', 1, [['ok', 'superato'], ['skip', 'saltato']]),
		...run('full-fail', 2, [['bad', 'fallito']]),
		...run('filtered-pass', 3, [['ok', 'superato']], { filter: ['ok'] }),
		...run('filtered-fail', 4, [['bad', 'fallito']], { filter: ['bad'] }),
		...run('filtered-empty', 5, [], { filter: ['missing'] }),
		...run('empty', 6, []),
		...run('inconsistent', 7, [['ok', 'superato']], { totals: { superato: 2, fallito: 0, saltato: 0 } }),
		...run('interrupted-results', 8, [['ok', 'superato']], { end: false }), { time: at(8), kind: 'end', run: 'interrupted-results', suite: 'app', interrupted: 'SIGINT' },
		...run('interrupted-empty', 9, [], { end: false }), { time: at(9), kind: 'end', run: 'interrupted-empty', suite: 'app', interrupted: 'SIGTERM' },
	], { now: NOW, state: 'aaa' });
	const byId: Record<string, any> = Object.fromEntries(report.runs.map((item: { id: string }) => [item.id, item]));
	assert.deepEqual([byId['full-pass'].completion, byId['full-pass'].scope, byId['full-pass'].resultCount,
		byId['full-pass'].passedCount, byId['full-pass'].failedCount, byId['full-pass'].skippedCount, byId['full-pass'].totalsConsistent],
		['completed', 'full', 2, 1, 0, 1, true]);
	assert.equal(byId['full-fail'].scope, 'full', 'a failed run can still cover the full suite');
	assert.equal(byId['filtered-pass'].scope, 'filtered');
	assert.equal(byId['filtered-pass'].status, 'superata');
	assert.equal(byId['filtered-fail'].scope, 'filtered');
	assert.equal(byId['filtered-fail'].status, 'fallita');
	assert.equal(byId['filtered-empty'].scope, 'empty');
	assert.equal(byId.empty.scope, 'empty');
	assert.deepEqual([byId.inconsistent.scope, byId.inconsistent.totalsConsistent], ['partial', false]);
	assert.deepEqual([byId['interrupted-results'].completion, byId['interrupted-results'].scope, byId['interrupted-results'].resultCount], ['interrupted', 'incomplete', 1]);
	assert.deepEqual([byId['interrupted-empty'].completion, byId['interrupted-empty'].scope, byId['interrupted-empty'].resultCount], ['interrupted', 'incomplete', 0]);
});

test('a newer filtered run updates its tests but never replaces the latest complete run', () => {
	const report = analyze([
		...run('complete', 1, [['one', 'superato'], ['two', 'superato']]),
		...run('filtered', 2, [['one', 'fallito']], { filter: ['one'] }),
	], { now: NOW, state: 'aaa' });
	assert.deepEqual(report.completeCurrentRuns.map((item: { id: string }) => item.id), ['complete']);
	assert.deepEqual(report.partialCurrentRuns.map((item: { id: string }) => item.id), ['filtered']);
	assert.equal(report.latestCurrentResults.find((item: { key: string }) => item.key === 'app · one')?.result.run.id, 'filtered');
	assert.equal(report.latestCurrentResults.find((item: { key: string }) => item.key === 'app · two')?.result.run.id, 'complete');
	const filteredView = analyze([...run('complete', 1, [['one', 'superato'], ['two', 'superato']])], { now: NOW, state: 'aaa', only: 'one' });
	assert.equal(filteredView.completeCurrentRuns[0].scope, 'full', 'filtering the report does not alter the original run scope');
	assert.deepEqual(filteredView.latestCurrentResults.map((item: { key: string }) => item.key), ['app · one']);
});

test('current completeness and last outcomes preserve code identity, environment and coverage boundaries', () => {
	const current = analyze([
		...run('old-full', 1, [['same', 'superato']], { state: 'old' }),
		...run('obsidian-old', 2, [['same', 'fallito']], { obsidian: '1.13.4' }),
		...run('obsidian-new', 3, [['same', 'superato']], { obsidian: '1.13.7' }),
		...run('missing-environment', 4, [['unknown', 'superato']], { environment: false }),
		...run('coverage', 5, [['covered', 'superato']], { coverage: true }),
	], { now: NOW, state: 'aaa' });
	assert.ok(!current.completeCurrentRuns.some((item: { id: string }) => item.id === 'old-full'));
	assert.equal(current.latestCurrentResults.filter((item: { key: string }) => item.key === 'app · same').length, 2, 'Obsidian versions do not overwrite one another');
	assert.deepEqual(current.latestCurrentResults.filter((item: { key: string }) => item.key === 'app · same').map((item: { result: { result: string } }) => item.result.result), ['fallito', 'superato']);
	assert.equal(current.nonComparableRuns.find((item: { id: string }) => item.id === 'missing-environment').comparability, 'unidentified-environment');
	assert.ok(!current.latestCurrentResults.some((item: { key: string }) => item.key === 'app · unknown'));
	assert.equal(current.completeCurrentRuns.filter((item: { id: string }) => ['obsidian-new', 'coverage'].includes(item.id)).length, 2,
		'coverage and normal runs have distinct environment keys');
	const oldOnly = analyze([...run('old-full', 1, [['same', 'superato']], { state: 'old' })], { now: NOW, state: 'aaa' });
	assert.equal(oldOnly.completeCurrentRuns.length, 0);
	assert.deepEqual(oldOnly.suitesWithoutCompleteCurrentRun, ['node', 'chromium', 'chromium-righe', 'app'],
		'a suite observed only on other code is historical, not verified now');
});

test('test histories describe observed pass and failure transitions across code identities', () => {
	const report = analyze([
		...run('p-f-p-1', 1, [['cycle', 'superato']], { state: 'one' }),
		...run('p-f-p-2', 2, [['cycle', 'fallito']], { state: 'two' }),
		...run('p-f-p-3', 3, [['cycle', 'superato']], { state: 'three' }),
		...run('persistent-1', 4, [['persistent', 'fallito']], { state: 'two' }),
		...run('persistent-2', 5, [['persistent', 'fallito']], { state: 'three' }),
		...run('fail-pass-1', 6, [['recovered', 'fallito']], { state: 'two' }),
		...run('fail-pass-2', 7, [['recovered', 'superato']], { state: 'three' }),
	], { now: NOW, state: 'three' });
	const history = (testName: string) => report.testHistories.find((item: { test: string }) => item.test === testName);
	const cycle = history('cycle');
	assert.deepEqual([cycle.observations.length, cycle.comparableRunCount, cycle.firstFailure.run.id, cycle.previousPass.run.id,
		cycle.lastFailure.run.id, cycle.firstPassAfterLastFailure.run.id, cycle.latestStatus, cycle.currentCodeStatus],
		[3, 3, 'p-f-p-2', 'p-f-p-1', 'p-f-p-2', 'p-f-p-3', 'passing', 'passing']);
	assert.equal(history('persistent').firstPassAfterLastFailure, undefined);
	assert.deepEqual([history('persistent').latestStatus, history('persistent').currentCodeStatus], ['failing', 'failing']);
	assert.equal(history('recovered').previousPass, undefined, 'there was no known pass before the first observed failure');
	assert.equal(history('recovered').firstPassAfterLastFailure.run.id, 'fail-pass-2');
});

test('test histories accept actual filtered and interrupted results, deduplicate a run, and reject incomplete identity', () => {
	const duplicate = run('duplicate', 3, [['last-wins', 'fallito']], { filter: ['last-wins'] });
	duplicate.splice(-1, 0, { time: at(3), kind: 'result', run: 'duplicate', suite: 'app', test: 'last-wins', result: 'superato', error: undefined });
	const interrupted = run('interrupted-history', 4, [['interrupted-result', 'fallito']], { end: false });
	const report = analyze([
		...run('filtered-failure', 1, [['filtered-only', 'fallito']], { filter: ['filtered-only'] }),
		...duplicate,
		...interrupted, { time: at(4), kind: 'end', run: 'interrupted-history', suite: 'app', interrupted: 'SIGINT' },
		...run('no-environment', 5, [['excluded', 'fallito']], { environment: false }),
	], { now: NOW, state: 'aaa', only: 'something-else' });
	const names = report.testHistories.map((item: { test: string }) => item.test);
	assert.ok(names.includes('filtered-only'), 'the report filter changes presentation, not historical data');
	assert.ok(names.includes('interrupted-result'));
	assert.ok(!names.includes('excluded'));
	const lastWins = report.testHistories.find((item: { test: string }) => item.test === 'last-wins');
	assert.deepEqual([lastWins.observations.length, lastWins.comparableRunCount, lastWins.latestStatus], [1, 1, 'passing']);
});

test('current problems exclude resolved historical failures while retaining their extended history', () => {
	const report = analyze([
		...run('old-failure', 1, [['recovered', 'fallito']], { state: 'old' }),
		...run('current-pass', 2, [['recovered', 'superato']], { state: 'current' }),
		...run('current-failure', 3, [['broken', 'fallito']], { state: 'current' }),
	], { now: NOW, state: 'current' });
	assert.deepEqual(report.currentTestProblems.map((item: { test: string }) => item.test), ['broken']);
	assert.equal(report.testHistories.find((item: { test: string }) => item.test === 'recovered').firstPassAfterLastFailure.run.id, 'current-pass');
	assert.equal(report.currentTestProblems[0].currentCodeObservation.run.id, 'current-failure');
});

test('historical environment separates Obsidian versions and coverage but crosses app main hashes', () => {
	const first = run('app-one', 1, [['same', 'fallito']], { obsidian: '1.13.7', state: 'one' });
	const second = run('app-two', 2, [['same', 'superato']], { obsidian: '1.13.7', state: 'two' });
	(second.find(entry => entry.kind === 'environment') as { mainHash: string }).mainHash = 'another-hash';
	const report = analyze([
		...first, ...second,
		...run('other-obsidian', 3, [['same', 'fallito']], { obsidian: '1.13.4', state: 'two' }),
		...run('coverage-history', 4, [['same', 'fallito']], { obsidian: '1.13.7', state: 'two', coverage: true }),
	], { now: NOW, state: 'two' });
	const histories = report.testHistories.filter((item: { test: string }) => item.test === 'same');
	assert.equal(histories.length, 3);
	assert.equal(histories.find((item: { observations: unknown[] }) => item.observations.length === 2).firstPassAfterLastFailure.run.id, 'app-two');
});

test('console histories use the existing signature and only full comparable runs prove absence', () => {
	const warning = (id: string, minute: number, number: number, options = {}) => [
		...run(id, minute, [['probe', 'superato']], options),
		{ time: at(minute), kind: 'console', run: id, suite: 'app', level: 'warning', source: 'plugin', test: 'probe', text: `warning ${number}` },
	];
	const interrupted = run('interrupted-no-warning', 4, [['probe', 'superato']], { end: false });
	const report = analyze([
		...warning('warning-1', 1, 12, { state: 'one' }),
		...warning('warning-2', 2, 98, { state: 'two', filter: ['probe'] }),
		...run('filtered-no-warning', 3, [['probe', 'superato']], { state: 'two', filter: ['probe'] }),
		...interrupted, { time: at(4), kind: 'end', run: 'interrupted-no-warning', suite: 'app', interrupted: 'SIGTERM' },
		...run('full-no-warning', 5, [['probe', 'superato']], { state: 'three' }),
	], { now: NOW, state: 'three' });
	assert.equal(report.consoleHistories.length, 1, 'numbers are neutralized by the current signature');
	const history = report.consoleHistories[0];
	assert.deepEqual([history.occurrenceCount, history.runCount, history.tests.size, history.codes.size], [2, 2, 1, 2]);
	assert.equal(history.firstComparableRunWithoutMessageAfterLastOccurrence.id, 'full-no-warning');
	assert.equal(history.latestExposureStatus, 'not-observed');
});

test('recurring console messages and different environments retain separate histories', () => {
	const consoleEntry = (id: string, minute: number, obsidian: string) => [
		...run(id, minute, [['probe', 'superato']], { obsidian }),
		{ time: at(minute), kind: 'console', run: id, suite: 'app', level: 'error', source: 'obsidian', test: 'probe', text: 'same error' },
	];
	const report = analyze([
		...consoleEntry('old-env-1', 1, '1.13.4'),
		...run('old-env-absence', 2, [['probe', 'superato']], { obsidian: '1.13.4' }),
		...consoleEntry('old-env-again', 3, '1.13.4'),
		...consoleEntry('new-env', 4, '1.13.7'),
	], { now: NOW, state: 'aaa' });
	assert.equal(report.consoleHistories.length, 2);
	const recurring = report.consoleHistories.find((item: { occurrenceCount: number }) => item.occurrenceCount === 2);
	assert.equal(recurring.latestExposureStatus, 'observed');
	assert.equal(recurring.firstComparableRunWithoutMessageAfterLastOccurrence, undefined);
});

test('the latest command invocation wins even when its terminal record is missing', () => {
	const completed = run('build-completed', 1, [], { end: false }); completed[0]!.suite = 'comando:build';
	const missingTerminal = run('build-missing-terminal', 2, [], { end: false }); missingTerminal[0]!.suite = 'comando:build';
	const failed = run('lint-failed', 3, [], { end: false }); failed[0]!.suite = 'comando:lint';
	const interrupted = run('lint-interrupted', 4, [], { end: false }); interrupted[0]!.suite = 'comando:lint';
	const recent = run('latest-running', 59, [], { end: false }); recent[0]!.suite = 'comando:check:latest';
	const report = analyze([
		...completed, { time: at(1), kind: 'command', run: 'build-completed', suite: 'comando:build', command: 'build', phase: 'bundle', ok: true, exitCode: 0, status: 'completed' },
		...missingTerminal,
		...failed, { time: at(3), kind: 'command', run: 'lint-failed', suite: 'comando:lint', command: 'lint', phase: 'lint', ok: false, exitCode: 1, status: 'completed' },
		...interrupted, { time: at(4), kind: 'command', run: 'lint-interrupted', suite: 'comando:lint', command: 'lint', phase: 'lint', ok: false, exitCode: null, signal: 'SIGTERM', status: 'interrupted', interrupted: true },
		...recent,
	], { now: NOW, state: 'aaa' });
	assert.deepEqual([report.latestCommandRuns.get('build').id, report.latestCommandRuns.get('build').status], ['build-missing-terminal', 'interrotta']);
	assert.deepEqual([report.latestCommandRuns.get('lint').id, report.latestCommandRuns.get('lint').status], ['lint-interrupted', 'interrotta']);
	assert.deepEqual([report.latestCommandRuns.get('check:latest').id, report.latestCommandRuns.get('check:latest').status], ['latest-running', 'in corso']);
});

test('console current state never promotes a warning seen only on older code', () => {
	const oldWarning = [
		...run('old-warning', 1, [['probe', 'superato']], { state: 'old' }),
		{ time: at(1), kind: 'console', run: 'old-warning', suite: 'app', level: 'warning', source: 'plugin', test: 'probe', text: 'warning 12' },
	];
	const historicalOnly = analyze(oldWarning, { now: NOW, state: 'current' });
	assert.equal(historicalOnly.consoleHistories[0].currentCodeStatus, 'not-verified');
	assert.equal(historicalOnly.currentConsoleProblems.length, 0);
	const absentNow = analyze([...oldWarning, ...run('current-clean', 2, [['probe', 'superato']], { state: 'current' })], { now: NOW, state: 'current' });
	assert.equal(absentNow.consoleHistories[0].currentCodeStatus, 'not-observed');
	assert.equal(absentNow.currentConsoleProblems.length, 0);
	const currentWarning = analyze([
		...oldWarning,
		...run('current-warning', 2, [['probe', 'superato']], { state: 'current', filter: ['probe'] }),
		{ time: at(2), kind: 'console', run: 'current-warning', suite: 'app', level: 'warning', source: 'plugin', test: 'probe', text: 'warning 98' },
	], { now: NOW, state: 'current' });
	assert.equal(currentWarning.consoleHistories[0].currentCodeStatus, 'observed');
	assert.equal(currentWarning.currentConsoleProblems.length, 1);
});

test('all expected suites are explicit when absent, filtered, or only historical', () => {
	const appOnly = analyze(run('app-current', 1, [['probe', 'superato']]), { now: NOW, state: 'aaa' });
	assert.deepEqual(appOnly.suitesWithoutCompleteCurrentRun, ['node', 'chromium', 'chromium-righe']);
	const filteredApp = analyze(run('app-filtered', 1, [['probe', 'superato']], { filter: ['probe'] }), { now: NOW, state: 'aaa' });
	assert.deepEqual(filteredApp.suitesWithoutCompleteCurrentRun, ['node', 'chromium', 'chromium-righe', 'app']);
	const historicalApp = analyze(run('app-old', 1, [['probe', 'superato']], { state: 'old' }), { now: NOW, state: 'aaa' });
	assert.deepEqual(historicalApp.suitesWithoutCompleteCurrentRun, ['node', 'chromium', 'chromium-righe', 'app']);
	const coverageOnly = analyze(run('app-coverage', 1, [['probe', 'superato']], { coverage: true }), { now: NOW, state: 'aaa' });
	assert.ok(coverageOnly.suitesWithoutCompleteCurrentRun.includes('app'), 'coverage does not attest the corresponding normal suite');
});

const manualRun = (id: string, minute: number, check: Record<string, unknown>, state = 'aaa', content?: string) => [
	{ time: at(minute), kind: 'run', run: id, suite: 'manual', state, ...(content ? { content } : {}), commit: 'c', plugin: '0.1.0', platform: 'linux x64', node: 'v24' },
	{ time: at(minute), kind: 'environment', run: id, suite: 'manual', system: 'Windows', obsidian: '1.13.7', loadedPlugin: '0.1.0', mainHash: 'h' },
	{ time: at(minute), kind: 'manual-check', run: id, suite: 'manual', ...check },
];

test('manual checks finish their run while remaining separate from tests, commands and automatic checks', () => {
	const report = analyze(manualRun('manual', 1, { type: 'targeted', scenarios: ['resize'], status: 'passed' }), { now: NOW, state: 'aaa' });
	const [manual] = report.runs;
	assert.deepEqual([manual.completion, manual.scope, manual.status], ['completed', 'not-applicable', 'passed']);
	assert.deepEqual([manual.results.length, manual.checks.length, manual.commands.length, manual.manualChecks.length], [0, 0, 0, 1]);
	assert.deepEqual([report.manualChecks.length, report.checks.length, report.commands.length], [1, 0, 0]);
	assert.equal(report.completeCurrentRuns.length, 0);
	assert.equal(report.partialCurrentRuns.length, 0);
});

test('manual targeted and complete observations stay distinct across code identities and statuses', () => {
	const report = analyze([
		...manualRun('old-complete', 1, { type: 'complete', scenarios: 'all', status: 'passed' }, 'old'),
		...manualRun('targeted-pass', 2, { type: 'targeted', scenarios: ['drag-images', 'resize'], status: 'passed' }),
		...manualRun('targeted-issue', 3, { type: 'targeted', scenarios: ['resize'], status: 'issue-observed', note: 'salto' }),
		...manualRun('targeted-blocked', 4, { type: 'targeted', scenarios: ['live-reading'], status: 'not-completable', note: 'vista assente' }),
	], { now: NOW, state: 'aaa' });
	assert.equal(report.currentCompleteManualCheck, undefined, 'targeted observations never make a complete one');
	assert.equal(report.latestHistoricalCompleteManualCheck.run.id, 'old-complete');
	assert.deepEqual(report.currentManualChecks.map((item: { check: { status: string } }) => item.check.status),
		['passed', 'issue-observed', 'not-completable']);
	assert.deepEqual(report.currentManualIssues.map((item: { run: { id: string } }) => item.run.id), ['targeted-issue']);
	assert.equal(report.historicalManualChecks.length, 1);
});

test('manual check schema requires the declared scopes and notes', () => {
	assert.equal(manualCheckProblem({ type: 'targeted', scenarios: ['resize'], status: 'passed' }), undefined);
	assert.equal(manualCheckProblem({ type: 'complete', scenarios: 'all', status: 'passed' }), undefined);
	assert.match(manualCheckProblem({ type: 'targeted', scenarios: [], status: 'passed' }) ?? '', /almeno uno scenario/);
	assert.match(manualCheckProblem({ type: 'complete', scenarios: ['resize'], status: 'passed' }) ?? '', /scenarios="all"/);
	assert.match(manualCheckProblem({ type: 'targeted', scenarios: ['resize'], status: 'issue-observed' }) ?? '', /richiede una nota/);
	assert.match(manualCheckProblem({ type: 'targeted', scenarios: ['resize'], status: 'not-completable' }) ?? '', /richiede una nota/);
	assert.match(manualCheckProblem({ type: 'targeted', scenarios: ['resize'], status: 'failed' }) ?? '', /esito non valido/);
});

test('same code: the content when both lines have it, otherwise the Git state, never an assumed equivalence', () => {
	assert.equal(sameCode({ state: 'a', content: 'T' }, { state: 'b', content: 'T' }), true, 'a commit of the same files');
	assert.equal(sameCode({ state: 'a', content: 'T' }, { state: 'a', content: 'U' }), false, 'content decides when both have it');
	assert.equal(sameCode({ state: 'a' }, { state: 'a', content: 'T' }), true, 'an older line: the same state is the same code, as before');
	assert.equal(sameCode({ state: 'a' }, { state: 'b', content: 'T' }), false, 'an older line is never reinterpreted through content');
	assert.equal(sameCode({ state: 'a', content: UNKNOWN }, { state: 'b', content: 'T' }), false, 'unknown content: the state decides');
	assert.equal(sameCode({ state: UNKNOWN }, { state: UNKNOWN }), false, 'nothing known: not the same code');
});

test('a commit that keeps the content keeps runs, histories and manual checks current', () => {
	const entries = [
		...run('before-commit', 1, [['probe', 'superato']], { state: 'dirty', content: 'T' }),
		...manualRun('complete', 2, { type: 'complete', scenarios: 'all', status: 'passed' }, 'dirty', 'T'),
		...manualRun('issue', 3, { type: 'targeted', scenarios: ['resize'], status: 'issue-observed', note: 'salto' }, 'dirty', 'T'),
	];
	const afterCommit = analyze(entries, { now: NOW, state: 'committed', content: 'T' });
	const [tests] = afterCommit.runs;
	assert.equal(tests.comparability, 'current');
	assert.deepEqual(afterCommit.completeCurrentRuns.map((item: { id: string }) => item.id), ['before-commit']);
	assert.ok(!afterCommit.suitesWithoutCompleteCurrentRun.includes('app'));
	assert.equal(afterCommit.latestCurrentResults.length, 1);
	assert.equal(afterCommit.testHistories[0].currentCodeStatus, 'passing');
	assert.equal(afterCommit.currentCompleteManualCheck?.run.id, 'complete');
	assert.deepEqual(afterCommit.currentManualIssues.map((item: { run: { id: string } }) => item.run.id), ['issue'], 'an issue stays current too');

	const changed = analyze(entries, { now: NOW, state: 'committed', content: 'U' });
	assert.equal(changed.runs[0].comparability, 'historical', 'another content: historical, whatever the commit');
	assert.ok(changed.suitesWithoutCompleteCurrentRun.includes('app'));
	assert.equal(changed.currentCompleteManualCheck, undefined);
	assert.equal(changed.latestHistoricalCompleteManualCheck?.run.id, 'complete');
	assert.equal(changed.currentManualIssues.length, 0);

	// Runs of the same content under two commits are the same code in the same conditions, each keeping its commit.
	const twoCommits = analyze([
		...run('first', 1, [['flaky', 'fallito']], { state: 'dirty', content: 'T' }),
		...run('second', 2, [['flaky', 'superato']], { state: 'committed', content: 'T' }),
	], { now: NOW, state: 'committed', content: 'T' });
	assert.deepEqual(twoCommits.unstable.map((item: { key: string }) => item.key), ['app · flaky']);
	assert.deepEqual(twoCommits.runs.map((item: { info: { state: string } }) => item.info.state), ['dirty', 'committed'], 'no deduplication');
});

test('older lines without content keep their Git-state semantics and are never promoted by a new content', () => {
	const legacy = [
		...run('legacy', 1, [['probe', 'superato']], { state: 'aaa' }),
		...manualRun('legacy-complete', 2, { type: 'complete', scenarios: 'all', status: 'passed' }, 'aaa'),
	];
	const sameState = analyze(legacy, { now: NOW, state: 'aaa', content: 'T' });
	assert.equal(sameState.runs[0].comparability, 'current', 'the same state is still the same code');
	assert.equal(sameState.currentCompleteManualCheck?.run.id, 'legacy-complete');
	const otherState = analyze(legacy, { now: NOW, state: 'bbb', content: 'T' });
	assert.equal(otherState.runs[0].comparability, 'historical');
	assert.ok(otherState.suitesWithoutCompleteCurrentRun.includes('app'));
	assert.equal(otherState.currentCompleteManualCheck, undefined);
	assert.equal(otherState.latestHistoricalCompleteManualCheck?.run.id, 'legacy-complete');
	// Read as before when the caller knows only the state.
	assert.equal(analyze(legacy, { now: NOW, state: 'aaa' }).runs[0].comparability, 'current');
	// An older line and a new one are not grouped as the same conditions.
	const mixed = analyze([
		...run('legacy-fail', 1, [['flaky', 'fallito']], { state: 'aaa' }),
		...run('new-pass', 2, [['flaky', 'superato']], { state: 'aaa', content: 'T' }),
	], { now: NOW, state: 'aaa', content: 'T' });
	assert.deepEqual(mixed.unstable, []);
});

test('an uncaught exception without stack or location just after a secondary window closed is external, reviewed, never by its text', () => {
	const observed = { event: 'pageerror', where: '', stack: '', sinceSecondaryClose: 30 };
	assert.equal(windowTeardownError(observed), true);
	assert.equal(consoleSource(observed), 'external', 'A: the case observed');
	assert.equal(consoleSource({ ...observed, stack: 'Error: illegal access' }), 'external', 'a message line alone is no stack');
	// The text plays no part: another message with the same structure is the same case.
	assert.equal(windowTeardownError({ ...observed, stack: 'Error: something else' }), true);

	const notTeardown = {
		'B: before any close': { ...observed, sinceSecondaryClose: undefined },
		'B: before this close (negative)': { ...observed, sinceSecondaryClose: -5 },
		'past the window': { ...observed, sinceSecondaryClose: TEARDOWN_WINDOW_MS + 1 },
		'C: with a stack frame': { ...observed, stack: 'Error: illegal access\n    at closing (<anonymous>)' },
		'D: with a location': { ...observed, where: 'app://obsidian.md/app.js' },
		'D: with a location in the stack': { ...observed, stack: 'Error: illegal access (app://obsidian.md/app.js:1:2)' },
		'F: a console message, not an uncaught exception': { ...observed, event: 'console' },
	};
	for (const [name, evidence] of Object.entries(notTeardown)) assert.equal(windowTeardownError(evidence), false, name);
	assert.equal(consoleSource(notTeardown['B: before any close']), 'uncertain');
	assert.equal(consoleSource(notTeardown['C: with a stack frame']), 'uncertain');
	assert.equal(consoleSource(notTeardown['F: a console message, not an uncaught exception']), 'uncertain');
	assert.equal(consoleSource(notTeardown['D: with a location']), 'external', 'external by its location, as before: still blocking');
	// E: a plugin frame wins over the teardown rule.
	assert.equal(consoleSource({ ...observed, frames: ['src/rendering/row-widget.ts:89'] }), 'plugin');

	const text = 'illegal access';
	const teardown = { source: 'external', text, test: 'finestra separata', frames: [], teardown: true };
	const reviewed = consoleOutcome([teardown], []);
	assert.equal(reviewed.state, 'passed-with-review-warnings');
	assert.deepEqual(reviewed.blocking, []);
	assert.deepEqual(reviewed.reviewErrors, [teardown]);
	assert.equal(consoleReviewLabel(reviewed), '⚠ 1 errori esterni di chiusura di una finestra da revisionare');
	// Every other error keeps blocking: uncertain, plugin, external without the teardown evidence.
	for (const source of ['uncertain', 'plugin', 'external']) {
		const error = { source, text, test: 'finestra separata', frames: [] };
		assert.equal(consoleOutcome([error], []).state, 'failed-error', source);
		assert.deepEqual(consoleOutcome([teardown, error], []).blocking, [error], `${source} next to a teardown error`);
	}
	assert.equal(consoleOutcome([{ ...teardown, source: 'uncertain' }], []).state, 'failed-error', 'the mark alone changes nothing');

	// The registry reads the same mark from its console lines.
	const analyzed = analyze([
		...run('teardown', 1, [['probe', 'superato']]),
		{ time: at(1), kind: 'console', run: 'teardown', suite: 'app', level: 'error', source: 'external', test: 'probe', text, teardown: true, sinceSecondaryClose: 30 },
	], { now: NOW, state: 'aaa' }).runs[0];
	assert.equal(analyzed.consoleOutcome.state, 'passed-with-review-warnings');
});
