import { describe, expect, it } from "vitest";
import { renderParas, splitChapters } from "./chapters.ts";

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
