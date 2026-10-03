// Gives the command runner harmless phases for its process-level tests.
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { finishLikeChild, runRegisteredCommand } from '../registro-comando.mjs';

const child = fileURLToPath(new URL('./registro-comando-child.mjs', import.meta.url));
const [mode, value] = process.argv.slice(2);
let steps;
if (mode === 'build-fail') steps = [
	{ phase: 'type-check', executable: process.execPath, args: [child, 'fail', value] },
	{ phase: 'bundle', executable: process.execPath, args: [child, 'mark', process.env.IW_FIXTURE_MARKER] },
];
else if (mode === 'wait') steps = [{ phase: 'wait', executable: process.execPath, args: [child, 'wait'] }];
else if (mode === 'mark') steps = [{ phase: 'mark', executable: process.execPath, args: [child, 'mark', value] }];
else if (mode === 'fail') steps = [{ phase: 'fixture', executable: process.execPath, args: [child, 'fail', value] }];
else steps = [{ phase: 'fixture', executable: process.execPath, args: [child, 'output'] }];
finishLikeChild(await runRegisteredCommand('fixture', steps));
