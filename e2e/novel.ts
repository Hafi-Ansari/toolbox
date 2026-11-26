// A small, made-up novel as a born-digital PDF: justified prose with a song
// quoted in italics (two stanzas), for the manual overrides in PDF → TXT.
// Used by pdf-txt.spec.ts; written to out/novel.pdf.
import fs from "node:fs";
import * as mupdf from "mupdf";

const W = 360;
const H = 540;
const LEFT = 40;
const RIGHT = 320;

interface Text {
	text: string;
	x: number;
	/** Distance from the top of the page to the baseline. */
	y: number;
	font: "R" | "I" | "B";
	size: number;
	/** Word spacing, to justify a line to the right margin. */
	tw?: number;
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function novelPdf(file: string) {
	const pdf = new mupdf.PDFDocument();
	const faces = {
		R: new mupdf.Font("Times-Roman"),
		I: new mupdf.Font("Times-Italic"),
		B: new mupdf.Font("Times-Bold"),
	};
	const fonts = {
		R: pdf.addSimpleFont(faces.R),
		I: pdf.addSimpleFont(faces.I),
		B: pdf.addSimpleFont(faces.B),
	};
	const width = (t: string, size: number) =>
		[...t].reduce((w, c) => w + faces.R.advanceGlyph(faces.R.encodeCharacter(c.codePointAt(0) ?? 32), 0) * size, 0);

	/** A paragraph: first line indented, every line but the last justified. */
	const para = (lines: string[], y: number): Text[] =>
		lines.map((text, i) => {
			const x = i === 0 ? LEFT + 14 : LEFT;
			const last = i === lines.length - 1;
			const spaces = text.split(" ").length - 1;
			const tw = last || !spaces ? 0 : (RIGHT - x - width(text, 10)) / spaces;
			return { text, x, y: y + i * 14, font: "R", size: 10, tw };
		});
	const verse = (lines: string[], y: number): Text[] =>
		lines.map((text, i) => ({ text, x: LEFT + 24, y: y + i * 11, font: "I", size: 9 }));

	const page: Text[] = [
		{ text: "One", x: LEFT, y: 60, font: "B", size: 14 },
		...para(
			[
				"The ferry men came in after dark, and the tavern filled",
				"with the smell of rope and rain. Nobody spoke of the river.",
				"When the fire had settled, an old woman by the window",
				"began to sing, and the cook put down his knife.",
			],
			100,
		),
		...verse(
			["Down where the water keeps its name,", "the lanterns lean and the reeds lean too;", "nobody sleeps tonight,"],
			166,
		),
		...verse(["carry me over, carry me through,", "carry me home by the river light."], 210),
		...para(
			[
				"When the song ended, nobody moved. The ferry men looked",
				"at their hands, and the rain kept on against the glass as",
				"if it had heard.",
			],
			250,
		),
		...para(
			[
				"In the morning the river was high and brown, and the ferry",
				"stayed tied to its post. The old woman was gone before the",
				"cook woke, and nobody had seen her leave the tavern or",
				"cross the yard.",
			],
			300,
		),
	];
	const content = page
		.map((t) => `BT /${t.font} ${t.size} Tf ${(t.tw ?? 0).toFixed(3)} Tw ${t.x} ${H - t.y} Td (${esc(t.text)}) Tj ET`)
		.join("\n");
	pdf.insertPage(-1, pdf.addPage([0, 0, W, H], 0, { Font: fonts }, content));
	fs.writeFileSync(file, pdf.saveToBuffer("compress").asUint8Array());
}
