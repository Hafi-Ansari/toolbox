// Pure functions that turn positioned PDF text into reflowable structure.
// No MuPDF imports here, so everything is unit-testable with plain fixtures.
// Shared by every tool that reads PDF text; output formats live with their tool.
import { cleanText } from "./text.ts";

export interface Line {
	text: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Dominant font size of the line, in points. */
	size: number;
	bold: boolean;
	italic: boolean;
}

export interface TextBlock {
	kind: "text";
	lines: Line[];
}

export interface ImageBlock {
	kind: "image";
	href: string;
	width: number;
	height: number;
}

export type Block = TextBlock | ImageBlock;

export interface PageModel {
	index: number;
	width: number;
	height: number;
	blocks: Block[];
	/** The text is an OCR layer over a scan: fragmented into lines and word groups that need rejoining. */
	ocr?: boolean;
	/** A scanned page with no text layer: its words, if any, exist only in the image and need OCR. */
	imageOnly?: boolean;
}

export type Para =
	| { kind: "p" | "h1" | "h2" | "h3"; text: string; page: number }
	| { kind: "img"; href: string; width: number; height: number; page: number };

export interface OutlineEntry {
	title: string;
	page: number;
	level: number;
}

const roundHalf = (n: number) => Math.round(n * 2) / 2;

/** The most common font size, weighted by characters. That is the body text. */
export function bodyFontSize(pages: PageModel[]): number {
	const weights = new Map<number, number>();
	for (const p of pages)
		for (const b of p.blocks)
			if (b.kind === "text")
				for (const l of b.lines) {
					const k = roundHalf(l.size);
					weights.set(k, (weights.get(k) ?? 0) + l.text.length);
				}
	let best = 10;
	let bestW = -1;
	for (const [size, w] of weights) if (w > bestW) [best, bestW] = [size, w];
	return best;
}

const PAGE_NUMBER = /^[\s\p{P}]*(?:page\s*)?(?:\d{1,5}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,5})?[\s\p{P}]*$/iu;

/** Normalizes running-header text so "Chapter 3 · 41" and "Chapter 3 · 42" match. */
export function furnitureKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\d+/g, "#")
		.replace(/\b[ivxlcdm]+\b/g, "#")
		.replace(/\s+/g, " ")
		.trim();
}

type Band = "top" | "bottom";

function bandOf(block: TextBlock, page: PageModel): Band | null {
	const y0 = Math.min(...block.lines.map((l) => l.y0));
	const y1 = Math.max(...block.lines.map((l) => l.y1));
	if (y1 <= page.height * 0.09) return "top";
	if (y0 >= page.height * 0.91) return "bottom";
	return null;
}

const blockText = (b: TextBlock) =>
	b.lines
		.map((l) => l.text)
		.join(" ")
		.trim();

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };

function romanValue(s: string): number {
	let total = 0;
	for (let i = 0; i < s.length; i++) {
		const v = ROMAN[s[i]];
		const next = ROMAN[s[i + 1]] ?? 0;
		total += v < next ? -v : v;
	}
	return total;
}

/**
 * The page number printed at either end of a short header or footer line,
 * like "30 What Is Gender?" or "Introduction xvii". Roman numerals count only
 * in lowercase, so a heading such as "PART I" is not mistaken for one.
 */
export function folioOf(text: string): { kind: "arabic" | "roman"; value: number } | null {
	const t = text.trim();
	if (t.length > 90) return null;
	const m = /^(\d{1,4}|[ivxlc]{1,8})\b|\b(\d{1,4}|[ivxlc]{1,8})$/.exec(t);
	const token = m?.[1] ?? m?.[2];
	if (!token) return null;
	if (/^\d+$/.test(token)) return { kind: "arabic", value: Number(token) };
	const value = romanValue(token);
	return value > 0 ? { kind: "roman", value } : null;
}

/**
 * Removes running headers, footers and page numbers: short blocks in the top
 * or bottom band whose normalized text repeats on many pages, or that carry a
 * page number in step with the page sequence (running heads that change with
 * every chapter, as in most printed books). Mutates and returns `pages`.
 */
