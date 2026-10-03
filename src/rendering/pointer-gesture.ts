// The common base of the plugin's pointer gestures: what
// every gesture needs, written once so that the gestures cannot drift apart.
// - Pointer events are followed on the element's own document (pop-outs), in
//   the capture phase, and only for the pointer that started the gesture.
// - Esc, the browser cancelling the pointer, or the window losing focus end it
//   without committing; Obsidian's native drag of embeds is blocked meanwhile
//   (it would cancel the gesture).
// - Moves count once the pointer has gone `threshold` px; `onFrame` then runs
//   once per frame for the last position (layout reads, feedback), and the
//   scroller scrolls near its top and bottom edges if one is given.
// - Obsidian's tooltips stay hidden while it lasts (GESTURE_CLASS in
//   styles.css): one pending from before the press would otherwise appear
//   over the gesture. And until the pointer really moves after it: at
//   the release Obsidian sees the element under a still pointer as a new hover.
// - `onEnd` runs exactly once, after every listener is gone; the returned
//   function cancels (a widget's cleanup calls it).
// Nothing is dispatched to the editor before the end: in Obsidian a transaction
// during a gesture can redraw the widget under it, which ends the gesture.

export interface GestureEnd { commit: boolean; moved: boolean; x: number; y: number }

export interface GestureOptions {
	event: PointerEvent;
	// Takes the pointer, so moves outside the window still arrive.
	capture?: HTMLElement;
	// Takes the pointer over if `capture` loses it during the gesture (removed
	// or redrawn meanwhile), so the release outside the window still arrives.
	recapture?: HTMLElement;
	threshold?: number;
	scroller?: HTMLElement;
	// On the body while the gesture lasts (cursor styles).
	bodyClass?: string;
	// The gesture's own document and window, when not the target's.
	doc?: Document;
	win?: Window;
	// Moves (once past the threshold) and the release are the gesture's alone:
	// no other listener receives them (image drag: no editor selection meanwhile).
	exclusive?: boolean;
	onFrame?: (x: number, y: number) => void;
	onEnd: (end: GestureEnd) => void;
}

const GESTURE_CLASS = 'iw-gesture';

const EDGE = 32, STEP = 20, SETTLE = 8;

// Tooltips back once the pointer has gone SETTLE px from where the gesture
// ended, or at the next press, key or loss of focus; any tooltip left from the
// meantime goes (Obsidian creates it again when it next needs it).
const waiting = new Set<() => void>();

// At unload: tooltips back now, no listener left behind.
export function restoreTooltipsNow(): void {
	for (const done of Array.from(waiting)) done();
}

function restoreTooltips(doc: Document, win: Window, x: number, y: number): void {
	const done = () => {
		waiting.delete(done);
		doc.removeEventListener('pointermove', move, true);
		doc.removeEventListener('pointerdown', done, true);
		doc.removeEventListener('keydown', done, true);
		win.removeEventListener('blur', done);
		doc.body.classList.remove(GESTURE_CLASS);
		for (const tooltip of Array.from(doc.body.children)) if (tooltip.classList.contains('tooltip')) tooltip.remove();
	};
	const move = (event: PointerEvent) => { if (Math.hypot(event.clientX - x, event.clientY - y) >= SETTLE) done(); };
	waiting.add(done);
	doc.addEventListener('pointermove', move, true);
	doc.addEventListener('pointerdown', done, true);
	doc.addEventListener('keydown', done, true);
	win.addEventListener('blur', done);
}

export function startGesture(options: GestureOptions): () => void {
	const { event, capture, recapture, threshold = 0, scroller, bodyClass, exclusive, onFrame, onEnd } = options;
	const target = (capture ?? event.target) as Node;
	const doc = options.doc ?? target.doc, win = options.win ?? target.win;
	let moved = threshold === 0, done = false;
	// The element that holds the pointer now: `capture`, then `recapture`.
	let holder = capture;
	let frame: number | undefined;
	let last = { x: event.clientX, y: event.clientY };

	const move = (moveEvent: PointerEvent) => {
		if (moveEvent.pointerId !== event.pointerId) return;
		if (!moved && Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) < threshold) return;
		moved = true;
		moveEvent.preventDefault();
		if (exclusive) moveEvent.stopImmediatePropagation();
		last = { x: moveEvent.clientX, y: moveEvent.clientY };
		if (scroller) {
			const box = scroller.getBoundingClientRect();
			if (moveEvent.clientY < box.top + EDGE) scroller.scrollTop -= STEP;
			else if (moveEvent.clientY > box.bottom - EDGE) scroller.scrollTop += STEP;
		}
		if (onFrame && frame === undefined) frame = win.requestAnimationFrame(() => { frame = undefined; if (!done) onFrame(last.x, last.y); });
	};
	const finish = (commit: boolean, x = last.x, y = last.y) => {
		if (done) return;
		done = true;
		if (frame !== undefined) win.cancelAnimationFrame(frame);
		doc.removeEventListener('pointermove', move, true);
		doc.removeEventListener('pointerup', up, true);
		doc.removeEventListener('pointercancel', cancel, true);
		doc.removeEventListener('keydown', escape, true);
		doc.removeEventListener('dragstart', noNativeDrag, true);
		doc.removeEventListener('lostpointercapture', lost, true);
		win.removeEventListener('blur', cancel);
		if (holder?.hasPointerCapture?.(event.pointerId)) holder.releasePointerCapture(event.pointerId);
		if (bodyClass) doc.body.classList.remove(bodyClass);
		restoreTooltips(doc, win, x, y);
		onEnd({ commit, moved, x, y });
	};
	const up = (upEvent: PointerEvent) => {
		if (upEvent.pointerId !== event.pointerId) return;
		upEvent.preventDefault();
		if (exclusive) upEvent.stopImmediatePropagation();
		finish(true, upEvent.clientX, upEvent.clientY);
	};
	const cancel = () => finish(false);
	const escape = (keyEvent: KeyboardEvent) => {
		if (keyEvent.key !== 'Escape') return;
		keyEvent.preventDefault(); keyEvent.stopImmediatePropagation();
		finish(false);
	};
	const noNativeDrag = (dragEvent: DragEvent) => dragEvent.preventDefault();
	// Our pointer released while the gesture lasts: `recapture` takes it, once;
	// if the pointer is already gone, its release or cancel ends the gesture.
	const lost = (lostEvent: PointerEvent) => {
		if (lostEvent.pointerId !== event.pointerId || !recapture || holder === recapture) return;
		try {
			recapture.setPointerCapture(event.pointerId);
			holder = recapture;
		} catch { /* no active pointer any more */ }
	};

	event.preventDefault();
	event.stopPropagation();
	capture?.setPointerCapture?.(event.pointerId);
	if (recapture) doc.addEventListener('lostpointercapture', lost, true);
	doc.addEventListener('pointermove', move, true);
	doc.addEventListener('pointerup', up, true);
	doc.addEventListener('pointercancel', cancel, true);
	doc.addEventListener('keydown', escape, true);
	doc.addEventListener('dragstart', noNativeDrag, true);
	win.addEventListener('blur', cancel);
	doc.body.classList.add(GESTURE_CLASS, ...(bodyClass ? [bodyClass] : []));
	return cancel;
}
