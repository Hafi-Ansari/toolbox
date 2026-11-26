import { describe, expect, it } from "vitest";
import type { Line, PageModel } from "../../../lib/pdf/heuristics.ts";
import { convert, txtLines } from "./index.ts";
import { toRows } from "./layout.ts";
import { applyOcr, convertWithOcr, fromTesseract, type OcrLine, type OcrPage, similarity } from "./ocr.ts";

const W = 360;
const H = 520;

function line(text: string, y: number, opts: Partial<Line> = {}): Line {
	const x0 = opts.x0 ?? 40;
	return { text, x0, y0: y, x1: x0 + text.length * 4.5, y1: y + 9, size: 8, bold: false, italic: false, ...opts };
}

function page(index: number, lines: Line[], extra: Partial<PageModel> = {}): PageModel {
	return { index, width: W, height: H, blocks: lines.map((l) => ({ kind: "text" as const, lines: [l] })), ...extra };
}

/** An OCR row: words laid out left to right (ink boxes a little tighter than the text layer's), or at given x. */
function ocrLine(text: string, y: number, conf = 95, xs?: number[]): OcrLine {
	let x = 40;
	const words = text.split(" ").map((w, i) => {
		const x0 = xs?.[i] ?? x;
		x = x0 + w.length * 4.5 + 4.5;
		return { text: w, x0, y0: y + 1, x1: x0 + w.length * 4.5, y1: y + 8, conf };
	});
	return {
		text,
		x0: words[0].x0,
		y0: y + 1,
		x1: words[words.length - 1].x1,
		y1: y + 8,
		conf,
		size: 8,
		words,
	};
}

const ocrOf = (p: number, lines: OcrLine[]): ReadonlyMap<number, OcrPage> => new Map([[p, { page: p, lines }]]);
const rowTexts = (m: PageModel) => toRows(m).map((r) => r.text);

/** A short poem on one page, as an OCR text layer would carry it. */
const poem = () =>
	page(
		0,
		[
			line("Small Hours", 30, { size: 11, y1: 43 }),
			line("first line of the poem", 80),
			line("second line of the poem", 94),
			line("third line of the poem", 108),
		],
		{ ocr: true },
	);

describe("similarity", () => {
	it("ignores case, spacing and quote styles", () => {
		expect(similarity("Can’t  sleep", "can't sleep")).toBe(1);
		expect(similarity("Xq GC @ Rw 8BE", "abc abc abc")).toBeLessThan(0.5);
	});
});

describe("applyOcr", () => {
	it("adds a confident row the text layer lacks, in reading order, and flags it", () => {
		const ocr = ocrOf(0, [
			ocrLine("first line of the poem", 80),
			ocrLine("a lost line in between", 66),
			ocrLine("second line of the poem", 94),
			ocrLine("third line of the poem", 108),
		]);
		const { pages, flags, stats } = applyOcr([poem()], ocr);
		expect(rowTexts(pages[0])).toEqual([
			"Small Hours",
			"a lost line in between",
			"first line of the poem",
			"second line of the poem",
			"third line of the poem",
		]);
		expect(flags.map((f) => f.kind)).toEqual(["ocr-added"]);
		expect(flags[0].box?.y0).toBeCloseTo(66, 0);
		expect(stats.get(0)).toMatchObject({ added: 1, replaced: 0, differs: 0 });
	});

	it("leaves unsure and letterless rows out, and page numbers the layer lacks", () => {
		const ocr = ocrOf(0, [ocrLine("maybe a line", 60, 55), ocrLine("~ — ~", 150), ocrLine("24", 500)]);
		const { pages, flags, stats } = applyOcr([poem()], ocr);
		expect(rowTexts(pages[0])).toEqual(rowTexts(poem()));
		expect(flags).toEqual([]);
		expect(stats.get(0)?.dropped).toBe(2);
	});

	it("swaps a garbled row for a confident OCR reading, keeping the gaps between groups", () => {
		const garbled = page(
			0,
			[
				line("The kettle starts to sing:", 80),
				line("Xq", 94, { x1: 58 }),
				line("GC", 94, { x0: 65, x1: 70 }),
				line("@ Rw", 94, { x0: 83, x1: 112 }),
				line("8BE", 94, { x0: 125, x1: 154 }),
				line("And the window fogs over slowly:", 108),
			],
			{ ocr: true },
		);
		const ocr = ocrOf(0, [
			ocrLine("The kettle starts to sing:", 80),
			ocrLine("abc abc abc", 94, 88, [40, 70, 100]),
			ocrLine("And the window fogs over slowly:", 108),
		]);
		const { pages, flags } = applyOcr([garbled], ocr);
		const rows = rowTexts(pages[0]);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toMatch(/^abc {3,}abc {3,}abc$/);
		expect(flags.map((f) => f.kind)).toEqual(["ocr-replaced"]);
		expect(flags[0].reason).toContain('"Xq GC @ Rw 8BE"');
	});

	it("keeps a garbled row when OCR is unsure of it", () => {
		const garbled = page(0, [line("Xq GC @ Rw 8BE", 94)], { ocr: true });
		const { pages, flags } = applyOcr([garbled], ocrOf(0, [ocrLine("abc abc abc", 94, 65)]));
		expect(rowTexts(pages[0])).toEqual(["Xq GC @ Rw 8BE"]);
		expect(flags).toEqual([]);
	});

	it("keeps the text layer where the readings are close, flagging material differences", () => {
		const ocr = ocrOf(0, [
			ocrLine("first line of the poem", 80),
			ocrLine("second lime of the poem", 94),
			ocrLine("thirsty lone of tho pome", 108),
		]);
		const { pages, flags } = applyOcr([poem()], ocr);
		expect(rowTexts(pages[0])).toEqual(rowTexts(poem()));
		expect(flags.map((f) => [f.kind, f.text])).toEqual([["ocr-differs", "third line of the poem"]]);
	});

	it("gives a scan without a text layer the OCR text, minus unsure rows", () => {
		const scan = page(0, [], { imageOnly: true });
		const ocr = ocrOf(0, [
			ocrLine("Untitled", 30),
			ocrLine("words only OCR could read", 80),
			ocrLine("smudge", 94, 40),
		]);
		const { pages, flags } = applyOcr([scan], ocr);
		expect(pages[0].imageOnly).toBe(false);
		expect(pages[0].ocr).toBe(true);
		expect(rowTexts(pages[0])).toEqual(["Untitled", "words only OCR could read"]);
		expect(flags.map((f) => f.kind)).toEqual(["ocr-page"]);
		expect(flags[0].reason).toContain("2 lines");
		expect(flags[0].reason).toContain("1 unsure line left out");
	});

	it("treats a page with no text at all as a scan, even when it wasn't marked as one", () => {
		const { pages, flags } = applyOcr([page(0, [])], ocrOf(0, [ocrLine("small type the ink test missed", 80)]));
		expect(rowTexts(pages[0])).toEqual(["small type the ink test missed"]);
		expect(pages[0].ocr).toBe(true);
		expect(flags.map((f) => f.kind)).toEqual(["ocr-page"]);
	});

	it("leaves pages without OCR untouched", () => {
		const models = [poem(), page(1, [line("other page", 80)])];
		const { pages } = applyOcr(models, ocrOf(0, []));
		expect(pages[1]).toBe(models[1]);
		expect(pages[0]).not.toBe(models[0]);
		expect(models[0].blocks).toHaveLength(4);
	});
});

