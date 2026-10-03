// Harmless child process used by registro-comando.test.ts.
import { appendFileSync } from 'node:fs';

const [mode, value] = process.argv.slice(2);
if (mode === 'output') {
	process.stdout.write('stdout diretto\n');
	process.stderr.write('stderr diretto\n');
} else if (mode === 'mark') {
	appendFileSync(value, 'eseguito\n');
} else if (mode === 'wait') {
	process.stdout.write('pronto\n');
	setInterval(() => {}, 1000);
} else if (mode === 'fail') {
	process.exitCode = Number(value);
}
