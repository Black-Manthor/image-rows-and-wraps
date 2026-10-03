import { REFERENCE_WIDTH, type ImageRow } from '../markdown/row-model';
import { windowOf } from './preview-dom';

// A row is laid out in the 700 px reference, then shown in a band of
// min(100%, 700px). Widths and gap are percentages of that band, so the whole
// composition scales in CSS: the printed page is re-laid out at a width the
// plugin cannot measure beforehand.

export interface RowComposition { widths: number[]; gap: number }

export function composeRow(widths: Array<number | undefined>, gap: number,
	reference = REFERENCE_WIDTH): RowComposition | undefined {
	if (!Number.isFinite(gap) || gap < 0 || !Number.isFinite(reference) || reference <= 0 || !widths.length || widths.some(width => !(width! > 0) || !Number.isFinite(width))) return undefined;
	const known = widths as number[];
	const total = known.reduce((sum, width) => sum + width, 0) + gap * (known.length - 1);
	// Images and gaps shrink together, by the same factor, when the row overflows.
	if (!Number.isFinite(total)) return undefined;
	const factor = Math.min(1, reference / total);
	const percent = (value: number) => value * factor / reference * 100;
	return { widths: known.map(percent), gap: known.length > 1 ? percent(gap) : 0 };
}

const ALIGN_PREFIX = 'iw-row-align-';
const VALIGN_PREFIX = 'iw-row-valign-';

function setClass(element: HTMLElement, name: string, prefix: string): void {
	for (const cls of Array.from(element.classList)) if (cls.startsWith(prefix) && cls !== name) element.classList.remove(cls);
	if (!element.classList.contains(name)) element.classList.add(name);
}

// Direct children only: every child must be an embed, with no visible text.
function rowEmbeds(paragraph: HTMLElement): HTMLElement[] | undefined {
	const children = Array.from(paragraph.children) as HTMLElement[];
	if (children.some(child => !child.matches('.internal-embed'))) return undefined;
	if (Array.from(paragraph.childNodes).some(node => node.nodeType === 3 && node.textContent?.trim())) return undefined;
	return children;
}

export function naturalWidth(embed: HTMLElement): number | undefined {
	const image = embed.querySelector('img');
	return image && image.naturalWidth > 0 ? image.naturalWidth : undefined;
}

function clearRow(paragraph: HTMLElement): void {
	for (const cls of Array.from(paragraph.classList)) if (cls === 'iw-row' || cls.startsWith('iw-row-')) paragraph.classList.remove(cls);
	paragraph.setCssProps({ '--iw-row-gap': '' });
	for (const child of Array.from(paragraph.children) as HTMLElement[]) child.setCssProps({ '--iw-row-width': '' });
}

// Idempotent: unchanged classes are not touched, so an observer on `class`
// does not loop. Returns false while a natural width is still unknown.
export function applyRow(paragraph: HTMLElement, row: ImageRow): boolean {
	const embeds = rowEmbeds(paragraph);
	const layout = embeds?.length === row.images.length
		? composeRow(row.images.map((image, index) => image.width ?? naturalWidth(embeds[index]!)), row.settings.gap)
		: undefined;
	if (!embeds || !layout) {
		if (paragraph.classList.contains('iw-row')) clearRow(paragraph);
		return false;
	}
	if (!paragraph.classList.contains('iw-row')) paragraph.classList.add('iw-row');
	setClass(paragraph, `${ALIGN_PREFIX}${row.settings.align}`, ALIGN_PREFIX);
	setClass(paragraph, `${VALIGN_PREFIX}${row.settings.valign}`, VALIGN_PREFIX);
	paragraph.setCssProps({ '--iw-row-gap': `${layout.gap}%` });
	embeds.forEach((embed, index) => embed.setCssProps({ '--iw-row-width': `${layout.widths[index]}%` }));
	return true;
}

// Keeps a rendered row laid out while Obsidian replaces placeholders and
// images load. The returned function restores the paragraph.
export function watchRow(paragraph: HTMLElement, row: ImageRow, onUpdate?: () => void): () => void {
	let alive = true;
	const update = () => { if (!alive) return; applyRow(paragraph, row); onUpdate?.(); };
	const observer = new (windowOf(paragraph).MutationObserver)(update);
	observer.observe(paragraph, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
	// `load` does not bubble: listen in the capture phase for images inside the row.
	paragraph.addEventListener('load', update, true);
	update();
	return () => {
		alive = false;
		observer.disconnect();
		paragraph.removeEventListener('load', update, true);
		clearRow(paragraph);
	};
}
