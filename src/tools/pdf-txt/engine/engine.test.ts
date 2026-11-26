import { describe, expect, it } from "vitest";
import type { Line, OutlineEntry, PageModel } from "../../../lib/pdf/heuristics.ts";
import { guessMode } from "./guess.ts";
import { convert, sentences, summarize, toTxt, txtLines } from "./index.ts";
import { toRows } from "./layout.ts";
import { compareToReference, parseReference } from "./measure.ts";
import { indentLevels } from "./poetry.ts";
import { joinStackedTitles, type Start } from "./works.ts";

const W = 360;
const H = 520;
const LEAD = 14;

function line(text: string, y: number, opts: Partial<Line> = {}): Line {
	const x0 = opts.x0 ?? 40;
	return { text, x0, y0: y, x1: x0 + text.length * 4.5, y1: y + 9, size: 8, bold: false, italic: false, ...opts };
}

function page(index: number, lines: Line[], extra: Partial<PageModel> = {}): PageModel {
	return { index, width: W, height: H, blocks: lines.map((l) => ({ kind: "text" as const, lines: [l] })), ...extra };
}

const title = (text: string, y = 30) => line(text, y, { size: 11, y1: y + 13 });

/** A stanza of `n` lines from `y`, one leading apart. */
function stanza(words: string, n: number, y: number, x0 = 40): Line[] {
	return Array.from({ length: n }, (_, i) => line(`${words} line ${i + 1} of the stanza`, y + i * LEAD, { x0 }));
}

/** A small poetry book: titles at the top, page numbers at the foot. */
function book(): PageModel[] {
	const folio = (i: number) => line(String(i + 3), 495, { x0: 176, x1: 186, size: 7.5 });
	return [
		page(0, [title("First Poem"), ...stanza("alpha", 3, 65), ...stanza("beta", 3, 65 + 4 * LEAD + 12), folio(0)]),
		page(1, [title("Second Poem"), ...stanza("gamma", 4, 65), folio(1)]),
		page(2, [...stanza("gamma more", 2, 30), line("4O", 495, { x0: 176, x1: 186, size: 7.5 })]),
		page(3, [title("Third Poem"), ...stanza("delta", 3, 65), folio(3)]),
		page(4, [], { imageOnly: true }),
		page(5, [title("Fourth Poem"), ...stanza("epsilon", 2, 65), folio(5)]),
	];
}

describe("rows", () => {
	it("joins OCR word groups on one baseline, keeping wide gaps as spaces", () => {
		const p = page(0, [
			line("a b c", 100, { x0: 40, x1: 60 }),
			line("a b c", 100, { x0: 100, x1: 120 }),
			line("so we", 120, { x0: 40, x1: 62 }),
			line("begin", 120, { x0: 65, x1: 85 }),
		]);
		const rows = toRows(p);
		expect(rows.map((r) => r.text)).toEqual(["a b c          a b c", "so we begin"]);
	});
});

describe("indent levels", () => {
	it("snaps OCR jitter to one level without chaining scattered indents together", () => {
		const level = indentLevels([0, 1.6, 1.75, 1.7, 4, 4.5, 5, 5.5, 6], 0.6);
		expect(level(1.6)).toBe(level(1.75));
		expect(level(4)).not.toBe(level(6));
	});
});

