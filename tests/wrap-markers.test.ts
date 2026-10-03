import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addWrapMarkers, fixWrap, fixWraps, removeWrap, toggleWrapSide } from '../src/markdown/wrap-actions';
import { addWrap, centerImage } from '../src/markdown/actions';
import { END, START, compactWraps, parseDocument, startMarker } from '../src/markdown/model';

const LEFT = startMarker('left');

const apply = (source: string, from: number, to = from) => {
	const edit = addWrapMarkers(source, from, to);
	return { text: source.slice(0, edit.from) + edit.text + source.slice(edit.to), cursor: edit.cursor! };
};

test('a selection wraps every block it touches, with the note line endings', () => {
	for (const eol of ['\n', '\r\n']) {
		const source = ['Uno.', '', 'Due.', '', 'Tre.', '', 'Quattro.'].join(eol);
		const result = apply(source, source.indexOf('ue.'), source.indexOf('re.'));
		assert.equal(result.text, ['Uno.', '', LEFT, '', 'Due.', '', 'Tre.', '', END, '', 'Quattro.'].join(eol));
	}
	// Selecting whole lines up to the start of the next one does not take it in.
	const source = 'Uno.\n\nDue.\nAncora.\n\nTre.';
	assert.equal(apply(source, source.indexOf('Due'), source.indexOf('\n\nTre') + 2).text,
		`Uno.\n\n${LEFT}\n\nDue.\nAncora.\n\n${END}\n\nTre.`);
});

test('refused inside a wrap, on blank lines, and around code, quotes or properties', () => {
	const wrapped = `${LEFT}\n\n![[a.png]]\n\nTesto.\n\n${END}`;
	assert.throws(() => addWrapMarkers(wrapped, wrapped.indexOf('Testo'), wrapped.indexOf('Testo')), /già in un wrap/);
	assert.throws(() => addWrapMarkers('Uno.\n\n\n\nDue.', 6, 6), /Posiziona il cursore/);
	for (const block of ['```\ncodice\n```', '> citazione', '---\ntitolo: x\n---']) {
		const at = block.indexOf(block.includes('codice') ? 'codice' : block.includes('citazione') ? 'citazione' : 'titolo');
		assert.throws(() => addWrapMarkers(block, at, at), /solo testo e immagini/);
	}
});

test('fixing wraps adds only the blank lines and comments they lack, in one edit', () => {
	const fix = (source: string, caret = 0) => {
		const edit = fixWraps(source, caret);
		return { text: source.slice(0, edit.from) + edit.text + source.slice(edit.to), cursor: edit.cursor! };
	};
	for (const eol of ['\n', '\r\n']) {
		const source = ['Prima.', LEFT, '', '![[a.png]]', 'Testo.', END, 'Dopo.'].join(eol);
		const result = fix(source, source.indexOf('Testo'));
		assert.equal(result.text, ['Prima.', '', LEFT, '', '![[a.png]]', 'Testo.', '', END, '', 'Dopo.'].join(eol));
		// The caret stays on the same character.
		assert.equal(result.text.slice(result.cursor, result.cursor + 5), 'Testo');
	}
	// A marker touching another marker gets one blank line, not two.
	const pair = `${LEFT}\n\n![[a.png]]\n\n${END}\n${startMarker('right')}\n\n![[b.png]]\n\n${END}`;
	assert.equal(fix(pair).text, pair.replace(`${END}\n[`, `${END}\n\n[`));
	// Already in order, or only malformed markers: nothing to do, nothing written.
	assert.throws(() => fixWraps(`${LEFT}\n\n![[a.png]]\n\n${END}`, 0), /già in ordine/);
	assert.throws(() => fixWraps(`Testo.\n${START}\n\n![[a.png]]`, 0), /già in ordine/);
});

test('fixing wraps writes the side on every start marker: missing or invalid is left, unknown tokens kept', () => {
	const fix = (source: string) => { const edit = fixWraps(source, 0); return source.slice(0, edit.from) + edit.text + source.slice(edit.to); };
	assert.equal(fix(`${START}\n\n![[a.png|300]]\n\nTesto.\n\n${END}`), `${LEFT}\n\n![[a.png|300]]\n\nTesto.\n\n${END}`);
	assert.equal(fix(`${START} %%iw-wrap side=pippo futuro=1%%\n\n${END}`), `${START} %%iw-wrap side=left futuro=1%%\n\n${END}`);
	assert.equal(fix(`${START}%%iw-wrap side=right%%\n\n![[a.png]]\n\n${END}`), `${startMarker('right')}\n\n![[a.png]]\n\n${END}`);
	// Links are never touched, inside or outside wraps.
	assert.throws(() => fixWraps(`${startMarker('right')}\n\n![[a.png|left wrap]]\n\n${END}`, 0), /già in ordine/);
});

