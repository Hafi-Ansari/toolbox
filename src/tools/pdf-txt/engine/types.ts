// What the PDF → TXT engine returns. Everything carries its source page
// (0-based page index), so a preview can link each line to the page image.

export type Mode = "poetry" | "prose";

/** A rectangle on the source page, in PDF points from the page's top-left corner. */
export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** One output line. An empty `text` is a stanza break (poetry) or paragraph break (prose). */
export interface TxtLine {
	text: string;
	/** Page the line starts on. */
	page: number;
	/** Where the printed line sits (poetry: the line; prose: the start of the sentence's paragraph). */
	box?: Box;
	/** Poetry: how far the line is indented from the work's left edge on its page, in ems (0 when flush). */
	indent?: number;
	/** The printed lines this line comes from, in reading order: what a manual override is keyed to. */
	span?: SourceSpan;
}

export type WorkKind =
	/** A poem, story, chapter: the units the TXT is made of. */
	| "work"
	/** A part or section divider ("II", "Part One: Arrival"): a title with little or no body. */
	| "section"
	/** Front or back matter (copyright, contents, about the author): left out of the TXT by default. */
	| "matter";

export interface Work {
	kind: WorkKind;
	/** Empty for an untitled work. */
	title: string;
	/** Page where the work starts, and the last page it covers. */
	page: number;
	endPage: number;
	/** Where the printed title sits, when it was found on the page. */
	titleBox?: Box;
	/** How the start was found. */
	source: "outline" | "layout" | "start";
	/** 0..1: how sure the engine is that a work starts here and that this is its title. */
	confidence: number;
	/** Body lines, with "" for stanza or paragraph breaks. Never starts or ends with "". */
	lines: TxtLine[];
}

export type FlagKind =
	/** A scanned page with no text layer: its words need OCR. */
	| "image-only"
	/** A page with no text at all (blank leaf, divider, or a picture). */
	| "empty-page"
	/** A short line at the page edge was removed as a probable page number or running head. */
	| "furniture-removed"
	/** A short line at the page edge was kept, but may be a page number or running head. */
	| "furniture-kept"
	/** A title the engine is unsure of (weak styling, odd position, or an outline title not found on its page). */
	| "low-confidence-title"
	/** Two printed lines were joined as one wrapped verse line. */
	| "wrap-joined"
	/** A printed line reaches the right margin: it may be one long verse line wrapped by the layout. */
	| "possible-wrap"
	/** Text that OCR probably misread (a pattern typical of OCR noise). */
	| "ocr-noise"
	/** A typical OCR misreading was corrected (a lone "|" read back as "I"). */
	| "ocr-fixed"
	/** On-demand OCR found a line the PDF's text lacks, and added it. */
	| "ocr-added"
	/** On-demand OCR replaced a garbled line of the PDF's text (the two readings barely resemble each other). */
	| "ocr-replaced"
	/** On-demand OCR reads a line differently; the PDF's text was kept. */
	| "ocr-differs"
	/** A scan without a text layer was read by on-demand OCR. */
	| "ocr-page";

export interface Flag {
	kind: FlagKind;
	page: number;
	reason: string;
	/** Index into `works`, when the flag belongs to one. */
	work?: number;
	/** The text concerned, when there is one. */
	text?: string;
	box?: Box;
}

export interface TxtResult {
	mode: Mode;
	works: Work[];
	flags: Flag[];
	/** How works were found: from the PDF outline, from page layout, or both (outline sections, layout titles). */
	detection: "outline" | "layout" | "outline+layout";
	pages: number;
}

export interface ConvertOptions {
	mode: Mode;
	/** Language for sentence splitting in prose mode (BCP 47). Default "en". */
	lang?: string;
	/** Corrections a person made, keyed to the source. Each applies only where it fits (see Override). */
	overrides?: Override[];
}

export interface ExportOptions {
	/** Include front and back matter (copyright, contents, notes). Default false. */
	matter?: boolean;
	/** Include section dividers ("II", "Part I") as title-only works. Default true. */
	sections?: boolean;
	/** Keep poetry indentation as leading spaces, two per em (a monospace approximation). Default true. */
	indent?: boolean;
}

/** A point in the book's reading order: a page and a height on it, in PDF points from the top. */
export interface SourcePos {
	page: number;
	y: number;
}

/**
 * A stretch of the source in reading order, from the top of its first printed
 * line to the bottom of its last. A printed line belongs to the span when its
 * middle lies inside it.
 */
export interface SourceSpan {
	from: SourcePos;
	to: SourcePos;
}

/**
 * A manual correction, tied to where the text is printed (never to TXT line
 * numbers), so it survives re-conversion, mode switches and export options.
 * `text` is a short label for listing the override; the engine ignores it.
 */
export type Override =
	/** Prose mode: keep these printed lines as printed (verse quoted in prose): one TXT line each, stanzas from gaps. */
	| { kind: "lines"; span: SourceSpan; text?: string }
	/** Poetry mode: reflow these printed lines into paragraphs, one sentence per line (a prose poem, a note). */
	| { kind: "reflow"; span: SourceSpan; text?: string }
	/** Poetry (and kept lines in prose): join the printed line at `at` to the line above, one verse line wrapped by the layout. */
	| { kind: "join"; at: SourcePos; text?: string };
