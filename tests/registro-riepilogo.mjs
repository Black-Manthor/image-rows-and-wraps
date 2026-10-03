// What the registry says (tests/registro.mjs, read by tests/registro-analisi.mjs),
// without scripts made on the spot: the last runs, their outcome and the code
// and conditions they tested; failures on the code of now; failures many tests
// share; unstable tests; the last failures with why and where; console errors
// and warnings grouped; the coverage over time; automatic external checks and
// manual observations.
//
//   npm run registro                     the last 7 days
//   npm run registro -- --giorni 30      a longer period
//   npm run registro -- --test "wrap a"  only the tests whose name holds that text
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze, parseRegistry } from './registro-analisi.mjs';
import { consoleReviewLabel } from './console-policy.mjs';
import { codeState, registry, UNKNOWN } from './registro.mjs';

const option = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const days = Number(option('--giorni') ?? 7);
const only = option('--test');
const historyView = process.argv.includes('--storia');
const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

const files = existsSync(registry) ? readdirSync(registry).filter(file => file.endsWith('.jsonl') && file.slice(0, 10) >= since).sort()
	.map(name => ({ name, text: readFileSync(join(registry, name), 'utf8') })) : [];
const { entries, unreadable } = parseRegistry(files);
if (!entries.length) { console.log(`Registro vuoto negli ultimi ${days} giorni (${registry}).`); process.exit(0); }
const now = codeState();
const report = analyze(entries, { state: now.state, content: now.content, only });

