// Pure functions that turn positioned PDF text into reflowable structure.
// No MuPDF imports here, so everything is unit-testable with plain fixtures.
import { cleanText, escapeXml } from "./epub.ts";

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
}

export type Para =
	| { kind: "p" | "h1" | "h2" | "h3"; text: string; page: number }
	| { kind: "img"; href: string; width: number; height: number; page: number };

export interface OutlineEntry {
	title: string;
	page: number;
	level: number;
}

export interface Chapter {
	title: string;
	/** Table-of-contents entries that point at this chapter (empty for continuation parts). */
	nav: { title: string; level: number }[];
	paras: Para[];
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

/**
 * Removes running headers, footers and page numbers: short blocks in the top
 * or bottom band whose normalized text repeats on many pages.
 * Mutates and returns `pages`.
 */
export function stripFurniture(pages: PageModel[]): PageModel[] {
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
			if (PAGE_NUMBER.test(text)) return false;
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
 * Turns page models into a flat paragraph stream. A paragraph that MuPDF split
 * into two blocks, or that continues on the next page, is joined back together
 * when the first part does not end a sentence and the next starts lowercase.
 */
export function toParagraphs(pages: PageModel[], body: number): Para[] {
	const out: Para[] = [];
	let lastSize = 0;
	for (const page of pages) {
		let firstOnPage = true;
		for (const b of page.blocks) {
			if (b.kind === "image") {
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
				if (
					last?.kind === kind &&
					(kind === "p" || !firstOnPage) &&
					sameStyle &&
					!ENDS_SENTENCE.test(last.text) &&
					/^[\p{Ll}]/u.test(text)
				) {
					last.text = /[a-z]-$/.test(last.text) ? last.text.slice(0, -1) + text : `${last.text} ${text}`;
				} else {
					out.push({ kind, text, page: page.index });
				}
				lastSize = size;
				firstOnPage = false;
			}
		}
	}
	return out;
}

const MAX_CHAPTER_CHARS = 250_000;

/**
 * Groups paragraphs into chapters: by the PDF outline when it has at least two
 * entries, otherwise at h1 headings, otherwise in fixed-size parts. Very long
 * chapters are split further so each XHTML file stays fast to open in readers.
 */
export function splitChapters(paras: Para[], outline: OutlineEntry[], fallbackTitle: string): Chapter[] {
	const chapters: Chapter[] = [];
	const marks = outline.filter((o) => o.page >= 0).sort((a, b) => a.page - b.page || a.level - b.level);

	if (marks.length >= 2) {
		let mi = 0;
		let current: Chapter | null = null;
		const pre: Para[] = [];
		for (const p of paras) {
			while (mi < marks.length && p.page >= marks[mi].page) {
				const entry = { title: marks[mi].title, level: marks[mi].level };
				// Several outline entries on one page (e.g. "Part I" then "Chapter 1") share a file.
				if (current && current.paras.length === 0) current.nav.push(entry);
				else {
					current = { title: entry.title, nav: [entry], paras: [] };
					chapters.push(current);
				}
				mi++;
			}
			(current ? current.paras : pre).push(p);
		}
		if (pre.length) chapters.unshift({ title: "Front matter", nav: [{ title: "Front matter", level: 1 }], paras: pre });
	} else if (paras.filter((p) => p.kind === "h1").length >= 2) {
		let current: Chapter = { title: fallbackTitle, nav: [{ title: fallbackTitle, level: 1 }], paras: [] };
		chapters.push(current);
		for (const p of paras) {
			if (p.kind === "h1") {
				if (current.paras.length > 0) {
					current = { title: p.text, nav: [{ title: p.text, level: 1 }], paras: [] };
					chapters.push(current);
				} else {
					current.title = p.text;
					current.nav = [{ title: p.text, level: 1 }];
				}
			}
			current.paras.push(p);
		}
	} else {
		chapters.push({ title: fallbackTitle, nav: [{ title: fallbackTitle, level: 1 }], paras: [...paras] });
	}

	// Split oversize chapters into continuation parts.
	const result: Chapter[] = [];
	for (const c of chapters) {
		let part: Chapter = { ...c, paras: [] };
		let size = 0;
		let n = 1;
		for (const p of c.paras) {
			const len = p.kind === "img" ? 200 : p.text.length;
			if (size + len > MAX_CHAPTER_CHARS && part.paras.length > 0) {
				result.push(part);
				n++;
				part = { title: `${c.title} (${n})`, nav: [], paras: [] };
				size = 0;
			}
			part.paras.push(p);
			size += len;
		}
		if (part.paras.length || result.length === 0) result.push(part);
	}
	return result.filter((c) => c.paras.length > 0);
}

/** Renders paragraphs as an XHTML body fragment. */
export function renderParas(paras: Para[]): string {
	let html = "";
	let afterBreak = true;
	for (const p of paras) {
		if (p.kind === "img") {
			html += `<figure><img src="${escapeXml(p.href)}" alt="" width="${p.width}" height="${p.height}"/></figure>\n`;
			afterBreak = true;
		} else if (p.kind === "p") {
			html += afterBreak ? `<p class="first">${escapeXml(p.text)}</p>\n` : `<p>${escapeXml(p.text)}</p>\n`;
			afterBreak = false;
		} else {
			html += `<${p.kind}>${escapeXml(p.text)}</${p.kind}>\n`;
			afterBreak = true;
		}
	}
	return html;
}
