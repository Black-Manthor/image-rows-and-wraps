import { en } from './en';
import { it, type Strings } from './it';

export type { Strings };

// The texts the plugin shows, in Obsidian's language: Italian when Obsidian is
// in Italian, English otherwise. main.ts sets it at load from getLanguage();
// Obsidian changes language only on restart, which reloads the plugin. The
// modules read it when they show a text, never at import: a text asked for
// before the language is set stops everything, in every test suite, instead
// of showing the wrong language.
let current: Strings | undefined;

export function setLanguage(code: string): void {
	current = /^it\b/i.test(code) ? it : en;
}

export function t(): Strings {
	if (!current) throw new Error('A text was asked for before setLanguage(): read texts when shown, not at import.');
	return current;
}
