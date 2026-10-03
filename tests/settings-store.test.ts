import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettingsStore } from '../src/settings-store';
import { defaultSettings, type ImageSettings } from '../src/settings';
import { notices } from './obsidian-stub';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setup(stored: unknown = {}, { failRead = false, failWrite = false } = {}) {
	const saved: ImageSettings[] = [];
	const cleanups: Array<() => void> = [];
	// `slow`: reads and writes take that long; a write reaches the disk at its end.
	// `reads`: durations of the next reads, one each, before `slow` applies again.
	const disk = { value: stored, failRead, failWrite, slow: 0, reads: [] as number[] };
	const plugin = {
		loadData: async () => {
			const value = disk.value;
			const delay = disk.reads.shift() ?? disk.slow;
			if (delay) await wait(delay);
			if (disk.failRead) throw new Error('corrupt');
			return value;
		},
		saveData: async (data: ImageSettings) => {
			if (disk.slow) await wait(disk.slow);
			if (disk.failWrite) throw new Error('disk full');
			disk.value = data;
			saved.push(data);
		},
		register: (callback: () => void) => { cleanups.push(callback); },
	};
	const store = new SettingsStore(plugin as never, { save: 10, rows: 10 });
	const effects = { layout: 0, rows: 0 };
	store.connect({ layout: () => { effects.layout++; }, rows: () => { effects.rows++; } });
	return { store, saved, effects, disk, unload: () => { for (const cleanup of cleanups) cleanup(); } };
}

test('a burst of changes applies at once, then one save with the last values and one row redraw', async () => {
	const { store, saved, effects } = setup();
	await store.load();
	for (const rowGap of [13, 14, 15, 16]) await store.change({ ...store.current, rowGap });
	assert.equal(store.current.rowGap, 16, 'values apply immediately');
	assert.equal(effects.layout, 4, 'CSS variables follow every change');
	assert.equal(saved.length, 0, 'nothing written during the burst');
	await wait(40);
	assert.equal(saved.length, 1);
	assert.equal(saved[0]!.rowGap, 16);
	assert.equal(effects.rows, 1);
});

test('only a change of the row defaults redraws the rows; values are normalized', async () => {
	const { store, effects } = setup();
	await store.load();
	await store.change({ ...store.current, wrapGap: 2, noticeSeconds: 999 });
	await wait(40);
	assert.equal(effects.rows, 0);
	assert.equal(store.current.noticeSeconds, 30);
});

test('unreadable preferences are never overwritten, until data.json can be read again', async () => {
	const { store, saved, disk } = setup({ rowGap: 20 }, { failRead: true });
	await store.load();
	assert.deepEqual(store.current, defaultSettings());
	await store.change({ ...store.current, rowGap: 30 });
	await wait(40);
	assert.equal(saved.length, 0);
	disk.failRead = false;
	await store.reloadExternal();
	assert.equal(store.current.rowGap, 20, 'the stored value is back');
	await store.change({ ...store.current, rowGap: 25 });
	await wait(40);
	assert.equal(saved.at(-1)?.rowGap, 25);
});

test('an external change applies, unless a local change is still waiting to be written', async () => {
	const { store, effects, disk } = setup({ rowGap: 12 });
	await store.load();
	disk.value = { rowGap: 40, rowAlign: 'center' };
	await store.reloadExternal();
	assert.equal(store.current.rowGap, 40);
	assert.equal(store.current.rowAlign, 'center');
	await wait(40);
	assert.equal(effects.rows, 1);
	await store.change({ ...store.current, rowGap: 8 });
	disk.value = { rowGap: 50 };
	await store.reloadExternal();
	assert.equal(store.current.rowGap, 8, 'the local change wins');
});

test('of two external reads that overlap, the later one wins even if it ends first', async () => {
	// Sync writes data.json twice in a row: the first read is slow, the second
	// quick. The first one's older values must not come back.
	const { store, disk } = setup({ rowGap: 12 });
	await store.load();
	disk.value = { rowGap: 6 };
	disk.reads = [40];
	const first = store.reloadExternal();
	disk.value = { rowGap: 48 };
	const second = store.reloadExternal();
	await second;
	assert.equal(store.current.rowGap, 48);
	await first;
	assert.equal(store.current.rowGap, 48, 'the older read does not apply');
});

test('a local change also wins while it is being written, and over a read that overlapped the write', async () => {
	const { store, saved, disk } = setup({ rowGap: 12 });
	await store.load();
	disk.slow = 30;
	await store.change({ ...store.current, rowGap: 8 });
	await wait(20);
	assert.equal(saved.length, 0, 'the write has started, not finished');
	await store.reloadExternal();
	assert.equal(store.current.rowGap, 8, 'the old file, read during the write, is not applied');
	// A read that starts before a write and ends after it.
	disk.slow = 0;
	await wait(20);
	assert.equal(saved.at(-1)?.rowGap, 8);
	disk.slow = 30;
	const reading = store.reloadExternal();
	disk.slow = 5;
	await store.change({ ...store.current, rowGap: 9 });
	await wait(40);
	disk.value = { rowGap: 50 };
	await reading;
	assert.equal(store.current.rowGap, 9);
	// With every write over, an external change applies again.
	await wait(20);
	disk.slow = 0;
	disk.value = { rowGap: 40 };
	await store.reloadExternal();
	assert.equal(store.current.rowGap, 40);
});

test('after unload nothing applies: a pending read, or a change, is ignored', async () => {
	const { store, saved, effects, disk, unload } = setup({ rowGap: 12 });
	await store.load();
	disk.slow = 30;
	disk.value = { rowGap: 40 };
	const reading = store.reloadExternal();
	unload();
	await reading;
	assert.equal(store.current.rowGap, 12, 'the read ends after unload: not applied');
	assert.equal(effects.layout, 0);
	await store.change({ ...store.current, rowGap: 20 });
	await wait(60);
	assert.equal(store.current.rowGap, 12);
	assert.equal(effects.rows, 0, 'no redraw after unload');
	assert.equal(saved.length, 0, 'nothing written');
});

test('a change still waiting is written at unload', async () => {
	const { store, saved, effects, unload } = setup();
	await store.load();
	await store.change({ ...store.current, rowGap: 33 });
	unload();
	await wait(20);
	assert.equal(saved.length, 1);
	assert.equal(saved[0]!.rowGap, 33);
	assert.equal(effects.rows, 0, 'no redraw after unload');
});

test('a failed save says so; the change stays for this session and the next one is saved', async () => {
	const { store, saved, disk } = setup({ rowGap: 12 }, { failWrite: true });
	await store.load();
	await store.change({ ...store.current, rowGap: 30 });
	await wait(40);
	assert.equal(notices.at(-1), 'Impossibile salvare le preferenze. Le modifiche valgono solo per questa sessione.');
	assert.equal(store.current.rowGap, 30, 'the value still applies');
	assert.equal(saved.length, 0);
	disk.failWrite = false;
	await store.change({ ...store.current, rowGap: 31 });
	await wait(40);
	assert.equal(saved.at(-1)?.rowGap, 31, 'the disk works again: saved');
});
