// Dedicated secret scan shared by the publication script and release CI.
// Gitleaks stays an external development tool: it is not a plugin dependency.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GITLEAKS_VERSION = '8.28.0';
export const GITLEAKS_LINUX_X64_SHA256 = 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb';
const FINDING_EXIT_CODE = 7;

const result = (kind, message) => ({ kind, message });

/**
 * Run one redacted Gitleaks scan. Process output is deliberately never
 * forwarded: even a scanner diagnostic must not disclose the matched value.
 * @param {'dir'|'git'} mode
 * @param {string} target
 * @param {string} config
 * @param {(command: string, args: string[], options: object) => import('node:child_process').SpawnSyncReturns<Buffer>} run
 */
export function runGitleaks(mode, target, config, run = spawnSync) {
	const version = run('gitleaks', ['version'], { encoding: 'buffer', stdio: 'pipe' });
	if (version.error?.code === 'ENOENT') {
		return result('unavailable', `Gitleaks ${GITLEAKS_VERSION} non disponibile nel PATH`);
	}
	if (version.error || version.status === null) {
		return result('error', 'impossibile verificare la versione di Gitleaks (processo non completato)');
	}
	if (version.status !== 0) {
		return result('error', `impossibile verificare la versione di Gitleaks (uscita ${version.status ?? 'non disponibile'})`);
	}
	const versionText = Buffer.concat([version.stdout ?? Buffer.alloc(0), version.stderr ?? Buffer.alloc(0)]).toString('utf8');
	if (!new RegExp(`(?:^|\\D)v?${GITLEAKS_VERSION.replaceAll('.', '\\.')}($|\\D)`).test(versionText)) {
		return result('version', `versione Gitleaks diversa da ${GITLEAKS_VERSION}`);
	}

	const reportDir = mkdtempSync(join(tmpdir(), 'image-flow-gitleaks-'));
	try {
		const report = join(reportDir, 'report.json');
		const scan = run('gitleaks', [mode, target, '--config', config, '--redact=100', '--no-banner',
			'--report-format', 'json', '--report-path', report, '--exit-code', String(FINDING_EXIT_CODE)],
		{ encoding: 'buffer', stdio: 'pipe' });
		if (scan.error?.code === 'ENOENT') return result('unavailable', `Gitleaks ${GITLEAKS_VERSION} non disponibile nel PATH`);
		if (scan.error || scan.status === null) {
			return result('error', `errore operativo di Gitleaks durante la scansione ${mode} (processo non completato)`);
		}
		if (scan.status === FINDING_EXIT_CODE) {
			return result('finding', `Gitleaks ha rilevato uno o più possibili segreti nella scansione ${mode} (contenuto nascosto)`);
		}
		if (scan.status !== 0) {
			return result('error', `errore operativo di Gitleaks durante la scansione ${mode} (uscita ${scan.status})`);
		}
		return result('ok', `scansione Gitleaks ${mode} superata`);
	} finally {
		rmSync(reportDir, { recursive: true, force: true });
	}
}

/** Run the working-tree scan and, for a repository with commits, history. */
export function scanPublicSecrets(root, { history = false, run = spawnSync } = {}) {
	const config = join(root, '.gitleaks.toml');
	if (!existsSync(config)) return [result('error', `configurazione Gitleaks mancante: ${config}`)];
	const scans = [runGitleaks('dir', root, config, run)];
	if (scans[0].kind === 'ok' && history) scans.push(runGitleaks('git', root, config, run));
	return scans;
}

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const hasHistory = spawnSync('git', ['rev-list', '--count', '--all'], { cwd: project, encoding: 'utf8', stdio: 'pipe' }).stdout?.trim() !== '0';
	const scans = scanPublicSecrets(project, { history: hasHistory });
	for (const scan of scans) console.log(`  ${scan.message}`);
	if (scans.some(scan => scan.kind !== 'ok')) process.exitCode = 1;
}
