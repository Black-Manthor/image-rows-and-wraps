import { isImagePath, parseDocument } from '../markdown/model';

export type AddClass = (element: HTMLElement, className: string) => void;

// Obsidian may invoke postprocessors before an internal embed becomes image-embed.
// Include the section itself, as well as placeholders and completed descendants.
export function imageEmbeds(root: HTMLElement): HTMLElement[] {
	const candidates = Array.from(root.querySelectorAll<HTMLElement>('.internal-embed, .image-embed'));
	if (root.matches('.internal-embed, .image-embed')) candidates.unshift(root);
	return candidates.filter(element => element.classList.contains('image-embed') || isImagePath(element.getAttribute('src') ?? ''));
}

export function flattenImageParagraph(embed: HTMLElement, add: AddClass): HTMLElement | undefined {
	const paragraph = embed.parentElement;
	if (!paragraph || paragraph.tagName !== 'P' || paragraph.children.length !== 1 ||
		Array.from(paragraph.childNodes).some(node => node.nodeType === 3 && node.textContent?.trim())) return undefined;
	add(paragraph, 'iw-image-paragraph');
	return paragraph;
}

export function firstParagraph(root: HTMLElement): HTMLElement | null {
	return root.matches('p') ? root : root.querySelector<HTMLElement>('p');
}

export function alignPreviewParagraphs(root: HTMLElement, embed: HTMLElement, add: AddClass): void {
	const imageParagraph = flattenImageParagraph(embed, add);
	if (!imageParagraph) return;
	const paragraphs = Array.from(root.querySelectorAll<HTMLElement>('p'));
	const next = paragraphs[paragraphs.indexOf(imageParagraph) + 1];
	if (next && next !== imageParagraph) add(next, 'iw-first-paragraph');
}

// Classes of a wrap's own container, known before rendering, so the float
// applies as soon as the image appears: the side, and whether the first
// block is the image alone. Shared by Live Preview and Reading view.
export function wrapContainerClasses(markdown: string, side: string): string[] {
	const first = parseDocument(markdown).images[0];
	if (!first || !markdown.trimStart().startsWith(first.raw)) return [];
	const classes = [`iw-layout-${side}`];
	if (markdown.trim().split(/\n\s*\n/)[0]?.trim() === first.raw) classes.push('iw-leading-image-only');
	return classes;
}

// The rendered image floats on its side, its paragraph box goes and the next
// paragraph loses its top margin. Idempotent: safe from a class observer.
export function layoutWrapContent(content: HTMLElement, side: string): void {
	const firstEmbed = content.querySelector<HTMLElement>('.internal-embed, .image-embed');
	if (!firstEmbed?.classList.contains('image-embed')) return;
	if (!firstEmbed.classList.contains(side)) firstEmbed.classList.add(side);
	alignPreviewParagraphs(content, firstEmbed, (element, cls) => {
		if (!element.classList.contains(cls)) element.classList.add(cls);
	});
}
