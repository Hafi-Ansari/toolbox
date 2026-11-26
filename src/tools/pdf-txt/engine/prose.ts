// Prose: rebuild paragraphs with the shared toParagraphs (which joins printed
// wraps and paragraphs that run across pages), then put one sentence per line.
import { type Block, type PageModel, toParagraphs } from "../../../lib/pdf/heuristics.ts";
import { sourceFinder } from "./source.ts";
import type { Box, TxtLine } from "./types.ts";

/** A piece of a work on one page: everything between `fromY` and `toY`, minus the title. */
export interface Slice {
	model: PageModel;
	fromY: number;
	toY: number;
	exclude?: Box;
}

const ABBREV =
	/(?:^|[\s(“"‘'])(?:Mr|Mrs|Ms|Mx|Dr|Prof|St|Sr|Jr|Mt|Ft|Gen|Col|Capt|Cpt|Lt|Sgt|Maj|Cmdr|Adm|Gov|Sen|Rep|Rev|Fr|Hon|Pres|Supt|Insp|vs|etc|cf|al|approx|ca|esp|incl|fig|figs|vol|vols|no|nos|pp|ch|chap|ed|eds|trans|op|cit|ibid|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Ave|Blvd|Rd|Inc|Ltd|Co|Corp|Bros)\.$/i;
/** Ends with an initial ("J.", "J. R. R.") or a dotted abbreviation ("e.g.", "U.S."). */
const INITIAL = /(?:^|[\s(“"‘'.])\p{Lu}\.$|\b(?:\p{L}\.){2,}$/u;

/**
 * Splits a paragraph into sentences with Intl.Segmenter, then mends the splits
 * it gets wrong in books: after abbreviations and initials, and before a
 * lowercase continuation (“Go!” she said).
 */
export function sentences(text: string, lang = "en"): string[] {
	const seg = new Intl.Segmenter(lang, { granularity: "sentence" });
	const parts = [...seg.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
	const out: string[] = [];
	for (const part of parts) {
		const last = out[out.length - 1];
		if (last !== undefined && (ABBREV.test(last) || INITIAL.test(last) || /^[\p{Ll}]/u.test(part)))
			out[out.length - 1] = `${last} ${part}`;
		else out.push(part);
	}
	return out;
}

const center = (l: { x0: number; y0: number; x1: number; y1: number }) => ({
	x: (l.x0 + l.x1) / 2,
	y: (l.y0 + l.y1) / 2,
});
const inBox = (p: { x: number; y: number }, b: Box) =>
	p.x >= b.x0 - 1 && p.x <= b.x1 + 1 && p.y >= b.y0 - 1 && p.y <= b.y1 + 1;

/** The part of a page model a slice covers. */
function cut(s: Slice): PageModel {
	const blocks: Block[] = [];
	for (const b of s.model.blocks) {
		if (b.kind !== "text") continue;
		const lines = b.lines.filter((l) => {
			const c = center(l);
			return c.y >= s.fromY && c.y < s.toY && !(s.exclude && inBox(c, s.exclude));
		});
		if (lines.length) blocks.push({ ...b, lines });
	}
	return { ...s.model, blocks };
}

/**
 * Born-digital books often come one block per printed line, which the shared
 * paragraph builder only rejoins for OCR pages. When most blocks are single
 * lines, treat them as OCR pages are treated.
 */
export function fragmentedBook(models: PageModel[]): boolean {
	let blocks = 0;
	let single = 0;
	for (const m of models)
		if (!m.ocr)
			for (const b of m.blocks)
				if (b.kind === "text") {
					blocks++;
					if (b.lines.length === 1) single++;
				}
	return blocks > 20 && single / blocks > 0.6;
}

export function proseLines(slices: Slice[], body: number, opts: { lang?: string; merge: boolean }): TxtLine[] {
	// A fragmented born-digital page is read the way an OCR layer is: blocks rejoined
	// into paragraphs, and a paragraph cut at the foot of a page carried onto the next
	// page's first unindented line ("…the road home, like" / "Boston.").
	const models = slices.map(cut).map((m) => (opts.merge ? { ...m, ocr: true } : m));
	const out: TxtLine[] = [];
	// Where each sentence was printed (its first line), for the preview and for manual overrides.
	const locate = sourceFinder(models);
	for (const para of toParagraphs(models, body)) {
		if (para.kind === "img") continue;
		if (out.length) out.push({ text: "", page: para.page });
		if (para.kind !== "p") {
			out.push({ text: para.text.trim(), page: para.page, ...locate(para.text) });
			continue;
		}
		for (const s of sentences(para.text, opts.lang)) out.push({ text: s, page: para.page, ...locate(s) });
	}
	return out;
}
