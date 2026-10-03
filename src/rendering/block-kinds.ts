// The drawn side of block alignment (markdown/blocks.ts aligns, without DOM):
// what a rendered top-level block is, and which embeds it holds.

// Exported side: a top-level child of the export, described by kind and embeds.
const KINDS: Array<[string, string]> = [
	['yaml', '.frontmatter, .metadata-container'], ['callout', '.callout'],
	['heading', 'h1, h2, h3, h4, h5, h6'], ['code', 'pre'], ['table', 'table'],
	['footnoteDefinition', '.footnotes'], ['math', '.math-block, mjx-container[display="true"]'],
	['thematicBreak', 'hr'], ['list', 'ul, ol'], ['blockquote', 'blockquote'], ['paragraph', 'p'],
];

export function kindOf(element: Element): string {
	return KINDS.find(([, selector]) => element.matches(selector) || element.querySelector(selector))?.[0] ?? 'other';
}

export function embedPaths(element: Element): string[] {
	const embeds = Array.from(element.querySelectorAll('.internal-embed'));
	if (element.matches('.internal-embed')) embeds.unshift(element);
	return embeds.map(embed => embed.getAttribute('src') ?? '');
}
