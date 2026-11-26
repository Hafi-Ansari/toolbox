// Turns page models into printed rows (one per printed line) and learns the
// book's typography from them: body size, line height, leading, text column.
// Pure functions over PageModel; no MuPDF here.
import { type PageModel, stripFurniture } from "../../../lib/pdf/heuristics.ts";
import { cleanText } from "../../../lib/pdf/text.ts";
import type { Flag } from "./types.ts";

/** One printed line: OCR word groups on the same baseline joined left to right. */
export interface Row {
	text: string;
	page: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	size: number;
	bold: boolean;
	italic: boolean;
}

export interface PageRows {
	index: number;
	width: number;
	height: number;
	rows: Row[];
	ocr: boolean;
	imageOnly: boolean;
	/** The page with furniture removed, as the shared paragraph builder wants it. */
	model: PageModel;
}

export interface BookStats {
	/** Typical body font size (character-weighted median). */
	size: number;
	/** Typical body line height (median row height). */
	height: number;
	/** Typical baseline-to-baseline distance inside a paragraph or stanza. */
	leading: number;
	/** Share of body characters set in bold: high means bold says nothing about headings. */
	boldShare: number;
	/** Where body lines usually end on the right (high percentile of x1). */
	right: number;
	/** Most common left edge of body text. */
	left: number;
	/** Typical top of the first row on a continuation page. */
	top: number;
}

const median = (xs: number[]) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};
export const percentile = (xs: number[], p: number) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/** Character-weighted median of a numeric property: what most of the text uses. */
function weightedMedian(items: { v: number; w: number }[]): number {
	const s = items.filter((i) => i.w > 0).sort((a, b) => a.v - b.v);
	const total = s.reduce((n, i) => n + i.w, 0);
	let acc = 0;
	for (const i of s) {
		acc += i.w;
		if (acc >= total / 2) return i.v;
	}
	return 0;
}

const visible = (t: string) => t.replace(/\s+/g, "").length;

/**
 * Joins the pieces of one printed row. A gap much wider than a word space
 * (spatial poetry, a tab stop) is kept as several spaces; plain text cannot
 * do better, and a single space would merge separate groups.
 */
function joinRow(parts: Row[]): Row {
	parts.sort((a, b) => a.x0 - b.x0);
	let text = parts[0].text.trimEnd();
	for (let i = 1; i < parts.length; i++) {
		const prev = parts[i - 1];
		const cur = parts[i];
		const em = Math.max(prev.size, cur.size) || 10;
		const gap = cur.x0 - prev.x1;
		const spaces = gap > em * 1.5 ? Math.min(12, Math.round(gap / (em * 0.5))) : 1;
		text = `${text.trimEnd()}${" ".repeat(spaces)}${cur.text.trim()}`;
	}
	const chars = (r: Row) => visible(r.text);
	const total = parts.reduce((n, p) => n + chars(p), 0) || 1;
	return {
		text: text.trim(),
		page: parts[0].page,
		x0: Math.min(...parts.map((p) => p.x0)),
		y0: Math.min(...parts.map((p) => p.y0)),
		x1: Math.max(...parts.map((p) => p.x1)),
		y1: Math.max(...parts.map((p) => p.y1)),
		size: weightedMedian(parts.map((p) => ({ v: p.size, w: chars(p) }))),
		bold: parts.reduce((n, p) => n + (p.bold ? chars(p) : 0), 0) > total / 2,
		italic: parts.reduce((n, p) => n + (p.italic ? chars(p) : 0), 0) > total / 2,
	};
}

/** Groups a page's lines into printed rows, top to bottom. */
export function toRows(page: PageModel): Row[] {
	const lines: Row[] = [];
	for (const b of page.blocks)
		if (b.kind === "text")
			for (const l of b.lines) {
				const text = cleanText(l.text).replace(/\s+/g, " ");
				if (text.trim()) lines.push({ ...l, text, page: page.index });
			}
	lines.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
	const rows: Row[][] = [];
	for (const l of lines) {
		const row = rows[rows.length - 1];
		const last = row?.[row.length - 1];
		if (row && last) {
			const overlap = Math.min(last.y1, l.y1) - Math.max(last.y0, l.y0);
			const h = Math.min(last.y1 - last.y0, l.y1 - l.y0);
			// Same baseline and side by side. OCR word boxes may overlap their neighbour by
			// a letter or so (one group ending at x=108, the next starting at x=101).
			const slack = Math.max(l.size, 4) * 1.2;
			const apart = row.every(
				(r) => (l.x0 >= r.x1 - slack && l.x0 > r.x0 + slack) || (l.x1 <= r.x0 + slack && l.x1 < r.x1 - slack),
			);
			if (h > 0 && overlap > h * 0.5 && apart) {
				row.push(l);
				continue;
			}
		}
		rows.push([l]);
	}
	return rows.map(joinRow);
}

function deepClone(pages: PageModel[]): PageModel[] {
	return pages.map((p) => ({
		...p,
		blocks: p.blocks.map((b) => (b.kind === "text" ? { ...b, lines: b.lines.map((l) => ({ ...l })) } : { ...b })),
	}));
}

/** A box where page numbers sit, learned from rows that are plainly numbers. */
interface FolioBox {
	cx: number;
	y0: number;
	tolX: number;
	tolY: number;
}

