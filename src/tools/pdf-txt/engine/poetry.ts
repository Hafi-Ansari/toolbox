// Poetry lineation: one printed line becomes one TXT line. Stanza breaks come
// from vertical gaps clearly larger than the book's leading. Two printed lines
// are joined only on strong evidence of a layout wrap: the first runs to the
// right margin and the second is an indented, lowercase continuation.
import type { BookStats, Row } from "./layout.ts";
import type { Flag, SourcePos, TxtLine } from "./types.ts";

export interface PoetryContext {
	stats: BookStats;
	/** Lowest y1 the book's text reaches on a full page: a page that stops a line or more above it ends a stanza. */
	bottom: number;
	flags: Flag[];
	work: number;
	/** Pages whose text is an OCR layer: only there are odd symbols a sign of misreading. */
	ocrPages: Set<number>;
	/** Manual joins: the printed line at each spot is joined to the line above it. */
	joins?: SourcePos[];
}

/** A gap this many times the leading or more is a stanza break. */
export const STANZA_GAP = 1.45;

/**
 * Marks of a misread OCR line: symbols that rarely occur in verse (@ ¥ ®), a letter and digit fused into one short token ("a6"),
 * or capitals run into a word ("VWWords").
 */
export function ocrNoise(text: string): boolean {
	const tokens = text.trim().split(/\s+/);
	return tokens.some(
		(t) => /[@¥®©¢¬]/.test(t) || /^[\p{L}]\d[,.;:]?$|^\d[\p{L}][,.;:]?$/u.test(t) || /\p{Lu}{2}\p{Ll}{2}/u.test(t),
	);
}

const boxOf = (r: Row) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
const spanOf = (r: Row) => ({ from: { page: r.page, y: r.y0 }, to: { page: r.page, y: r.y1 } });
const joinedAt = (r: Row, joins: SourcePos[] | undefined) =>
	!!joins?.some((j) => j.page === r.page && j.y >= r.y0 && j.y <= r.y1);

const reaches = (r: Row, stats: BookStats) => r.x1 >= stats.right - stats.size * 1.2;

/**
 * Indents that this work uses only for runovers: every row set at that indent
 * follows a row that reaches the right margin. A poem that indents lines by
 * design (stepped or scattered lines) uses its indents after short lines too,
 * and then no indent is evidence of a wrap.
 */
export function runoverIndents(rows: Row[], stats: BookStats): number[] {
	const em = stats.size;
	const left = Math.min(...rows.map((r) => r.x0));
	const levels: { x: number; ok: boolean }[] = [];
	for (let i = 1; i < rows.length; i++) {
		const r = rows[i];
		if (r.x0 - left < em * 1.5 || rows[i - 1].page !== r.page) continue;
		let level = levels.find((l) => Math.abs(l.x - r.x0) < em * 0.75);
		if (!level) {
			level = { x: r.x0, ok: true };
			levels.push(level);
		}
		if (!reaches(rows[i - 1], stats)) level.ok = false;
	}
	return levels.filter((l) => l.ok).map((l) => l.x);
}

