import { setIcon } from 'obsidian';

// Overlay in the top corner of a preview widget (row or wrap): shown on hover
// or keyboard focus, never part of the layout. Its events belong to it: the
// widgets ignore them and the preview controller does not enter the source.
export const BLOCK_TOOLBAR_CLASS = 'iw-block-toolbar';

// `action` runs on click; `press` on pointer down, for a handle that is dragged.
export interface ToolbarButton {
	icon: string; label: string; cls?: string;
	action?: (button: HTMLButtonElement) => void;
	press?: (event: PointerEvent, button: HTMLButtonElement) => void;
}

// A toolbar with its own name: over its edges and the gaps between its buttons
// Obsidian would otherwise show the block's tooltip («Click to edit»); its own
// tooltip is off in styles.css, the buttons keep theirs.
export function createBlockToolbar(root: HTMLElement, cls: string, label: string, buttons: ToolbarButton[]): HTMLElement {
	const bar = root.createDiv({ cls: [BLOCK_TOOLBAR_CLASS, cls], attr: { role: 'toolbar', 'aria-label': label } });
	for (const { icon, label, cls: extra, action, press } of buttons) {
		const button = bar.createEl('button', { type: 'button', cls: ['iw-block-toolbar-button', 'clickable-icon', ...(extra ? [extra] : [])],
			attr: { 'aria-label': label } });
		setIcon(button, icon);
		if (action) button.addEventListener('click', event => { event.preventDefault(); action(button); });
		if (press) button.addEventListener('pointerdown', event => press(event, button));
	}
	return bar;
}
