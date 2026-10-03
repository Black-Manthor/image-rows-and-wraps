import { build } from 'esbuild';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { coverageDir, mergeLines, serialize, sourceLines } from './copertura-mappa.mjs';

const directory = await mkdtemp(join(tmpdir(), 'image-wrap-tests-'));
try {
	const outfile = join(directory, 'tests.mjs');
	const files = (await readdir('tests')).filter(name => name.endsWith('.test.ts')).sort();
	await build({
		stdin: { contents: ['node-dom.ts', ...files].map(name => `import './tests/${name}';`).join('\n'), resolveDir: process.cwd() },
		outfile, bundle: true, platform: 'node', format: 'esm',
		// A map back to the sources: stack traces in the registry, and the coverage.
		sourcemap: 'inline',
		plugins: [{ name: 'obsidian-test', setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(process.cwd(), 'tests/obsidian-stub.ts') }));
		} }],
	});
	const v8 = join(directory, 'v8');
	// Results printed, and recorded in the registry (tests/registro-reporter.mjs).
	const result = spawnSync(process.execPath, ['--enable-source-maps', '--test-reporter=spec', '--test-reporter-destination=stdout',
		'--test-reporter=./tests/registro-reporter.mjs', '--test-reporter-destination=stderr', outfile],
	{ stdio: 'inherit', env: { ...process.env, IW_SUITE: 'node', ...(coverageDir ? { NODE_V8_COVERAGE: v8 } : {}) } });
	process.exitCode = result.status ?? 1;
	if (coverageDir) {
		const code = await readFile(outfile, 'utf8');
		const url = pathToFileURL(outfile).href;
		const runs = [];
		for (const name of await readdir(v8)) {
			const { result: scripts } = JSON.parse(await readFile(join(v8, name), 'utf8'));
			for (const script of scripts) if (script.url === url) runs.push(sourceLines(code, script.functions, directory));
		}
		await mkdir(coverageDir, { recursive: true });
		await writeFile(join(coverageDir, 'node.json'), JSON.stringify(serialize(mergeLines(...runs))));
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
