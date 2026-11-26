import { describe, expect, it } from "vitest";
import {
	bodyFontSize,
	folioOf,
	furnitureKey,
	isJunkText,
	joinFragments,
	joinLines,
	type Line,
	type PageModel,
	renderParas,
	splitChapters,
	stripFurniture,
	toParagraphs,
} from "./heuristics.ts";

const W = 432;
const H = 648;

function line(text: string, y: number, opts: Partial<Line> = {}): Line {
	return { text, x0: 54, y0: y, x1: 378, y1: y + 12, size: 11, bold: false, italic: false, ...opts };
}

function page(index: number, ...blocks: Line[][]): PageModel {
	return { index, width: W, height: H, blocks: blocks.map((lines) => ({ kind: "text" as const, lines })) };
}

describe("bodyFontSize", () => {
	it("picks the size carrying the most characters", () => {
		const p = page(0, [line("Big Title", 60, { size: 24 })], [line("a".repeat(400), 120), line("b".repeat(400), 134)]);
		expect(bodyFontSize([p])).toBe(11);
	});
});

describe("furniture", () => {
	it("normalizes numbers so running headers match across pages", () => {
		expect(furnitureKey("Chapter 3 · 41")).toBe(furnitureKey("Chapter 3 · 42"));
		expect(furnitureKey("  The   River  ")).toBe("the river");
	});

	it("removes repeated headers and page numbers but keeps body text", () => {
		const pages = Array.from({ length: 8 }, (_, i) =>
			page(
				i,
				[line("THE RIVER BOOK", 20)],
				[line(`Body text on page ${i} that is unique.`, 200)],
				[line(String(i + 1), 620)],
			),
		);
		stripFurniture(pages);
		for (const p of pages) {
			expect(p.blocks).toHaveLength(1);
			expect(p.blocks[0].kind === "text" && p.blocks[0].lines[0].text).toMatch(/^Body text/);
		}
	});

	it("keeps a one-off line near the top (like a chapter title)", () => {
		const pages = Array.from({ length: 8 }, (_, i) => page(i, [line(i === 3 ? "A Rare Title" : `Head ${i}`, 20)]));
		stripFurniture(pages);
		expect(pages[3].blocks).toHaveLength(1);
	});
});

describe("joinLines", () => {
	it("undoes end-of-line hyphenation and joins with spaces", () => {
		expect(joinLines(["The quick brown fox jum-", "ped over the lazy dog."])).toBe(
			"The quick brown fox jumped over the lazy dog.",
		);
		expect(joinLines(["Well-", "Known names"])).toBe("Well- Known names");
		expect(joinLines(["soft­hyphen", "here"])).toBe("softhyphen here");
	});
});

describe("toParagraphs", () => {
	it("detects headings by size relative to body text", () => {
		const p = page(
			0,
			[line("Chapter One", 60, { size: 22 })],
			[line("Section", 100, { size: 15 })],
			[line("Body paragraph text.", 140)],
		);
		const paras = toParagraphs([p], 11);
		expect(paras.map((x) => x.kind)).toEqual(["h1", "h2", "p"]);
	});

	it("joins a paragraph that continues onto the next page", () => {
		const pages = [
			page(0, [line("The sentence starts here and", 500)]),
			page(1, [line("continues on the next page.", 60)]),
		];
		const paras = toParagraphs(pages, 11);
		expect(paras).toHaveLength(1);
		expect(paras[0].kind === "p" && paras[0].text).toBe("The sentence starts here and continues on the next page.");
	});

	it("does not join across a finished sentence", () => {
		const pages = [page(0, [line("A finished sentence.", 500)]), page(1, [line("another starts lowercase.", 60)])];
		expect(toParagraphs(pages, 11)).toHaveLength(2);
	});

	it("splits a block into paragraphs at first-line indents", () => {
		const p = page(0, [
			line("First paragraph line one that runs the full width", 100),
			line("and ends here.", 114, { x1: 160 }),
			line("Second paragraph begins indented", 128, { x0: 72 }),
			line("and continues.", 142),
		]);
		const paras = toParagraphs([p], 11);
		expect(paras).toHaveLength(2);
	});
});

describe("splitChapters", () => {
	const paras = [
		{ kind: "p" as const, text: "Preface", page: 0 },
		{ kind: "h1" as const, text: "One", page: 1 },
		{ kind: "p" as const, text: "one body", page: 1 },
		{ kind: "h1" as const, text: "Two", page: 3 },
		{ kind: "p" as const, text: "two body", page: 3 },
	];

	it("splits by outline and keeps entries that share a page", () => {
		const chapters = splitChapters(
			paras,
			[
				{ title: "Part I", page: 1, level: 1 },
				{ title: "Chapter 1", page: 1, level: 2 },
				{ title: "Chapter 2", page: 3, level: 2 },
			],
			"Book",
		);
		expect(chapters.map((c) => c.title)).toEqual(["Front matter", "Part I", "Chapter 2"]);
		expect(chapters[1].nav.map((n) => n.title)).toEqual(["Part I", "Chapter 1"]);
	});

	it("falls back to h1 headings without an outline", () => {
		const chapters = splitChapters(paras, [], "Book");
		expect(chapters.map((c) => c.title)).toEqual(["Book", "One", "Two"]);
	});
});

