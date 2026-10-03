import { debounce, type Debouncer, type Plugin } from 'obsidian';
import { defaultSettings, normalizeSettings, rowDefaults, type ImageSettings } from './settings';
import { notify } from './ui/notify';
import { t } from './i18n';

// What follows a change: `layout` (CSS variables, cheap) at once, `rows` (the
// views whose rows follow the defaults) once the changes stop.
export interface SettingsEffects { layout: () => void; rows: () => void }

const same = (a: ImageSettings, b: ImageSettings) => JSON.stringify(a) === JSON.stringify(b);

// The one place the settings change: the settings tab, and data.json changed
// outside Obsidian (Sync, another program). A slider sends many changes: the
// values apply at once, the disk write and the row redraw once they stop.
export class SettingsStore {
	current = defaultSettings();
	private effects: SettingsEffects = { layout: () => {}, rows: () => {} };
	private saveQueue: Promise<void> = Promise.resolve();
	// Stored preferences that could not be read must not be overwritten by the
	// defaults: until they are read, changes last only for this session.
	private readFailed = false;
	private readFailureShown = false;
	// A local change wins over data.json read before it is written: from the
	// change until its write is over. A read that overlapped a write may have
	// found the old file, so it is not applied either.
	private unsaved = false;
	private writing = 0;
	private writes = 0;
	// External reads can end out of order: only the latest one started applies.
	private reads = 0;
	// After unload nothing applies or redraws: a read still pending ends there.
	private unloaded = false;
	private persist: Debouncer<[], void>;
	private redrawRows: Debouncer<[], void>;

	constructor(private plugin: Plugin, delays = { save: 400, rows: 150 }) {
		this.persist = debounce(() => { void this.save(); }, delays.save, true);
		this.redrawRows = debounce(() => this.effects.rows(), delays.rows, true);
		// A change still waiting is written at unload, not lost.
		plugin.register(() => { this.redrawRows.cancel(); this.persist.run(); this.unloaded = true; });
	}

	async load(): Promise<void> {
		try { this.current = normalizeSettings(await this.plugin.loadData()); }
		catch {
			this.readFailed = true;
			notify(this.current, t().cannotReadSettings);
		}
	}

	connect(effects: SettingsEffects): void { this.effects = effects; }

	change(next: ImageSettings): Promise<void> {
		if (this.unloaded) return Promise.resolve();
		this.apply(next);
		this.unsaved = true;
		this.persist();
		return Promise.resolve();
	}

	async reloadExternal(): Promise<void> {
		// A write in progress at the start or started meanwhile: the read overlapped it.
		const writes = this.writes, busy = this.writing > 0, read = ++this.reads;
		let stored: ImageSettings;
		try { stored = normalizeSettings(await this.plugin.loadData()); } catch { return; }
		if (this.unloaded || read !== this.reads) return;
		// Readable again: from now on changes are saved.
		this.readFailed = false;
		this.readFailureShown = false;
		if (this.unsaved || busy || this.writing > 0 || this.writes !== writes || same(stored, this.current)) return;
		this.apply(stored);
	}

	private apply(next: ImageSettings): void {
		const previousRows = JSON.stringify(rowDefaults(this.current));
		this.current = normalizeSettings(next);
		this.effects.layout();
		// Rows without a comment follow the defaults: redraw both views.
		if (JSON.stringify(rowDefaults(this.current)) !== previousRows) this.redrawRows();
	}

	private save(): Promise<void> {
		this.unsaved = false;
		if (this.readFailed) {
			if (!this.readFailureShown) notify(this.current, t().settingsNotRead);
			this.readFailureShown = true;
			return Promise.resolve();
		}
		// Serialized, so an older selection can never be written last.
		const snapshot = { ...this.current };
		this.writes++;
		this.writing++;
		this.saveQueue = this.saveQueue.then(() => this.plugin.saveData(snapshot)).catch(() => {
			notify(this.current, t().cannotSaveSettings);
		}).finally(() => { this.writing--; });
		return this.saveQueue;
	}
}
