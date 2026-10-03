import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeState } from './registro.mjs';

const harness = 'tests/fixtures/registro-comando-runner.mjs';
// The children record in `registry` whatever the environment running the tests
// says (a publication check runs them with IW_REGISTRO_COMANDI=0, for
// instance). Only the test of that switch sets it to 0 itself.
const childEnv = (registry: string, extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, IW_REGISTRO: registry, IW_REGISTRO_COMANDI: '1', ...extra });
const registryEntries = (registry: string) => existsSync(registry) ? readdirSync(registry)
	.flatMap(file => readFileSync(join(registry, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) : [];

function run(mode: string, value?: string, extraEnv: NodeJS.ProcessEnv = {}) {
	const registry = mkdtempSync(join(tmpdir(), 'iw-comando-'));
	const result = spawnSync(process.execPath, [harness, mode, ...(value === undefined ? [] : [value])], {
		encoding: 'utf8', env: childEnv(registry, extraEnv),
	});
	return { registry, result, lines: registryEntries(registry) };
}

test('a successful command keeps inherited output and records its Git state and terminal result', () => {
	const dir = mkdtempSync(join(tmpdir(), 'iw-comando-output-'));
	const registry = join(dir, 'registro'), stdoutFile = join(dir, 'stdout'), stderrFile = join(dir, 'stderr');
	try {
		const stdout = openSync(stdoutFile, 'w'), stderr = openSync(stderrFile, 'w');
		const result = spawnSync(process.execPath, [harness, 'output'], { env: childEnv(registry), stdio: ['ignore', stdout, stderr] });
		closeSync(stdout); closeSync(stderr);
		assert.equal(result.status, 0);
		assert.equal(readFileSync(stdoutFile, 'utf8'), 'stdout diretto\n');
		assert.equal(readFileSync(stderrFile, 'utf8'), 'stderr diretto\n');
		const lines = registryEntries(registry);
		const start = lines.find(line => line.kind === 'run');
		assert.equal(start.suite, 'comando:fixture');
		assert.equal(typeof start.commit, 'string');
		assert.equal(typeof start.branch, 'string');
		// The code where the tests run: a Git state in a repository, «non disponibile»
		// outside one (the isolated copy of a publication is not a repository).
		const here = codeState();
		assert.equal(start.state, here.state);
		assert.equal(start.content, here.content);
		assert.equal(typeof start.node, 'string');
		assert.equal(typeof start.platform, 'string');
		const command = lines.find(line => line.kind === 'command');
		assert.equal(command.command, 'fixture');
		assert.equal(command.phase, 'fixture');
		assert.equal(command.ok, true);
		assert.equal(command.exitCode, 0);
		assert.equal(command.status, 'completed');
		assert.equal(typeof command.ms, 'number');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed command preserves its exit code and the build stops at the failing phase', () => {
	const markerDir = mkdtempSync(join(tmpdir(), 'iw-comando-marker-'));
	const marker = join(markerDir, 'bundle');
	const { registry, result, lines } = run('build-fail', '7', { IW_FIXTURE_MARKER: marker });
	try {
		assert.equal(result.status, 7);
		assert.equal(existsSync(marker), false, 'the bundle phase did not run');
		const command = lines.find(line => line.kind === 'command');
		assert.equal(command.ok, false);
		assert.equal(command.exitCode, 7);
		assert.equal(command.phase, 'type-check');
		assert.equal(command.status, 'completed');
	} finally {
		rmSync(registry, { recursive: true, force: true });
		rmSync(markerDir, { recursive: true, force: true });
	}
});

// A child still alive when a test ends (an assertion failed, the run never
// started) is stopped with SIGTERM, which the runner forwards to its own child,
// so none is left behind to keep the suite from ending; SIGKILL only if the
// runner does not end within a few seconds. The test's own error stays.
async function stopChild(child: ChildProcess | undefined) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
	child.kill('SIGTERM');
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), 5000); });
	if (await Promise.race([exited, late]) === 'late') {
		child.kill('SIGKILL');
		await exited;
	}
	clearTimeout(timer);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`${signal} is forwarded, recorded and remains a signal termination`, async () => {
	const registry = mkdtempSync(join(tmpdir(), 'iw-comando-signal-'));
	let child: ChildProcess | undefined;
	try {
		const running = spawn(process.execPath, [harness, 'wait'], { env: childEnv(registry), stdio: 'ignore' });
		child = running;
		await new Promise<void>((resolve, reject) => {
			running.once('error', reject);
			const deadline = Date.now() + 3000;
			const poll = () => {
				if (registryEntries(registry).some(line => line.kind === 'run')) setTimeout(resolve, 100);
				else if (Date.now() >= deadline) reject(new Error('the command run did not start'));
				else setTimeout(poll, 20);
			};
			poll();
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => running.once('exit', (code, exitedSignal) => resolve({ code, signal: exitedSignal })));
		running.kill(signal);
		const outcome = await exited;
		assert.equal(outcome.code, null);
		assert.equal(outcome.signal, signal);
		const command = registryEntries(registry).find(line => line.kind === 'command');
		assert.equal(command.status, 'interrupted');
		assert.equal(command.interrupted, true);
		assert.equal(command.signal, signal);
		assert.equal(command.ok, false);
	} finally {
		await stopChild(child);
		rmSync(registry, { recursive: true, force: true });
	}
});

test('IW_REGISTRO_COMANDI=0 writes nothing but still executes the command', () => {
	const dir = mkdtempSync(join(tmpdir(), 'iw-comando-disabled-'));
	const marker = join(dir, 'marker');
	const registry = join(dir, 'registro');
	try {
		const result = spawnSync(process.execPath, [harness, 'mark', marker], {
			encoding: 'utf8', env: childEnv(registry, { IW_REGISTRO_COMANDI: '0' }),
		});
		assert.equal(result.status, 0);
		assert.equal(readFileSync(marker, 'utf8'), 'eseguito\n');
		assert.equal(existsSync(registry), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
