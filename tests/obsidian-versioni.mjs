// Which Obsidian build of .obsidian-test/ the real-app suite runs: the one
// named by IW_OBSIDIAN_VERSIONE (e.g. 1.13.0, the minimum the plugin declares),
// or else the newest, by version number (1.13.10 comes after 1.13.7).

const numbers = name => name.slice('obsidian-'.length).split('.').map(Number);

/**
 * @param {string[]} names the entries of .obsidian-test/
 * @param {string} [wanted] a version, as in IW_OBSIDIAN_VERSIONE
 * @returns {string} the folder of the build to run
 */
export function chooseObsidian(names, wanted) {
	const builds = names.filter(name => /^obsidian-\d+(\.\d+)*$/.test(name)).sort((a, b) => {
		const [x, y] = [numbers(a), numbers(b)];
		for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
		return 0;
	});
	if (!builds.length) throw new Error('Obsidian non trovato: estrai il tar.gz per Linux in .obsidian-test/ (vedi CONTRIBUTING.md).');
	if (!wanted) return builds[builds.length - 1];
	if (builds.includes(`obsidian-${wanted}`)) return `obsidian-${wanted}`;
	throw new Error(`Obsidian ${wanted} (IW_OBSIDIAN_VERSIONE) non trovato in .obsidian-test/; presenti: ${builds.map(name => name.slice('obsidian-'.length)).join(', ')}.`);
}
