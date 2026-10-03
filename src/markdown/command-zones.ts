import type { DocumentModel } from './model';
import { markerZones } from './row-model';
import { t } from '../i18n';

// Valid wraps remain command targets. Only ambiguous marker intervals block
// edits; an unrelated malformed region must not disable the whole document.
export function assertUnambiguous(model: DocumentModel, from: number, to: number): void {
	for (const [start, end] of markerZones(model)) {
		if (model.regions.some(region => region.start === start && region.end === end)) continue;
		if (from <= model.lines[end]!.to && to >= model.lines[start]!.from) {
			throw new Error(t().fixMarkersInZone);
		}
	}
}
