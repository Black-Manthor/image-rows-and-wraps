// Starts the real Obsidian desktop app (downloaded into .obsidian-test/) on a fresh test vault.
import { chromium } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { coverageDir, inlineMap, savePageCoverage, startPageCoverage } from './copertura-mappa.mjs';
import { chooseObsidian } from './obsidian-versioni.mjs';
import { consoleSource, windowTeardownError } from './console-policy.mjs';
import { fileHash, ourFrames, record, registryFile, sourceMapper } from './registro.mjs';

// Everything odd seen in the app (errors, warnings, test results) goes to the
// registry of every suite (tests/registro.mjs).
export { record, registryFile };
export const root = join(process.cwd(), '.obsidian-test');
export const vault = join(root, 'vault');
const config = join(root, 'config');
const pluginId = 'image-flow';
// With `npm run test:copertura` the app runs a build mapped back to the
// sources (tests/copertura.mjs makes it), instead of the production one.
const appBundleDir = coverageDir ? join(coverageDir, 'app') : undefined;
const appBundle = appBundleDir ? join(appBundleDir, 'main.js') : 'main.js';

// The plugin's code as the app runs it, with a way back to the sources: the
// coverage build carries its map; the production one is built again with the
// map beside it (esbuild.config.mjs mappa), used only when identical to main.js.
async function pluginMap() {
	const code = await readFile(appBundle, 'utf8');
	if (coverageDir) return { code, map: sourceMapper(inlineMap(code), appBundleDir), how: 'copertura' };
	const dir = join(root, 'mappa');
	await rm(dir, { recursive: true, force: true });
	spawnSync(process.execPath, ['esbuild.config.mjs', 'mappa', join(dir, 'main.js')], { stdio: 'ignore' });
	const built = await readFile(join(dir, 'main.js'), 'utf8').catch(() => undefined);
	if (built !== code) return { code, how: 'nessuna: la build con la mappa non è uguale a main.js' };
	return { code, map: sourceMapper(JSON.parse(await readFile(join(dir, 'main.js.map'), 'utf8')), dir), how: 'produzione' };
}

// Where main.js sits in the script Obsidian runs (it wraps a plugin's code in
// a function): asked once to the app's debugger, from the script's own text.
async function pluginPlacement(page, code) {
	const cdp = await page.context().newCDPSession(page);
	const scripts = [];
	cdp.on('Debugger.scriptParsed', script => scripts.push(script));
	try {
		// Enabling it reports the scripts already there.
		await cdp.send('Debugger.enable');
		await new Promise(resolve => setTimeout(resolve, 300));
		const candidates = scripts.filter(script => script.url.includes(pluginId) || (script.length >= code.length && script.length < code.length + 5000));
		for (const script of candidates.reverse()) {
			const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
			const index = scriptSource.indexOf(code.slice(0, 500));
			if (index < 0) continue;
			const before = scriptSource.slice(0, index);
			return { url: script.url, lineOffset: before.split('\n').length - 1, columnOffset: index - (before.lastIndexOf('\n') + 1) };
		}
		return undefined;
	} finally {
		await cdp.send('Debugger.disable').catch(() => {});
		await cdp.detach().catch(() => {});
	}
}

async function obsidianBinary() {
	return join(root, chooseObsidian(existsSync(root) ? await readdir(root) : [], process.env.IW_OBSIDIAN_VERSIONE), 'obsidian');
}

// Colored PNGs of a given size, drawn by Chromium so no image dependency is needed.
async function writeImages(images) {
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	for (const [name, width, height, color] of images) {
		await page.setViewportSize({ width, height });
		await page.setContent(`<body style="margin:0;background:${color}"></body>`);
		await page.screenshot({ path: join(vault, name) });
	}
	await browser.close();
}

/** notes: { 'Name.md': 'markdown' }, images: [[file, width, height, color]] */
export async function prepareVault(notes, images) {
	await rm(vault, { recursive: true, force: true });
	await rm(config, { recursive: true, force: true });
	const plugin = join(vault, '.obsidian', 'plugins', pluginId);
	await mkdir(plugin, { recursive: true });
	await mkdir(config, { recursive: true });
	if (!existsSync(appBundle)) throw new Error(`Manca ${appBundle}: per la copertura si parte da npm run test:copertura.`);
	await cp(appBundle, join(plugin, 'main.js'));
	for (const file of ['manifest.json', 'styles.css']) await cp(file, join(plugin, file));
	await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify([pluginId]));
	await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ livePreview: true, promptDelete: false }));
	await writeFile(join(config, 'obsidian.json'), JSON.stringify({
		updateDisabled: true,
		vaults: { iwtestvault00001: { path: vault, ts: Date.now(), open: true } },
	}));
	for (const [name, text] of Object.entries(notes)) await writeFile(join(vault, name), text);
	await writeImages(images);
}

