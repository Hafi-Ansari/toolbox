import { describe, expect, it } from "vitest";
import type { Line, PageModel } from "../../../lib/pdf/heuristics.ts";
import { convert, type Override, selectionSpan, toTxt, txtLines } from "./index.ts";
import { selectedLines } from "./select.ts";

// Made-up text only: this repo is public.

function line(text: string, y: number, opts: Partial<Line> = {}): Line {
	const x0 = opts.x0 ?? 40;
	return { text, x0, y0: y, x1: x0 + text.length * 5, y1: y + 13, size: 11, bold: false, italic: false, ...opts };
}

function page(index: number, lines: Line[]): PageModel {
	return { index, width: 360, height: 520, blocks: lines.map((l) => ({ kind: "text" as const, lines: [l] })) };
}

/** A prose line that fills the column (or stops short, ending a paragraph). */
const prose = (y: number, text: string, opts: Partial<Line> = {}) => line(text, y, { x1: 320, ...opts });
/** A verse line quoted in the prose: indented, smaller, set tighter. */
const verse = (y: number, text: string) =>
	line(text, y, { x0: 70, x1: 70 + text.length * 4, size: 9, y1: y + 10, italic: true });

/** A short novel: a paragraph, a quoted song of two stanzas running onto the next page, more prose. */
function novel(): PageModel[] {
	return [
		page(0, [
			line("Chapter One", 60, { size: 20, y1: 84 }),
			prose(110, "The hall was loud until the old woman stood. She", { x0: 55 }),
			prose(124, "began to sing, and the room went quiet."),
			verse(150, "down by the water"),
			verse(161, "the lanterns glow"),
			verse(172, "and nobody sleeps"),
			verse(189, "carry me over"),
			verse(200, "where the reeds grow"),
		]),
		page(1, [
			verse(40, "and the river keeps"),
			prose(66, "When the song ended, nobody spoke. We went home", { x0: 55 }),
			prose(80, "in the dark.", { x1: 120 }),
		]),
	];
}
const outline = [{ title: "Chapter One", page: 0, level: 1 }];

describe("prose source positions", () => {
	it("gives each sentence the printed lines it spans", () => {
		const r = convert(novel(), outline, { mode: "prose" });
		const second = r.works[0].lines.find((l) => l.text.startsWith("She began"));
		expect(second?.span).toEqual({ from: { page: 0, y: 110 }, to: { page: 0, y: 137 } });
		const last = r.works[0].lines.find((l) => l.text === "We went home in the dark.");
		expect(last?.page).toBe(1);
		expect(last?.span).toEqual({ from: { page: 1, y: 66 }, to: { page: 1, y: 93 } });
	});
});

describe("keep printed lines (prose)", () => {
	const before = convert(novel(), outline, { mode: "prose" });
	const lines = txtLines(before);
	const first = lines.findIndex((l) => l.text.startsWith("down by the water"));
	const last = lines.findIndex((l) => l.text.includes("river keeps"));
	const sel = selectionSpan(lines, first, last);
	const keep: Override[] = sel ? [{ kind: "lines", span: sel.span, text: sel.text }] : [];

	it("reflows the quoted verse without an override", () => {
		expect(lines[first].text).toContain("the lanterns glow and nobody sleeps");
	});

	it("maps the selected sentences to the verse's printed lines, not the prose around them", () => {
		expect(sel?.span).toEqual({ from: { page: 0, y: 150 }, to: { page: 1, y: 50 } });
	});

	it("keeps the marked passage line by line, with its stanza break, and leaves the prose reflowed", () => {
		const r = convert(novel(), outline, { mode: "prose", overrides: keep });
		expect(r.works[0].lines.map((l) => l.text)).toEqual([
			"The hall was loud until the old woman stood.",
			"She began to sing, and the room went quiet.",
			"",
			"down by the water",
			"the lanterns glow",
			"and nobody sleeps",
			"",
			"carry me over",
			"where the reeds grow",
			"and the river keeps",
			"",
			"When the song ended, nobody spoke.",
			"We went home in the dark.",
		]);
	});

	it("survives export options and is ignored in poetry mode", () => {
		const r = convert(novel(), outline, { mode: "prose", overrides: keep });
		expect(toTxt(r, { matter: true, indent: false })).toContain("down by the water\nthe lanterns glow\n");
		const poetry = convert(novel(), outline, { mode: "poetry", overrides: keep });
		expect(toTxt(poetry)).toBe(toTxt(convert(novel(), outline, { mode: "poetry" })));
	});

	it("takes the whole paragraph around a caret", () => {
		const caret = selectionSpan(lines, first, first, true);
		expect(caret?.span.from).toEqual({ page: 0, y: 150 });
		expect(caret?.text.startsWith("down by the water")).toBe(true);
		const title = lines.findIndex((l) => l.text === "Chapter One");
		expect(selectionSpan(lines, title, title, true)).toBeNull();
	});
});

