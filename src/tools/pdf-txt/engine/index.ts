// PDF → TXT engine: page models in, works with source-linked lines and review
// flags out, then plain text. No MuPDF here; read.ts does the reading.
//
//   const { pages, outline } = readPdf(doc);           // worker side (MuPDF)
//   const result = convert(pages, outline, { mode: "poetry" });
//   const txt = toTxt(result);
import type { OutlineEntry, PageModel } from "../../../lib/pdf/heuristics.ts";
import { bookStats, type PageRows, percentile, preparePages, type Row } from "./layout.ts";
import { poetryLines } from "./poetry.ts";
import { fragmentedBook, proseLines, type Slice } from "./prose.ts";
import type { ConvertOptions, ExportOptions, Flag, TxtLine, TxtResult, Work } from "./types.ts";
import { chooseStarts, type Start } from "./works.ts";

export { sentences } from "./prose.ts";
export type * from "./types.ts";

/** Flags for pages that will contribute nothing: scans without text, and blank pages. */
function pageFlags(pages: PageRows[], flags: Flag[]) {
	for (const p of pages) {
		if (p.imageOnly)
			flags.push({
				kind: "image-only",
				page: p.index,
				reason: "This page is a scan with no text layer. Its words need OCR and are missing from the TXT.",
			});
		else if (!p.rows.length)
			flags.push({
				kind: "empty-page",
				page: p.index,
				reason: "No text on this page (a blank leaf, divider or picture).",
			});
	}
}

/** Short rows at a page edge that survived furniture stripping: possibly a page number or running head. */
function furnitureKept(pages: PageRows[], flags: Flag[]) {
	for (const p of pages) {
		const edges = [p.rows[0], p.rows[p.rows.length - 1]].filter(Boolean);
		for (const r of new Set(edges)) {
			const inBand = r.y1 <= p.height * 0.08 || r.y0 >= p.height * 0.92;
			const t = r.text.trim();
			if (inBand && t.replace(/\s/g, "").length <= 6 && !/\p{L}{4,}/u.test(t))
				flags.push({
					kind: "furniture-kept",
					page: p.index,
					reason: `"${t}" sits at the page edge and may be a page number or running head; kept.`,
					text: t,
					box: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
				});
		}
	}
}

/** Rows that belong to the work starting at `s` and ending where `next` starts. */
function workRows(pages: PageRows[], s: Start, next: Start | undefined): { rows: Row[]; endPage: number } {
	const rows: Row[] = [];
	let endPage = s.page;
	const pageOf = new Map(pages.map((p) => [p.index, p]));
	const last = next ? next.page : (pages[pages.length - 1]?.index ?? s.page);
	for (let i = s.page; i <= last; i++) {
		const p = pageOf.get(i);
		if (!p) continue;
		const from = i === s.page ? s.row + s.titleRows : 0;
		const to = next && i === next.page ? next.row : p.rows.length;
		if (to > from) {
			rows.push(...p.rows.slice(from, to));
			endPage = i;
		}
	}
	return { rows, endPage };
}

