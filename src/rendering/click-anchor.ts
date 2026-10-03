import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { eventElement } from './preview-dom';

// A click that moves the caret out of a wrap or a row of images draws the block
// again, with another height than its source: below it, the clicked line and
// everything after it moved. The clicked line keeps its place on
// screen; what changes shape is above it. Clicking above a block needs nothing:
// CodeMirror keeps the top of the screen still.
// The correction rides on the click's own selection transaction (a transaction
// extender), so the first frame drawn is already the right one: a correction a
// frame later (a requestAnimationFrame scroll) was tried: it showed as a small
// jump in the lower part of the screen, and was dropped.
// Clicks on a preview are preview-interaction.ts's, which anchors them itself.

// The clicked line of a pointer press, by the state it was pressed in: the
// selection transaction that follows starts from that state.
const pressed = new WeakMap<EditorState, { pos: number; offset: number }>();

export const clickAnchor: Extension = [
	EditorView.domEventHandlers({
		pointerdown(event, view) {
			if (event.button !== 0 || eventElement(event)?.closest('.iw-preview')) return false;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			const top = pos === null ? undefined : view.coordsAtPos(pos)?.top;
			if (pos !== null && top !== undefined) pressed.set(view.state, { pos, offset: top - view.scrollDOM.getBoundingClientRect().top });
			return false;
		},
	}),
	EditorState.transactionExtender.of(tr => {
		const press = pressed.get(tr.startState);
		if (!press || !tr.selection || !tr.isUserEvent('select.pointer')) return null;
		pressed.delete(tr.startState);
		return { effects: EditorView.scrollIntoView(press.pos, { y: 'start', yMargin: Math.max(0, press.offset) }) };
	}),
];