describe("convertWithOcr", () => {
	const book = () => [poem(), page(1, [], { imageOnly: true })];

	it("is convert() when nothing was OCR'd", () => {
		expect(convertWithOcr(book(), [], { mode: "poetry" }, new Map())).toEqual(convert(book(), [], { mode: "poetry" }));
	});

	it("puts recovered text into the TXT and the OCR flags into the review list", () => {
		const ocr = new Map<number, OcrPage>([
			[0, { page: 0, lines: [ocrLine("a lost line in between", 66)] }],
			[1, { page: 1, lines: [ocrLine("text from the scanned page", 80)] }],
		]);
		const result = convertWithOcr(book(), [], { mode: "poetry" }, ocr);
		const texts = txtLines(result).map((l) => l.text);
		expect(texts).toContain("a lost line in between");
		expect(texts).toContain("text from the scanned page");
		const kinds = result.flags.map((f) => f.kind);
		expect(kinds).toContain("ocr-added");
		expect(kinds).toContain("ocr-page");
		expect(kinds).not.toContain("image-only");
		for (const f of result.flags) expect(f.work).toBeDefined();
	});
});

describe("fromTesseract", () => {
	it("converts pixels to points and drops empty words", () => {
		const scale = 300 / 72;
		const px = (n: number) => n * scale;
		const page = fromTesseract(
			[
				{
					paragraphs: [
						{
							lines: [
								{
									text: "Hi there\n",
									confidence: 91,
									bbox: { x0: px(10), y0: px(20), x1: px(50), y1: px(28) },
									rowAttributes: { rowHeight: px(8), descenders: px(2), ascenders: px(2) },
									words: [
										{ text: "Hi", confidence: 90, bbox: { x0: px(10), y0: px(20), x1: px(18), y1: px(28) } },
										{ text: " ", confidence: 0, bbox: { x0: px(19), y0: px(20), x1: px(20), y1: px(28) } },
										{ text: "there", confidence: 92, bbox: { x0: px(22), y0: px(20), x1: px(50), y1: px(28) } },
									],
								},
							],
						},
					],
				},
			],
			3,
			scale,
		);
		expect(page.page).toBe(3);
		expect(page.lines).toHaveLength(1);
		const [l] = page.lines;
		expect(l.text).toBe("Hi there");
		expect(l.words.map((w) => w.text)).toEqual(["Hi", "there"]);
		expect(l.x0).toBeCloseTo(10);
		expect(l.y1).toBeCloseTo(28);
		expect(l.size).toBeCloseTo(8);
	});
});