describe("poetry", () => {
	const result = convert(book(), [], { mode: "poetry" });

	it("finds every titled poem from layout and keeps page links", () => {
		expect(result.detection).toBe("layout");
		expect(result.works.map((w) => [w.title, w.page, w.endPage])).toEqual([
			["First Poem", 0, 0],
			["Second Poem", 1, 2],
			["Third Poem", 3, 3],
			["Fourth Poem", 5, 5],
		]);
		for (const w of result.works) for (const l of w.lines) if (l.text) expect(l.box).toBeDefined();
		expect(result.works[1].lines.at(-1)?.page).toBe(2);
	});

	it("keeps one printed line per TXT line and marks stanza breaks", () => {
		const first = result.works[0].lines.map((l) => l.text);
		expect(first).toEqual([
			"alpha line 1 of the stanza",
			"alpha line 2 of the stanza",
			"alpha line 3 of the stanza",
			"",
			"beta line 1 of the stanza",
			"beta line 2 of the stanza",
			"beta line 3 of the stanza",
		]);
	});

	it("strips page numbers, including OCR-garbled ones where the book prints them", () => {
		const all = result.works.flatMap((w) => w.lines.map((l) => l.text));
		expect(all.some((t) => /^\d+$|^4O$/.test(t))).toBe(false);
		expect(result.flags.find((f) => f.kind === "furniture-removed")).toMatchObject({ page: 2, text: "4O" });
	});

	it("flags image-only pages instead of exporting them silently", () => {
		expect(result.flags.filter((f) => f.kind === "image-only").map((f) => f.page)).toEqual([4]);
		expect(summarize(result).needsOcr).toEqual([4]);
	});

	it("exports title, blank line, body, and three empty lines between works", () => {
		const txt = toTxt(result);
		expect(txt.startsWith("First Poem\n\nalpha line 1")).toBe(true);
		expect(txt).toContain("beta line 3 of the stanza\n\n\n\nSecond Poem\n\n");
		expect(txt.endsWith("epsilon line 2 of the stanza\n")).toBe(true);
		expect(txt).not.toContain("\r");
	});

	it("finds a title that starts mid-page and one that wraps onto a second row", () => {
		const pages = [
			page(0, [
				title("A Long Title That Runs On", 30),
				title("to a Second Row", 45),
				...stanza("one", 3, 80),
				title("Short Poem", 80 + 3 * LEAD + 30),
				...stanza("two", 2, 80 + 3 * LEAD + 30 + 35),
			]),
			page(1, [title("Last"), ...stanza("three", 3, 65)]),
			page(2, [title("Very Last"), ...stanza("four", 3, 65)]),
		];
		const r = convert(pages, [], { mode: "poetry" });
		expect(r.works.map((w) => w.title)).toEqual([
			"A Long Title That Runs On to a Second Row",
			"Short Poem",
			"Last",
			"Very Last",
		]);
		expect(r.works[0].lines).toHaveLength(3);
	});

	it("joins an indented runover only where the poem uses that indent for nothing else", () => {
		const long = "a line long enough to reach the right margin of the page and";
		const rows = (indentAfterShort: boolean) =>
			page(0, [
				title("Wraps"),
				line(long, 65, { x1: 330 }),
				line("wrap onto the next", 65 + LEAD, { x0: 80 }),
				line("A short line.", 65 + 2 * LEAD),
				line(indentAfterShort ? "stepped by design" : "Another short line.", 65 + 3 * LEAD, {
					x0: indentAfterShort ? 80 : 40,
				}),
			]);
		const pages = (indentAfterShort: boolean) => [
			rows(indentAfterShort),
			page(1, [title("Next"), ...stanza("x", 2, 65)]),
			page(2, [title("Other"), ...stanza("y", 2, 65)]),
		];
		const joined = convert(pages(false), [], { mode: "poetry" });
		expect(joined.works[0].lines[0].text).toBe(`${long} wrap onto the next`);
		expect(joined.flags.some((f) => f.kind === "wrap-joined")).toBe(true);
		const kept = convert(pages(true), [], { mode: "poetry" });
		expect(kept.works[0].lines[1].text).toBe("wrap onto the next");
	});

	it("keeps indentation as leading spaces unless asked not to", () => {
		const pages = [page(0, [title("Steps"), line("flush", 65), line("indented", 65 + LEAD, { x0: 72 })])];
		const r = convert(pages, [], { mode: "poetry" });
		expect(toTxt(r)).toBe(`Steps\n\nflush\n${" ".repeat(8)}indented\n`);
		expect(toTxt(r, { indent: false })).toBe("Steps\n\nflush\nindented\n");
	});

	it("reads a lone bar on an OCR page back as I, with a flag", () => {
		const pages = [
			page(0, [title("Where | Stood"), line("Then | left.", 65), ...stanza("then", 3, 65 + LEAD)], { ocr: true }),
		];
		const r = convert(pages, [], { mode: "poetry" });
		expect(r.works[0].title).toBe("Where I Stood");
		expect(r.works[0].lines[0].text).toBe("Then I left.");
		expect(r.flags.filter((f) => f.kind === "ocr-fixed")).toHaveLength(2);
	});
});

