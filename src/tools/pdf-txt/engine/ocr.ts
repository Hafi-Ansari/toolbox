// OCR on demand: merges what OCR read from a rendered page into the text the
// PDF already carries. Pure functions over PageModel; the OCR itself runs
// elsewhere (tesseract.js in a worker in the app, scripts/pdf-txt-ocr.ts in Node).
//
// The rule is "fill gaps, flag disagreements", never "replace the page": on
// the books measured, OCR was no better than an existing OCR text layer
// overall (each won some rows) and only added errors on born-digital pages.
// Its clear wins are rows the text layer lacks and rows it garbled entirely.
//   1. Every text-layer row is kept.
//   2. An OCR row that overlaps no text-layer row is added (confident, with letters or digits).
//   3. A row whose text layer barely resembles a confident OCR reading is swapped for it.
//   4. A row where the two differ less is kept, and flagged when the difference is material.
// A scan without a text layer takes the OCR text as its own (same confidence floor).
import type { Line, PageModel, TextBlock } from "../../../lib/pdf/heuristics.ts";
import { convert } from "./index.ts";
import { type Row, toRows } from "./layout.ts";
import type { Box, ConvertOptions, Flag, TxtResult } from "./types.ts";

/** One word as OCR read it, in PDF points from the page's top-left corner. */
export interface OcrWord {
	text: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** 0..100 */
	conf: number;
}

/** One printed line as OCR read it. */
export interface OcrLine {
	/** The words joined by single spaces. */
	text: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** 0..100, the mean of the line's words. */
	conf: number;
	/** Estimated font size in points (OCR measures ink, so this is only roughly the text layer's size). */
	size: number;
	words: OcrWord[];
}

/** What OCR read on one page. */
export interface OcrPage {
	/** 0-based page index. */
	page: number;
	lines: OcrLine[];
}

/** Thresholds, measured on Night Sky with Exit Wounds (tesseract best_int, 300 dpi, PSM 4). */
export const OCR_RULES = {
	/** Rows below this confidence are never added. ("35" read as "BS" came in at 55.) */
	minConf: 60,
	/** A row is swapped, or flagged as differing, only when OCR is at least this sure. */
	swapConf: 70,
	/** Swap when the text layer's row is less similar than this to the OCR row. */
	swapBelow: 0.5,
	/** Flag a kept row when the two readings are less similar than this. */
	differsBelow: 0.8,
};

/** Which parts of the page the merge changed, for status lines and the CLI. */
export interface OcrStats {
	added: number;
	replaced: number;
	differs: number;
	/** OCR rows left out for low confidence or no letters or digits. */
	dropped: number;
}

/* ---------- Reading tesseract.js output */

interface TBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
/** The parts of tesseract.js's `blocks` output used here (structural, so the engine needs no tesseract types). */
export interface TesseractBlock {
	paragraphs: {
		lines: {
			text: string;
			confidence: number;
			bbox: TBox;
			rowAttributes?: { rowHeight: number; descenders: number; ascenders: number };
			words: { text: string; confidence: number; bbox: TBox }[];
		}[];
	}[];
}

/**
 * Converts tesseract.js `blocks` (pixels of an image rendered at `scale`
 * pixels per point) into an OcrPage in PDF points.
 */
export function fromTesseract(blocks: TesseractBlock[] | null | undefined, page: number, scale: number): OcrPage {
	const lines: OcrLine[] = [];
	for (const block of blocks ?? [])
		for (const para of block.paragraphs)
			for (const l of para.lines) {
				const words: OcrWord[] = l.words
					.filter((w) => w.text.trim())
					.map((w) => ({
						text: w.text.trim(),
						x0: w.bbox.x0 / scale,
						y0: w.bbox.y0 / scale,
						x1: w.bbox.x1 / scale,
						y1: w.bbox.y1 / scale,
						conf: w.confidence,
					}));
				if (!words.length) continue;
				// rowHeight is x-height plus ascenders: close to the font size, and steadier than the ink box.
				const h = l.rowAttributes?.rowHeight || l.bbox.y1 - l.bbox.y0;
				lines.push({
					text: words.map((w) => w.text).join(" "),
					x0: l.bbox.x0 / scale,
					y0: l.bbox.y0 / scale,
					x1: l.bbox.x1 / scale,
					y1: l.bbox.y1 / scale,
					conf: l.confidence,
					size: h / scale,
					words,
				});
			}
	return { page, lines };
}

