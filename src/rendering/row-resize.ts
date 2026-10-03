import { REFERENCE_WIDTH } from '../markdown/row-model';
import { composeRow } from './row-layout';

// Resize handle arithmetic, all in the 700 px reference composition.
// Screen widths are converted before and after (scale = band / 700).

export const MIN_COMPOSED_WIDTH = 35;

export interface ResizeContext {
	widths: number[]; // desired widths, explicit or natural
	gap: number;
	index: number; // the image being resized
	reference?: number;
}

// Width of every image in the reference composition (after the common factor).
export function composedWidths(widths: number[], gap: number, reference = REFERENCE_WIDTH): number[] | undefined {
	return composeRow(widths, gap, reference)?.widths.map(percent => percent / 100 * reference);
}

// Sum of the other desired widths plus all gaps: what the resized image shares the row with.
function othersSpan({ widths, gap, index }: ResizeContext): number {
	return widths.reduce((sum, width, i) => i === index ? sum : sum + width, 0) + gap * (widths.length - 1);
}

// Desired width that gives the resized image composed width `composed`.
// Without overflow they coincide; with overflow w = d·S / (R − d), which grows
// without bound as d approaches R: the limits below keep it finite.
export function desiredForComposed(context: ResizeContext, composed: number): number {
	const reference = context.reference ?? REFERENCE_WIDTH;
	const span = othersSpan(context);
	if (composed <= reference - span) return composed;
	return composed >= reference ? Infinity : composed * span / (reference - composed);
}

// Range of desired widths the handle may save. No image may go below the
// common minimum (35 px composed) because of the gesture; an image already
// below it may stay there but not shrink further. One image alone: up to 700.
export function resizeLimits(context: ResizeContext): { min: number; max: number } | undefined {
	const reference = context.reference ?? REFERENCE_WIDTH;
	const start = composedWidths(context.widths, context.gap, reference);
	if (!start) return undefined;
	const floor = (i: number) => Math.min(MIN_COMPOSED_WIDTH, start[i]!);
	const span = othersSpan(context);
	let max = context.widths.length === 1 ? reference : Infinity;
	context.widths.forEach((width, i) => {
		if (i !== context.index) max = Math.min(max, reference * width / floor(i) - span);
	});
	const min = desiredForComposed(context, floor(context.index));
	return { min, max: Math.max(min, max) };
}

// Desired width to save for a target composed width, clamped and rounded to
// whole pixels inside the limits (never below 1).
export function resizedWidth(context: ResizeContext, composed: number): number | undefined {
	const limits = resizeLimits(context);
	if (!limits || !Number.isFinite(composed)) return undefined;
	const wanted = desiredForComposed(context, composed);
	const low = Math.max(1, Math.ceil(limits.min - 1e-9));
	const high = Math.max(low, Math.floor(limits.max + 1e-9));
	return Math.min(high, Math.max(low, Math.round(Math.min(wanted, high + 1))));
}

// The link with a new width. `|W` or `|WxH` is replaced (the height follows the
// same proportion); without a size parameter one is appended. Other parameters
// stay as they are.
export function withWidth(raw: string, width: number): string {
	const parts = raw.slice(3, -2).split('|');
	const index = parts.findIndex((part, i) => i > 0 && /^\s*\d+(?:x\d+)?\s*$/.test(part));
	if (index < 0) return `![[${[...parts, String(width)].join('|')}]]`;
	const [, oldWidth, oldHeight] = /^\s*(\d+)(?:x(\d+))?\s*$/.exec(parts[index]!)!;
	// The proportion is kept only from real sizes: `0x100` has none, so it
	// becomes the plain width instead of `200xInfinity`.
	const height = Number(oldHeight) * width / Number(oldWidth);
	parts[index] = oldHeight && Number(oldWidth) > 0 && Number(oldHeight) > 0 && Number.isFinite(height)
		? `${width}x${Math.max(1, Math.round(height))}` : String(width);
	return `![[${parts.join('|')}]]`;
}