function learnFolioBoxes(pages: PageRows[]): FolioBox[] {
	const boxes: FolioBox[] = [];
	for (const band of ["top", "bottom"] as const) {
		const hits: Row[] = [];
		for (const p of pages) {
			const rows = band === "top" ? p.rows.slice(0, 2) : p.rows.slice(-2);
			for (const r of rows) {
				const inBand = band === "top" ? r.y1 <= p.height * 0.12 : r.y0 >= p.height * 0.88;
				if (inBand && /^\d{1,4}$/.test(r.text.trim())) hits.push(r);
			}
		}
		if (hits.length < 3 || hits.length < pages.length * 0.15) continue;
		const cx = median(hits.map((r) => (r.x0 + r.x1) / 2));
		const y0 = median(hits.map((r) => r.y0));
		const size = median(hits.map((r) => r.size)) || 8;
		// Centered folios stay put; outer-margin folios alternate sides, so only y is checked then.
		const spreadX = percentile(
			hits.map((r) => Math.abs((r.x0 + r.x1) / 2 - cx)),
			0.8,
		);
		boxes.push({ cx, y0, tolX: spreadX > size * 4 ? Number.POSITIVE_INFINITY : size * 4, tolY: size * 1.5 });
	}
	return boxes;
}

/**
 * OCR reads the capital "I" as a vertical bar ("then | left", "Where | Stood").
 * A bar standing alone between words of an OCR text layer is put back as "I".
 */
export function fixOcrPipes(page: PageModel, flags: Flag[]) {
	for (const b of page.blocks)
		if (b.kind === "text")
			for (const l of b.lines) {
				const fixed = l.text.replace(/(^|[\s“"‘(])\|(?=[\s’'.,;:!?]|$)/g, "$1I");
				if (fixed !== l.text) {
					flags.push({
						kind: "ocr-fixed",
						page: page.index,
						reason: `Read "|" as "I": "${fixed.trim()}".`,
						text: fixed.trim(),
						box: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 },
					});
					l.text = fixed;
				}
			}
}

/** A short row with no real word in it: an OCR misreading of a page number ("4O", "ie", "3l,"). */
const folioLike = (t: string) => visible(t) <= 4 && !/\p{L}{4,}/u.test(t);

/**
 * Prepares pages for TXT: strips running heads and page numbers with the shared
 * stripFurniture, groups lines into rows, then removes OCR-garbled page numbers
 * that sit exactly where this book prints its page numbers. Each removal of
 * the latter kind is reported as a flag, so the UI can offer to restore it.
 */
export function preparePages(input: PageModel[], flags: Flag[]): PageRows[] {
	const pages = deepClone(input);
	for (const p of pages) if (p.ocr) fixOcrPipes(p, flags);
	const raw = pages.map((p) => ({
		index: p.index,
		width: p.width,
		height: p.height,
		rows: toRows(p),
		ocr: !!p.ocr,
		imageOnly: !!p.imageOnly,
		model: p,
	}));
	const boxes = learnFolioBoxes(raw);
	const stripped = stripFurniture(deepClone(pages));
	return stripped.map((p) => {
		let rows = toRows(p);
		const removed: Row[] = [];
		rows = rows.filter((r, i) => {
			const edge = i === 0 || i === rows.length - 1;
			if (!edge || !folioLike(r.text)) return true;
			const hit = boxes.some((b) => Math.abs((r.x0 + r.x1) / 2 - b.cx) <= b.tolX && Math.abs(r.y0 - b.y0) <= b.tolY);
			if (hit && !/^\d{1,4}$/.test(r.text.trim()))
				flags.push({
					kind: "furniture-removed",
					page: p.index,
					reason: `Removed "${r.text}": sits where this book prints page numbers.`,
					text: r.text,
				});
			if (hit) removed.push(r);
			return !hit;
		});
		if (removed.length) {
			const inside = (l: { x0: number; y0: number; x1: number; y1: number }) =>
				removed.some((r) => {
					const cx = (l.x0 + l.x1) / 2;
					const cy = (l.y0 + l.y1) / 2;
					return cx >= r.x0 - 1 && cx <= r.x1 + 1 && cy >= r.y0 - 1 && cy <= r.y1 + 1;
				});
			p.blocks = p.blocks
				.map((b) => (b.kind === "text" ? { ...b, lines: b.lines.filter((l) => !inside(l)) } : b))
				.filter((b) => b.kind !== "text" || b.lines.length > 0);
		}
		return {
			index: p.index,
			width: p.width,
			height: p.height,
			rows,
			ocr: !!p.ocr,
			imageOnly: !!p.imageOnly,
			model: p,
		};
	});
}

/** Learns the body typography from every row in the book. */
export function bookStats(pages: PageRows[]): BookStats {
	const rows = pages.flatMap((p) => p.rows);
	const size = weightedMedian(rows.map((r) => ({ v: r.size, w: visible(r.text) }))) || 10;
	const body = rows.filter((r) => Math.abs(r.size - size) <= size * 0.15);
	const height = median(body.map((r) => r.y1 - r.y0)) || size * 1.2;
	const pitches: number[] = [];
	for (const p of pages)
		for (let i = 1; i < p.rows.length; i++) {
			const d = p.rows[i].y1 - p.rows[i - 1].y1;
			if (d > height * 0.5 && d < height * 4) pitches.push(d);
		}
	// The lower mode of the pitches: stanza and paragraph gaps are larger.
	const leading = percentile(pitches, 0.3) || height * 1.2;
	const bodyChars = body.reduce((n, r) => n + visible(r.text), 0) || 1;
	const boldShare = body.reduce((n, r) => n + (r.bold ? visible(r.text) : 0), 0) / bodyChars;
	const right = percentile(
		body.map((r) => r.x1),
		0.97,
	);
	const left = median(body.map((r) => Math.round(r.x0 / 4) * 4));
	const tops = pages.filter((p) => p.rows.length > 3).map((p) => p.rows[0].y0);
	return { size, height, leading, boldShare, right, left, top: percentile(tops, 0.3) };
}
