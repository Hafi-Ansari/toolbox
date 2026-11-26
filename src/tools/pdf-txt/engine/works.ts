// Finds where works (poems, chapters, stories) start and what they are called.
// Two sources: the PDF outline, when it marks works, and the page layout,
// learned per book (how much titles stand out from body text, where they sit,
// how much space follows them). Pure functions over PageRows.
import type { OutlineEntry } from "../../../lib/pdf/heuristics.ts";
import { type BookStats, type PageRows, percentile, type Row } from "./layout.ts";
import type { Box, Flag, WorkKind } from "./types.ts";

/** Where a work starts: a row on a page. Its title rows (if any) are excluded from the body. */
export interface Start {
	kind: WorkKind;
	title: string;
	page: number;
	/** Index of the first row of the work on `page` (the title, if printed). */
	row: number;
	/** How many rows from `row` on are the printed title. */
	titleRows: number;
	titleBox?: Box;
	source: "outline" | "layout" | "start";
	confidence: number;
}

export const boxOf = (rows: Row[]): Box => ({
	x0: Math.min(...rows.map((r) => r.x0)),
	y0: Math.min(...rows.map((r) => r.y0)),
	x1: Math.max(...rows.map((r) => r.x1)),
	y1: Math.max(...rows.map((r) => r.y1)),
});

const letters = (t: string) => t.replace(/[^\p{L}]/gu, "");
const isCaps = (t: string) => letters(t).length >= 2 && letters(t) === letters(t).toUpperCase();

/** How much a row stands out from body text by size. OCR sizes are noisy, so box height counts too. */
function prominence(r: Row, stats: BookStats): number {
	return (r.size / stats.size + (r.y1 - r.y0) / stats.height) / 2;
}

/** Text that cannot be a title: too long, ends mid-clause, or has no letters. */
function titleShaped(text: string): boolean {
	const t = text.trim();
	return t.length > 0 && t.length <= 120 && /\p{L}/u.test(t) && !/[,;]$/.test(t);
}

export interface TitleCandidate {
	page: number;
	row: number;
	rows: number;
	text: string;
	score: number;
	/** A lone, large heading on an otherwise empty page: a part or section divider. */
	divider: boolean;
	box: Box;
}

/**
 * Scores every place on every page where a title could be. A title stands out
 * (larger, taller, bold or capitals where the body is not), opens the page or
 * follows a clear gap, is followed by a clear gap, and may wrap onto a second
 * or third row set the same way. The book's own body typography is the yardstick,
 * so the same rules work on 8pt OCR and 15pt born-digital pages.
 */
export function findTitleCandidates(pages: PageRows[], stats: BookStats): TitleCandidate[] {
	const out: TitleCandidate[] = [];
	const lead = stats.leading;
	const bodyCaps = (() => {
		const rows = pages.flatMap((p) => p.rows);
		return rows.length ? rows.filter((r) => isCaps(r.text)).length / rows.length : 0;
	})();
	const boldMeans = stats.boldShare < 0.2;
	for (const p of pages) {
		const rows = p.rows;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const prev = rows[i - 1];
			const before = prev ? (r.y1 - prev.y1) / lead : Number.POSITIVE_INFINITY;
			if (prev && before < 1.9) continue;
			// A chapter number or part label ("1", "Part I") may stand on its own row above the title.
			const label = /^(?:\p{L}+\s+)?(?:\d{1,3}|[IVXLC]{1,6})\.?$/u.test(r.text.trim());
			if (!titleShaped(r.text) && !label) continue;
			const prom = prominence(r, stats);
			const bold = boldMeans && r.bold;
			const caps = bodyCaps < 0.1 && isCaps(r.text);
			// A wrapped title: following rows set the same way, close together.
			let j = i + 1;
			while (j < rows.length && j - i < 4) {
				const n = rows[j];
				const pitch = (n.y1 - rows[j - 1].y1) / Math.max(n.y1 - n.y0, rows[j - 1].y1 - rows[j - 1].y0, 1);
				const nProm = prominence(n, stats);
				const same =
					(nProm >= 1.1 && prom >= 1.1 && (label || Math.abs(nProm - prom) < 0.2)) ||
					(bold && boldMeans && n.bold) ||
					(caps && isCaps(n.text));
				const bothBig = nProm >= 1.1 && prom >= 1.1;
				if (!same || !titleShaped(n.text) || pitch > (bothBig ? 2.6 : 1.8)) break;
				j++;
			}
			const last = rows[j - 1];
			const next = rows[j];
			const titleRows = rows.slice(i, j);
			const text = titleRows.map((t) => t.text.trim()).join(" ");
			const divider = !prev && !next && prom >= 1.4 && text.length <= 40;
			if (!next && !divider) continue;
			if (label && j === i + 1 && !divider) continue;
			const after = next ? (next.y1 - last.y1) / lead : 3;
			const meanProm = titleRows.reduce((n, t) => n + prominence(t, stats), 0) / titleRows.length;
			let score = 0;
			score += Math.max(0, Math.min(1, (meanProm - 1) / 0.25)) * 0.5;
			if (bold) score += 0.35;
			if (caps) score += 0.15;
			score += prev ? 0.1 : 0.15;
			score += Math.max(0, Math.min(1, (after - 1) / 1)) * 0.3;
			if (divider) score = Math.max(score, 0.8);
			if (/^\p{Ll}/u.test(text)) score -= 0.2;
			if (text.length > 80) score -= 0.15;
			out.push({ page: p.index, row: i, rows: j - i, text, score, divider, box: boxOf(titleRows) });
			// The rows of a wrapped title are not titles of their own.
			i = j - 1;
		}
	}
	return out;
}

