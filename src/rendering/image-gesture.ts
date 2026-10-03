import type { EditorView } from '@codemirror/view';

// Keep the pressed image active without opening/replacing its region widget
// under the pointer. The Markdown selection is committed on release.
export const pressedImages = new WeakMap<EditorView, number>();
export const imageFeedbackRefresh = new WeakMap<EditorView, () => void>();
export function setPressedImage(view: EditorView, from: number | undefined): void {
	if (from === undefined) pressedImages.delete(view);
	else pressedImages.set(view, from);
	imageFeedbackRefresh.get(view)?.();
}