/** The same region as page slices, for the paragraph builder. */
function workSlices(pages: PageRows[], s: Start, next: Start | undefined): Slice[] {
	const slices: Slice[] = [];
	const pageOf = new Map(pages.map((p) => [p.index, p]));
	const last = next ? next.page : (pages[pages.length - 1]?.index ?? s.page);
	for (let i = s.page; i <= last; i++) {
		const p = pageOf.get(i);
		if (!p) continue;
		const fromRow = i === s.page ? p.rows[s.row + s.titleRows] : undefined;
		const fromY = i === s.page ? (fromRow ? fromRow.y0 - 0.5 : Number.POSITIVE_INFINITY) : Number.NEGATIVE_INFINITY;
		const toRow = next && i === next.page ? p.rows[next.row] : undefined;
		const toY =
			next && i === next.page ? (toRow ? toRow.y0 - 0.5 : Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
		if (next && i === next.page && next.row === 0) continue;
		slices.push({ model: p.model, fromY, toY, exclude: i === s.page ? s.titleBox : undefined });
	}
	return slices;
}

const trimBlanks = (lines: TxtLine[]) => {
	let a = 0;
	let b = lines.length;
	while (a < b && !lines[a].text.trim()) a++;
	while (b > a && !lines[b - 1].text.trim()) b--;
	// Never two blank lines in a row inside a work.
	return lines.slice(a, b).filter((l, i, all) => l.text.trim() || all[i - 1]?.text.trim());
};

/** Converts a book's page models (and its outline, if any) into works for TXT export. */
export function convert(models: PageModel[], outline: OutlineEntry[], opts: ConvertOptions): TxtResult {
	const flags: Flag[] = [];
	const pages = preparePages(models, flags);
	pageFlags(pages, flags);
	furnitureKept(pages, flags);
	const stats = bookStats(pages);
	const { starts, detection } = chooseStarts(outline, pages, stats, flags);
	if (!starts.length && pages.some((p) => p.rows.length))
		starts.push({ kind: "work", title: "", page: 0, row: 0, titleRows: 0, source: "start", confidence: 0.3 });
	const full = pages.filter((p) => p.rows.length >= 5).map((p) => p.rows[p.rows.length - 1].y1);
	const bottom = percentile(full, 0.95);
	const merge = fragmentedBook(models);
	const ocrPages = new Set(pages.filter((p) => p.ocr).map((p) => p.index));
	const works: Work[] = starts.map((s, i) => {
		const next = starts[i + 1];
		const { rows, endPage } = workRows(pages, s, next);
		const lines =
			opts.mode === "poetry"
				? poetryLines(rows, { stats, bottom, flags, work: i, ocrPages })
				: proseLines(workSlices(pages, s, next), stats.size, { lang: opts.lang, merge });
		return {
			kind: s.kind,
			title: s.title.replace(/\s+/g, " ").trim(),
			page: s.page,
			endPage: Math.max(endPage, s.page),
			titleBox: s.titleBox,
			source: s.source,
			confidence: s.confidence,
			lines: trimBlanks(lines),
		};
	});
	// Attach page flags to the work that covers the page.
	for (const f of flags)
		if (f.work === undefined) {
			const w = works.findIndex((x) => f.page >= x.page && f.page <= x.endPage);
			if (w >= 0) f.work = w;
		}
	flags.sort((a, b) => a.page - b.page);
	return { mode: opts.mode, works, flags, detection, pages: models.length };
}

/**
 * Plain text per the export format: each work is its title, a blank line and
 * its body (an untitled work is just its body); works are joined by three
 * empty lines. LF line endings; the caller encodes as UTF-8.
 */
export function toTxt(result: TxtResult, opts: ExportOptions = {}): string {
	const parts: string[] = [];
	for (const w of result.works) {
		if (w.kind === "matter" && !opts.matter) continue;
		if (w.kind === "section" && opts.sections === false) continue;
		const pad = (l: TxtLine) =>
			opts.indent !== false && l.indent ? " ".repeat(Math.min(40, Math.round(l.indent * 2))) : "";
		const body = w.lines.map((l) => pad(l) + l.text.trimEnd()).join("\n");
		const text = [w.title, body].filter(Boolean).join("\n\n").replace(/\n+$/, "");
		if (text.trim()) parts.push(text);
	}
	return parts.length ? `${parts.join("\n\n\n\n")}\n` : "";
}

/** Counts for a status line: works by kind, flags by kind, pages that need OCR. */
export function summarize(result: TxtResult) {
	const works = { work: 0, section: 0, matter: 0 };
	for (const w of result.works) works[w.kind]++;
	const flags: Partial<Record<Flag["kind"], number>> = {};
	for (const f of result.flags) flags[f.kind] = (flags[f.kind] ?? 0) + 1;
	const needsOcr = result.flags.filter((f) => f.kind === "image-only").map((f) => f.page);
	return { works, flags, needsOcr, lowConfidence: result.works.filter((w) => w.confidence < 0.75).length };
}
