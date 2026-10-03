import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseObsidian } from './obsidian-versioni.mjs';

// The real-app suite must run the build asked for, or the newest, and never
// quietly fall back to another one.

test('without a version asked for, the newest build by number, not by text', () => {
	assert.equal(chooseObsidian(['config', 'obsidian-1.13.7', 'obsidian-1.13.10', 'obsidian-1.9.0', 'vault']), 'obsidian-1.13.10');
});

test('a version asked for is the one run, even when not the newest', () => {
	assert.equal(chooseObsidian(['obsidian-1.13.0', 'obsidian-1.13.7'], '1.13.0'), 'obsidian-1.13.0');
});

test('a version asked for and missing stops the suite, listing the builds there', () => {
	assert.throws(() => chooseObsidian(['obsidian-1.13.10', 'obsidian-1.13.7'], '1.13.0'), /Obsidian 1\.13\.0 .*presenti: 1\.13\.7, 1\.13\.10\./);
	assert.throws(() => chooseObsidian(['config', 'vault']), /Obsidian non trovato: .*CONTRIBUTING\.md/);
});
