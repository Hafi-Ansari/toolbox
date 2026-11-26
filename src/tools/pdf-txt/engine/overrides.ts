// Manual overrides: a person marks a passage the whole-book mode gets wrong.
// In prose, verse quoted in the text keeps its printed lines; in poetry, a
// passage of prose (a prose poem, a note) is reflowed. Joins are applied by
// poetryLines itself. Everything is keyed to source positions, so overrides
// survive re-conversion, mode switches and export options.
import type { BookStats, Row } from "./layout.ts";
import { type PoetryContext, poetryLines } from "./poetry.ts";
import { proseLines, type Slice } from "./prose.ts";
import { before, inSpan } from "./source.ts";
import type { Mode, Override, SourcePos, SourceSpan, TxtLine } from "./types.ts";

export { before, inSpan } from "./source.ts";

/** One work's source, as convert() has it. */
export interface WorkSource {
	rows: Row[];
	slices: () => Slice[];
	poetry: PoetryContext;
	/** Body font size, for the paragraph builder. */
	body: number;
	prose: { lang?: string; merge: boolean };
}

/** The kind of passage override each mode acts on. */
export const PASSAGE_KIND: Record<Mode, "lines" | "reflow"> = { prose: "lines", poetry: "reflow" };

/** The spots where manual joins apply. */
export function joinsOf(overrides: Override[] | undefined): SourcePos[] | undefined {
	const at = overrides?.flatMap((o) => (o.kind === "join" ? [o.at] : []));
	return at?.length ? at : undefined;
}

/** Passage spans of one kind, in reading order, with overlapping ones merged. */
export function spansOf(overrides: Override[] | undefined, kind: "lines" | "reflow"): SourceSpan[] {
	const spans = (overrides ?? [])
		.flatMap((o) => (o.kind === kind ? [o.span] : []))
		.sort((a, b) => (before(a.from, b.from) ? -1 : before(b.from, a.from) ? 1 : 0));
	const out: SourceSpan[] = [];
	for (const s of spans) {
		const last = out[out.length - 1];
		if (last && !before(last.to, s.from))
			out[out.length - 1] = { from: last.from, to: before(last.to, s.to) ? s.to : last.to };
		else out.push(s);
	}
	return out;
}

const rowIn = (span: SourceSpan, r: Row) => inSpan(span, r.page, r.y0, r.y1);

/** True when an output line's printed source lies in the span (judged by its first printed line). */
export function lineIn(span: SourceSpan, l: TxtLine): boolean {
	if (!l.span) return false;
	const { from, to } = l.span;
	return inSpan(span, from.page, from.y, from.page === to.page ? to.y : from.y);
}

/** The slices cut to what lies after `a` and before `b` (a line counts by its middle). */
export function clip(slices: Slice[], a: SourcePos | null, b: SourcePos | null): Slice[] {
	const out: Slice[] = [];
	for (const s of slices) {
		const p = s.model.index;
		if ((a && p < a.page) || (b && p > b.page)) continue;
		const fromY = a && p === a.page ? Math.max(s.fromY, a.y) : s.fromY;
		const toY = b && p === b.page ? Math.min(s.toY, b.y) : s.toY;
		if (toY > fromY) out.push({ ...s, fromY, toY });
	}
	return out;
}

/**
 * The leading inside a passage. Verse quoted in prose is often set smaller and
 * tighter than the book's text, so its stanza gaps are measured against its
 * own line spacing.
 */
export function localStats(rows: Row[], stats: BookStats): BookStats {
	const gaps: number[] = [];
	for (let i = 1; i < rows.length; i++) if (rows[i].page === rows[i - 1].page) gaps.push(rows[i].y1 - rows[i - 1].y1);
	if (gaps.length < 2) return stats;
	gaps.sort((x, y) => x - y);
	return { ...stats, leading: gaps[Math.floor(gaps.length / 2)] };
}

/**
 * A work's lines with its passage overrides applied, or null when none of
 * them touches the work (convert() then takes its usual path).
 */
export function applyOverrides(mode: Mode, overrides: Override[] | undefined, src: WorkSource): TxtLine[] | null {
	const spans = spansOf(overrides, PASSAGE_KIND[mode]).filter((sp) => src.rows.some((r) => rowIn(sp, r)));
	if (!spans.length) return null;
	return mode === "prose" ? keepLines(spans, src) : reflow(spans, src);
}

/** Prose with verse kept: prose up to each span, the span's rows lineated as poetry, prose after. */
function keepLines(spans: SourceSpan[], src: WorkSource): TxtLine[] {
	const slices = src.slices();
	const out: TxtLine[] = [];
	let after: SourcePos | null = null;
	for (const sp of spans) {
		const rows = src.rows.filter((r) => rowIn(sp, r));
		out.push(...proseLines(clip(slices, after, sp.from), src.body, src.prose), { text: "", page: sp.from.page });
		out.push(...poetryLines(rows, { ...src.poetry, stats: localStats(rows, src.poetry.stats) }));
		out.push({ text: "", page: sp.to.page });
		after = sp.to;
	}
	out.push(...proseLines(clip(slices, after, null), src.body, src.prose));
	return out;
}

/** Poetry with prose passages: each span's lines replaced by its text reflowed into sentences. */
function reflow(spans: SourceSpan[], src: WorkSource): TxtLine[] {
	const out = poetryLines(src.rows, src.poetry);
	const slices = src.slices();
	for (const sp of [...spans].reverse()) {
		const first = out.findIndex((l) => lineIn(sp, l));
		if (first < 0) continue;
		let last = first;
		for (let i = first; i < out.length; i++) if (lineIn(sp, out[i])) last = i;
		const prose = proseLines(clip(slices, sp.from, sp.to), src.body, src.prose);
		out.splice(first, last - first + 1, { text: "", page: sp.from.page }, ...prose, { text: "", page: sp.to.page });
	}
	return out;
}
