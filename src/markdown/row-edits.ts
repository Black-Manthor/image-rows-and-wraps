import type { Edit } from './edits';
import type { ImageRow, RowSettings } from './row-model';

// The keys the plugin writes in a row comment. Anything else in the comment
// belongs to someone else and is kept as it is.
const KNOWN_KEYS = ['align', 'valign', 'gap'] as const;

// The row comment with these tokens, or nothing when there are none.
export const formatRowComment = (tokens: string[]): string => tokens.length ? `%%iw-row ${tokens.join(' ')}%%` : '';

// Only keys that differ from the current defaults, in a fixed order, so that
// absent keys keep following later changes of the defaults. Tokens the plugin
// does not know are kept after them.
export function serializeRowComment(settings: RowSettings, defaults: RowSettings, extra: string[] = []): string {
	const tokens = KNOWN_KEYS.filter(key => settings[key] !== defaults[key]).map(key => `${key}=${settings[key]}`);
	tokens.push(...extra);
	return formatRowComment(tokens);
}

export function unknownTokens(body: string | undefined): string[] {
	return (body ?? '').split(/\s+/).filter(token => token && !KNOWN_KEYS.some(key => token.startsWith(`${key}=`)));
}

export function foreignRowComment(body: string | undefined): string {
	return formatRowComment(unknownTokens(body));
}

// Rewrites everything after the last link: exactly one space before the
// comment, or nothing when every setting is back to its default.
export function rowSettingsEdit(row: ImageRow, settings: RowSettings, defaults: RowSettings): Edit {
	const last = row.images[row.images.length - 1]!;
	const comment = serializeRowComment(settings, defaults, unknownTokens(row.comment?.body));
	return { from: row.from + last.to, to: row.to, text: comment ? ` ${comment}` : '' };
}