/** A poem whose long line wraps onto a short, lowercase second line, then a prose note. */
function poems(): PageModel[] {
	const v = (y: number, text: string, x1?: number) => line(text, y, { x1: x1 ?? 40 + text.length * 5 });
	return [
		page(0, [
			line("Small Hours", 30, { size: 14, y1: 47 }),
			v(70, "the kettle and the window both"),
			v(84, "a long line that runs all the way out to the margin and", 320),
			v(98, "keeps going"),
			v(112, "until the light comes"),
			v(140, "and the cups are cold"),
			v(154, "on the sill"),
			v(168, "where we left them"),
		]),
		page(1, [
			line("Note", 30, { size: 14, y1: 47 }),
			v(70, "This poem was written in a kitchen. It took", 320),
			v(84, "a whole winter to finish.", 160),
		]),
	];
}

describe("join wrapped lines (poetry)", () => {
	const before = convert(poems(), [], { mode: "poetry" });
	const flag = before.flags.find((f) => f.kind === "possible-wrap");
	const box = flag?.box ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
	const join: Override = { kind: "join", at: { page: flag?.page ?? 0, y: (box.y0 + box.y1) / 2 } };

	it("joins the flagged runover to the line above and clears the flag", () => {
		expect(flag?.text).toBe("keeps going");
		const r = convert(poems(), [], { mode: "poetry", overrides: [join] });
		const text = r.works[0].lines.map((l) => l.text);
		expect(text[1]).toBe("a long line that runs all the way out to the margin and keeps going");
		expect(text).toHaveLength(before.works[0].lines.length - 1);
		expect(r.flags.some((f) => f.kind === "possible-wrap" && f.text === "keeps going")).toBe(false);
		expect(r.works[0].lines[1].span).toEqual({ from: { page: 0, y: 84 }, to: { page: 0, y: 111 } });
	});

	it("is undone by dropping the override", () => {
		expect(toTxt(convert(poems(), [], { mode: "poetry", overrides: [] }))).toBe(toTxt(before));
	});
});

describe("reflow as prose (poetry)", () => {
	it("reflows the marked lines into sentences and leaves the poems alone", () => {
		const before = convert(poems(), [], { mode: "poetry" });
		const lines = txtLines(before);
		const at = lines.findIndex((l) => l.text.startsWith("This poem"));
		const sel = selectionSpan(lines, at, at, true);
		expect(sel).not.toBeNull();
		const r = convert(poems(), [], { mode: "poetry", overrides: sel ? [{ kind: "reflow", span: sel.span }] : [] });
		expect(r.works[1].lines.map((l) => l.text)).toEqual([
			"This poem was written in a kitchen.",
			"It took a whole winter to finish.",
		]);
		expect(r.works[0].lines).toEqual(before.works[0].lines);
	});
});

describe("selectedLines", () => {
	const text = "one\ntwo\n\nthree\n";
	it("maps textarea offsets to TXT lines", () => {
		expect(selectedLines(text, 5, 5)).toEqual({ first: 1, last: 1, caret: true });
		expect(selectedLines(text, 0, 6)).toEqual({ first: 0, last: 1, caret: false });
		// Dragged to the start of the next line: that line is not taken.
		expect(selectedLines(text, 0, 8)).toEqual({ first: 0, last: 1, caret: false });
	});
});
