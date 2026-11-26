import { describe, expect, it } from "vitest";
import {
	bodyFontSize,
	furnitureKey,
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
