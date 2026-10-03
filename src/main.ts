import { registerIcons } from './icons';
import { registerLayoutSettings } from './layout-settings';
import { Plugin, getLanguage } from 'obsidian';
import { setLanguage } from './i18n';
import { registerCommands } from './commands';
import { createLivePreview, refreshLivePreviews } from './rendering/live-preview';
import { restoreTooltipsNow } from './rendering/pointer-gesture';
import { registerReadingView } from './rendering/reading-view';
import { SettingsStore } from './settings-store';
import { ImageSettingsTab } from './ui/settings-tab';
import { registerRowSettingCommands } from './ui/row-settings';

export default class ImageWrapPlugin extends Plugin {
	private store: SettingsStore | undefined;

	async onload() {
		// Before anything shows a text: Obsidian's language, Italian or English.
		setLanguage(getLanguage());
		const store = this.store = new SettingsStore(this);
		await store.load();
		const settings = () => store.current;
		registerIcons(this);
		registerCommands(this, settings);
		registerRowSettingCommands(this, settings);
		const updateLayout = registerLayoutSettings(this, settings);
		this.registerEditorExtension(createLivePreview(this, settings));
		this.register(restoreTooltipsNow);
		const refreshReading = registerReadingView(this, settings);
		store.connect({ layout: updateLayout, rows: () => { refreshLivePreviews(); refreshReading(); } });
		this.addSettingTab(new ImageSettingsTab(this, settings, next => store.change(next)));
	}

	// data.json changed outside Obsidian (Sync, another program).
	async onExternalSettingsChange() {
		await this.store?.reloadExternal();
	}
}