/** True when `cur` looks like the runover of `prev`, wrapped by a narrow text column. */
export function isWrap(prev: Row, cur: Row, stats: BookStats, indents: number[]): boolean {
	if (prev.page !== cur.page) return false;
	const em = stats.size;
	if (!indents.some((x) => Math.abs(x - cur.x0) < em * 0.75)) return false;
	const reachesMargin = reaches(prev, stats);
	const indented = cur.x0 - prev.x0 >= em * 1.5;
	const close = cur.y1 - prev.y1 <= stats.leading * 1.25;
	const continues = /^[\p{Ll}]/u.test(cur.text.trim()) && !/[.!?:;]["”’)]?$/.test(prev.text.trim());
	const short = cur.x1 < stats.right - em * 3;
	return reachesMargin && indented && close && continues && short;
}

/**
 * Snaps indents (in ems) to the levels a work uses, so OCR jitter of a point
 * or two does not print the same indent with three spaces here and four there.
 * Returns a function from a raw indent to its level's median.
 */
export function indentLevels(values: number[], tolerance: number): (v: number) => number {
	const sorted = [...values].sort((a, b) => a - b);
	const groups: number[][] = [];
	for (const v of sorted) {
		const g = groups[groups.length - 1];
		// Close to the last value and the group stays narrow (scattered lines must not chain into one level).
		if (g && v - g[g.length - 1] <= tolerance && v - g[0] <= tolerance * 2) g.push(v);
		else groups.push([v]);
	}
	const levels = groups.map((g) => ({ lo: g[0], hi: g[g.length - 1], at: g[Math.floor(g.length / 2)] }));
	return (v) => levels.find((l) => v >= l.lo && v <= l.hi)?.at ?? v;
}

/** Lineates the rows of one work. Rows come in reading order, possibly across pages. */
export function poetryLines(rows: Row[], ctx: PoetryContext): TxtLine[] {
	const { stats, flags, work } = ctx;
	const out: TxtLine[] = [];
	let prev: Row | null = null;
	const indents = runoverIndents(rows, stats);
	// The left edge per page: scans shift from page to page, and versos differ from rectos.
	const lefts = new Map<number, number>();
	for (const r of rows) lefts.set(r.page, Math.min(lefts.get(r.page) ?? r.x0, r.x0));
	const level = indentLevels(
		rows.map((r) => (r.x0 - (lefts.get(r.page) ?? r.x0)) / stats.size),
		0.6,
	);
	for (const r of rows) {
		const text = r.text.replace(/­/g, "").trimEnd();
		if (prev) {
			let brk = false;
			if (prev.page === r.page) brk = r.y1 - prev.y1 > stats.leading * STANZA_GAP;
			// Across a page turn: if one more line would have fitted, the stanza ended there.
			else brk = prev.y1 + stats.leading <= ctx.bottom - stats.leading * 0.2;
			const manual = joinedAt(r, ctx.joins);
			if (manual || (!brk && isWrap(prev, r, stats, indents))) {
				const last = out[out.length - 1];
				last.text = `${last.text} ${text.trim()}`;
				if (last.box) last.box = { ...last.box, x1: Math.max(last.box.x1, r.x1), y1: r.y1 };
				if (last.span) last.span = { ...last.span, to: { page: r.page, y: r.y1 } };
				flags.push({
					kind: "wrap-joined",
					page: r.page,
					work,
					reason: manual
						? `Joined to the line above, as you asked: "${last.text}".`
						: `Joined an indented runover to the line above: "${last.text}".`,
					text: last.text,
					box: boxOf(r),
				});
				prev = r;
				continue;
			}
			if (brk) out.push({ text: "", page: r.page });
			else if (prev.x1 >= stats.right - stats.size * 1.2 && r.x1 < stats.right * 0.6 && /^[\p{Ll}]/u.test(text.trim()))
				flags.push({
					kind: "possible-wrap",
					page: r.page,
					work,
					reason: `"${prev.text.trim()}" runs to the margin and "${text.trim()}" may be its runover; kept as printed.`,
					text: text.trim(),
					box: boxOf(r),
				});
		}
		if (ctx.ocrPages.has(r.page) && ocrNoise(text))
			flags.push({
				kind: "ocr-noise",
				page: r.page,
				work,
				reason: `"${text.trim()}" looks like misread OCR text; check it against the page image.`,
				text: text.trim(),
				box: boxOf(r),
			});
		const indent = level((r.x0 - (lefts.get(r.page) ?? r.x0)) / stats.size);
		out.push({
			text: text.trim(),
			page: r.page,
			box: boxOf(r),
			indent: indent >= 1 ? Math.round(indent * 2) / 2 : 0,
			span: spanOf(r),
		});
		prev = r;
	}
	return out;
}