describe("outline", () => {
	const pages = [
		page(0, [line("Copyright 2020 by Someone. All rights reserved.", 60)]),
		page(1, [line("II", 150, { size: 24, y1: 175 })]),
		page(2, [line("The Poem", 60, { bold: true }), ...stanza("body", 3, 90)]),
		page(3, [line("Untitled In Print", 60), ...stanza("more", 2, 90)]),
	];
	const outline: OutlineEntry[] = [
		{ title: "Copyright", page: 0, level: 1 },
		{ title: "II", page: 1, level: 1 },
		{ title: "The Poem", page: 2, level: 2 },
		{ title: "Missing Title", page: 3, level: 2 },
	];
	const r = convert(pages, outline, { mode: "poetry" });

	it("classifies entries as matter, sections and works", () => {
		expect(r.detection).toBe("outline");
		expect(r.works.map((w) => [w.kind, w.title])).toEqual([
			["matter", "Copyright"],
			["section", "II"],
			["work", "The Poem"],
			["work", "Missing Title"],
		]);
		expect(r.works[2].lines.map((l) => l.text)[0]).toBe("body line 1 of the stanza");
	});

	it("flags an outline title that is not printed on its page", () => {
		expect(r.flags.find((f) => f.kind === "low-confidence-title")).toMatchObject({ page: 3 });
		expect(r.works[3].lines[0].text).toBe("Untitled In Print");
	});

	it("leaves matter out of the TXT unless asked", () => {
		expect(toTxt(r)).not.toContain("Copyright");
		expect(toTxt(r, { matter: true })).toContain("Copyright");
		expect(toTxt(r).startsWith("II\n\n\n\nThe Poem\n\n")).toBe(true);
	});
});

describe("outline that marks only parts", () => {
	it("keeps the outline as sections and takes works from layout titles", () => {
		const b = book();
		const outline: OutlineEntry[] = [{ title: "Part One", page: 0, level: 1 }];
		const r = convert(b, outline, { mode: "poetry" });
		expect(r.detection).toBe("outline+layout");
		expect(r.works.filter((w) => w.kind === "work").map((w) => w.title)).toEqual([
			"First Poem",
			"Second Poem",
			"Third Poem",
			"Fourth Poem",
		]);
	});
});

describe("scans without text", () => {
	it("returns no works but a flag for every page, never a silently empty result", () => {
		const pages = [0, 1, 2].map((i) => page(i, [], { imageOnly: true }));
		const r = convert(pages, [], { mode: "prose" });
		expect(r.works).toEqual([]);
		expect(toTxt(r)).toBe("");
		expect(summarize(r).needsOcr).toEqual([0, 1, 2]);
	});
});

describe("prose", () => {
	it("puts one sentence per line, mending abbreviations, initials and quoted speech", () => {
		expect(sentences("Mr. Darrow came home. J. R. R. Tolkien wrote it. “Go!” she said. Then e.g. this.")).toEqual([
			"Mr. Darrow came home.",
			"J. R. R. Tolkien wrote it.",
			"“Go!” she said.",
			"Then e.g. this.",
		]);
	});

	it("rebuilds paragraphs across printed lines and pages, a blank line between paragraphs", () => {
		const prose = (y: number, text: string, x0 = 40, x1 = 320) => line(text, y, { x0, x1, size: 11, y1: y + 13 });
		const pages = [
			page(0, [
				line("Chapter One", 60, { size: 20, y1: 84 }),
				prose(110, "The first sentence ends here. The second one", 55),
				prose(124, "runs on to the next line. A third sentence"),
				prose(138, "goes onto the next"),
			]),
			page(1, [prose(40, "page and ends.", 40, 140), prose(54, "A new paragraph.", 55, 140)]),
		];
		const outline = [{ title: "Chapter One", page: 0, level: 1 }];
		const r = convert(pages, outline, { mode: "prose" });
		expect(r.works[0].title).toBe("Chapter One");
		expect(r.works[0].lines.map((l) => l.text)).toEqual([
			"The first sentence ends here.",
			"The second one runs on to the next line.",
			"A third sentence goes onto the next page and ends.",
			"",
			"A new paragraph.",
		]);
		expect(r.works[0].lines.at(-1)?.page).toBe(1);
	});
});

describe("measure", () => {
	it("parses a reference TXT and counts matching titles and lines", () => {
		const ref = "First Poem\nalpha line 1 of the stanza\n\n\n\nSecond Poem\ngamma line 1 of the stanza\n";
		expect(parseReference(ref).map((w) => w.title)).toEqual(["First Poem", "Second Poem"]);
		const m = compareToReference(convert(book(), [], { mode: "poetry" }), ref);
		expect(m.titlesFound).toBe(2);
		expect(m.titlesExact).toBe(2);
		expect(m.bodyMatched).toBe(2);
	});
});

describe("txtLines", () => {
	it("is toTxt line by line, with each line's source page and work", () => {
		const result = convert(book(), [], { mode: "poetry" });
		const lines = txtLines(result);
		expect(`${lines.map((l) => l.text).join("\n")}\n`).toBe(toTxt(result));
		const gamma = lines.find((l) => l.text.startsWith("gamma more"));
		expect(gamma?.page).toBe(2);
		expect(result.works[gamma?.work ?? -1].title).toBe("Second Poem");
		expect(lines.find((l) => l.text === "Third Poem")?.box).toBeDefined();
	});
});

