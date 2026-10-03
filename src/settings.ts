import { DEFAULT_ROW_SETTINGS, ROW_ALIGNS, ROW_VALIGNS, type RowAlign, type RowSettings, type RowValign } from './markdown/row-model';

export const numericDefaults = { noticeSeconds: 10, wrapGap: 1, wrapMaxPercent: 45, rowGap: DEFAULT_ROW_SETTINGS.gap };
export type NumericKey = keyof typeof numericDefaults;
export const numericLimits: Record<NumericKey, readonly [number, number, number]> = {
	noticeSeconds: [3, 30, 1], wrapGap: [0, 3, 0.1], wrapMaxPercent: [10, 80, 1], rowGap: [0, 100, 1],
};
export interface ImageSettings extends Record<NumericKey, number> {
	rowAlign: RowAlign; rowValign: RowValign;
	dragImages: boolean;
}

export function defaultSettings(): ImageSettings {
	return { ...numericDefaults, rowAlign: DEFAULT_ROW_SETTINGS.align, rowValign: DEFAULT_ROW_SETTINGS.valign, dragImages: true };
}

// Row defaults used wherever a row comment omits a key.
export function rowDefaults(settings: ImageSettings): RowSettings {
	return { align: settings.rowAlign, valign: settings.rowValign, gap: settings.rowGap };
}

// Values from earlier versions that no longer exist (old groups, ribbon
// visibility, extended drag) are ignored.
export function normalizeSettings(data: unknown): ImageSettings {
	const settings = defaultSettings();
	if (!data || typeof data !== 'object') return settings;
	const read = (key: string): unknown => Object.getOwnPropertyDescriptor(data, key)?.value;
	for (const key of Object.keys(numericDefaults) as NumericKey[]) {
		const value = read(key);
		const [min, max, step] = numericLimits[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			settings[key] = Number((Math.round(Math.max(min, Math.min(max, value)) / step) * step).toFixed(2));
		}
	}
	const align = read('rowAlign');
	if (typeof align === 'string' && (ROW_ALIGNS as readonly string[]).includes(align)) settings.rowAlign = align as RowAlign;
	const valign = read('rowValign');
	if (typeof valign === 'string' && (ROW_VALIGNS as readonly string[]).includes(valign)) settings.rowValign = valign as RowValign;
	const drag = read('dragImages');
	if (typeof drag === 'boolean') settings.dragImages = drag;
	return settings;
}