/**
 * Keeps the candidates that look like this book's titles. Candidates that pass
 * the base score teach the book's title position (how far down the page titles
 * start); a weak candidate far from that position is dropped, a strong one kept.
 */
export function pickTitles(cands: TitleCandidate[], pages: PageRows[]): TitleCandidate[] {
	const strong = cands.filter((c) => c.score >= 0.75 && !c.divider);
	const pageOf = new Map(pages.map((p) => [p.index, p]));
	const tops = strong.filter((c) => c.row === 0).map((c) => c.box.y0);
	const titleTop = tops.length >= 3 ? percentile(tops, 0.5) : null;
	return cands.filter((c) => {
		if (c.score >= 0.75 || c.divider) return true;
		if (c.score < 0.55) return false;
		// Weak: accept only at the learned title position.
		const p = pageOf.get(c.page);
		return !!p && titleTop !== null && c.row === 0 && Math.abs(c.box.y0 - titleTop) < (c.box.y1 - c.box.y0) * 1.5;
	});
}

const MATTER =
	/^(?:also by\b.*|books by\b.*|by the same author|other books\b.*|praise\b.*|title(?: page)?|half[- ]title|cover|copyright(?: page)?|dedication|epigraph|(?:table of )?contents|acknowledg(?:e)?ments?|notes(?: (?:&|and) acknowledg(?:e)?ments?)?|about the (?:author|publisher)|index|bibliography|colophon|newsletter\b.*|teaser\b.*)$/i;

export const isMatterTitle = (t: string) => MATTER.test(t.trim());

