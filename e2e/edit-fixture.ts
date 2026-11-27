import { writeFileSync } from "node:fs";
import * as mupdf from "mupdf";

export const password = "paper-fox";

export function editDocument(): mupdf.PDFDocument {
	const doc = new mupdf.PDFDocument();
	const helvetica = new mupdf.Font("Helvetica");
	const font = doc.addSimpleFont(helvetica);
	helvetica.destroy();
	const first = doc.addPage(
		[0, 0, 410, 620],
		0,
		{ Font: { Main: font } },
		"BT /Main 24 Tf 35 555 Td (Field Notes) Tj /Main 12 Tf 0 -28 Td (Project: Paper lantern) Tj ET\n0.8 G 35 500 m 375 500 l S\n35 410 m 375 410 l S\n35 320 m 375 320 l S\n35 230 m 375 230 l S\n35 140 m 375 140 l S",
	);
	doc.insertPage(-1, first);
	const second = doc.addPage(
		[10, 20, 410, 620],
		90,
		{ Font: { Main: font } },
		"0.87 G 75 65 m 75 575 l S\n155 65 m 155 575 l S\n235 65 m 235 575 l S\n315 65 m 315 575 l S\nBT /Main 22 Tf 0 1 -1 0 75 65 Tm (Route Sketch) Tj ET",
	);
	second.put("CropBox", [30, 40, 400, 600]);
	doc.insertPage(-1, second);
	const third = doc.addPage(
		[20, 30, 430, 650],
		0,
		{ Font: { Main: font } },
		"BT /Main 18 Tf 60 570 Td (Checklist) Tj ET",
	);
	third.put("CropBox", [35, 45, 405, 620]);
	doc.insertPage(-1, third);
	return doc;
}

export function testImage() {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 10], false);
	try {
		const pixels = pixmap.getPixels();
		for (let i = 0; i < pixels.length; i += 3) {
			pixels[i] = 255;
			pixels[i + 1] = 120;
			pixels[i + 2] = 34;
		}
		return pixmap.asPNG().slice();
	} finally {
		pixmap.destroy();
	}
}

if (process.argv[1]?.endsWith("edit-fixture.ts")) {
	const doc = editDocument();
	const plain = doc.saveToBuffer("compress");
	const locked = doc.saveToBuffer(
		"compress,encrypt=aes-256,user-password=paper-fox,owner-password=lantern-keeper,permissions=-1",
	);
	try {
		writeFileSync("out/edit.pdf", plain.asUint8Array());
		writeFileSync("out/edit-locked.pdf", locked.asUint8Array());
	} finally {
		plain.destroy();
		locked.destroy();
		doc.destroy();
	}
}
