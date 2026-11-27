import * as mupdf from "mupdf";
import { apply, applyRect, IDENTITY, invert, itemMatrix } from "./geometry.ts";
import {
	DOT_RADIUS,
	type ImageDataMap,
	type Item,
	inkWidth,
	MARK_PATHS,
	type Mode,
	SIGNATURE_BASELINE,
	type Strokes,
	TEXT_BASELINE,
	TEXT_LEADING,
	TEXT_PADDING,
	typedSize,
} from "./items.ts";

export interface Fonts {
	sans: mupdf.Font;
	script: mupdf.Font;
}

function rgb(color: string): [number, number, number] {
	return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function drawText(
	device: mupdf.Device,
	item: Item,
	lines: string[],
	fonts: Fonts,
	unsupported: Set<string>,
	size: number,
	script = false,
) {
	const text = new mupdf.Text();
	try {
		for (const [row, line] of lines.entries()) {
			let x = script ? 0 : TEXT_PADDING;
			const y = script ? item.h * SIGNATURE_BASELINE : TEXT_PADDING + size * (TEXT_BASELINE + row * TEXT_LEADING);
			for (const char of line) {
				let font = script ? fonts.script : fonts.sans;
				let gid = font.encodeCharacter(char);
				if (script && !gid) {
					font = fonts.sans;
					gid = font.encodeCharacter(char);
				}
				if (!gid) {
					unsupported.add(char);
					gid = font.encodeCharacter("\u25a1");
				}
				text.showGlyph(font, [size, 0, 0, -size, x, y], gid, char.codePointAt(0) ?? 0);
				x += font.advanceGlyph(gid) * size;
			}
		}
		device.fillText(text, IDENTITY, mupdf.ColorSpace.DeviceRGB, rgb(item.color), 1);
	} finally {
		text.destroy();
	}
}

function strokesFor(item: Item): Strokes {
	if (item.kind === "ink") return item.strokes;
	if (item.kind === "mark" && item.shape !== "dot") return MARK_PATHS[item.shape];
	return item.kind === "signature" && item.source.kind === "drawn" ? item.source.strokes : [];
}

function drawStrokes(device: mupdf.Device, item: Item) {
	const shape = new mupdf.Path();
	const pen = new mupdf.StrokeState({ lineWidth: inkWidth(item), lineCap: "Round", lineJoin: "Round", miterLimit: 10 });
	try {
		for (const stroke of strokesFor(item)) {
			const start = stroke[0];
			if (!start) continue;
			shape.moveTo(start[0] * item.w, start[1] * item.h);
			if (stroke.length === 1) shape.lineTo(start[0] * item.w + 0.001, start[1] * item.h);
			for (const [x, y] of stroke.slice(1)) shape.lineTo(x * item.w, y * item.h);
		}
		device.strokePath(shape, pen, IDENTITY, mupdf.ColorSpace.DeviceRGB, rgb(item.color), 1);
	} finally {
		pen.destroy();
		shape.destroy();
	}
}

function drawDot(device: mupdf.Device, item: Item) {
	const circle = new mupdf.Path();
	try {
		const x = item.w / 2;
		const y = item.h / 2;
		const r = Math.min(item.w, item.h) * DOT_RADIUS;
		const c = r * 0.55228475;
		circle.moveTo(x + r, y);
		circle.curveTo(x + r, y + c, x + c, y + r, x, y + r);
		circle.curveTo(x - c, y + r, x - r, y + c, x - r, y);
		circle.curveTo(x - r, y - c, x - c, y - r, x, y - r);
		circle.curveTo(x + c, y - r, x + r, y - c, x + r, y);
		circle.closePath();
		device.fillPath(circle, false, IDENTITY, mupdf.ColorSpace.DeviceRGB, rgb(item.color), 1);
	} finally {
		circle.destroy();
	}
}

function drawItem(device: mupdf.Device, item: Item, fonts: Fonts, images: ImageDataMap, unsupported: Set<string>) {
	if (item.kind === "text") {
		drawText(device, item, item.lines, fonts, unsupported, item.size);
		return;
	}
	if (item.kind === "signature" && item.source.kind === "typed") {
		drawText(device, item, [item.source.text], fonts, unsupported, typedSize(item), true);
		return;
	}
	const key =
		item.kind === "image"
			? item.key
			: item.kind === "signature" && item.source.kind === "image"
				? item.source.key
				: null;
	if (key) {
		const data = images[key];
		if (!data) throw new Error("An image used on the page is missing.");
		const image = new mupdf.Image(data);
		try {
			device.fillImage(image, [item.w, 0, 0, item.h, 0, 0], 1);
		} finally {
			image.destroy();
		}
		return;
	}
	if (item.kind === "mark" && item.shape === "dot") drawDot(device, item);
	else drawStrokes(device, item);
}

function makeForm(
	doc: mupdf.PDFDocument,
	item: Item,
	fonts: Fonts,
	images: ImageDataMap,
	unsupported: Set<string>,
	matrix = IDENTITY,
): mupdf.PDFObject {
	const box: mupdf.Rect = [0, 0, item.w, item.h];
	const data = new mupdf.Buffer();
	const writer = new mupdf.DocumentWriter(data, "pdf", "compress");
	try {
		const device = writer.beginPage(box);
		try {
			drawItem(device, item, fonts, images, unsupported);
			writer.endPage();
		} finally {
			device.destroy();
		}
		writer.close();
		const source = new mupdf.PDFDocument(data);
		try {
			source.subsetFonts();
			const page = source.findPage(0);
			const stream = page.get("Contents").readStream();
			try {
				return doc.addStream(stream, {
					Type: "XObject",
					Subtype: "Form",
					FormType: 1,
					BBox: box,
					Matrix: matrix,
					Resources: doc.graftObject(page.get("Resources")),
				});
			} finally {
				stream.destroy();
			}
		} finally {
			source.destroy();
		}
	} finally {
		writer.destroy();
		data.destroy();
	}
}

function copyDictionary(doc: mupdf.PDFDocument, object: mupdf.PDFObject): mupdf.PDFObject {
	const copy = doc.newDictionary();
	if (object.isDictionary())
		object.forEach((value, key) => {
			copy.put(key, value);
		});
	return copy;
}

function flattenPage(
	doc: mupdf.PDFDocument,
	page: mupdf.PDFPage,
	items: Item[],
	fonts: Fonts,
	images: ImageDataMap,
	unsupported: Set<string>,
) {
	const object = page.getObject();
	// Resources can be inherited or shared between pages. Only modify a new page-local dictionary.
	const resources = copyDictionary(doc, object.getInheritable("Resources"));
	const forms = copyDictionary(doc, resources.get("XObject"));
	let index = 0;
	const commands: string[] = [];
	for (const item of items) {
		let name: string;
		do {
			name = `Tbx${++index}`;
		} while (!forms.get(name).isNull());
		forms.put(name, makeForm(doc, item, fonts, images, unsupported));
		commands.push(`q ${itemMatrix(item, page.getTransform()).join(" ")} cm /${name} Do Q`);
	}
	resources.put("XObject", forms);
	object.put("Resources", resources);

	// Contain existing clipping and graphics state before displaying the added forms.
	const contents = doc.newArray();
	const previous = object.get("Contents");
	if (!previous.isNull()) {
		contents.push(doc.addStream("q\n", {}));
		if (previous.isArray())
			previous.forEach((stream) => {
				contents.push(stream);
			});
		else contents.push(previous);
	}
	contents.push(doc.addStream(`${previous.isNull() ? "" : "Q\n"}${commands.join("\n")}\n`, {}));
	object.put("Contents", contents);
}

function annotatePage(
	doc: mupdf.PDFDocument,
	page: mupdf.PDFPage,
	items: Item[],
	fonts: Fonts,
	images: ImageDataMap,
	unsupported: Set<string>,
) {
	const object = page.getObject();
	let annotations = object.get("Annots");
	if (!annotations.isArray()) {
		annotations = doc.newArray();
		object.put("Annots", annotations);
	}
	const transform = page.getTransform();
	for (const item of items) {
		const appearance = makeForm(doc, item, fonts, images, unsupported, itemMatrix(item, transform));
		const annotation = {
			Type: "Annot",
			Rect: applyRect([item.x, item.y, item.x + item.w, item.y + item.h], invert(transform)),
			P: object,
			NM: doc.newString(item.id),
			F: 4,
			AP: { N: appearance },
			C: rgb(item.color),
		};
		let kind: Record<string, unknown>;
		if (item.kind === "text") {
			kind = {
				Subtype: "FreeText",
				Contents: doc.newString(item.text),
				DA: doc.newString(`/Helv ${item.size} Tf ${rgb(item.color).join(" ")} rg`),
			};
		} else if (item.kind === "mark" && item.shape === "dot") {
			const inset = Math.min(item.w, item.h) * (0.5 - DOT_RADIUS);
			kind = { Subtype: "Circle", IC: rgb(item.color), RD: [inset, inset, inset, inset] };
		} else if (item.kind === "mark" || item.kind === "ink") {
			const inverse = invert(transform);
			const list = strokesFor(item).map((stroke) =>
				stroke.flatMap(([x, y]) => apply([item.x + x * item.w, item.y + y * item.h], inverse)),
			);
			kind = { Subtype: "Ink", InkList: list, BS: { W: inkWidth(item) * Math.hypot(inverse[0], inverse[1]) } };
		} else {
			kind = { Subtype: "Stamp", Name: item.kind === "signature" ? "Signature" : "StampImage" };
		}
		// The saved AP stream preserves the exact on-screen appearance across rotation and cropping.
		annotations.push(doc.addObject({ ...annotation, ...kind }));
	}
}

export function applyItems(
	doc: mupdf.PDFDocument,
	items: Item[],
	fonts: Fonts,
	images: ImageDataMap,
	mode: Mode,
): string[] {
	const pages = new Map<number, Item[]>();
	for (const item of items) {
		if (item.kind === "text" && !item.text.trim()) continue;
		const group = pages.get(item.page);
		if (group) group.push(item);
		else pages.set(item.page, [item]);
	}
	const unsupported = new Set<string>();
	for (const [index, group] of pages) {
		const page = doc.loadPage(index);
		try {
			if (mode === "flatten") flattenPage(doc, page, group, fonts, images, unsupported);
			else annotatePage(doc, page, group, fonts, images, unsupported);
		} finally {
			page.destroy();
		}
	}
	return [...unsupported];
}
