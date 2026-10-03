// The registry of every test run and check, of every suite: one JSON object
// per line, one file per day, never overwritten, so that a rare problem stays
// on record after clean runs. `npm run registro` summarizes it.
//
// Every run starts with a `run` line saying which code it tested: the commit
// and a fingerprint of the changes not committed yet (`state`, the Git
// identity), and the content of the working tree (`content`, whatever the
// commit), or «non disponibile» when git cannot say. An `environment` line
// then says in which conditions: the build run (its hash), Obsidian's or
// Chromium's version. Runs with the same content and the same conditions ran
// the very same thing: a test that passes and fails there is unstable (older
// lines, without `content`, are compared by `state`). Every later line
// carries the run's id; a run ends with an `end` line (or a `check`, a
// `command`, a `coverage`): without one it was interrupted. Kinds: run,
// environment, end, result, console, screenshot, coverage, check, command,
// manual-check.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segments } from './copertura-mappa.mjs';

const root = process.cwd();
// IW_REGISTRO: another folder (the registry's own tests), never the real one.
export const registry = resolve(process.env.IW_REGISTRO ?? join(root, '.obsidian-test', 'registro'));
export const registryFile = (date = new Date()) => resolve(registry, `${date.toISOString().slice(0, 10)}.jsonl`);

export const UNKNOWN = 'non disponibile';

export const MANUAL_CHECK_TYPES = ['targeted', 'complete'];
export const MANUAL_CHECK_STATUSES = ['passed', 'issue-observed', 'not-completable'];

// A manual observation is deliberately not a test result. Return the first
// schema problem, or undefined when the record is valid.
export function manualCheckProblem(entry) {
	if (!MANUAL_CHECK_TYPES.includes(entry?.type)) return 'tipo non valido';
	if (!MANUAL_CHECK_STATUSES.includes(entry?.status)) return 'esito non valido';
	if (entry.type === 'complete' && entry.scenarios !== 'all') return 'una verifica completa richiede scenarios="all"';
	if (entry.type === 'targeted' && (!Array.isArray(entry.scenarios) || !entry.scenarios.length
		|| entry.scenarios.some(scenario => typeof scenario !== 'string' || !scenario.trim()))) return 'una verifica mirata richiede almeno uno scenario';
	if (entry.type === 'targeted' && new Set(entry.scenarios).size !== entry.scenarios.length) return 'gli scenari non possono essere duplicati';
	if ((entry.status === 'issue-observed' || entry.status === 'not-completable')
		&& (typeof entry.note !== 'string' || !entry.note.trim())) return `l'esito ${entry.status} richiede una nota`;
	if (entry.note !== undefined && typeof entry.note !== 'string') return 'la nota deve essere testo';
	if (entry.screenshot !== undefined && (typeof entry.screenshot !== 'string' || !entry.screenshot.trim())) return 'lo screenshot deve essere un percorso';
	return undefined;
}

// git's output, or undefined when git fails.
const gitWith = (env, dir, ...args) => {
	try { return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; }
};
const git = (dir, ...args) => gitWith(process.env, dir, ...args);

// The content of the working tree, whatever the commit: the id of the Git
// tree a commit of every file not ignored would have (tracked and new files,
// deletions, file modes; .gitignore respected, so the build and local data
// stay out). After a commit of exactly these files it is the commit's tree.
// Staged in a temporary index: the real index and the files are not touched;
// git only gains unreferenced objects, which its own cleanup removes.
function workingTreeContent(dir) {
	let temp;
	try {
		temp = mkdtempSync(join(tmpdir(), 'iw-contenuto-'));
		const index = join(temp, 'index');
		// From a copy of the real index git skips the files it knows unchanged.
		const real = git(dir, 'rev-parse', '--git-path', 'index')?.trim();
		if (real && existsSync(resolve(dir, real))) copyFileSync(resolve(dir, real), index);
		const env = { ...process.env, GIT_INDEX_FILE: index };
		if (gitWith(env, dir, 'add', '-A') === undefined) return UNKNOWN;
		const tree = gitWith(env, dir, 'write-tree')?.trim();
		return tree && /^[0-9a-f]{40,64}$/.test(tree) ? tree : UNKNOWN;
	} catch {
		return UNKNOWN;
	} finally {
		if (temp) rmSync(temp, { recursive: true, force: true });
	}
}

// The code a run tests: commit, branch, the files changed and not committed,
// a fingerprint of all of it (the commit plus every uncommitted change, new
// files included: the Git identity) and the content alone (`content`, which a
// commit of the same files does not change). Paths come NUL-separated,
// exactly as on disk (accented names included): read as text lines git would
// quote them.
export function codeState(dir = root) {
	const commit = git(dir, 'rev-parse', '--short', 'HEAD')?.trim();
	const status = git(dir, 'status', '--porcelain', '-z', '-uall');
	const diff = git(dir, 'diff', 'HEAD', '--binary');
	if (!commit || status === undefined || diff === undefined) {
		return { commit: commit ?? UNKNOWN, branch: UNKNOWN, state: UNKNOWN, content: UNKNOWN, changed: [], changedCount: 0 };
	}
	const hash = createHash('sha1').update(commit).update(diff);
	const changed = [];
	const records = status.split('\0');
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const code = record.slice(0, 2), file = record.slice(3);
		// A rename has its old path in the next record.
		if (code[0] === 'R' || code[0] === 'C') i++;
		changed.push(file);
		const path = join(dir, file);
		if (code === '??' && existsSync(path) && statSync(path).isFile()) hash.update(file).update(readFileSync(path));
	}
	return { commit, branch: git(dir, 'branch', '--show-current')?.trim() || UNKNOWN, state: hash.digest('hex').slice(0, 10),
		content: workingTreeContent(dir), changed: changed.slice(0, 30), changedCount: changed.length };
}

