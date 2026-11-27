import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { extractPage, isBlankPage } from "./extract.ts";

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

/**
 * A scanned page: `content` (a PDF content stream on a 355×521 pt page with a Times font as F1)
 * drawn on paper of tone `paper`, rendered at 300 dpi and placed as the page's only image.
 */
function scanPage(content: string, paper = 0.92): mupdf.Page {
	const src = new mupdf.PDFDocument();
	const font = src.addSimpleFont(new mupdf.Font("Times-Roman"));
	const fill = `${paper} g 0 0 355 521 re f\n`;
	src.insertPage(-1, src.addPage([0, 0, 355, 521], 0, { Font: { F1: font } }, fill + content));
	const pix = src.loadPage(0).toPixmap(mupdf.Matrix.scale(300 / 72, 300 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
	const pdf = new mupdf.PDFDocument();
	const img = pdf.addImage(new mupdf.Image(pix));
	pdf.insertPage(-1, pdf.addPage([0, 0, 355, 521], 0, { XObject: { I: img } }, "q 355 0 0 521 0 0 cm /I Do Q"));
	return pdf.loadPage(0);
}

/** Lines of small (8 pt) type, like a poem page, in `tone` (0 black … 1 white). */
const smallPrint = (n: number, tone = 0) =>
	Array.from(
		{ length: n },
		(_, i) => `${tone} g BT /F1 8 Tf 57 ${450 - i * 14} Td (a strand of black hair unraveled ${i}) Tj ET`,
	).join("\n");

describe("isBlankPage", () => {
	it("sees small print on a scanned page", () => {
		expect(isBlankPage(scanPage(smallPrint(4)))).toBe(false);
		expect(isBlankPage(scanPage(smallPrint(1)))).toBe(false);
	});

	it("calls a blank leaf blank, tinted paper and faint show-through included", () => {
		expect(isBlankPage(scanPage(""))).toBe(true);
		expect(isBlankPage(scanPage("", 0.8))).toBe(true);
		// Text from the other side of the leaf shows through, mirrored and faint.
		expect(isBlankPage(scanPage(`q -1 0 0 1 355 0 cm ${smallPrint(20, 0.78)} Q`))).toBe(true);
	});
});