// The official build refuses Playwright's --inspect launch, so connect over the DevTools protocol.
const port = 9300 + Math.floor(Math.random() * 500);

async function connect(deadline) {
	while (Date.now() < deadline) {
		try {
			const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
			const page = browser.contexts()[0]?.pages().find(candidate => candidate.url().startsWith('app://'));
			if (page) return { browser, page };
			await browser.close();
		} catch { /* not listening yet */ }
		await new Promise(resolve => setTimeout(resolve, 300));
	}
	throw new Error(`Obsidian non raggiungibile sulla porta ${port}.`);
}

// The bench app's processes still running: every Obsidian started with this
// bench's own configuration folder (never the user's apps).
function benchProcesses() {
	try {
		return execFileSync('pgrep', ['-f', '--', `--user-data-dir=${config}`], { encoding: 'utf8' }).split('\n').map(Number).filter(pid => pid && pid !== process.pid);
	} catch { return []; }
}

// The app and every process it started (its own process group): asked to
// quit, then forced after 3 s.
async function stopApp(child) {
	const group = pid => { try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ } };
	if (child.exitCode === null && child.signalCode === null) {
		group(child.pid);
		const gone = await Promise.race([new Promise(resolve => child.once('exit', () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
		if (!gone) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
	}
}

// The bench app never outlives its run: closed when the run ends or is
// interrupted (Ctrl+C), when its start fails half way, and, if a run was
// killed before it could close it, at the next start (said in the registry).
export async function launchObsidian() {
	const stale = benchProcesses();
	if (stale.length) {
		for (const pid of stale) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
		record({ kind: 'console', level: 'warning', source: 'banco', test: '', text: `Obsidian del banco rimasto aperto da un'esecuzione precedente (${stale.length} processi): chiuso prima di partire` });
	}
	const child = spawn(await obsidianBinary(), ['--no-sandbox', `--user-data-dir=${config}`, `--remote-debugging-port=${port}`], { stdio: 'ignore', detached: true });
	const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
	const interrupted = signal => {
		kill();
		record({ kind: 'end', interrupted: signal });
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	process.once('exit', kill);
	process.once('SIGINT', interrupted);
	process.once('SIGTERM', interrupted);
	let browser;
	const close = async () => {
		await browser?.close().catch(() => {});
		await stopApp(child);
		process.removeListener('exit', kill);
		process.removeListener('SIGINT', interrupted);
		process.removeListener('SIGTERM', interrupted);
	};
	try {
		const connected = await connect(Date.now() + 60000);
		browser = connected.browser;
		return await start(connected.page, { close });
	} catch (error) {
		await close();
		throw error;
	}
}

async function start(page, app) {
	// Errors and plugin warnings fail the run; external and uncertain warnings
	// remain reviewable. `current` is the test in progress (set by the test file).
	const errors = [], warnings = [];
	const state = { current: '' };
	const bundles = [];
	// When a secondary window (a pop-out opened by a test) last closed: the
	// structural evidence of windowTeardownError (console-policy.mjs).
	let secondaryClosedAt;
	page.context().on('page', other => { if (other !== page) other.once('close', () => { secondaryClosedAt = Date.now(); }); });
	const note = (level, text, where, stack, event = 'console') => {
		const frames = ourFrames(stack, bundles);
		const sinceSecondaryClose = secondaryClosedAt === undefined ? undefined : Date.now() - secondaryClosedAt;
		const source = consoleSource({ frames, where, stack, pluginId, bundleUrls: bundles.map(bundle => bundle.url), event, sinceSecondaryClose });
		const teardown = source === 'external' && windowTeardownError({ event, where, stack, sinceSecondaryClose });
		(level === 'warning' ? warnings : errors).push({ source, text, test: state.current, frames, ...(teardown ? { teardown } : {}) });
		record({ kind: 'console', level, source, test: state.current, text, where, ...(frames.length ? { frames } : {}),
			...(teardown ? { teardown, sinceSecondaryClose } : {}) });
	};
	page.on('pageerror', error => note('error', error.message, '', error.stack ?? '', 'pageerror'));
	page.on('console', message => {
		const level = message.type();
		if (level !== 'error' && level !== 'warning') return;
		const { url = '', lineNumber = 0, columnNumber = 0 } = message.location() ?? {};
		// The text may hold a stack of its own (an error logged): its frames first.
		const [first, ...stack] = message.text().split('\n');
		note(level, first, url, `${stack.join('\n')}\nat (${url}:${lineNumber + 1}:${columnNumber + 1})`);
	});
	await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60000 });
	// First opening of a vault with plugins asks whether to trust its author.
	// Its button would also open the settings, in a window of their own over the
	// app: the same choice is made here without it, and the question
	// closed.
	const trust = page.locator('.modal.mod-trust-folder');
	if (await trust.isVisible({ timeout: 5000 }).catch(() => false)) {
		await page.evaluate(() => window.app.plugins.setEnable(true));
		await page.keyboard.press('Escape');
		await trust.waitFor({ state: 'detached', timeout: 5000 });
	}
	await page.waitForFunction(id => !!window.app.plugins.plugins[id], pluginId, { timeout: 30000 });
	const windows = page.context().pages().map(other => other.url());
	if (windows.length !== 1) throw new Error(`Finestre di Obsidian inattese all'avvio: ${windows.join(', ')}`);
	if (coverageDir) {
		// The plugin loaded before the measure could start: loaded again, so
		// that its onload counts too.
		await startPageCoverage(page);
		await page.evaluate(async id => { await window.app.plugins.disablePlugin(id); await window.app.plugins.enablePlugin(id); }, pluginId);
		await page.waitForFunction(id => !!window.app.plugins.plugins[id], pluginId, { timeout: 30000 });
	}
	// The plugin's errors from here on point at src/.
	const { code, map, how } = await pluginMap();
	const placement = map ? await pluginPlacement(page, code) : undefined;
	if (map && placement) bundles.push({ ...placement, map });
	// The conditions of the run: which app, which build (its hash), mapped or not.
	record({ kind: 'environment', mainHash: fileHash(appBundle), obsidian: await page.evaluate(() => /obsidian\/([\d.]+)/i.exec(navigator.userAgent)?.[1] ?? ''),
		installed: basename(dirname(await obsidianBinary())), build: coverageDir ? 'copertura' : 'produzione',
		sourceMap: map ? (placement ? how : 'nessuna: script del plugin non trovato') : how });
	// Obsidian opens modals in `activeWindow`, which it updates on focus. Driven
	// over CDP the app window never gets that event: it is sent once here, and
	// again by openNote.
	await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')));
	return { app, page, errors, warnings, state };
}

/** Opens a note in the given mode ('live' | 'reading') and waits for the view to settle. */
export async function openNote(page, path, mode) {
	await page.evaluate(async ({ path, mode }) => {
		const leaf = window.app.workspace.getLeaf(false);
		await leaf.openFile(window.app.vault.getAbstractFileByPath(path), {
			state: { mode: mode === 'reading' ? 'preview' : 'source', source: false },
		});
		window.app.workspace.setActiveLeaf(leaf, { focus: true });
		// activeWindow can drift back to the hidden settings window (see launchObsidian).
		window.dispatchEvent(new FocusEvent('focus'));
	}, { path, mode });
	await page.waitForFunction(({ path, mode }) => {
		const leaf = window.app.workspace.activeLeaf;
		if (window.app.workspace.getActiveFile()?.path !== path || !leaf) return false;
		const expected = mode === 'reading' ? 'preview' : 'source';
		if (leaf.view?.getMode?.() !== expected) return false;
		return mode === 'reading'
			? Boolean(leaf.view.containerEl?.querySelector('.markdown-preview-view'))
			: Boolean(leaf.view.editor?.cm?.dom?.isConnected && leaf.view.containerEl?.querySelector('.markdown-source-view'));
	}, { path, mode }, { timeout: 15000 });
}

// The plugin's coverage in the app, at the end of the run (`npm run test:copertura`).
export async function saveAppCoverage(page) {
	if (!coverageDir) return;
	const code = await readFile(appBundle, 'utf8');
	await savePageCoverage(page, 'app', code, appBundleDir, entry => (entry.source ?? '').includes(code.slice(0, 2000)));
}