// --- Formatting --------------------------------------------------------------
// Local time; the date only when not today.
const day = date => `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = day(new Date());
const when = time => { const local = new Date(time); const hm = local.toTimeString().slice(0, 5); return day(local) === today ? hm : `${day(local)} ${hm}`; };
// The code a line observed: its content when known (older lines: the Git state), shortened.
const identity = info => info?.content && info.content !== UNKNOWN ? info.content.slice(0, 10) : info?.state ?? '(codice non identificato)';
const code = info => info ? `${info.commit}${info.changedCount ? `+${info.changedCount}` : ''} ${identity(info)}` : '(codice non identificato)';
const firstLine = text => String(text ?? '').split('\n')[0].slice(0, 160);
const title = text => console.log(`\n▸ ${text}\n`);
const none = list => { if (!list.length) console.log('Nessuno.'); };
const manualMark = { passed: '✔', 'issue-observed': '⚠', 'not-completable': '⚠' };
const manualType = check => check.type === 'complete' ? 'completa' : `mirata: ${check.scenarios.join(', ').replaceAll('-', ' ')}`;
const manualLine = ({ run, check }, withCode = false) => {
	console.log(`${manualMark[check.status]} ${manualType(check)}${withCode ? `  ${identity(run.info)}` : ''}`);
	if (check.status === 'issue-observed') console.log(`    problema osservato: ${firstLine(check.note)}`);
	if (check.status === 'not-completable') console.log(`    non completabile: ${firstLine(check.note)}`);
	if (check.status === 'passed' && check.note) console.log(`    nota: ${firstLine(check.note)}`);
	if (check.screenshot) console.log(`    schermata: ${check.screenshot}`);
};

console.log(`Registro ${registry}, periodo caricato dal ${since} a oggi (${days} giorni): ${report.runs.length} esecuzioni.`);
console.log(`Codice di adesso: ${now.commit}${now.changedCount ? ` con ${now.changedCount} file cambiati` : ''}, contenuto ${now.content === UNKNOWN ? UNKNOWN : now.content.slice(0, 10)}, stato ${now.state} (ramo ${now.branch}).`);
console.log('(Contenuto: i file non ignorati dell\'albero di lavoro, che un commit degli stessi file non cambia; stato: commit più modifiche non salvate. Corrente è ciò che è stato osservato sullo stesso contenuto (le righe più vecchie, senza contenuto, sullo stesso stato). Due esecuzioni si confrontano solo con lo stesso codice e le stesse condizioni: build, Obsidian o Chromium, piattaforma.)');
if (only) console.log(`Vista filtrata del report: test contenente «${only}». La completezza originale delle run non cambia.`);
if (unreadable.length) {
	console.log(`\n✖ ${unreadable.length} righe del registro illeggibili (lasciate fuori): ${unreadable.slice(0, 5).map(item => `${item.file}:${item.line}`).join(', ')}${unreadable.length > 5 ? '…' : ''}`);
}

const environment = run => {
	const env = run.environment ?? {};
	return [run.info?.coverage ? 'coverage' : '', env.obsidian ? `Obsidian ${env.obsidian}` : '', env.chromium ? `Chromium ${env.chromium}` : '',
		run.info?.platform ?? '', run.info?.node ? `Node ${run.info.node.replace(/^v/, '')}` : ''].filter(Boolean).join(', ');
};
const counts = run => `✔ ${run.passedCount}${run.failedCount ? ` ✖ ${run.failedCount}` : ''}${run.skippedCount ? ` ↷ ${run.skippedCount}` : ''}`;
const consoleNote = run => consoleReviewLabel(run.consoleOutcome) ? ` · ${consoleReviewLabel(run.consoleOutcome)}` : '';
const mark = { superata: '✔', fallita: '✖', 'fallita (nessun test eseguito)': '✖', interrotta: '⚠', 'in corso': '…', 'non determinabile': '?' };

// --- Build, API compatibility and lint ---------------------------------------
title('Build, compatibilità API latest e lint');
for (const name of ['build', 'check:latest', 'lint']) {
	const run = report.latestCommandRuns.get(name);
	if (!run) { console.log(`${name}: mai avviato nel periodo.`); continue; }
	const command = run.commands.at(-1);
	if (!command) {
		const outcome = run.status === 'in corso' ? 'in corso' : run.status === 'interrotta' ? 'interrotto senza record terminale' : 'stato non determinabile';
		console.log(`${name}: ${outcome}, avviato ${when(run.time)}  [${code(run.info)}]`);
		continue;
	}
	const outcome = command.ok ? 'superato' : command.status === 'interrupted' ? `interrotto (${command.signal ?? 'segnale non disponibile'})` : `fallito (uscita ${command.exitCode ?? '?'})`;
	console.log(`${name}: ${outcome}, fase ${command.phase}, ${command.ms} ms, ultimo ${when(command.time)}  [${code(run.info)}]${command.diagnostic ? `\n    ${firstLine(command.diagnostic)}` : ''}`);
}

title('Ultime run complete sul codice corrente');
for (const run of report.completeCurrentRuns) {
	console.log(`${mark[run.status]} ${when(run.time).padEnd(11)} ${run.suite.padEnd(14)} ${run.status.padEnd(8)} ${counts(run)}${consoleNote(run)}  (${environment(run)})`);
}
none(report.completeCurrentRuns);
for (const suite of report.suitesWithoutCompleteCurrentRun) console.log(`⚠ ${suite}: nessuna run completa disponibile sul codice corrente.`);

title('Run parziali o filtrate recenti sul codice corrente');
for (const run of report.partialCurrentRuns.slice(-10)) {
	let description;
	if (run.scope === 'filtered') description = 'filtrata';
	else if (run.scope === 'empty') description = 'terminata senza eseguire test';
	else if (run.scope === 'partial') description = 'terminata, dati incompleti';
	else if (run.completion === 'interrupted') description = `interrotta${run.end?.interrupted ? ` (${run.end.interrupted})` : ''}`;
	else description = run.completion === 'running' ? 'in corso' : 'completezza non determinabile';
	const filter = run.filtered ? ` · filtro «${run.info.filter.join(', ')}»` : '';
	console.log(`${mark[run.status] ?? '?'} ${when(run.time).padEnd(11)} ${run.suite.padEnd(14)} ${description} · ${counts(run)}${filter}${consoleNote(run)}  (${environment(run)})`);
}
none(report.partialCurrentRuns);

title('Ultimo esito noto dei test sul codice corrente');
const latestByEnvironment = new Map();
for (const item of report.latestCurrentResults) {
	const key = item.environmentKey ?? `non identificato:${item.result.run.id}`;
	const group = latestByEnvironment.get(key) ?? { run: item.result.run, passed: 0, failed: 0 };
	group[item.result.result === 'superato' ? 'passed' : 'failed']++;
	latestByEnvironment.set(key, group);
}
for (const group of latestByEnvironment.values()) {
	console.log(`${group.run.suite} · ${environment(group.run)}: ${group.passed} superati, ${group.failed} falliti (ultime osservazioni dei singoli test).`);
}
const failingKeys = new Set(report.latestCurrentResults.filter(item => item.result.result === 'fallito').map(item => item.key));
const latestRelevant = report.latestCurrentResults.filter(item => failingKeys.has(item.key));
if (latestRelevant.length) console.log(`${latestRelevant.filter(item => item.result.result === 'fallito').length} ultimi esiti falliti; cronologia nella sezione seguente.`);
if (!latestRelevant.length) console.log('Nessun ultimo esito fallito noto negli ambienti identificati.');

// --- Temporal history -------------------------------------------------------
title(historyView ? 'Storia dei problemi nel periodo disponibile' : 'Problemi attuali e loro storia');
const historyMatches = history => !only || history.test?.toLowerCase().includes(only.toLowerCase())
	|| history.occurrences?.some(item => String(item.entry.test ?? '').toLowerCase().includes(only.toLowerCase()));
const testHistories = (historyView ? report.testHistories.filter(history => history.firstFailure) : report.currentTestProblems)
	.filter(historyMatches).slice(-20);
for (const history of testHistories) {
	const latest = historyView ? history.latestObservation : history.currentCodeObservation;
	const latestStatus = latest?.outcome === 'fallito' ? 'failing' : 'passing';
	console.log(`${latestStatus === 'failing' ? '✖' : '✔'} ${history.key} · ${environment(latest.run)}`);
	console.log(`    prima failure osservata nel periodo: ${when(history.firstFailure.time)}`);
	console.log(`    ${history.previousPass ? `ultimo passaggio noto precedente: ${when(history.previousPass.time)}` : 'nessun passaggio precedente disponibile'}`);
	console.log(`    ultimo fallimento osservato: ${when(history.lastFailure.time)}`);
	if (history.firstPassAfterLastFailure) console.log(`    prima esecuzione successiva superata: ${when(history.firstPassAfterLastFailure.time)}`);
	console.log(`    ultima osservazione${historyView ? '' : ' sul codice corrente'}: ${latestStatus === 'failing' ? 'fallita' : 'superata'} · ${history.comparableRunCount} run comparabili`);
}
const consoleHistories = (historyView ? report.consoleHistories : report.currentConsoleProblems)
	.filter(historyMatches).slice(-20);
for (const history of consoleHistories) {
	const observed = history.latestExposureStatus === 'observed';
	console.log(`${history.level === 'error' ? '✖ errore' : '⚠ avviso'} · ${history.suite} · ${history.source} · ${history.text}`);
	console.log(`    ${history.occurrenceCount} occorrenze in ${history.runCount} run, ${history.tests.size} test; prima osservata nel periodo: ${when(history.firstOccurrence.time)}; ultima: ${when(history.lastOccurrence.time)}`);
	if (history.firstComparableRunWithoutMessageAfterLastOccurrence) {
		console.log(`    prima run completa successiva senza questo messaggio: ${when(history.firstComparableRunWithoutMessageAfterLastOccurrence.time)}${observed ? ' (il messaggio è stato osservato di nuovo dopo)' : ''}`);
		if (!observed) console.log('    non più osservato nelle run complete comparabili disponibili');
	} else console.log('    nessuna run completa comparabile successiva disponibile');
	if (historyView && history.currentCodeStatus === 'not-verified') console.log('    non verificato sul codice corrente');
}
if (!testHistories.length && !consoleHistories.length) console.log('Nessun problema con storia confrontabile nella vista selezionata.');

const visibleNonComparable = historyView ? report.nonComparableRuns : report.currentNonComparableRuns;
if (visibleNonComparable.length) {
	title('Run non confrontabili recenti');
	for (const run of visibleNonComparable.slice(-10)) {
		const reason = run.comparability === 'unidentified-code' ? 'codice non identificato' : 'ambiente incompleto';
		console.log(`? ${when(run.time).padEnd(11)} ${run.suite.padEnd(14)} ${reason} · scope ${run.scope} · ${counts(run)}`);
	}
}

if (historyView) {
	title('Fallimenti correlati, causa da verificare (almeno metà dei test, 5 o più)');
	for (const run of report.correlated) {
		const failed = run.results.filter(result => result.result === 'fallito');
		const reasons = new Map();
		for (const result of failed) reasons.set(firstLine(result.error), (reasons.get(firstLine(result.error)) ?? 0) + 1);
		console.log(`${when(run.time)} ${run.suite} [${code(run.info)}]: ${failed.length} falliti su ${run.results.length}; ${[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([text, count]) => `${count}× ${text}`).join('; ')}`);
	}
	none(report.correlated);

	title('Test instabili (superati e falliti con lo stesso codice nelle stesse condizioni)');
	for (const item of report.unstable) console.log(`${item.key}\n    falliti ${item.failures} su ${item.total}, instabile in ${item.conditions} gruppi di condizioni; ultimo ${when(item.last.time)}: ${firstLine(item.last.error)}`);
	none(report.unstable);

	title('Esiti discordanti, codice non identificato (righe senza identità del codice: un difetto poi corretto, o un test instabile)');
	for (const item of report.discordant) console.log(`${item.key}: falliti ${item.failures} su ${item.total}; ultimo ${when(item.last.time)}: ${firstLine(item.last.error)}`);
	none(report.discordant);

	title('Ultimi fallimenti');
	for (const { run, result, screenshot } of report.failures.slice(-10)) {
		console.log(`${when(result.time)} ${run.suite} · ${result.test}  [${code(run.info)}]`);
		console.log(`    ${firstLine(result.error)}`);
		if (result.expected !== undefined) console.log(`    atteso ${String(result.expected).slice(0, 120)}  ottenuto ${String(result.actual).slice(0, 120)}`);
		if (result.frames?.length) console.log(`    dove: ${result.frames.slice(0, 4).join(' ← ')}`);
		if (screenshot) console.log(screenshot.missing ? `    schermata non disponibile: ${screenshot.reason}` : `    schermata: ${screenshot.path}`);
	}
	none(report.failures);
}

// --- Manual observations, coverage and automatic external checks ------------
title('Verifiche manuali');
if (historyView) {
	for (const item of report.manualChecks.slice(-20)) {
		process.stdout.write(`${when(item.check.time).padEnd(12)}`);
		manualLine(item, true);
	}
	if (!report.manualChecks.length) console.log('Nessuna verifica manuale registrata.');
} else {
	if (report.currentCompleteManualCheck) {
		manualLine(report.currentCompleteManualCheck);
		const { run, check } = report.currentCompleteManualCheck;
		console.log(`    ${run.environment?.obsidian ? `Obsidian ${run.environment.obsidian} · ` : ''}plugin ${run.environment?.loadedPlugin ?? run.info?.plugin ?? '?'} · ${when(check.time)}`);
	} else {
		console.log('◌ completa: non eseguita sul codice corrente');
		if (report.latestHistoricalCompleteManualCheck) {
			const item = report.latestHistoricalCompleteManualCheck;
			console.log(`    ultima completa: ${when(item.check.time)}, codice ${identity(item.run.info)} — storica`);
		}
	}
	const visible = new Set([...report.latestCurrentTargetedManualChecks, ...report.currentManualIssues]);
	for (const item of visible) manualLine(item);
}

if (report.coverage.length && !only) {
	title('Copertura (righe di codice eseguite)');
	for (const run of report.coverage.slice(historyView ? -5 : -1)) {
		const entry = run.coverage;
		console.log(`${when(entry.time).padEnd(11)} ${code(run.info).padEnd(21)} Node ${entry.Node} · Chromium ${entry.Chromium}${entry.App ? ` · App ${entry.App}` : ''} · insieme ${entry.together}${entry.failedSuites?.length ? `  (suite con errori: ${entry.failedSuites.join(', ')})` : ''}`);
		const files = Object.entries(entry.neverRun ?? {});
		if (historyView && files.length) console.log(`    mai eseguite: ${files.map(([file, lines]) => `${file} ${lines}`).join('; ')}`);
	}
}
if (report.checks.length) {
	title('Controlli automatici Windows');
	for (const { run, check } of report.checks.slice(historyView ? -10 : -5)) {
		console.log(`${check.ok ? '✔' : '✖'} ${when(check.time).padEnd(11)} ${check.name}  [${code(run.info)}]${check.plugin ? ` plugin ${check.plugin}` : ''}`);
		if (historyView) {
			for (const problem of check.problems ?? []) console.log(`    problema: ${problem}`);
			for (const [name, ok] of Object.entries(check.results ?? {})) if (ok !== true) console.log(`    ${name}: ${JSON.stringify(ok)}`);
			for (const line of (check.console ?? []).slice(0, 3)) console.log(`    console ${line}`);
			if (check.screenshot) console.log(`    schermata: ${check.screenshot}`);
		}
	}
}
