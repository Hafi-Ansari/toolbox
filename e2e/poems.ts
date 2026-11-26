// A small, made-up poetry book as a born-digital PDF: titles in bold above
// stanzas, an indented line, page numbers at the foot, one poem running onto
// a second page. Used by pdf-txt.spec.ts; written to out/poems.pdf.
// scanPdf() makes a scan of one of its pages: a page that is only a picture of
// the printed text, with no text layer (out/scan.pdf, for on-demand OCR).
import fs from "node:fs";
import * as mupdf from "mupdf";

const W = 360;
const H = 540;

interface Text {
	text: string;
	x: number;
	/** Distance from the top of the page to the baseline. */
	y: number;
	bold?: boolean;
	size?: number;
}

/** Escapes a string for a PDF literal: backslash and parentheses. */
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

function pageContent(items: Text[]): string {
	return items
		.map((t) => `BT /${t.bold ? "B" : "R"} ${t.size ?? 10} Tf ${t.x} ${H - t.y} Td (${esc(t.text)}) Tj ET`)
		.join("\n");
}

function stanza(lines: string[], y: number, x = 48): Text[] {
	return lines.map((line, i) => ({ text: line.trim(), x: line.startsWith("  ") ? x + 24 : x, y: y + i * 15 }));
}

function poemsDocument(): mupdf.PDFDocument {
	const pdf = new mupdf.PDFDocument();
	const fonts = {
		R: pdf.addSimpleFont(new mupdf.Font("Times-Roman")),
		B: pdf.addSimpleFont(new mupdf.Font("Times-Bold")),
	};
	const folio = (n: number): Text => ({ text: String(n), x: W / 2 - 4, y: H - 30, size: 9 });
	const pages: Text[][] = [
		[
			{ text: "Lantern Weather", x: 48, y: 60, bold: true, size: 14 },
			...stanza(
				["The ferry keeps its own small light,", "a coin of yellow on the tide,", "and nobody aboard is sure"],
				100,
			),
			...stanza(["which shore they meant to leave behind.", "  The gulls have opinions.", "The water does not."], 160),
			folio(7),
		],
		[
			{ text: "Inventory", x: 48, y: 60, bold: true, size: 14 },
			...stanza(
				["One kettle, dented on the left,", "two letters I will never send,", "a key to a house that sold in spring,"],
				100,
			),
			...stanza(["three stones from three different rivers,", "each one insisting it is the river."], 160),
			folio(8),
		],
		[...stanza(["And a list of everything I kept,", "which is this list."], 60), folio(9)],
	];
	for (const items of pages) {
		const page = pdf.addPage([0, 0, W, H], 0, { Font: fonts }, pageContent(items));
		pdf.insertPage(-1, page);
	}
	return pdf;
}

export function poemsPdf(file: string) {
	fs.writeFileSync(file, poemsDocument().saveToBuffer("compress").asUint8Array());
}

/** Page 2 of the poems ("Inventory") as a 200 dpi grey scan without a text layer. */
export function scanPdf(file: string) {
	const source = poemsDocument();
	const scale = 200 / 72;
	const pix = source.loadPage(1).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
	const pdf = new mupdf.PDFDocument();
	const image = pdf.addImage(new mupdf.Image(pix));
	const page = pdf.addPage([0, 0, W, H], 0, { XObject: { Scan: image } }, `q ${W} 0 0 ${H} 0 0 cm /Scan Do Q`);
	pdf.insertPage(-1, page);
	fs.writeFileSync(file, pdf.saveToBuffer("compress").asUint8Array());
}
