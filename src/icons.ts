import { addIcon, removeIcon, type Plugin } from 'obsidian';

// Original 100×100 outlines: images are rectangles, text is represented by lines.
const drawings: Record<string, string> = {
	'iw-image-center': '<rect x="29" y="12" width="42" height="36" rx="4"/><path d="M34 41l11-12 8 8 8-8 6 12M15 65h70M15 82h70"/>',
	'iw-wrap-left': '<rect x="10" y="12" width="35" height="43" rx="4"/><path d="M15 47l10-14 7 8 7-8M58 18h30M58 35h30M58 52h30M10 70h78M10 87h78"/>',
	'iw-wrap-toggle': '<rect x="10" y="12" width="30" height="36" rx="4"/><path d="M52 18h36M52 34h36M10 70h78M10 87h78M56 52h30m-8-7 8 7-8 7"/>',
	'iw-row-merge': '<rect x="7" y="19" width="86" height="62" rx="7"/><rect x="17" y="32" width="27" height="35" rx="3"/><rect x="56" y="32" width="27" height="35" rx="3"/>',
	'iw-row-separate': '<rect x="8" y="29" width="29" height="42" rx="3"/><rect x="63" y="29" width="29" height="42" rx="3"/><path d="M37 14H16l7-7M63 86h21l-7 7"/>',
	'iw-row-split': '<rect x="7" y="29" width="28" height="42" rx="3"/><rect x="65" y="29" width="28" height="42" rx="3"/><path d="M50 10v15m0 15v20m0 15v15"/>',
	'iw-row-left': '<rect x="50" y="29" width="40" height="42" rx="4"/><path d="M40 50H10m14-14L10 50l14 14"/>',
	'iw-row-right': '<rect x="10" y="29" width="40" height="42" rx="4"/><path d="M60 50h30M76 36l14 14-14 14"/>',
	'iw-row-align': '<path d="M10 20v60M90 20v60"/><rect x="22" y="35" width="22" height="30" rx="3"/><rect x="56" y="35" width="22" height="30" rx="3"/>',
	'iw-row-valign': '<path d="M10 85h80"/><rect x="18" y="30" width="26" height="48" rx="3"/><rect x="56" y="52" width="26" height="26" rx="3"/>',
	'iw-row-gap': '<rect x="8" y="30" width="28" height="40" rx="3"/><rect x="64" y="30" width="28" height="40" rx="3"/><path d="M42 50h16M46 44l-6 6 6 6M54 44l6 6-6 6"/>',
	'iw-wrap-separate': '<path d="M28 8H13v22h15M72 8h15v22H72M28 92H13V70h15M72 92h15V70H72"/><path d="M32 50h36"/>',
	'iw-wrap-move': '<path d="M50 8v84M34 24l16-16 16 16M34 76l16 16 16-16M20 50h60"/>',
	'iw-remove-wrap': '<rect x="10" y="13" width="35" height="36" rx="4"/><path d="M10 67h78M10 84h78M60 15l25 28M85 15 60 43"/>',
};

export function registerIcons(plugin: Plugin): void {
	for (const [id, drawing] of Object.entries(drawings)) {
		addIcon(id, `<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${drawing}</g>`);
	}
	plugin.register(() => { for (const id of Object.keys(drawings)) removeIcon(id); });
}