// A file's fingerprint, to say which build a run ran.
export const fileHash = path => { try { return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16); } catch { return UNKNOWN; } };

const suiteOf = file => process.env.IW_SUITE ?? ({ 'obsidian.mjs': 'app', 'browser.mjs': 'chromium', 'row-layout-browser.mjs': 'chromium-righe' })[basename(file ?? '')] ?? basename(file ?? 'sconosciuta');

function write(entry) {
	mkdirSync(registry, { recursive: true });
	appendFileSync(registryFile(), JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
}

let current;
// This process's run, started (and described in the registry) at its first use.
export function currentRun(suite = suiteOf(process.argv[1])) {
	if (current) return current;
	current = { run: `${new Date().toISOString()}-${randomBytes(2).toString('hex')}`, suite };
	let plugin = '';
	try { plugin = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')).version; } catch { /* outside the project */ }
	const filter = process.execArgv.filter(arg => arg.startsWith('--test-name-pattern')).map(arg => arg.split('=').slice(1).join('='));
	write({ kind: 'run', run: current.run, suite, ...codeState(), plugin, node: process.version, platform: `${process.platform} ${process.arch}`,
		...(filter.length ? { filter } : {}), ...(process.env.IW_COPERTURA ? { coverage: true } : {}), ...(process.env.CI ? { ci: true } : {}) });
	return current;
}

export function record(entry) {
	const { run, suite } = currentRun();
	write({ run, suite, ...entry });
}

// --- Where an error comes from ---------------------------------------------

// A bundle's source map as a lookup: generated line and column (1-based, as in
// stack traces) -> 'src/x.ts:12'. `map` is the parsed map; its paths are
// relative to `bundleDir`.
export function sourceMapper(map, bundleDir) {
	const files = map.sources.map(source => relative(root, resolve(bundleDir, map.sourceRoot ?? '', source)).replaceAll('\\', '/'));
	const byLine = new Map();
	for (const [line, column, source, sourceLine] of segments(map)) {
		const list = byLine.get(line) ?? [];
		list.push([column, source, sourceLine]);
		byLine.set(line, list);
	}
	return (line, column) => {
		const list = byLine.get(line - 1);
		if (!list) return undefined;
		let found;
		for (const entry of list) { if (entry[0] <= column - 1) found = entry; else break; }
		return found && `${files[found[1]]}:${found[2] + 1}`;
	};
}

// The frames of a stack trace that are ours, as project paths: mapped through
// `bundles` ({ url, map, lineOffset?, columnOffset? }) when the frame is in a
// bundle, kept as they are when already in the project; the rest (Node,
// node_modules, Obsidian) goes. At most `limit` frames.
export function ourFrames(stack, bundles = [], limit = 6) {
	const frames = [];
	for (const line of String(stack ?? '').split('\n')) {
		const match = /(?:\(|at |@)((?:[a-z]+:\/\/\/?|[a-z-]+:)?[^()\s]*?):(\d+):(\d+)\)?\s*$/i.exec(line);
		if (!match) continue;
		const [, url, lineText, columnText] = match;
		const bundle = bundles.find(candidate => url.includes(candidate.url));
		let where;
		if (bundle) {
			const lineNumber = Number(lineText) - (bundle.lineOffset ?? 0);
			const column = Number(columnText) - (lineNumber === 1 ? bundle.columnOffset ?? 0 : 0);
			where = bundle.map(lineNumber, column);
		} else {
			const path = url.startsWith('file:') ? fileURLToPath(url) : url;
			if (isAbsolute(path) && path.startsWith(root) && !path.includes('node_modules')) where = `${relative(root, path).replaceAll('\\', '/')}:${lineText}`;
		}
		// Libraries' own frames (node_modules) say nothing about our code.
		if (where && !where.startsWith('node_modules/') && !frames.includes(where)) frames.push(where);
		if (frames.length >= limit) break;
	}
	return frames;
}

const short = value => {
	let text;
	try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = undefined; }
	try { return (text ?? String(value)).slice(0, 500); } catch { return '(valore non rappresentabile)'; }
};

// A failed test in the registry: the message, what was expected and what came
// instead (assertions), and where: our frames, innermost first. Anything can
// be thrown (a string, undefined, an object without a message): described as
// it is, never lost.
export function describeError(error, bundles) {
	try {
		const inner = error !== null && typeof error === 'object' && 'cause' in error && error.cause !== undefined ? error.cause : error;
		const isObject = inner !== null && typeof inner === 'object';
		const message = isObject && typeof inner.message === 'string' ? inner.message : short(inner);
		return {
			error: message.slice(0, 2000),
			...(isObject && 'expected' in inner && 'actual' in inner ? { expected: short(inner.expected), actual: short(inner.actual) } : {}),
			frames: isObject ? ourFrames(inner.stack, bundles) : [],
		};
	} catch (failure) {
		return { error: `(errore non descrivibile: ${String(failure)})`, frames: [] };
	}
}
