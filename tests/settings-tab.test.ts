import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { ImageSettingsTab } from '../src/ui/settings-tab';
import { defaultSettings, normalizeSettings, type ImageSettings } from '../src/settings';

function tab() {
	let settings = defaultSettings();
	const saved: ImageSettings[] = [];
	const instance = new ImageSettingsTab({ app: {} } as never, () => settings, async next => {
		settings = normalizeSettings(next); saved.push(settings);
	});
	return { instance: instance as ImageSettingsTab & { updates: number; domRefreshes: number }, saved, current: () => settings };
}

function flatten(items: SettingDefinitionItem[]): SettingDefinition[] {
	return items.flatMap(item => 'type' in item && (item.type === 'group' || item.type === 'list')
		? flatten(item.items ?? []) : [item as SettingDefinition]);
}

test('every control key reads a real setting, and every definition has a name for the search', () => {
	const { instance } = tab();
	const definitions = flatten(instance.getSettingDefinitions());
	const keys = definitions.flatMap(item => 'control' in item && item.control ? [item.control.key] : []);
	assert.ok(keys.includes('dragImages') && keys.includes('rowGap') && keys.includes('noticeSeconds'));
	for (const key of keys) assert.notEqual(instance.getControlValue(key), undefined, key);
	for (const item of definitions) assert.ok(item.name.trim(), 'searchable name');
	// Dropdowns offer the current value.
	for (const item of definitions) if ('control' in item && item.control?.type === 'dropdown') {
		assert.ok(String(instance.getControlValue(item.control.key)) in item.control.options);
	}
});

test('changes go through the plugin change function, normalized, and refresh the rows state', async () => {
	const { instance, saved, current } = tab();
	await instance.setControlValue('rowGap', 24);
	assert.equal(current().rowGap, 24);
	await instance.setControlValue('rowGap', 5000);
	assert.equal(current().rowGap, 100, 'clamped by normalizeSettings');
	await instance.setControlValue('rowAlign', 'center');
	assert.equal(instance.getControlValue('rowAlign'), 'center');
	await instance.setControlValue('dragImages', false);
	assert.equal(current().dragImages, false);
	assert.equal(saved.length, 4);
	assert.equal(instance.domRefreshes, 4);
});

test('«Ripristina valori predefiniti» brings every setting back to its default, then redraws the tab', async () => {
	const { instance, current } = tab();
	await instance.setControlValue('rowGap', 40);
	await instance.setControlValue('dragImages', false);
	const reset = flatten(instance.getSettingDefinitions()).find(item => item.name === 'Ripristina valori predefiniti');
	assert.ok(reset && 'render' in reset && reset.render, 'the reset row draws its own button');
	let label = '', click: (() => Promise<void>) | undefined;
	const button = { setButtonText(text: string) { label = text; return button; }, onClick(callback: () => Promise<void>) { click = callback; return button; } };
	(reset.render as (setting: unknown) => void)({ addButton(build: (control: typeof button) => void) { build(button); } });
	assert.equal(label, 'Ripristina');
	await click!();
	assert.deepEqual(current(), defaultSettings());
	assert.equal(instance.updates, 1, 'the whole tab drawn again with the defaults');
});
