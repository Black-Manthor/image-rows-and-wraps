// node:test reporter for every suite: each result goes to the registry
// (tests/registro.mjs) with its duration and, when it failed, why and where;
// the run ends with its totals. The spec reporter still prints the run; this
// one writes nothing to its own destination.
import { relative } from 'node:path';
import { currentRun, describeError, record } from './registro.mjs';

export default async function* registro(source) {
	currentRun();
	// Values as in the registry since its start (2026-09-26).
	const totals = { superato: 0, fallito: 0, saltato: 0 };
	const started = Date.now();
	for await (const event of source) {
		if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
		const { name, nesting, details, file, line, skip, todo } = event.data;
		if (nesting !== 0 || details?.type === 'suite') continue;
		const result = event.type === 'test:fail' ? 'fallito' : skip || todo ? 'saltato' : 'superato';
		totals[result]++;
		// The test's own place, when it is a project file (not a temporary bundle).
		const place = file && !relative(process.cwd(), file).startsWith('..') ? `${relative(process.cwd(), file)}${line ? `:${line}` : ''}` : undefined;
		record({ kind: 'result', test: name, result, ms: Math.round(details?.duration_ms ?? 0), ...(place ? { file: place } : {}),
			...(result === 'fallito' ? describeError(details?.error) : {}) });
	}
	record({ kind: 'end', ...totals, ms: Date.now() - started });
}
