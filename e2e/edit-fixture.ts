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

/** Two short made-up pages to merge into the edit fixture. The second has a 270° rotation. */
export function mergeDocument(): mupdf.PDFDocument {
	const doc = new mupdf.PDFDocument();
	const helvetica = new mupdf.Font("Helvetica");
	const font = doc.addSimpleFont(helvetica);
	helvetica.destroy();
	for (const [i, rotate] of [0, 270].entries()) {
		const page = doc.addPage(
			[0, 0, 300, 420],
			rotate as mupdf.Rotate,
			{ Font: { Main: font } },
			`BT /Main 20 Tf 30 370 Td (Appendix ${i + 1}) Tj ET`,
		);
		doc.insertPage(-1, page);
	}
	return doc;
}

function appearance(doc: mupdf.PDFDocument, contents: string, w: number, h: number, resources = {}) {
	return doc.addStream(contents, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: resources });
}

/**
 * A made-up one-page AcroForm: required single-line text, multi-line text with MaxLen, check box,
 * radio group, combo box, list box with export values, read-only text and an unsigned signature field.
 */
export function formDocument(): mupdf.PDFDocument {
	const doc = new mupdf.PDFDocument();
	const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
	const zadb = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" });
	const labels = [
		[522, "Full name"],
		[486, "Notes"],
		[388, "I agree"],
		[358, "Size: small / large"],
		[318, "Colour"],
		[248, "Reference"],
		[200, "Signature"],
	]
		.map(([y, label]) => `BT /Helv 10 Tf 40 ${y} Td (${label}) Tj ET`)
		.join("\n");
	const object = doc.addPage(
		[0, 0, 400, 600],
		0,
		{ Font: { Helv: helv } },
		`BT /Helv 18 Tf 40 560 Td (Lantern Club Form) Tj ET\n${labels}`,
	);
	doc.insertPage(-1, object);
	const page = doc.findPage(0);
	const fields = doc.newArray();
	const annots = doc.newArray();
	page.put("Annots", annots);
	const widget = (entries: Record<string, unknown>) => {
		const annot = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: page, ...entries });
		annots.push(annot);
		return annot;
	};
	const da = doc.newString("/Helv 11 Tf 0 g");
	const check = (w: number) =>
		appearance(doc, `q 0 g BT /ZaDb ${w - 4} Tf 2 3 Td (4) Tj ET Q`, w, w, { Font: { ZaDb: zadb } });
	const name = (text: string) => doc.newString(text);
	fields.push(widget({ FT: "Tx", T: name("name"), TU: name("Full name"), Rect: [40, 498, 240, 516], Ff: 2, DA: da }));
	fields.push(widget({ FT: "Tx", T: name("notes"), Rect: [40, 400, 240, 480], Ff: 4096, MaxLen: 40, DA: da }));
	fields.push(
		widget({
			FT: "Btn",
			T: name("agree"),
			TU: name("I agree"),
			Rect: [100, 384, 116, 400],
			V: doc.newName("Off"),
			AS: doc.newName("Off"),
			MK: { CA: name("4") },
			DA: doc.newString("/ZaDb 0 Tf 0 g"),
			AP: { N: { Yes: check(16), Off: appearance(doc, "", 16, 16) } },
		}),
	);
	const radio = doc.addObject({
		FT: "Btn",
		T: name("size"),
		TU: name("Size"),
		Ff: 49152,
		V: doc.newName("Off"),
		Kids: doc.newArray(),
	});
	for (const [i, state] of ["small", "large"].entries()) {
		const kid = widget({
			Parent: radio,
			Rect: [150 + i * 40, 354, 166 + i * 40, 370],
			AS: doc.newName("Off"),
			MK: { CA: name("l") },
			AP: { N: { [state]: check(16), Off: appearance(doc, "", 16, 16) } },
		});
		radio.get("Kids").push(kid);
	}
	fields.push(radio);
	const options = ["Red", "Green", "Blue"].map(name);
	fields.push(
		widget({
			FT: "Ch",
			T: name("colour"),
			Rect: [40, 290, 180, 310],
			Ff: 131072,
			Opt: options,
			V: name("Red"),
			DA: da,
		}),
	);
	fields.push(
		widget({
			FT: "Ch",
			T: name("fruit"),
			TU: name("Fruit"),
			Rect: [220, 260, 360, 320],
			Opt: [
				[name("a"), name("Apple")],
				[name("p"), name("Pear")],
			],
			DA: da,
		}),
	);
	fields.push(widget({ FT: "Tx", T: name("ref"), Rect: [40, 220, 200, 240], Ff: 1, V: name("FIXED-7"), DA: da }));
	fields.push(widget({ FT: "Sig", T: name("signature"), TU: name("Signature"), Rect: [40, 120, 240, 190] }));
	doc
		.getTrailer()
		.get("Root")
		.put("AcroForm", { Fields: fields, DA: doc.newString("/Helv 0 Tf 0 g"), DR: { Font: { Helv: helv, ZaDb: zadb } } });
	// Give the text and choice fields their initial appearances.
	const loaded = doc.loadPage(0);
	for (const field of loaded.getWidgets()) field.update();
	loaded.update();
	loaded.destroy();
	return doc;
}

/** A made-up dynamic XFA form: an AcroForm with an XFA packet and no fields. */
export function xfaDocument(): mupdf.PDFDocument {
	const doc = new mupdf.PDFDocument();
	doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, {}, ""));
	const packet = doc.addStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>', {});
	doc.getTrailer().get("Root").put("AcroForm", { Fields: doc.newArray(), XFA: packet });
	doc.getTrailer().get("Root").put("NeedsRendering", true);
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
		for (const [file, make] of [
			["out/merge.pdf", mergeDocument],
			["out/form.pdf", formDocument],
			["out/xfa.pdf", xfaDocument],
		] as const) {
			const extra = make();
			const bytes = extra.saveToBuffer("compress");
			writeFileSync(file, bytes.asUint8Array());
			bytes.destroy();
			extra.destroy();
		}
	} finally {
		plain.destroy();
		locked.destroy();
		doc.destroy();
	}
}