export function stripFurniture(pages: PageModel[]): PageModel[] {
	// Printed page number = page index - offset, and the offset stays constant
	// over long runs of pages. An offset seen on 3+ pages marks real folios.
	const folioKey = (b: TextBlock, page: PageModel) => {
		if (b.lines.length > 2 || !bandOf(b, page)) return null;
		const f = folioOf(blockText(b));
		return f ? { kind: f.kind, offset: page.index - f.value } : null;
	};
	const offsets = new Map<string, number>();
	for (const page of pages)
		for (const b of page.blocks) {
			if (b.kind !== "text") continue;
			const k = folioKey(b, page);
			if (k) offsets.set(`${k.kind}|${k.offset}`, (offsets.get(`${k.kind}|${k.offset}`) ?? 0) + 1);
		}
	const isFolio = (b: TextBlock, page: PageModel) => {
		const k = folioKey(b, page);
		if (!k) return false;
		for (let d = -1; d <= 1; d++) if ((offsets.get(`${k.kind}|${k.offset + d}`) ?? 0) >= 3) return true;
		return false;
	};

	const counts = new Map<string, number>();
	for (const page of pages) {
		const seen = new Set<string>();
		for (const b of page.blocks) {
			if (b.kind !== "text" || b.lines.length > 2) continue;
			const band = bandOf(b, page);
			if (!band) continue;
			const key = `${band}|${furnitureKey(blockText(b))}`;
			if (!seen.has(key)) {
				seen.add(key);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
	}
	const threshold = Math.max(3, Math.ceil(pages.length * 0.25));
	for (const page of pages) {
		page.blocks = page.blocks.filter((b) => {
			if (b.kind !== "text" || b.lines.length > 2) return true;
			const band = bandOf(b, page);
			if (!band) return true;
			const text = blockText(b);
			if (PAGE_NUMBER.test(text) || isFolio(b, page)) return false;
			return (counts.get(`${band}|${furnitureKey(text)}`) ?? 0) < threshold;
		});
	}
	return pages;
}

/** Joins wrapped lines, undoing end-of-line hyphenation. */
export function joinLines(lines: string[]): string {
	let out = "";
	for (const raw of lines) {
		const line = raw.replace(/­/g, "").trim();
		if (!line) continue;
		if (!out) out = line;
		else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
		else out += ` ${line}`;
	}
	return out.replace(/\s+/g, " ");
}

function headingLevel(lines: Line[], text: string, body: number): "h1" | "h2" | "h3" | null {
	if (lines.length > 3 || text.length > 160 || text.length === 0) return null;
	const size = Math.max(...lines.map((l) => l.size));
	const r = size / body;
	if (r >= 1.75) return "h1";
	if (r >= 1.35) return "h2";
	if (r >= 1.15) return "h3";
	if (lines.every((l) => l.bold) && lines.length <= 2 && text.length < 90 && !/[.,;:]$/.test(text) && r >= 0.95)
		return "h3";
	return null;
}

/**
 * Splits one text block into paragraphs. MuPDF usually gives one block per
 * paragraph, but justified books often pack several into a block; a new
 * paragraph starts at a first-line indent after a sentence-ending line.
 */
function splitBlock(block: TextBlock): Line[][] {
	const lines = block.lines;
	if (lines.length < 3) return [lines];
	const left = Math.min(...lines.map((l) => l.x0));
	const right = Math.max(...lines.map((l) => l.x1));
	const out: Line[][] = [];
	let cur: Line[] = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const prev = lines[i - 1];
		const indented = l.x0 - left > l.size * 0.8;
		const prevShort = prev && prev.x1 < right - prev.size * 2.5;
		const prevEnds = prev && /[.!?:"”’)\]…]$/.test(prev.text.trim());
		if (prev && indented && (prevEnds || prevShort)) {
			out.push(cur);
			cur = [];
		}
		cur.push(l);
	}
	if (cur.length) out.push(cur);
	return out;
}

const ENDS_SENTENCE = /[.!?:"”’)\]…]$/;

/**
 * Joins text blocks that are really one paragraph: OCR text layers in scanned
 * books often come as one block per line or two. Two blocks merge when the
 * second starts on the next line (normal leading), in the same column and
 * style, and the first does not end with a short, sentence-ending line (a
 * paragraph end). splitBlock() later splits merged runs at first-line indents.
 */
export function mergeBlocks(blocks: Block[]): Block[] {
	// The text column's right edge: where most lines end (a high percentile, so
	// short last lines and headings don't pull it in).
	const ends: number[] = [];
	for (const b of blocks) if (b.kind === "text") for (const l of b.lines) ends.push(l.x1);
	ends.sort((a, b) => a - b);
	const right = ends.length ? ends[Math.floor(ends.length * 0.8)] : 0;
	const continues = (a: TextBlock, b: TextBlock) => continuesParagraph(a, b, right);
	const out: Block[] = [];
	for (const b of blocks) {
		const prev = out[out.length - 1];
		const lines = b.kind === "text" ? joinFragments(b.lines) : [];
		if (b.kind === "text" && prev?.kind === "text" && sameBaseline(prev.lines[prev.lines.length - 1], lines[0]))
			prev.lines = joinFragments([...prev.lines, ...lines]);
		else if (b.kind === "text" && prev?.kind === "text" && continues(prev, { kind: "text", lines }))
			prev.lines.push(...lines);
		else out.push(b.kind === "text" ? { kind: "text", lines } : b);
	}
	return out;
}

/**
 * Rejoins one printed line that OCR split into word groups ("okay way",
 * "to communicate,", "as", "long" …): consecutive lines that share a baseline
 * and run left to right become a single line.
 */
function sameBaseline(prev: Line | undefined, l: Line | undefined): boolean {
	if (!prev || !l) return false;
	const overlap = Math.min(prev.y1, l.y1) - Math.max(prev.y0, l.y0);
	const h = Math.min(prev.y1 - prev.y0, l.y1 - l.y0);
	return h > 0 && overlap > h * 0.5 && l.x0 >= prev.x1 - l.size * 1.5 && l.x0 > prev.x0;
}

export function joinFragments(lines: Line[]): Line[] {
	const out: Line[] = [];
	for (const l of lines) {
		const prev = out[out.length - 1];
		if (prev && sameBaseline(prev, l)) {
			out[out.length - 1] = {
				...prev,
				text: `${prev.text.trimEnd()} ${l.text.trimStart()}`,
				x1: Math.max(prev.x1, l.x1),
				y0: Math.min(prev.y0, l.y0),
				y1: Math.max(prev.y1, l.y1),
				size: Math.max(prev.size, l.size),
				bold: prev.bold && l.bold,
				italic: prev.italic && l.italic,
			};
		} else out.push(l);
	}
	return out;
}

function continuesParagraph(a: TextBlock, b: TextBlock, columnRight: number): boolean {
	const last = a.lines[a.lines.length - 1];
	const first = b.lines[0];
	const size = Math.max(last.size, first.size);
	// OCR sizes come from line boxes, so a line without descenders measures smaller;
	// allow more slack when the next line plainly continues the sentence.
	const lower = /^[\p{Ll}]/u.test(first.text.trim());
	if (!size || Math.abs(last.size - first.size) > size * (lower ? 0.5 : 0.12) || last.bold !== first.bold) return false;
	const lineH = Math.max(last.y1 - last.y0, first.y1 - first.y0) || size;
	const gap = first.y0 - last.y1;
	if (gap < -lineH * 0.3 || gap > lineH * 0.6) return false;
	const aLeft = Math.min(...a.lines.map((l) => l.x0));
	const aRight = Math.max(...a.lines.map((l) => l.x1));
	const bLeft = Math.min(...b.lines.map((l) => l.x0));
	const bRight = Math.max(...b.lines.map((l) => l.x1));
	// Same column: starts within an indent of each other, and the boxes meet
	// (a short last line may sit entirely left of an indented first line's start).
	if (Math.abs(bLeft - aLeft) > size * 2.5 || bLeft >= aRight || bRight + size * 2.5 < aLeft) return false;
	const endsParagraph = last.x1 < Math.max(aRight, columnRight) - size * 2.5 && ENDS_SENTENCE.test(last.text.trim());
	return !endsParagraph;
}

/** The left margin of a page's text: the median line start. */
function leftMargin(page: PageModel): number {
	const xs: number[] = [];
	for (const b of page.blocks) if (b.kind === "text") for (const l of b.lines) xs.push(l.x0);
	xs.sort((a, b) => a - b);
	return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
}

const isWord = (t: string) => {
	const w = t.replace(/^[“"‘'([]+|[.,;:!?”"’')\]]+$/g, "");
	return (
		/^(?:[A-Za-z][a-z’'-]*[a-z]|[A-Z][A-Z’'-]*[A-Z])$/.test(w) &&
		w.replace(/[^A-Za-z]/g, "").length >= 4 &&
		/[aeiouy]/i.test(w)
	);
};

/**
 * True for OCR noise rather than text: what a scanner "reads" in show-through
 * from the other side of a blank page ("ee ae Th — oe ca"). Real text, even a
 * references or contents page, is mostly words of four or more letters; noise
 * is mostly fragments.
 */
export function isJunkText(text: string): boolean {
	const tokens = text.split(/\s+/).filter(Boolean);
	if (tokens.length < 2) return false;
	return tokens.filter(isWord).length / tokens.length < 0.3;
}

/**
 * Turns page models into a flat paragraph stream. A paragraph that MuPDF split
 * into two blocks, or that continues on the next page, is joined back together
 * when the first part does not end a sentence and the next starts lowercase.
 */
export function toParagraphs(pages: PageModel[], body: number): Para[] {
	const out: Para[] = [];
	let lastSize = 0;
	// Footnotes sit between the halves of a paragraph that runs onto the next
	// page; they are held back and emitted before the next new paragraph.
	let notes: Para[] = [];
	const flushNotes = () => {
		if (notes.length) out.push(...notes);
		notes = [];
	};
	for (const page of pages) {
		let firstOnPage = true;
		const left = leftMargin(page);
		// Born-digital PDFs already come in sensible blocks (and joining them would
		// fold tables into one line); OCR text layers need rejoining.
		const blocks = page.ocr ? mergeBlocks(page.blocks) : page.blocks;
		const noteStart = blocks.findIndex((b, i) => isFootnote(b, blocks[i - 1], page, body));
		// Text below the first note is notes too, as long as it is set no larger.
		const pageNotes: Block[] = [];
		if (noteStart >= 0) {
			const noteH = lineHeight(blocks[noteStart]);
			for (const b of blocks.slice(noteStart)) {
				if (b.kind !== "text" || lineHeight(b) > noteH * 1.1 || b.lines.some((l) => l.bold)) break;
				pageNotes.push(b);
			}
		}
		for (const b of blocks) {
			if (pageNotes.includes(b)) {
				const text = b.kind === "text" ? cleanText(joinLines(b.lines.map((l) => l.text))) : "";
				if (text) notes.push({ kind: "p", text, page: page.index });
				continue;
			}
			if (b.kind === "image") {
				flushNotes();
				out.push({ kind: "img", href: b.href, width: b.width, height: b.height, page: page.index });
				firstOnPage = false;
				continue;
			}
			for (const group of splitBlock(b)) {
				const text = cleanText(joinLines(group.map((l) => l.text)));
				if (!text) continue;
				const kind = headingLevel(group, text, body) ?? "p";
				const size = group[0].size;
				const last = out[out.length - 1];
				const sameStyle = firstOnPage || Math.abs(size - lastSize) < 0.6;
				// A body paragraph cut off at the foot of a page continues on the next
				// page's first unindented line, whatever case that line starts with.
				// (Scans only: a born-digital page may open with a figure or table caption.)
				const carriesOver =
					page.ocr &&
					firstOnPage &&
					kind === "p" &&
					last?.kind === "p" &&
					last.text.length > 60 &&
					!ENDS_SENTENCE.test(last.text) &&
					group[0].x0 - left <= size * 0.8;
				if (carriesOver) {
					last.text = /[a-z]-$/.test(last.text) ? last.text.slice(0, -1) + text : `${last.text} ${text}`;
				} else if (
					last?.kind === kind &&
					(kind === "p" || !firstOnPage) &&
					sameStyle &&
					!ENDS_SENTENCE.test(last.text) &&
					/^[\p{Ll}]/u.test(text)
				) {
					last.text = /[a-z]-$/.test(last.text) ? last.text.slice(0, -1) + text : `${last.text} ${text}`;
				} else {
					flushNotes();
					out.push({ kind, text, page: page.index });
				}
				lastSize = size;
				firstOnPage = false;
			}
		}
	}
	flushNotes();
	return out;
}

const NOTE_MARK = /^\s*(?:\d{1,3}[.)]?|[*†‡§])\s+\S/;

/**
 * The first footnote on a page: in the lower part of the page, starting with a
 * note mark ("1.", "*", "†"), and set off from the text above either by a
 * smaller size or by a clear gap (OCR sizes are too noisy to rely on alone).
 */
function isFootnote(b: Block, prev: Block | undefined, page: PageModel, body: number): boolean {
	if (b.kind !== "text" || !NOTE_MARK.test(b.lines[0].text) || b.lines.some((l) => l.bold)) return false;
	const top = Math.min(...b.lines.map((l) => l.y0));
	if (top < page.height * 0.6) return false;
	const size = Math.max(...b.lines.map((l) => l.size));
	if (size < body * 0.92) return true;
	// Same nominal size (noisy OCR): it must still be set smaller than the text
	// above, and separated from it by a clear gap. Numbered headings are larger.
	if (prev?.kind !== "text" || size > body * 1.05 || lineHeight(b) > lineHeight(prev) * 0.95) return false;
	return top - Math.max(...prev.lines.map((l) => l.y1)) > lineHeight(b) * 1.5;
}

/** Median line height of a text block. */
function lineHeight(b: Block): number {
	if (b.kind !== "text") return 0;
	const hs = b.lines.map((l) => l.y1 - l.y0).sort((x, y) => x - y);
	return hs[Math.floor(hs.length / 2)];
}
