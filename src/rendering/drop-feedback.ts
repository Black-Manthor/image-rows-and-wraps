// Feedback shared by image and wrap drags: a bar where the drop goes, or a note
// saying why it cannot go there. Overlays on the editor's own document (a
// pop-out window has its own), never intercepting the pointer (styles.css).
export interface DropMark { rect: { left: number; right: number; top: number; bottom: number }; vertical: boolean; after: boolean }

export class DropFeedback {
	private indicator: HTMLElement | undefined;
	private rejection: HTMLElement | undefined;
	constructor(private doc: Document) {}
	show({ rect, vertical, after }: DropMark): void {
		this.hideRejection();
		const marker = this.indicator ?? this.doc.body.createDiv({ cls: 'iw-drop-indicator' });
		this.indicator = marker;
		marker.setCssProps({
			'--iw-drop-left': `${vertical && after ? rect.right : rect.left}px`,
			'--iw-drop-top': `${!vertical && after ? rect.bottom : rect.top}px`,
			'--iw-drop-width': vertical ? '3px' : `${rect.right - rect.left}px`,
			'--iw-drop-height': vertical ? `${rect.bottom - rect.top}px` : '3px',
		});
	}
	reject(message: string, x: number, y: number): void {
		this.hideIndicator();
		const hint = this.rejection ?? this.doc.body.createDiv({ cls: 'iw-drop-rejection' });
		this.rejection = hint;
		hint.textContent = message;
		hint.setCssProps({
			'--iw-hint-left': `${Math.max(8, Math.min(x + 16, (this.doc.defaultView?.innerWidth ?? 800) - 320))}px`,
			'--iw-hint-top': `${Math.max(8, Math.min(y + 20, (this.doc.defaultView?.innerHeight ?? 600) - 110))}px`,
		});
		this.doc.body.classList.add('iw-drag-forbidden');
	}
	clear(): void { this.hideIndicator(); this.hideRejection(); }
	private hideIndicator(): void { this.indicator?.remove(); this.indicator = undefined; }
	private hideRejection(): void {
		this.rejection?.remove(); this.rejection = undefined;
		this.doc.body.classList.remove('iw-drag-forbidden');
	}
}
