// Every text the plugin shows, in Italian. The English texts (en.ts) have the
// same keys: TypeScript checks that none is missing. Names are for someone
// reading them for the first time: never a bare «riga», which in a note is a
// line of text, but «riga di immagini».
export const it = {
	// Ribbon menu: group titles.
	menuWrap: 'Wrap',
	menuRows: 'Righe di immagini',
	menuStyle: 'Allineamento e distanza',

	// Command names, by command ID (the IDs never change).
	commands: {
		'center-image': 'Centra immagini',
		'add-wrap': 'Aggiungi wrap',
		'toggle-wrap-side': 'Cambia lato del wrap',
		'remove-wrap': 'Rimuovi wrap mantenendo il contenuto',
		'fix-wraps': 'Correggi il formato dei wrap della nota',
		'row-merge': 'Unisci con la riga di immagini vicina',
		'row-separate': 'Metti ogni immagine su una riga propria',
		'row-split-before': 'Dividi la riga di immagini prima di questa',
		'row-move-left': 'Sposta l’immagine a sinistra nella riga',
		'row-move-right': 'Sposta l’immagine a destra nella riga',
		'row-set-align': 'Scegli la distribuzione della riga di immagini',
		'row-set-valign': 'Scegli l’allineamento verticale della riga di immagini',
		'row-set-gap': 'Scegli la distanza tra le immagini',
	},

	// Choices of a row of images (bar menus, dialogs, settings).
	align: { left: 'Sinistra', center: 'Centro', right: 'Destra', between: 'Distribuite sui bordi', evenly: 'Distribuite con margini' },
	valign: { top: 'In alto', center: 'Al centro', bottom: 'In basso' },
	isDefault: ' (predefinito)',
	chooseValue: 'Scegli un valore per la riga di immagini',
	gapPlaceholder: 'Distanza in px sul riferimento da 700 px (es. 16)',
	otherValue: 'Altro valore…',
	otherValueNow: (gap: number) => `Altro valore… (ora ${gap} px)`,

	// Settings tab.
	dragHeading: 'Trascinamento immagini',
	dragName: 'Sposta immagini con trascinamento',
	dragDesc: 'In anteprima dal vivo, trascina un’immagine per riordinarla nella sua riga di immagini, spostarla in un’altra o portarla fra due paragrafi, dove diventa una riga di immagini a sé. Non si può rilasciare dentro un wrap o dentro un paragrafo. Disattiva per lasciare il trascinamento a Obsidian.',
	rowsHeading: 'Righe di immagini: valori predefiniti',
	rowAlignName: 'Allineamento orizzontale',
	rowValignName: 'Allineamento verticale',
	rowDefaultDesc: 'Usato quando la riga di immagini non ha una scelta propria.',
	rowGapName: 'Distanza tra le immagini',
	rowGapDesc: 'In px su una larghezza di riferimento di 700 px: la riga di immagini viene poi scalata allo spazio disponibile.',
	wrapHeading: 'Wrap',
	wrapGapName: 'Distanza tra immagine e testo',
	wrapGapDesc: 'Wrap: un’immagine con il testo che scorre accanto e continua sotto.',
	wrapMaxName: 'Larghezza massima dell’immagine',
	wrapMaxDesc: 'Rispetto alla larghezza della colonna.',
	noticesHeading: 'Avvisi',
	noticeName: 'Durata degli avvisi',
	seconds: 'secondi',
	defaultValue: (value: number, unit: string) => `Predefinito: ${value} ${unit}.`,
	resetName: 'Ripristina valori predefiniti',
	resetDesc: 'Ripristina trascinamento, righe di immagini, wrap e avvisi.',
	resetButton: 'Ripristina',

	// Bars, handles and accessibility labels (Live Preview).
	rowAlignBar: 'Distribuzione della riga di immagini',
	rowValignBar: 'Allineamento verticale della riga di immagini',
	rowGapBar: 'Distanza tra le immagini',
	moveRow: 'Trascina per spostare la riga di immagini',
	moveWrap: 'Trascina per spostare il wrap',
	resizeImage: 'Trascina per ridimensionare l’immagine',
	fixWrap: 'Correggi il formato del wrap',
	rowToolbar: 'Comandi della riga di immagini',
	wrapToolbar: 'Comandi del wrap',
	rowPreview: 'Riga di immagini. Fai clic per modificare.',
	wrapPreview: 'Regione wrap. Fai clic per modificare.',
	previewUnavailable: 'Anteprima non disponibile. Fai clic per modificare.',

	// Notices: commands in general.
	openNote: 'Apri una nota per usare questo comando.',
	switchToEditing: 'Passa alla modalità modifica per usare questo comando.',
	oneSelection: 'Usa una sola selezione.',
	cannotChangeSelection: 'Impossibile modificare la selezione.',
	placeCursorInNote: 'Posiziona il cursore nella nota.',
	placeCursorOnImage: 'Posiziona il cursore sul collegamento di una sola immagine o selezionalo.',
	selectionInMarkdown: 'La selezione deve iniziare e finire nel normale Markdown.',

	// Notices: wrap markers.
	nestedMarkers: 'Marcatori annidati: layout disattivato.',
	endWithoutStart: 'Marcatore di fine senza inizio.',
	startWithoutEnd: 'Marcatore di inizio senza fine: layout disattivato.',
	fixMarkersInZone: 'Correggi i marcatori incompleti o annidati nella zona interessata.',
	fixMarkersOverlap: 'Correggi i marcatori esistenti ed evita regioni sovrapposte.',

	// Notices: wraps.
	cursorInOneWrap: 'Posiziona il cursore dentro un solo wrap.',
	selectionCrossesWrap: 'La selezione attraversa il confine del wrap.',
	selectionCrossesWrapCenter: 'La selezione attraversa il confine del wrap: seleziona solo la regione o posiziona il cursore al suo interno.',
	oneWrapAtATime: 'Modifica una sola regione wrap alla volta.',
	wrapImageError: 'La regione deve iniziare con una sola immagine, su una riga propria.',
	alreadyInWrap: 'Il testo è già in un wrap.',
	alreadyInWrapSwitchSide: 'Il testo è già in un wrap: usa Cambia lato del wrap per spostare l’immagine.',
	wrapOnlyTextAndImages: 'Il wrap può contenere solo testo e immagini: niente codice, citazioni, commenti o proprietà.',
	multiImageRowToWrap: 'Una riga di più immagini non diventa un wrap: sposta prima l’immagine su una riga propria.',
	selectOneImageWithText: 'Seleziona una sola immagine con il testo da affiancare.',
	selectImageOnOwnLine: 'Seleziona un’immagine su una riga propria, eventualmente seguita dal testo da affiancare.',
	selectImageAndText: 'Seleziona prima immagine e testo da includere.',
	placeCursorOnParagraph: 'Posiziona il cursore su un paragrafo o seleziona il testo da mettere nel wrap.',
	wrapsInOrder: 'I wrap di questa nota sono già in ordine.',
	wrapInOrder: 'Questo wrap è già in ordine.',
	wrapNotFoundChanged: 'Wrap non trovato: la nota è cambiata.',
	cannotChangeWrap: 'Impossibile modificare il wrap.',
	wrapLimit: (percent: number) => `Larghezza massima dell’immagine nel wrap: ${percent}% della colonna. Si cambia in Impostazioni → Wrap.`,
	wrapChangedWhileResizing: 'Il wrap è cambiato durante il ridimensionamento: nessuna modifica.',

	// Notices: rows of images.
	centerNeedsRow: 'Centra immagini agisce su una riga di immagini, separata dal testo da righe vuote.',
	placeCursorOnRow: 'Posiziona il cursore su una riga di immagini.',
	placeCursorOnRowImage: 'Posiziona il cursore sul collegamento di una sola immagine della riga di immagini.',
	noNearbyRow: 'Non c’è una riga di immagini subito prima o dopo, separata soltanto da righe vuote.',
	selectTwoRows: 'Seleziona almeno due righe di immagini, separate soltanto da righe vuote.',
	rowHasOneImage: 'La riga di immagini contiene una sola immagine.',
	splitAtFirstImage: 'È la prima immagine della riga di immagini: la prima parte sarebbe vuota.',
	alreadyFirst: 'L’immagine è già la prima della riga di immagini.',
	alreadyLast: 'L’immagine è già l’ultima della riga di immagini.',
	rowChangedWhileChoosing: 'La riga di immagini è cambiata mentre sceglievi: nessuna modifica.',
	noteChangedWhileChoosing: 'Mentre sceglievi è stata aperta un’altra nota: nessuna modifica.',
	cannotChangeRow: 'Impossibile modificare la riga di immagini.',
	waitForImages: 'Attendi il caricamento delle immagini prima di ridimensionare.',
	rowChangedWhileResizing: 'La riga di immagini è cambiata durante il ridimensionamento: nessuna modifica.',

	// Notices: dragging.
	imageIntoWrap: 'Non puoi inserire un’immagine in un wrap: il wrap gestisce una sola immagine. Usa una riga di immagini per affiancarne più di una.',
	wrapIntoWrap: 'Un wrap non può stare dentro un altro wrap: rilascialo fra due paragrafi.',
	rowIntoWrap: 'Una riga di immagini non può stare dentro un wrap: rilasciala fra due paragrafi.',
	dropBetweenBlocks: 'Rilascia tra due blocchi di testo, fuori da codice e proprietà.',
	dropWrapBetweenBlocks: 'Rilascia il wrap tra due blocchi di testo, fuori da codice ed elenchi.',
	dropRowBetweenBlocks: 'Rilascia la riga di immagini tra due blocchi di testo, fuori da codice ed elenchi.',
	chooseSlotInRow: 'Scegli uno spazio dentro la riga di immagini.',
	dropInSameEditor: 'Rilascia nella stessa nota, dentro questo editor.',
	dropOutsideCode: 'Rilascia fuori da codice, citazioni e proprietà.',
	dropOnVisibleBlock: 'Rilascia su un blocco visibile.',
	dropPositionUnavailable: 'Posizione di rilascio non disponibile.',
	dropNotAllowed: 'Destinazione non consentita.',
	imageNotFound: 'Immagine non trovata nella nota: riprova.',
	wrapNotFound: 'Wrap non trovato nella nota: riprova.',
	rowNotFound: 'Riga di immagini non trovata nella nota: riprova.',
	rowNotReady: 'Riga di immagini non ancora pronta: riprova.',
	noteChangedMoveCancelled: 'La nota è cambiata: spostamento annullato.',
	dragCancelled: 'La nota o le impostazioni sono cambiate: trascinamento annullato.',
	moveCancelled: 'Spostamento annullato.',

	// Notices: PDF export and settings file.
	compactWrapsInPdf: (count: number, name: string) => count === 1
		? `Nel PDF 1 wrap di «${name}» non è impaginato: ha i marcatori attaccati al testo. Usa «Correggi il formato dei wrap della nota» e riesporta.`
		: `Nel PDF ${count} wrap di «${name}» non sono impaginati: hanno i marcatori attaccati al testo. Usa «Correggi il formato dei wrap della nota» e riesporta.`,
	cannotReadSettings: 'Impossibile leggere le preferenze: uso i valori predefiniti, senza salvarli.',
	settingsNotRead: 'Le preferenze salvate non sono state lette all’avvio: le modifiche valgono solo per questa sessione, per non sovrascriverle. Riavvia Obsidian; se succede ancora, il file data.json del plugin è danneggiato.',
	cannotSaveSettings: 'Impossibile salvare le preferenze. Le modifiche valgono solo per questa sessione.',
};

export type Strings = typeof it;
