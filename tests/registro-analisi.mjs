// What the registry's lines mean (tests/registro.mjs), with no printing:
// tests/registro-riepilogo.mjs prints it, tests/registro.test.ts checks it.
// Missing or ambiguous data never becomes a firm conclusion: a run with no end
// is not green, results without a code identity do not prove instability,
// and failures many tests share are shown as such, never hidden.
import { manualCheckProblem, UNKNOWN } from './registro.mjs';
import { consoleOutcome } from './console-policy.mjs';

// A run's last line older than this, with no end: interrupted, not running.
export const RUNNING_FOR = 10 * 60000;
export const EXPECTED_TEST_SUITES = ['node', 'chromium', 'chromium-righe', 'app'];

// The registry's files, [{ name, text }] -> entries, and the lines that could
// not be read (a crash cut them), by file and line number.
export function parseRegistry(files) {
	const entries = [], unreadable = [];
	for (const { name, text } of files) {
		text.split('\n').forEach((line, index) => {
			if (!line.trim()) return;
			try {
				const entry = JSON.parse(line);
				if (entry && typeof entry === 'object' && typeof entry.time === 'string') entries.push(entry);
				else unreadable.push({ file: name, line: index + 1 });
			} catch { unreadable.push({ file: name, line: index + 1 }); }
		});
	}
	return { entries, unreadable };
}

const known = state => Boolean(state) && state !== UNKNOWN;

// Whether two observations are of the same code ({ state, content } of their
// `run` lines, or of now). The content of the working tree decides when both
// have it, so a commit of the same files keeps a verification current. A line
// without it (before 2026-09-30, or git could not say) is compared by its Git
// state, as before: the same state is the same code, and a different one is
// never assumed equal, even when the content happens to be.
export function sameCode(a, b) {
	if (known(a?.content) && known(b?.content)) return a.content === b.content;
	return known(a?.state) && known(b?.state) && a.state === b.state;
}

// The code as a grouping key: the content when known, otherwise the Git state.
// Older lines therefore group only among themselves (conservative: a pair
// sameCode would accept through the state is not grouped).
export const codeKey = info => known(info?.content) ? `content:${info.content}` : known(info?.state) ? `state:${info.state}` : undefined;

const testSuite = run => !run.commands.length && !run.checks.length && !run.manualChecks.length && !run.coverage
	&& !run.suite.startsWith('comando:') && run.suite !== 'windows' && run.suite !== 'copertura' && run.suite !== 'manual';

// The environment in which individual test outcomes can be compared. Code
// identity is deliberately separate: the same environment key is useful on
// successive code identities. A missing required value leaves the environment
// unidentified instead of making two incomplete descriptions look equal.
export function environmentOf(run) {
	const info = run.info ?? {}, env = run.environment ?? {};
	const common = [run.suite, Boolean(info.coverage), info.platform, info.node];
	if (!info.platform || !info.node) return undefined;
	if (run.suite === 'app') return env.obsidian && env.build && env.mainHash ? JSON.stringify([...common, env.obsidian, env.build, env.mainHash]) : undefined;
	if (run.suite === 'chromium' || run.suite === 'chromium-righe') return env.chromium && env.build ? JSON.stringify([...common, env.chromium, env.build]) : undefined;
	return JSON.stringify(common);
}

// Stable enough to follow observations over successive code identities.
// The real app's mainHash remains on each observation, but is code/build
// evidence rather than an environment boundary for this temporal history.
export function historyEnvironmentOf(run) {
	const info = run.info ?? {}, env = run.environment ?? {};
	const common = [run.suite, Boolean(info.coverage), info.platform, info.node];
	if (!info.platform || !info.node) return undefined;
	if (run.suite === 'app') return env.obsidian && env.build ? JSON.stringify([...common, env.obsidian, env.build]) : undefined;
	if (run.suite === 'chromium' || run.suite === 'chromium-righe') return env.chromium && env.build ? JSON.stringify([...common, env.chromium, env.build]) : undefined;
	return JSON.stringify(common);
}

const consoleSignature = (run, entry) => {
	const text = String(entry.text ?? '').split('\n')[0].slice(0, 160).replace(/\d+/g, 'N');
	return { key: `${entry.level}|${run.suite}|${entry.source}|${text}`, text };
};

// The conditions a run ran in, beside its code: two runs compare only when
// both are the same (suite, code, build, app and browser versions, platform).
export function conditionsOf(run) {
	const environment = environmentOf(run);
	const code = codeKey(run.info);
	return code && environment ? JSON.stringify([code, environment]) : undefined;
}

