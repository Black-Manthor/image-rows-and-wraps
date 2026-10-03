import { PluginSettingTab, type Plugin, type SettingDefinition, type SettingDefinitionItem } from 'obsidian';
import { defaultSettings, numericDefaults, numericLimits, type NumericKey, type ImageSettings } from '../settings';
import { alignChoices, valignChoices } from './row-settings';
import { t } from '../i18n';

// Declarative settings (Obsidian 1.13+): Obsidian renders the rows and indexes
// them for the settings search. Values are read and written through the
// plugin's change function, which normalizes, saves and refreshes the views.
export class ImageSettingsTab extends PluginSettingTab {
	constructor(plugin: Plugin, private getSettings: () => ImageSettings,
		private change: (settings: ImageSettings) => Promise<void>) { super(plugin.app, plugin); }

	getSettingDefinitions(): SettingDefinitionItem[] {
		const slider = (key: NumericKey, name: string, unit: string, desc = ''): SettingDefinition => {
			const [min, max, step] = numericLimits[key];
			// The unit goes in the name (kept from before minAppVersion 1.13.4: an inline
			// value format, from Obsidian 1.13.1, could show it instead).
			return { name: `${name} (${unit})`, desc: `${desc}${desc ? ' ' : ''}${t().defaultValue(numericDefaults[key], unit)}`,
				control: { type: 'slider', key, min, max, step } };
		};
		// A whole-settings change (reset, presets): the rows are drawn again afterwards.
		const button = (name: string, desc: string, text: string, next: () => ImageSettings): SettingDefinition => ({
			name, desc, render: setting => {
				setting.addButton(control => control.setButtonText(text).onClick(async () => {
					await this.change(next());
					this.update();
				}));
			},
		});
		return [
			{ type: 'group', heading: t().dragHeading, items: [
				{ name: t().dragName,
					desc: t().dragDesc,
					control: { type: 'toggle', key: 'dragImages' } },
			] },
			{ type: 'group', heading: t().rowsHeading, items: [
				{ name: t().rowAlignName, desc: t().rowDefaultDesc,
					control: { type: 'dropdown', key: 'rowAlign', options: Object.fromEntries(alignChoices()) } },
				{ name: t().rowValignName, desc: t().rowDefaultDesc,
					control: { type: 'dropdown', key: 'rowValign', options: Object.fromEntries(valignChoices()) } },
				slider('rowGap', t().rowGapName, 'px', t().rowGapDesc),
			] },
			{ type: 'group', heading: t().wrapHeading, items: [
				slider('wrapGap', t().wrapGapName, 'em', t().wrapGapDesc),
				slider('wrapMaxPercent', t().wrapMaxName, '%', t().wrapMaxDesc),
			] },
			{ type: 'group', heading: t().noticesHeading, items: [slider('noticeSeconds', t().noticeName, t().seconds)] },
			{ type: 'group', items: [
				button(t().resetName, t().resetDesc, t().resetButton, defaultSettings),
			] },
		];
	}

	getControlValue(key: string): unknown {
		return Object.getOwnPropertyDescriptor(this.getSettings(), key)?.value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const next = { ...this.getSettings(), [key]: value };
		// Invalid values are corrected by normalizeSettings in the change function.
		await this.change(next);
		// Rows whose visible or disabled state depends on a value follow it.
		this.refreshDomState();
	}
}