const norm = (t: string) =>
	t
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[’‘`]/g, "'")
		.replace(/[^\p{L}\p{N}' ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Share of `a`'s tokens found in `b`. */
function tokenCover(a: string, b: string): number {
	const ta = norm(a).split(" ").filter(Boolean);
	const tb = new Set(norm(b).split(" ").filter(Boolean));
	if (!ta.length) return 0;
	return ta.filter((t) => tb.has(t)).length / ta.length;
}

/** Finds an outline entry's printed title on its page: the first run of up to four rows whose words are the title's. */
function locateTitle(page: PageRows, title: string, from: number): { row: number; rows: number } | null {
	const rows = page.rows;
	for (let i = from; i < rows.length; i++) {
		let text = "";
		for (let j = i; j < Math.min(rows.length, i + 4); j++) {
			text = `${text} ${rows[j].text}`;
			const cover = tokenCover(text, title);
			if (cover < 0.8) break;
			if (tokenCover(title, text) >= 0.6) {
				// Take following rows too while they still belong to the title ("1" / "The Harbor").
				let end = j + 1;
				while (end < Math.min(rows.length, i + 4) && tokenCover(`${text} ${rows[end].text}`, title) >= 0.99) {
					text = `${text} ${rows[end].text}`;
					end++;
				}
				return { row: i, rows: end - i };
			}
		}
	}
	return null;
}

/** Starts from the outline: one per entry; entries with children are sections, known front and back matter is matter. */
export function startsFromOutline(outline: OutlineEntry[], pages: PageRows[], flags: Flag[]): Start[] {
	const pageOf = new Map(pages.map((p) => [p.index, p]));
	const starts: Start[] = [];
	const usedRow = new Map<number, number>();
	outline.forEach((e, i) => {
		const page = pageOf.get(e.page);
		if (!page) return;
		const hasChildren = (outline[i + 1]?.level ?? 0) > e.level;
		const kind: WorkKind = isMatterTitle(e.title) ? "matter" : hasChildren ? "section" : "work";
		const from = usedRow.get(e.page) ?? 0;
		const found = locateTitle(page, e.title, from);
		if (found) {
			usedRow.set(e.page, found.row + found.rows);
			starts.push({
				kind,
				title: e.title,
				page: e.page,
				row: found.row,
				titleRows: found.rows,
				titleBox: boxOf(page.rows.slice(found.row, found.row + found.rows)),
				source: "outline",
				confidence: 0.95,
			});
		} else {
			if (kind === "work")
				flags.push({
					kind: "low-confidence-title",
					page: e.page,
					reason: `Outline entry "${e.title}" is not printed on its page; the work starts at the top of the page.`,
					text: e.title,
				});
			starts.push({
				kind,
				title: e.title,
				page: e.page,
				row: from,
				titleRows: 0,
				source: "outline",
				confidence: kind === "work" ? 0.6 : 0.9,
			});
		}
	});
	// Two entries on the same page out of order (rare) would break the slicing; keep reading order.
	starts.sort((a, b) => a.page - b.page || a.row - b.row);
	return starts;
}

/** Starts from layout titles. Text before the first title is an untitled opening (or front matter). */
export function startsFromLayout(titles: TitleCandidate[], pages: PageRows[], flags: Flag[]): Start[] {
	// Front and back matter by title. Everything after back matter (ads, previews) is matter
	// too, but only in the last quarter of the book: earlier, a "Notes" or "Acknowledgments"
	// heading (an introduction's endnotes) is matter for its own stretch only.
	const lastPage = pages.length ? pages[pages.length - 1].index : 0;
	let back = false;
	let seenWork = false;
	const kinds = titles.map((t): WorkKind => {
		if (isMatterTitle(t.text)) {
			if (seenWork && t.page >= lastPage * 0.75) back = true;
			return "matter";
		}
		if (back) return "matter";
		const section = t.divider || /^(?:part|book|section)\s+(?:\d+|[IVXLC]+|\p{L}+)\b/iu.test(t.text);
		if (!section) seenWork = true;
		return section ? "section" : "work";
	});
	const starts: Start[] = titles.map((t, i) => ({
		kind: kinds[i],
		title: t.text,
		page: t.page,
		row: t.row,
		titleRows: t.rows,
		titleBox: t.box,
		source: "layout",
		confidence: Math.min(0.95, Math.max(0.3, t.score)),
	}));
	markFrontMatter(starts, pages, lastPage);
	for (const s of starts)
		if (s.confidence < 0.75 && s.kind === "work")
			flags.push({
				kind: "low-confidence-title",
				page: s.page,
				reason: `"${s.title}" was taken as a title, but it stands out only weakly from the body text.`,
				text: s.title,
				box: s.titleBox,
			});
	const first = starts[0];
	const lead = pages.filter((p) => !first || p.index < first.page || (p.index === first.page && first.row > 0));
	const leadText = lead
		.flatMap((p) => (first && p.index === first.page ? p.rows.slice(0, first.row) : p.rows))
		.map((r) => r.text)
		.join(" ");
	if (leadText.trim()) {
		const matter = /copyright|©|\bisbn\b|all rights reserved|library of congress|first published/i.test(leadText);
		const p = lead.find((pg) => pg.rows.length) ?? pages[0];
		starts.unshift({
			kind: matter ? "matter" : "work",
			title: "",
			page: p.index,
			row: 0,
			titleRows: 0,
			source: "start",
			confidence: 0.4,
		});
	}
	return starts;
}

const COPYRIGHT = /copyright|©|\bisbn\b|all rights reserved|library of congress|first published/i;

const LABEL = /^(?:chapter|part|book)\b|^(?:\d+|[IVXLC]+)\.?$/i;

/**
 * Joins stacked headings into one title: a work with no body whose heading sits
 * directly above the next work's ("CHAPTER TWO" / "Deconstructing My Self" /
 * "LEVI S. GOVONI" → "CHAPTER TWO: Deconstructing My Self — LEVI S. GOVONI").
 */
export function joinStackedTitles(starts: Start[]): Start[] {
	const out: Start[] = [];
	for (const s of starts) {
		const prev = out[out.length - 1];
		const stacked =
			prev &&
			prev.kind === "work" &&
			s.kind === "work" &&
			prev.source === "layout" &&
			s.source === "layout" &&
			prev.page === s.page &&
			prev.title &&
			s.row === prev.row + prev.titleRows;
		if (!stacked) {
			out.push(s);
			continue;
		}
		const joiner = LABEL.test(prev.title.trim()) && !prev.title.includes(":") ? ": " : " — ";
		const box =
			prev.titleBox && s.titleBox
				? {
						x0: Math.min(prev.titleBox.x0, s.titleBox.x0),
						y0: Math.min(prev.titleBox.y0, s.titleBox.y0),
						x1: Math.max(prev.titleBox.x1, s.titleBox.x1),
						y1: Math.max(prev.titleBox.y1, s.titleBox.y1),
					}
				: (prev.titleBox ?? s.titleBox);
		out[out.length - 1] = {
			...s,
			title: `${prev.title.trim()}${joiner}${s.title.trim()}`,
			row: prev.row,
			titleRows: prev.titleRows + s.titleRows,
			titleBox: box,
			confidence: Math.max(prev.confidence, s.confidence),
		};
	}
	return out;
}

/**
 * Front matter that has no matter title of its own: in the first 15% of the
 * book, everything before an early "Contents" (title page, copyright page,
 * dedication), and any stretch whose text carries copyright wording. Title-page
 * lines set large are otherwise taken for works. (A copyright page is short:
 * stretches over two pages are left alone.)
 */
function markFrontMatter(starts: Start[], pages: PageRows[], lastPage: number) {
	const front = lastPage * 0.15;
	const contents = starts.findIndex((s) => s.page <= front && /^(?:table of )?contents$/i.test(s.title.trim()));
	for (let i = 0; i < contents; i++) starts[i].kind = "matter";
	const pageOf = new Map(pages.map((p) => [p.index, p]));
	starts.forEach((s, i) => {
		const next = starts[i + 1];
		// Copyright pages are short; a long stretch that mentions publishing is text.
		if (s.kind === "matter" || s.page > front || (next?.page ?? lastPage) - s.page > 2) return;
		let text = "";
		for (let p = s.page; p <= (next?.page ?? s.page); p++) {
			const rows = pageOf.get(p)?.rows ?? [];
			const from = p === s.page ? s.row + s.titleRows : 0;
			const to = next && p === next.page ? next.row : rows.length;
			text += ` ${rows
				.slice(from, to)
				.map((r) => r.text)
				.join(" ")}`;
		}
		if (COPYRIGHT.test(text)) s.kind = "matter";
	});
}

/**
 * Chooses between the outline and the layout. The outline wins when it marks
 * about as many works as the layout finds titles; an outline that marks only
 * sections or chapters of a larger kind (fewer entries than titles) supplies
 * the sections, and layout titles supply the works inside them.
 */
export function chooseStarts(
	outline: OutlineEntry[],
	pages: PageRows[],
	stats: BookStats,
	flags: Flag[],
): { starts: Start[]; detection: "outline" | "layout" | "outline+layout" } {
	const layoutFlags: Flag[] = [];
	const titles = pickTitles(findTitleCandidates(pages, stats), pages);
	if (outline.length) {
		const outlineFlags: Flag[] = [];
		const fromOutline = startsFromOutline(outline, pages, outlineFlags);
		const works = fromOutline.filter((s) => s.kind === "work");
		const matterPages = new Set<number>();
		fromOutline.forEach((s, i) => {
			if (s.kind !== "matter") return;
			const end = fromOutline[i + 1]?.page ?? s.page + 1;
			for (let p = s.page; p < Math.max(end, s.page + 1); p++) matterPages.add(p);
		});
		const strong = titles.filter((t) => t.score >= 0.75 && !t.divider && !matterPages.has(t.page));
		if (works.length >= strong.length * 0.6 || strong.length < 3) {
			flags.push(...outlineFlags);
			return { starts: fromOutline, detection: "outline" };
		}
		// Outline marks only larger units: keep its sections and matter, add layout titles as works.
		const keep = fromOutline
			.filter((s) => s.kind !== "work" || !strong.some((t) => t.page === s.page))
			.map((s) => (s.kind === "work" ? { ...s, kind: "section" as const } : s));
		const layout = startsFromLayout(
			titles.filter((t) => !matterPages.has(t.page)),
			pages,
			layoutFlags,
		).filter((s) => s.source !== "start");
		flags.push(...layoutFlags);
		const starts = joinStackedTitles([...keep, ...layout].sort((a, b) => a.page - b.page || a.row - b.row));
		return { starts, detection: "outline+layout" };
	}
	const starts = joinStackedTitles(startsFromLayout(titles, pages, layoutFlags));
	flags.push(...layoutFlags);
	return { starts, detection: "layout" };
}