test('removing a wrap takes its markers and their blank lines; the content stays identical', () => {
	const remove = (source: string, at: number) => { const edit = removeWrap(source, at, at); return source.slice(0, edit.from) + edit.text + source.slice(edit.to); };
	for (const eol of ['\n', '\r\n']) {
		const source = ['Prima.', '', LEFT, '', '![[a.png]]', '', '**Testo**.', '', END, '', 'Dopo.'].join(eol);
		assert.equal(remove(source, source.indexOf('Testo')), ['Prima.', '', '![[a.png]]', '', '**Testo**.', '', 'Dopo.'].join(eol));
		// At the end of the note.
		const last = ['Prima.', '', LEFT, '', 'Testo.', '', END].join(eol);
		assert.equal(remove(last, last.indexOf('Testo')), ['Prima.', '', 'Testo.'].join(eol));
	}
	// An empty wrap disappears with one blank line.
	const empty = `Prima.\n\n${LEFT}\n\n\n\n${END}\n\nDopo.`;
	assert.equal(remove(empty, empty.indexOf('%%')), 'Prima.\n\nDopo.');
	// A compact wrap keeps its line structure.
	const compact = `Prima.\n${LEFT}\n![[a.png]]\n${END}\nDopo.`;
	assert.equal(remove(compact, compact.indexOf('![[')), 'Prima.\n![[a.png]]\nDopo.');
	assert.throws(() => remove('Testo.', 0), /dentro un solo wrap/);
});

test('compact wraps: a laid-out wrap with a marker touching its text, never a well-formed one', () => {
	const well = `${START}\n\n![[a.png]]\n\nTesto.\n\n${END}`;
	const compact = `${START}\n![[a.png]]\nTesto.\n${END}`;
	const count = (source: string) => compactWraps(parseDocument(source)).length;
	assert.equal(count(well), 0, 'markers on paragraphs of their own, the first at the note start');
	assert.equal(count(compact), 1);
	assert.equal(count(`${START}\n\n![[a.png]]\n\nTesto.\n${END}`), 1, 'only the end marker touches the text');
	assert.equal(count(`${well}\n\n${compact}\n\n${compact}`), 2);
	assert.equal(count(`${START}\nTesto senza immagine.\n${END}`), 0, 'not a laid-out wrap: nothing is lost in the PDF');
	const edit = fixWraps(compact, 0);
	assert.equal(count(compact.slice(0, edit.from) + edit.text + compact.slice(edit.to)), 0, 'the fix command leaves none');
});


test('fixing one wrap (its bar) changes that wrap only, like the note command would', () => {
	const compact = (side: string) => `${START} %%iw-wrap side=${side}%%\n![[a.png]]\nTesto.\n${END}`;
	const source = `Prima.\n\n${compact('left')}\n\nMezzo.\n\n${compact('right')}`;
	const edit = fixWrap(source, source.indexOf(START));
	const fixed = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
	assert.equal(fixed, `Prima.\n\n${START} %%iw-wrap side=left%%\n\n![[a.png]]\nTesto.\n\n${END}\n\nMezzo.\n\n${compact('right')}`);
	assert.equal(compactWraps(parseDocument(fixed)).length, 1, 'the other compact wrap is left as it is');
	// The note command gives the same first wrap.
	const all = fixWraps(source, 0);
	assert.ok((source.slice(0, all.from) + all.text + source.slice(all.to)).startsWith(fixed.slice(0, fixed.indexOf('Mezzo.'))));
	assert.throws(() => fixWrap(fixed, fixed.indexOf(START)), /già in ordine/);
	assert.throws(() => fixWrap(source, source.indexOf('Mezzo.')), /non trovato/);
});

// No command writes in a zone whose markers do not pair up: refused before
// writing, while the wraps and text around it stay command targets.
test('inside the zone of an end marker without a start, no command writes', () => {
	const source = `${LEFT}\n\n![[a.png]]\n\nTesto.\n\n${END}\n\nOrfano.\n\n![[b.png]]\n\n${END}\n\nDopo.`;
	const orphan = source.indexOf('Orfano');
	for (const [name, command] of Object.entries({ toggleWrapSide, removeWrap, centerImage, addWrap })) {
		assert.throws(() => command(source, orphan, orphan), /marcatori incompleti o annidati/, name);
	}
	assert.throws(() => centerImage(source, source.indexOf('![[b'), source.indexOf('![[b')), /marcatori incompleti o annidati/, 'the image in the zone');
	// The valid wrap before the zone, and the text after it, stay command targets.
	assert.doesNotThrow(() => toggleWrapSide(source, source.indexOf('Testo'), source.indexOf('Testo')));
	assert.doesNotThrow(() => addWrap(source, source.indexOf('Dopo'), source.indexOf('Dopo')));
});