describe("guessMode", () => {
	/** A page of lines starting at x0 40, reaching x1 from `ends`. */
	const shaped = (ends: number[]) =>
		page(
			0,
			ends.map((x1, i) => line("words ".repeat(8), 40 + i * LEAD, { x1 })),
		);

	it("reads ragged lines as poetry and full lines as prose", () => {
		expect(guessMode([shaped([180, 250, 140, 300, 210, 160, 230, 320, 190, 150])])).toBe("poetry");
		expect(guessMode([shaped([320, 319, 320, 318, 320, 200, 320, 320, 319, 320])])).toBe("prose");
	});

	it("measures each column against its own edge", () => {
		const col = (x0: number, x1: number) =>
			Array.from({ length: 8 }, (_, i) => line("words ".repeat(5), 40 + i * LEAD, { x0, x1 }));
		expect(guessMode([page(0, [...col(30, 170), ...col(190, 330)])])).toBe("prose");
	});

	it("defaults to poetry when there is too little text to tell", () => {
		expect(guessMode([page(0, [line("Title", 30)])])).toBe("poetry");
	});
});

describe("front and back matter in a book without bookmarks", () => {
	const body = (n: number, y = 70) =>
		Array.from({ length: n }, (_, i) =>
			line(`Prose words fill this printed line from the left edge across to the right ${i}`, y + i * LEAD),
		);
	const big = (text: string, y = 30) => line(text, y, { size: 16, y1: y + 18 });
	/** Title page, copyright, contents, an introduction with its own notes, chapters, acknowledgments. */
	function anthology(): PageModel[] {
		const pages: PageModel[] = [
			page(0, [big("A MADE-UP ANTHOLOGY", 120), big("Edited by Nobody", 160)]),
			page(1, [line("Copyright © 2001 Example Press. All rights reserved.", 300)]),
			page(2, [title("Contents"), ...body(4)]),
			page(3, [title("Introduction"), ...body(20)]),
			page(4, [title("Notes"), ...body(6)]),
		];
		const numbers = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE"];
		for (const [i, n] of numbers.entries())
			pages.push(page(pages.length, [title(`CHAPTER ${n}`), title(`Story Number ${i + 1}`, 46), ...body(20, 80)]));
		pages.push(page(pages.length, [title("Acknowledgments"), ...body(5)]));
		pages.push(page(pages.length, [title("Contributors"), ...body(8)]));
		return pages;
	}

	it("keeps the chapters as works and leaves out matter at both ends", () => {
		const result = convert(anthology(), [], { mode: "prose" });
		const works = result.works.filter((w) => w.kind === "work").map((w) => w.title);
		expect(works).toContain("Introduction");
		expect(works).toContain("CHAPTER ONE Story Number 1");
		expect(works).toContain("CHAPTER TWELVE Story Number 12");
		expect(works).toHaveLength(13);
		expect(works).not.toContain("A MADE-UP ANTHOLOGY");
		const matter = result.works.filter((w) => w.kind === "matter").map((w) => w.title);
		expect(matter).toEqual(expect.arrayContaining(["Contents", "Notes", "Acknowledgments", "Contributors"]));
		expect(toTxt(result)).not.toMatch(/Copyright|Contributors/);
	});
});

describe("stacked headings", () => {
	const start = (title: string, row: number, extra: Partial<Start> = {}): Start => ({
		kind: "work",
		title,
		page: 4,
		row,
		titleRows: 1,
		source: "layout",
		confidence: 0.9,
		...extra,
	});

	it("joins a label, a title and a byline set one under another", () => {
		const joined = joinStackedTitles([start("CHAPTER TWO", 0), start("Deconstructing", 1), start("A. WRITER", 2)]);
		expect(joined).toHaveLength(1);
		expect(joined[0]).toMatchObject({ title: "CHAPTER TWO: Deconstructing — A. WRITER", row: 0, titleRows: 3 });
	});

	it("leaves works with a body between them, sections and other pages alone", () => {
		expect(joinStackedTitles([start("One", 0), start("Two", 5)])).toHaveLength(2);
		expect(joinStackedTitles([start("I", 0, { kind: "section" }), start("Poem", 1)])).toHaveLength(2);
		expect(joinStackedTitles([start("One", 0), start("Two", 0, { page: 5 })])).toHaveLength(2);
	});
});
