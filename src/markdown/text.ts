// Small text rules shared by the Markdown modules.

// The note's own line ending, so an edit never mixes CRLF and LF.
export const eolOf = (source: string): string => source.includes('\r\n') ? '\r\n' : '\n';

// An embedded wikilink, `![[path|params]]`. Global: use it with matchAll, which
// copies the expression, never with exec or test.
export const EMBED = /!\[\[([^\]\n]+)\]\]/g;

// Inline code replaced by spaces of the same length: offsets stay the same, and
// what is inside the code is never read as Markdown.
export const maskCodeSpans = (text: string): string => text.replace(/(`+)([\s\S]*?)\1(?!`)/g, match => ' '.repeat(match.length));
