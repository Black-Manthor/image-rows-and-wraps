// Runs build, latest-API checking and lint without changing their output, and
// records their outcome in the common diagnostic registry. Set
// IW_REGISTRO_COMANDI=0 only when an enclosing check already records the
// command, or when running in an isolated disposable copy.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { currentRun, record } from './registro.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const executable = path => fileURLToPath(new URL(path, import.meta.url));

export const commands = {
	build: [
		{ phase: 'type-check', executable: process.execPath, args: [executable('../node_modules/typescript/bin/tsc'), '-noEmit', '-skipLibCheck'] },
		{ phase: 'bundle', executable: process.execPath, args: [fileURLToPath(new URL('../esbuild.config.mjs', import.meta.url)), 'production'] },
	],
	'check:latest': [
		{ phase: 'type-check latest', executable: process.execPath, args: [executable('../node_modules/typescript/bin/tsc'), '-noEmit', '-skipLibCheck', '-p', 'tsconfig.latest.json'] },
	],
	lint: [
		{ phase: 'lint', executable: process.execPath, args: [executable('../node_modules/eslint/bin/eslint.js'), '.'] },
	],
};

const runStep = (step, onChild) => new Promise(resolve => {
	let settled = false;
	const finish = result => {
		if (settled) return;
		settled = true;
		resolve(result);
	};
	let child;
	try {
		child = spawn(step.executable, step.args, { cwd: step.cwd ?? project, env: step.env ?? process.env, stdio: 'inherit' });
		onChild(child);
		child.once('error', error => finish({ code: null, signal: null, error }));
		child.once('exit', (code, signal) => finish({ code, signal, error: undefined }));
	} catch (error) {
		finish({ code: null, signal: null, error });
	}
});

/** Run command steps in order. Exported so tests can use harmless fixtures. */
export async function runRegisteredCommand(command, steps, { registry = process.env.IW_REGISTRO_COMANDI !== '0' } = {}) {
	if (registry) currentRun(`comando:${command}`);
	const started = Date.now();
	let child;
	let requestedSignal;
	const interrupt = signal => {
		requestedSignal ??= signal;
		if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
	};
	const onSigint = () => interrupt('SIGINT');
	const onSigterm = () => interrupt('SIGTERM');
	process.once('SIGINT', onSigint);
	process.once('SIGTERM', onSigterm);
	let result = { code: 0, signal: null, error: undefined };
	let phase = steps[0]?.phase ?? command;
	try {
		for (const step of steps) {
			phase = step.phase;
			if (requestedSignal) { result = { code: null, signal: requestedSignal, error: undefined }; break; }
			result = await runStep(step, running => { child = running; });
			child = undefined;
			if (result.code !== 0 || result.signal || result.error) break;
		}
	} finally {
		process.removeListener('SIGINT', onSigint);
		process.removeListener('SIGTERM', onSigterm);
	}
	const signal = requestedSignal ?? result.signal ?? undefined;
	const interrupted = Boolean(signal);
	const entry = {
		kind: 'command', command, phase, ok: !interrupted && !result.error && result.code === 0,
		exitCode: result.code, ms: Date.now() - started, status: interrupted ? 'interrupted' : 'completed',
		...(signal ? { signal, interrupted: true } : {}),
		...(result.error ? { diagnostic: String(result.error.message ?? result.error).slice(0, 1000) } : {}),
	};
	if (registry) record(entry);
	return entry;
}

export function finishLikeChild(entry) {
	if (entry.signal) {
		// Restore the operating system's signal exit semantics after the record is
		// safely appended. The fallback matters only on platforms that cannot
		// deliver this signal to the current process.
		try { process.kill(process.pid, entry.signal); } catch { process.exitCode = entry.signal === 'SIGINT' ? 130 : 143; }
		return;
	}
	process.exitCode = entry.exitCode ?? 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
	const command = process.argv[2];
	if (!commands[command]) {
		process.stderr.write(`Comando diagnostico sconosciuto: ${command ?? ''}\n`);
		process.exitCode = 2;
	} else {
		finishLikeChild(await runRegisteredCommand(command, commands[command]));
	}
}
