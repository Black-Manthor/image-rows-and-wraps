// Shared by the browser suite and manual Obsidian fixture generation.
import { pathToFileURL } from 'node:url';
export function longNote(count, imagePath = 'foto-prova.png') {
	if (![10, 50, 100].includes(count)) throw new Error('Usa 10, 50 oppure 100 righe di immagini.');
	return '# Prova nota lunga\n\n' + Array.from({ length: count }, (_, index) =>
		`## Sezione ${index + 1}\n\n` + ('Paragrafo di prova con testo prima delle immagini. '.repeat(30)) +
		`\n\n![[${imagePath}|100]] ![[${imagePath}|140]] %%iw-row align=center%%\n\n` +
		('Testo dopo la riga, che deve restare sotto tutte le immagini. '.repeat(30)) + '\n\n'
	).join('') + 'FINE DELLA NOTA\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.stdout.write(longNote(Number(process.argv[2] ?? 100), process.argv[3]));
}