/* ---------- Comparing readings */

const norm = (s: string) =>
	s
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[‘’ʼ`]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, "");

function levenshtein(a: string, b: string): number {
	const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j];
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[b.length];
}

/** 0..1: how alike two readings of a row are, ignoring case, spacing, and quote or dash styles. */
export function similarity(a: string, b: string): number {
	const x = norm(a);
	const y = norm(b);
	if (!x.length && !y.length) return 1;
	return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

const hasWord = (t: string) => /[\p{L}\p{N}]/u.test(t);

/**
 * A page number at the head or foot of the page. OCR reads these well, but the
 * TXT drops them anyway: one missing from the text layer is not added, and one
 * swapped for a garbled reading ("ie" → "11") is not worth a review flag.
 */
const isFolio = (o: OcrLine, page: PageModel) =>
	/^(?:\d{1,4}|[ivxlc]{1,7})$/i.test(o.text.trim()) && (o.y1 <= page.height * 0.1 || o.y0 >= page.height * 0.9);

/* ---------- Matching OCR rows to text-layer rows */

interface Match {
	ocr: OcrLine;
	row?: Row;
	sim: number;
	/** Overlaps a text-layer row that a better OCR row already matched: neither new nor comparable. */
	covered?: boolean;
}

/** Vertical overlap as a share of the shorter box (`of: "min"`) or the taller one. */
function overlapY(a: Box, b: Box, of: "min" | "max" = "min"): number {
	const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
	const h = Math[of](a.y1 - a.y0, b.y1 - b.y0);
	return h > 0 ? ov / h : 0;
}
const overlapsX = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;

/** Pairs each OCR row with the text-layer row it overlaps most, one to one. */
function match(rows: Row[], ocr: OcrLine[]): Match[] {
	const pairs: { o: number; r: number; ov: number }[] = [];
	ocr.forEach((o, i) => {
		rows.forEach((r, j) => {
			// Ranked by overlap of the taller box, so a speck of noise inside a line doesn't outrank the line.
			if (overlapY(o, r) > 0.4 && overlapsX(o, r)) pairs.push({ o: i, r: j, ov: overlapY(o, r, "max") });
		});
	});
	pairs.sort((a, b) => b.ov - a.ov);
	const rowOf = new Map<number, number>();
	const taken = new Set<number>();
	for (const p of pairs)
		if (!rowOf.has(p.o) && !taken.has(p.r)) {
			rowOf.set(p.o, p.r);
			taken.add(p.r);
		}
	const touches = new Set(pairs.map((p) => p.o));
	return ocr.map((o, i) => {
		const r = rowOf.get(i);
		if (r !== undefined) return { ocr: o, row: rows[r], sim: similarity(rows[r].text, o.text) };
		return { ocr: o, sim: 0, covered: touches.has(i) };
	});
}

/** How OCR boxes and sizes relate to this book's text layer: learned from rows both read alike. */
interface Calibration {
	dy0: number;
	dy1: number;
	size: number;
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function calibrate(matches: Match[], fallback: Calibration): Calibration {
	const good = matches.filter((m) => m.row && m.sim >= 0.8);
	if (good.length < 3) return fallback;
	return {
		dy0: median(good.map((m) => (m.row?.y0 ?? 0) - m.ocr.y0)),
		dy1: median(good.map((m) => (m.row?.y1 ?? 0) - m.ocr.y1)),
		size: median(good.map((m) => (m.row?.size ?? 0) / m.ocr.size)) || 1,
	};
}

/* ---------- Building lines */

/**
 * Turns an OCR row into text-layer lines: words a normal space apart become
 * one line; a wider gap starts a new line, so toRows() keeps it as several
 * spaces (spatial poetry), just as it does for a text layer.
 */
function toLines(o: OcrLine, cal: Calibration, like?: Row): Line[] {
	const size = like?.size ?? o.size * cal.size;
	const y0 = like?.y0 ?? o.y0 + cal.dy0;
	const y1 = like?.y1 ?? o.y1 + cal.dy1;
	const lines: Line[] = [];
	for (const w of [...o.words].sort((a, b) => a.x0 - b.x0)) {
		const last = lines[lines.length - 1];
		if (last && w.x0 - last.x1 <= size * 1.5) {
			last.text += ` ${w.text}`;
			last.x1 = Math.max(last.x1, w.x1);
		} else
			lines.push({
				text: w.text,
				x0: w.x0,
				y0,
				x1: w.x1,
				y1,
				size,
				bold: like?.bold ?? false,
				italic: like?.italic ?? false,
			});
	}
	return lines;
}

const centerY = (l: Box) => (l.y0 + l.y1) / 2;
/** A text-layer line that is part of `r`: mostly inside its band, and within its width. */
const inRow = (l: Line, r: Row) => {
	const cx = (l.x0 + l.x1) / 2;
	const ov = Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0);
	return ov > (l.y1 - l.y0) * 0.6 && cx >= r.x0 - 1 && cx <= r.x1 + 1;
};

/** Puts new lines into the page in reading order: inside the block they fall within, else as a block of their own. */
function place(model: PageModel, lines: Line[]) {
	const y = centerY(lines[0]);
	for (let i = 0; i < model.blocks.length; i++) {
		const b = model.blocks[i];
		if (b.kind !== "text") continue;
		const at = b.lines.findIndex((l) => centerY(l) > y);
		if (at > 0) {
			b.lines.splice(at, 0, ...lines);
			return;
		}
		if (at === 0) {
			model.blocks.splice(i, 0, { kind: "text", lines });
			return;
		}
	}
	model.blocks.push({ kind: "text", lines });
}

/** Swaps the text-layer lines that make up `row` for `lines`, where they stood. */
function replace(model: PageModel, row: Row, lines: Line[]) {
	let spot: { block: TextBlock; at: number } | null = null;
	for (const b of model.blocks) {
		if (b.kind !== "text") continue;
		const at = b.lines.findIndex((l) => inRow(l, row));
		if (at < 0) continue;
		if (!spot) spot = { block: b, at };
		b.lines = b.lines.filter((l) => !inRow(l, row));
	}
	if (spot) spot.block.lines.splice(Math.min(spot.at, spot.block.lines.length), 0, ...lines);
	else place(model, lines);
	model.blocks = model.blocks.filter((b) => b.kind !== "text" || b.lines.length);
}

const boxOf = (b: Box): Box => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/* ---------- Merging */

/**
 * Applies OCR results to a book's page models. Pages without OCR come back
 * as they were (the same objects). Returns the new models, the review flags
 * the merge raised, and what it changed per page.
 */
export function applyOcr(
	models: PageModel[],
	ocr: ReadonlyMap<number, OcrPage>,
	rules = OCR_RULES,
): { pages: PageModel[]; flags: Flag[]; stats: Map<number, OcrStats> } {
	const flags: Flag[] = [];
	const stats = new Map<number, OcrStats>();
	const done = models.filter((m) => ocr.has(m.index));
	const matched = new Map(
		done.map((m) => {
			const lines = (ocr.get(m.index)?.lines ?? []).filter((l) => l.words.length);
			return [m.index, match(toRows(m), lines)] as const;
		}),
	);
	// One calibration for the book, used on pages with too few rows to learn their own (scans without a layer).
	const book = calibrate([...matched.values()].flat(), { dy0: 0, dy1: 0, size: 1 });

	const pages = models.map((m) => {
		const matches = matched.get(m.index);
		if (!matches) return m;
		const cal = calibrate(matches, book);
		const model: PageModel = {
			...m,
			blocks: m.blocks.map((b) => (b.kind === "text" ? { ...b, lines: b.lines.map((l) => ({ ...l })) } : { ...b })),
		};
		const s: OcrStats = { added: 0, replaced: 0, differs: 0, dropped: 0 };
		// No text at all (a scan without a layer, or one the reader took for a blank leaf): OCR's text becomes the page's.
		const scanOnly = !!m.imageOnly || !m.blocks.some((b) => b.kind === "text" && b.lines.some((l) => l.text.trim()));
		let kept = 0;
		let confSum = 0;
		for (const x of matches) {
			const o = x.ocr;
			const usable = hasWord(o.text);
			const folio = isFolio(o, m);
			if (!x.row) {
				if (x.covered || (folio && !scanOnly)) continue;
				if (!usable || o.conf < rules.minConf) {
					s.dropped++;
					continue;
				}
				const lines = toLines(o, cal);
				place(model, lines);
				kept++;
				confSum += o.conf;
				if (scanOnly) continue;
				s.added++;
				flags.push({
					kind: "ocr-added",
					page: m.index,
					reason: `Added from OCR (confidence ${Math.round(o.conf)}): ${quote(o.text)} is missing from the PDF's text.`,
					text: o.text,
					box: boxOf({ x0: lines[0].x0, y0: lines[0].y0, x1: lines[lines.length - 1].x1, y1: lines[0].y1 }),
				});
				continue;
			}
			if (!usable || o.conf < rules.swapConf || x.sim >= rules.differsBelow) continue;
			if (x.sim < rules.swapBelow) {
				replace(model, x.row, toLines(o, cal, x.row));
				if (folio) continue;
				s.replaced++;
				flags.push({
					kind: "ocr-replaced",
					page: m.index,
					reason: `The PDF's text read ${quote(x.row.text)}; replaced with OCR's ${quote(o.text)} (confidence ${Math.round(o.conf)}).`,
					text: o.text,
					box: boxOf(x.row),
				});
			} else if (!folio) {
				s.differs++;
				flags.push({
					kind: "ocr-differs",
					page: m.index,
					reason: `OCR reads ${quote(o.text)} (confidence ${Math.round(o.conf)}); kept the PDF's ${quote(x.row.text)}.`,
					text: x.row.text,
					box: boxOf(x.row),
				});
			}
		}
		// A text-less page that OCR found empty too (a blank leaf) already has its "empty page" note.
		if (scanOnly && (m.imageOnly || kept)) {
			flags.push({
				kind: "ocr-page",
				page: m.index,
				reason: kept
					? `Read by OCR: ${kept} ${kept === 1 ? "line" : "lines"}, mean confidence ${Math.round(confSum / kept)}${
							s.dropped ? `; ${s.dropped} unsure ${s.dropped === 1 ? "line" : "lines"} left out` : ""
						}.`
					: "OCR found no text on this page.",
			});
			s.added = kept;
		}
		// Text read by OCR behaves like an OCR layer from here on (fragment rejoining, misreading checks).
		if (scanOnly && (m.imageOnly || kept)) {
			model.imageOnly = false;
			model.ocr = kept > 0;
		}
		stats.set(m.index, s);
		return model;
	});
	return { pages, flags, stats };
}

/** convert() with OCR results merged in: the book's text plus what OCR recovered, and the flags it raised. */
export function convertWithOcr(
	models: PageModel[],
	outline: Parameters<typeof convert>[1],
	opts: ConvertOptions,
	ocr: ReadonlyMap<number, OcrPage>,
): TxtResult {
	if (!ocr.size) return convert(models, outline, opts);
	const merged = applyOcr(models, ocr);
	const result = convert(merged.pages, outline, opts);
	for (const f of merged.flags) {
		const w = result.works.findIndex((x) => f.page >= x.page && f.page <= x.endPage);
		if (w >= 0) f.work = w;
	}
	result.flags = [...result.flags, ...merged.flags].sort((a, b) => a.page - b.page);
	return result;
}
