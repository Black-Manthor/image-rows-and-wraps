import { Notice } from 'obsidian';
import type { ImageSettings } from '../settings';

// Every notice lasts as long as the settings say.
export function notify(settings: ImageSettings, message: string): void {
	new Notice(message, settings.noticeSeconds * 1000);
}

// The error's own message (the commands throw readable ones), or the fallback.
export function notifyError(settings: ImageSettings, error: unknown, fallback: string): void {
	notify(settings, error instanceof Error ? error.message : fallback);
}
