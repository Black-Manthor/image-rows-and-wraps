import { assertUnambiguous } from './command-zones';
import { targetImage, wrapRange, type Edit } from './edits';
import { END, parseDocument, regionsTouching, selectionLeavesRegion, startMarker, wrapImage } from './model';
import { foreignRowComment, rowSettingsEdit, serializeRowComment } from './row-edits';
import { DEFAULT_ROW_SETTINGS, findRows, markerZones, parseRowText, type RowSettings } from './row-model';
import { addWrapMarkers } from './wrap-actions';
import { eolOf } from './text';
import { t } from '../i18n';

// Centers the row of the image under the cursor. Inside a wrap, the wrap goes:
// its image becomes a centered one-image row and the text follows it, with
// one blank line around them, as the wrap had.
// Returns one replacement, so each user action is one editor undo operation.
export function centerImage(source: string, from: number, to: number, defaults: RowSettings = DEFAULT_ROW_SETTINGS): Edit {
	const model = parseDocument(source);
	assertUnambiguous(model, from, to);
	const regions = regionsTouching(model, from, to);
	if (regions.length > 1) throw new Error(t().oneWrapAtATime);
	const region = regions[0];
	if (region) {
		const start = model.lines[region.start]!;
		const end = model.lines[region.end]!;
		if (selectionLeavesRegion(source, model, region, from, to)) throw new Error(t().selectionCrossesWrapCenter);
		const image = wrapImage(model, region);
		if (!image) throw new Error(t().wrapImageError);
		const comment = serializeRowComment({ ...defaults, align: 'center' }, defaults);
		const eol = eolOf(source);
		// The image is the region's first content line (wrapImage): the text
		// runs from it to the last content line, without the blank lines that
		// separated the markers from the content (as Rimuovi wrap).
		const following = source.slice(image.to, model.lines[region.last]!.to);
		// Compact valid wraps may have text on the very next line. Once
		// unwrapped, the image must become a dedicated Markdown paragraph.
		const afterImage = following.trim() && !/^\r?\n[\t ]*\r?\n/.test(following)
			? eol + following : following;
		// A compact marker touching the text outside: a blank line keeps the
		// row, and the text after it, paragraphs of their own (as Aggiungi wrap).
		const blank = (index: number) => !model.lines[index]?.text.trim();
		const lead = region.start > 0 && !blank(region.start - 1) ? eol : '';
		const next = model.lines[region.end + 1];
		const trail = next ? eol + (blank(region.end + 1) ? '' : eol) : '';
		return { from: start.from, to: next?.from ?? end.to,
			text: lead + image.raw + (comment ? ` ${comment}` : '') + afterImage + trail };
	}
	const image = targetImage(source, from, to);
	const row = findRows(source, model, defaults).find(row => image.from >= row.from && image.to <= row.to);
	if (!row) throw new Error(t().centerNeedsRow);
	return rowSettingsEdit(row, { ...row.settings, align: 'center' }, defaults);
}

// Adds a wrap, with its image on the left (Cambia lato switches it):
// - on an image alone on its line: that image, with the selected text if any;
// - on text: the paragraph under the cursor, or the blocks the selection touches;
// - on an empty line: an empty wrap, with the cursor inside, ready to fill.
// Markers are always paragraphs of their own.
export function addWrap(source: string, from: number, to: number): Edit {
	const model = parseDocument(source);
	assertUnambiguous(model, from, to);
	const index = model.lines.findIndex(line => from >= line.from && from <= line.to);
	const line = model.lines[index];
	if (!line) throw new Error(t().placeCursorInNote);
	if (markerZones(model).some(([start, end]) => index >= start && index <= end)) {
		throw new Error(t().alreadyInWrapSwitchSide);
	}
	if (!line.active) throw new Error(t().wrapOnlyTextAndImages);
	const eol = eolOf(source);
	if (from === to && !line.text.trim()) {
		const lead = model.lines[index - 1]?.text.trim() ? eol : '';
		const trail = model.lines[index + 1]?.text.trim() ? eol : '';
		const head = `${lead}${startMarker('left')}${eol}${eol}`;
		return { from: line.from, to: line.to, text: `${head}${eol}${eol}${END}${trail}`, cursor: line.from + head.length };
	}
	const parsed = parseRowText(line.text);
	if (!parsed || /^\s/.test(line.text)) return addWrapMarkers(source, from, to);
	if (parsed.images.length > 1) throw new Error(t().multiImageRowToWrap);
	const image = model.images.find(candidate => candidate.line === index)!;
	const wrap = from === to ? { from: line.from, to: line.to } : wrapRange(source, from, to);
	if (model.images.filter(candidate => candidate.from >= wrap.from && candidate.to <= wrap.to).length !== 1) {
		throw new Error(t().selectOneImageWithText);
	}
	if (wrap.from !== line.from) throw new Error(t().selectImageOnOwnLine);
	// The row comment does not belong to a wrap: the image line becomes the link
	// alone. Read from the line itself, a row of images or not (text right above
	// or below): unknown tokens are kept either way.
	const foreign = foreignRowComment(parsed.comment?.body);
	const content = image.raw + (foreign ? `${eol}${eol}${foreign}` : '') + source.slice(line.to, wrap.to);
	// A blank line before the start and after the end, and only one: added
	// when text touches the range (or after it, when the note ends there); a
	// blank line already there stays the only one.
	const lead = model.lines[index - 1]?.text.trim() ? eol : '';
	const next = model.lines[model.lines.findIndex(candidate => candidate.to === wrap.to) + 1];
	const trail = !next || next.text.trim() ? eol : '';
	return { from: wrap.from, to: wrap.to, text: `${lead}${startMarker('left')}${eol}${eol}${content}${eol}${eol}${END}${trail}` };
}