describe("renderParas", () => {
	it("escapes text and marks first paragraphs after headings", () => {
		const html = renderParas([
			{ kind: "h2", text: "A & B", page: 0 },
			{ kind: "p", text: "<tag>", page: 0 },
			{ kind: "p", text: "next", page: 0 },
		]);
		expect(html).toBe('<h2>A &amp; B</h2>\n<p class="first">&lt;tag&gt;</p>\n<p>next</p>\n');
	});
});

describe("running heads with page numbers", () => {
	it("reads folios at either end of a header line", () => {
		expect(folioOf("30 What Is Gender?")).toEqual({ kind: "arabic", value: 30 });
		expect(folioOf("Introduction xvii")).toEqual({ kind: "roman", value: 17 });
		expect(folioOf("PART I")).toBeNull(); // uppercase roman is a heading, not a folio
		expect(folioOf("What Is Gender?")).toBeNull();
	});

	it("strips chapter running heads that change every few pages, keeping body text", () => {
		// Printed page number = index - 10; each chapter has its own running head.
		const heads = ["Coatlicue", "Coatlicue", "Namesake", "Namesake", "Scrimshaw"];
		const pages = heads.map((h, i) =>
			page(i + 20, [line(i % 2 ? `${h} ${i + 10}` : `${i + 10} ${h}`, 20)], [line(`Body ${i} text.`, 200)]),
		);
		stripFurniture(pages);
		const left = pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "text" ? b.lines.map((l) => l.text) : [])));
		expect(left).toEqual(heads.map((_, i) => `Body ${i} text.`));
	});

	it("keeps a top-of-page line that merely starts with a number", () => {
		const pages = [page(5, [line("1984 was the year it began.", 20)], [line("More text.", 200)])];
		stripFurniture(pages);
		expect(pages[0].blocks).toHaveLength(2);
	});
});

describe("OCR text layers", () => {
	const ocr = (index: number, ...blocks: Line[][]): PageModel => ({ ...page(index, ...blocks), ocr: true });
	const at = (text: string, y: number, x0 = 54, x1 = 378, opts: Partial<Line> = {}) =>
		line(text, y, { x0, x1, ...opts });

	it("flags show-through noise but not real text", () => {
		expect(isJunkText("Saeed ae on - ile BeLa= vi xt ue Th _ ; oe a ann sans")).toBe(true);
		expect(isJunkText("~ pre ee — —— oe ca")).toBe(true);
		expect(isJunkText("NONBINARY")).toBe(false);
		expect(
			isJunkText("10. Kristen Hare, “AP Style Change: Singular They Is Acceptable in Limited Cases,” Poynter"),
		).toBe(false);
	});

	it("rejoins one printed line split into word groups", () => {
		const joined = joinFragments([
			at("okay way", 100, 56, 103),
			at("to communicate,", 100, 111, 193),
			at("as long as we", 100, 202, 300),
			at("next line", 114),
		]);
		expect(joined.map((l) => l.text)).toEqual(["okay way to communicate, as long as we", "next line"]);
	});

	it("rebuilds paragraphs from line-sized blocks, splitting at first-line indents", () => {
		const p = ocr(
			3,
			[at("witches, butches, and hippies became part of my landscape. I decided", 50)],
			[
				at("I must be one of them. I became a free spirit, openly queer in jeans", 64),
				at("and a womanhood.", 78, 54, 160),
			],
			[at("I was twenty-one the first time I heard the word “genderqueer.” It", 92, 66)],
			[at("fell into my heart like the seed of a redwood tree.", 106, 54, 300)],
		);
		const paras = toParagraphs([p], 11);
		expect(paras.map((x) => ("text" in x ? x.text.slice(0, 20) : ""))).toEqual([
			"witches, butches, an",
			"I was twenty-one the",
		]);
	});

	it("keeps short dialogue lines as separate paragraphs", () => {
		const p = ocr(
			3,
			[at("“I suppose I didn’t feel the need to.”", 50, 54, 220)],
			[at("“All the other subjects did.”", 64, 54, 180)],
			[at("x".repeat(60), 78)],
		);
		expect(toParagraphs([p], 11).filter((x) => x.kind === "p").length).toBe(3);
	});

	it("continues a paragraph across a page break and a footnote", () => {
		const a = ocr(
			1,
			[at("of the early days on testosterone, the experience of not feeling like a", 500)],
			[at("1. More information available at www.asexuality.org.", 560, 70, 280, { y1: 570 })],
		);
		const b = ocr(2, [at("woman, the plain honesty and acceptance these guys had about who", 40)]);
		const paras = toParagraphs([a, b], 11).map((x) => ("text" in x ? x.text : ""));
		expect(paras[0]).toMatch(/not feeling like a woman, the plain honesty/);
		expect(paras[1]).toMatch(/^1\. More information/);
	});

	it("does not mistake a numbered heading low on the page for a footnote", () => {
		const p = page(
			1,
			[line("self-attention and discuss its advantages over models such as these.", 600)],
			[line("3 Model Architecture", 630, { size: 13, bold: true, y1: 644 })],
			[line("Most competitive neural sequence transduction models have an encoder.", 660)],
		);
		expect(toParagraphs([p], 11).map((x) => x.kind)).toEqual(["p", "h3", "p"]);
	});
});