/**
 * @param {any[]} entries the registry's entries (parseRegistry)
 * @param {{ now?: number, state?: string, content?: string, only?: string }} [options] now; the Git state and the content of the
 *   code of now (codeState); a text the test names must hold
 */
export function analyze(entries, { now = Date.now(), state, content, only } = {}) {
	const matches = test => !only || String(test ?? '').toLowerCase().includes(only.toLowerCase());
	// The code of now: identified when either is known; a run is current when it observed the same code.
	const code = { state, content };
	const codeKnown = known(content) || known(state);
	const isCurrent = run => codeKnown && sameCode(run.info, code);
	const runs = new Map();
	const runOf = entry => {
		// Lines before 2026-09-28 have no `run` line and no suite: the real app's.
		const id = entry.run ?? `senza-esecuzione-${entry.time.slice(0, 13)}`;
		let run = runs.get(id);
		if (!run) runs.set(id, run = { id, time: entry.time, last: entry.time, suite: entry.suite ?? 'app', info: undefined, environment: undefined,
			results: [], console: [], screenshots: [], checks: [], manualChecks: [], commands: [], coverage: undefined, end: undefined });
		if (entry.time > run.last) run.last = entry.time;
		return run;
	};
	for (const entry of entries) {
		const run = runOf(entry);
		if (entry.kind === 'run') { run.info = entry; run.time = entry.time; run.suite = entry.suite; }
		else if (entry.kind === 'environment' || entry.kind === 'app') run.environment = { ...run.environment, ...entry };
		else if (entry.kind === 'result') run.results.push(entry);
		else if (entry.kind === 'console') run.console.push(entry);
		else if (entry.kind === 'screenshot') run.screenshots.push(entry);
		else if (entry.kind === 'check') run.checks.push(entry);
		else if (entry.kind === 'manual-check') run.manualChecks.push({ ...entry, problem: manualCheckProblem(entry) });
		else if (entry.kind === 'command') run.commands.push(entry);
		else if (entry.kind === 'coverage') run.coverage = entry;
		else if (entry.kind === 'end') run.end = entry;
	}
	const ordered = [...runs.values()].sort((a, b) => a.time.localeCompare(b.time));

	// Each run's outcome, only from what it recorded.
	for (const run of ordered) {
		run.resultCount = run.results.length;
		run.passedCount = run.results.filter(result => result.result === 'superato').length;
		run.failedCount = run.results.filter(result => result.result === 'fallito').length;
		run.skippedCount = run.results.filter(result => result.result === 'saltato').length;
		run.consoleOutcome = consoleOutcome(run.console.filter(entry => entry.level === 'error'), run.console.filter(entry => entry.level === 'warning'));
		const failed = run.failedCount;
		const finished = run.end ?? run.checks.at(-1) ?? run.manualChecks.at(-1) ?? run.commands.at(-1) ?? run.coverage;
		// Without an end, a run is interrupted once silent for RUNNING_FOR, or
		// once a later run of its suite started (a suite never runs twice at once).
		const later = ordered.some(other => other.suite === run.suite && other.time > run.time && other.info);
		if (!run.info) run.completion = 'undetermined';
		else if (run.end?.interrupted || run.commands.at(-1)?.interrupted || run.commands.at(-1)?.status === 'interrupted') run.completion = 'interrupted';
		else if (!finished) run.completion = later || now - Date.parse(run.last) >= RUNNING_FOR ? 'interrupted' : 'running';
		else run.completion = 'completed';
		run.filtered = Boolean(run.info?.filter?.length);
		run.totalsConsistent = Boolean(run.end) && ['superato', 'fallito', 'saltato'].every(key => Number.isInteger(run.end[key]))
			&& run.end.superato === run.passedCount && run.end.fallito === run.failedCount && run.end.saltato === run.skippedCount;
		if (!testSuite(run)) run.scope = 'not-applicable';
		else if (run.completion === 'running' || run.completion === 'interrupted') run.scope = 'incomplete';
		else if (run.completion !== 'completed') run.scope = 'unknown';
		else if (!run.resultCount) run.scope = 'empty';
		else if (run.filtered) run.scope = 'filtered';
		else if (!run.totalsConsistent) run.scope = 'partial';
		else run.scope = 'full';
		run.environmentKey = environmentOf(run);
		run.historyEnvironmentKey = historyEnvironmentOf(run);
		if (!codeKey(run.info)) run.comparability = 'unidentified-code';
		else if (codeKnown && !isCurrent(run)) run.comparability = 'historical';
		else if (testSuite(run) && !run.environmentKey) run.comparability = 'unidentified-environment';
		else run.comparability = codeKnown ? 'current' : 'historical';

		if (!run.info) run.status = 'non determinabile';
		else if (run.completion === 'interrupted') run.status = 'interrotta';
		else if (run.completion === 'running') run.status = 'in corso';
		else if (run.checks.length) run.status = run.checks.every(check => check.ok) ? 'superata' : 'fallita';
		else if (run.manualChecks.length) run.status = run.manualChecks.at(-1).problem ? 'non determinabile' : run.manualChecks.at(-1).status;
		else if (run.commands.length) run.status = run.commands.at(-1).ok ? 'superata' : 'fallita';
		else if (run.coverage) run.status = run.coverage.failedSuites?.length ? 'fallita' : 'superata';
		else if (failed || (run.end.fallito ?? 0) > 0) run.status = 'fallita';
		else if (!run.results.length) run.status = 'fallita (nessun test eseguito)';
		else run.status = 'superata';
		run.conditions = conditionsOf(run);
		// Correlated: at least half of its tests failed, 5 or more. A cause they
		// share (the environment, or one regression): to look at as a whole.
		run.correlated = failed >= 5 && failed * 2 >= run.results.length;
	}

	// Results by test, and by test and conditions.
	const byTest = new Map();
	for (const run of ordered) for (const result of run.results) {
		if (!matches(result.test) || result.result === 'saltato') continue;
		const key = `${run.suite} · ${result.test}`;
		const list = byTest.get(key) ?? [];
		list.push({ ...result, run });
		byTest.set(key, list);
	}
	const unstable = [], discordant = [], latestCurrentResults = [];
	for (const [key, list] of [...byTest].sort()) {
		// Unstable: passed and failed with the same code in the same conditions,
		// in runs whose failures are not shared by half the suite.
		const groups = new Map();
		for (const result of list) if (result.run.conditions && !result.run.correlated) {
			const outcomes = groups.get(result.run.conditions) ?? new Set();
			outcomes.add(result.result);
			groups.set(result.run.conditions, outcomes);
		}
		const mixed = [...groups.values()].filter(outcomes => outcomes.size > 1).length;
		const failures = list.filter(result => result.result === 'fallito');
		if (mixed) unstable.push({ key, conditions: mixed, failures: failures.length, total: list.length, last: failures.at(-1) });
		// Without a code identity a failure then a pass may be a fix: only discordant.
		const unidentified = list.filter(result => !codeKey(result.run.info));
		if (unidentified.some(result => result.result === 'fallito') && unidentified.some(result => result.result === 'superato')) {
			discordant.push({ key, failures: unidentified.filter(result => result.result === 'fallito').length, total: unidentified.length,
				last: unidentified.filter(result => result.result === 'fallito').at(-1) });
		}
		// Last outcome on the current code, separately for every identified
		// environment. Unidentified environments stay in the separate,
		// non-comparable runs instead of becoming a current judgement.
		if (codeKnown) {
			const current = list.filter(result => isCurrent(result.run) && result.run.environmentKey);
			const environments = new Map();
			for (const result of current) environments.set(result.run.environmentKey, result);
			for (const result of environments.values()) latestCurrentResults.push({ key, result, correlated: result.run.correlated,
				environmentKey: result.run.environmentKey });
		}
	}
	const brokenNow = latestCurrentResults.filter(item => item.result.result === 'fallito');

	const failures = ordered.flatMap(run => run.results.filter(result => result.result === 'fallito' && matches(result.test))
		.map(result => ({ run, result, screenshot: run.screenshots.find(entry => entry.test === result.test) })));

	// Console messages by level, suite, source and first line (numbers made neutral).
	const groups = new Map();
	for (const run of ordered) for (const entry of run.console) {
		if (!matches(entry.test)) continue;
		const { key, text } = consoleSignature(run, entry);
		const group = groups.get(key) ?? { level: entry.level, suite: run.suite, source: entry.source, text, count: 0, runs: new Set(), tests: new Set(), last: entry.time, frames: entry.frames };
		group.count++;
		group.runs.add(run.id);
		if (entry.test) group.tests.add(entry.test);
		group.last = entry.time;
		group.frames ??= entry.frames;
		groups.set(key, group);
	}
	const consoleGroups = [...groups.values()].sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1) || b.count - a.count);

	// Temporal histories cross code identities, but never environment
	// boundaries. Only actual, completed test results are observations.
	const histories = new Map();
	for (const run of ordered) {
		if (!codeKey(run.info) || !run.historyEnvironmentKey) continue;
		const lastByTest = new Map();
		for (const result of run.results) if (result.result === 'superato' || result.result === 'fallito') lastByTest.set(result.test, result);
		for (const [test, result] of lastByTest) {
			const key = `${run.suite} · ${test}`;
			const historyKey = JSON.stringify([run.suite, test, run.historyEnvironmentKey]);
			const history = histories.get(historyKey) ?? { key, suite: run.suite, test, historyEnvironmentKey: run.historyEnvironmentKey,
				environment: run.environment, observations: [] };
			history.observations.push({ time: result.time ?? run.time, outcome: result.result, run, result, code: codeKey(run.info),
				scope: run.scope, completion: run.completion, mainHash: run.environment?.mainHash });
			histories.set(historyKey, history);
		}
	}
	const testHistories = [...histories.values()].map(history => {
		history.observations.sort((a, b) => a.time.localeCompare(b.time));
		const failures = history.observations.filter(item => item.outcome === 'fallito');
		const firstFailure = failures[0];
		const lastFailure = failures.at(-1);
		const previousPass = firstFailure ? history.observations.filter(item => item.outcome === 'superato' && item.time < firstFailure.time).at(-1) : undefined;
		const firstPassAfterLastFailure = lastFailure ? history.observations.find(item => item.outcome === 'superato' && item.time > lastFailure.time) : undefined;
		const latestObservation = history.observations.at(-1);
		const current = codeKnown ? history.observations.filter(item => isCurrent(item.run)).at(-1) : undefined;
		return { ...history, comparableRunCount: new Set(history.observations.map(item => item.run.id)).size, firstFailure, previousPass,
			lastFailure, firstPassAfterLastFailure, latestObservation, latestStatus: latestObservation?.outcome === 'fallito' ? 'failing' : 'passing',
			currentCodeObservation: current,
			currentCodeStatus: !codeKnown ? 'not-comparable' : current ? current.outcome === 'fallito' ? 'failing' : 'passing' : 'not-observed' };
	}).sort((a, b) => (a.lastFailure?.time ?? '').localeCompare(b.lastFailure?.time ?? ''));

	// Console history intentionally keeps today's coarse signature. Presence is
	// direct evidence; absence requires a later full run in the same environment.
	const consoleHistoryMap = new Map();
	for (const run of ordered) {
		if (!run.historyEnvironmentKey) continue;
		for (const entry of run.console) {
			const signature = consoleSignature(run, entry);
			const historyKey = JSON.stringify([signature.key, run.historyEnvironmentKey]);
			const history = consoleHistoryMap.get(historyKey) ?? { signature: signature.key, level: entry.level, suite: run.suite,
				source: entry.source, text: signature.text, historyEnvironmentKey: run.historyEnvironmentKey, environment: run.environment, occurrences: [] };
			history.occurrences.push({ time: entry.time ?? run.time, entry, run, code: codeKey(run.info) });
			consoleHistoryMap.set(historyKey, history);
		}
	}
	const consoleHistories = [...consoleHistoryMap.values()].map(history => {
		history.occurrences.sort((a, b) => a.time.localeCompare(b.time));
		const firstOccurrence = history.occurrences[0], lastOccurrence = history.occurrences.at(-1);
		const eligibleRuns = ordered.filter(run => run.suite === history.suite && run.historyEnvironmentKey === history.historyEnvironmentKey
			&& codeKey(run.info) && run.scope === 'full');
		const hasSignature = run => run.console.some(entry => consoleSignature(run, entry).key === history.signature);
		const firstComparableRunWithoutMessageAfterLastOccurrence = eligibleRuns.find(run => run.time > lastOccurrence.time && !hasSignature(run));
		const exposures = [...history.occurrences.map(item => ({ time: item.time, status: 'observed', run: item.run })),
			...eligibleRuns.filter(run => !hasSignature(run)).map(run => ({ time: run.time, status: 'not-observed', run }))]
			.sort((a, b) => a.time.localeCompare(b.time));
		const currentOccurrences = codeKnown ? history.occurrences.filter(item => isCurrent(item.run)) : [];
		const currentFullRuns = codeKnown ? eligibleRuns.filter(isCurrent) : [];
		const currentExposures = [...currentOccurrences.map(item => ({ time: item.time, status: 'observed', run: item.run })),
			...currentFullRuns.filter(run => !hasSignature(run)).map(run => ({ time: run.time, status: 'not-observed', run }))]
			.sort((a, b) => a.time.localeCompare(b.time));
		return { ...history, firstOccurrence, lastOccurrence, occurrenceCount: history.occurrences.length,
			runCount: new Set(history.occurrences.map(item => item.run.id)).size,
			tests: new Set(history.occurrences.map(item => item.entry.test).filter(Boolean)),
			codes: new Set(history.occurrences.map(item => item.code).filter(Boolean)),
			firstComparableRunWithoutMessageAfterLastOccurrence, latestExposure: exposures.at(-1),
			latestExposureStatus: exposures.at(-1)?.status ?? 'unknown', currentCodeExposure: currentExposures.at(-1),
			currentCodeStatus: currentExposures.at(-1)?.status ?? (codeKnown ? 'not-verified' : 'not-comparable') };
	}).sort((a, b) => a.lastOccurrence.time.localeCompare(b.lastOccurrence.time));
	const currentTestProblems = testHistories.filter(history => history.firstFailure && history.currentCodeStatus === 'failing');
	const currentConsoleProblems = consoleHistories.filter(history => history.currentCodeStatus === 'observed');

	const latestComplete = new Map();
	for (const run of ordered) if (run.scope === 'full' && run.comparability === 'current') latestComplete.set(run.environmentKey, run);
	const completeCurrentRuns = [...latestComplete.values()];
	const suitesWithoutCompleteCurrentRun = EXPECTED_TEST_SUITES.filter(suite =>
		!completeCurrentRuns.some(run => run.suite === suite && !run.info?.coverage));
	const latestCommandRuns = new Map();
	for (const run of ordered) if (run.suite.startsWith('comando:')) latestCommandRuns.set(run.suite.slice('comando:'.length), run);
	const manualChecks = ordered.flatMap(run => run.manualChecks.filter(check => !check.problem).map(check => ({ run, check })));
	const currentManualChecks = manualChecks.filter(item => isCurrent(item.run));
	const historicalManualChecks = manualChecks.filter(item => !isCurrent(item.run));
	const currentCompleteManualCheck = currentManualChecks.filter(item => item.check.type === 'complete').at(-1);
	const latestHistoricalCompleteManualCheck = historicalManualChecks.filter(item => item.check.type === 'complete').at(-1);
	const latestTargetedByScenarios = new Map();
	for (const item of currentManualChecks.filter(item => item.check.type === 'targeted')) {
		const key = [...item.check.scenarios].sort().join('\0');
		latestTargetedByScenarios.set(key, item);
	}
	// A complete observation is already printed in the complete slot; retain all
	// targeted issues in addition to the latest observation of each target set.
	const currentManualIssues = currentManualChecks.filter(item => item.check.type === 'targeted' && item.check.status === 'issue-observed');
	return { runs: ordered, unstable, discordant, brokenNow, latestCurrentResults, completeCurrentRuns,
		partialCurrentRuns: ordered.filter(run => testSuite(run) && run.comparability === 'current' && run.scope !== 'full'),
		nonComparableRuns: ordered.filter(run => testSuite(run) && ['unidentified-code', 'unidentified-environment'].includes(run.comparability)),
		currentNonComparableRuns: ordered.filter(run => testSuite(run) && isCurrent(run) && run.comparability === 'unidentified-environment'),
		suitesWithoutCompleteCurrentRun, correlated: ordered.filter(run => run.correlated), failures, consoleGroups, testHistories, consoleHistories,
		currentTestProblems, currentConsoleProblems,
		commands: ordered.flatMap(run => run.commands.map(command => ({ run, command }))),
		latestCommandRuns,
		coverage: ordered.filter(run => run.coverage), checks: ordered.flatMap(run => run.checks.filter(check => matches(check.name)).map(check => ({ run, check }))),
		manualChecks, currentManualChecks, historicalManualChecks, currentCompleteManualCheck, latestHistoricalCompleteManualCheck,
		latestCurrentTargetedManualChecks: [...latestTargetedByScenarios.values()], currentManualIssues };
}
