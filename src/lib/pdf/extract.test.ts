import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { extractPage } from "./extract.ts";

/** A one-page PDF with the given lines set in Helvetica, 14 pt apart. */
function pdfPage(lines: string[]): mupdf.Page {
	const pdf = new mupdf.PDFDocument();
	const font = pdf.addSimpleFont(new mupdf.Font("Helvetica"));
	const text = lines.map((l, i) => `BT /F1 11 Tf 54 ${700 - i * 14} Td (${l}) Tj ET`).join("\n");
	const page = pdf.addPage([0, 0, 432, 792], 0, { Font: { F1: font } }, text);
	pdf.insertPage(-1, page);
	return pdf.loadPage(0);
}

const texts = (page: mupdf.Page) =>
	extractPage(page, 0).blocks.flatMap((b) => (b.kind === "text" ? b.lines.map((l) => l.text.trim()) : []));

describe("extractPage", () => {
	it("keeps each printed line whole, line-final hyphen included", () => {
		// Verse depends on this: a hyphen at a line end may be the poet's.
		expect(texts(pdfPage(["the sky-", "lark sings"]))).toEqual(["the sky-", "lark sings"]);
	});

	it("reports positions relative to the page, top-down", () => {
		const [block] = extractPage(pdfPage(["first", "second"]), 0).blocks;
		expect(block.kind).toBe("text");
		if (block.kind !== "text") return;
		const [a, b] = block.lines;
		expect(a.x0).toBeCloseTo(54, 0);
		expect(a.y0).toBeLessThan(b.y0);
		expect(a.size).toBe(11);
	});

	it("leaves pictures out when the caller keeps none", () => {
		const model = extractPage(pdfPage(["just text"]), 0);
		expect(model.blocks.every((b) => b.kind === "text")).toBe(true);
		expect(model.ocr).toBeUndefined();
		expect(model.imageOnly).toBeUndefined();
	});
});
