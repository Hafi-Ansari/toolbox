import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as mupdf from "mupdf";
import { afterAll, expect, it } from "vitest";
import { editDocument, password, testImage } from "../../../e2e/edit-fixture.ts";
import { applyItems } from "./build.ts";
import { applyRect, invert, itemMatrix } from "./geometry.ts";
import type { Item } from "./items.ts";

const require = createRequire(import.meta.url);
const fonts = {
	sans: new mupdf.Font(
		"Noto Sans",
		readFileSync(require.resolve("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf")),
	),
	script: new mupdf.Font(
		"Dancing Script",
		readFileSync(require.resolve("@expo-google-fonts/dancing-script/400Regular/DancingScript_400Regular.ttf")),
	),
};
afterAll(() => {
	fonts.sans.destroy();
	fonts.script.destroy();
});

const common = { page: "p1", x: 40, y: 40, w: 110, h: 34, color: "#000000" };
const text: Item = { ...common, id: "text", kind: "text", text: "Čaj Ω", size: 18, lines: ["Čaj Ω"] };
const items: Item[] = [
	text,
	{
		...common,
		id: "ink",
		kind: "ink",
		y: 90,
		width: 4,
		strokes: [
			[
				[0.1, 0.5],
				[0.9, 0.5],
			],
		],
	},
	{ ...common, id: "image", kind: "image", y: 140, w: 80, h: 50, key: "orange", natW: 16, natH: 10 },
	{ ...common, id: "signature", kind: "signature", page: "p0", source: { kind: "typed", text: "Ada Moss" } },
	{ ...common, id: "mark", kind: "mark", shape: "check", y: 200, w: 26, h: 26 },
	{ ...common, id: "dot", kind: "mark", shape: "dot", y: 240, w: 26, h: 26 },
	{
		...common,
		id: "drawn",
		kind: "signature",
		y: 280,
		source: {
			kind: "drawn",
			ratio: 3.2,
			strokes: [
				[
					[0.1, 0.5],
					[0.9, 0.5],
				],
			],
		},
	},
	{
		...common,
		id: "uploaded",
		kind: "signature",
		y: 320,
		h: 25,
		w: 40,
		source: { kind: "image", key: "orange", ratio: 1.6 },
	},
];

/** Groups items by page id "p<index>" into the per-page lists applyItems takes. */
function byPage(list: Item[]): Item[][] {
	const pages: Item[][] = [[], [], []];
	for (const item of list) pages[Number(item.page.slice(1))].push(item);
	return pages;
}

function readback(doc: mupdf.PDFDocument, options = "compress") {
	const buffer = doc.saveToBuffer(options);
	try {
		return new mupdf.PDFDocument(buffer);
	} finally {
		buffer.destroy();
	}
}

function expectNumbers(actual: number[], expected: number[]) {
	actual.forEach((n, i) => {
		expect(n).toBeCloseTo(expected[i], 4);
	});
}

it.each(["flatten", "annotations"] as const)(
	"preserves existing page content, positioning and appearance in %s mode",
	(mode) => {
		const source = editDocument();
		const before = source.loadPage(0);
		const existing = before.createAnnotation("Text");
		existing.setRect([250, 140, 280, 170]);
		existing.setContents("Original note");
		before.update();
		before.destroy();

		expect(applyItems(source, byPage(items), fonts, { orange: testImage() }, mode)).toEqual([]);
		const result = readback(source);
		try {
			const first = result.loadPage(0);
			const firstText = first.toStructuredText("");
			expect(firstText.asText()).toContain("Field Notes");
			expect(first.getObject().get("Annots", 0, "Contents").asString()).toBe("Original note");
			if (mode === "flatten") expect(firstText.asText()).toContain("Ada Moss");
			firstText.destroy();
			first.destroy();

			const page = result.loadPage(1);
			const contents = page.toStructuredText("");
			expect(contents.asText()).toContain("Route Sketch");
			const raw = page.getObject().get("Annots");
			if (mode === "flatten") {
				expect(raw.isNull()).toBe(true);
				let upright: { bbox: mupdf.Rect; dir: mupdf.Point } | undefined;
				contents.walk({
					beginLine(bbox, _wmode, dir) {
						if (Math.abs(bbox[0] - (text.x + 2)) < 1) upright = { bbox, dir };
					},
				});
				expect(contents.asText()).toContain("Čaj Ω");
				expect(upright?.dir).toEqual([1, 0]);
				expect(upright?.bbox[0]).toBeCloseTo(42, 1);
				expect(upright?.bbox[1]).toBeCloseTo(42, 0);
			} else {
				const types: string[] = [];
				raw.forEach((annotation) => {
					types.push(annotation.get("Subtype").asName());
				});
				expect(types).toEqual(["FreeText", "Ink", "Stamp", "Ink", "Circle", "Stamp", "Stamp"]);
				expect(raw.get(0, "Contents").asString()).toBe("Čaj Ω");
				const matrix = raw.get(0, "AP", "N", "Matrix");
				expectNumbers(
					Array.from({ length: 6 }, (_, i) => matrix.get(i).asNumber()),
					itemMatrix(text, page.getTransform()),
				);
				const rect = raw.get(0, "Rect");
				expectNumbers(
					Array.from({ length: 4 }, (_, i) => rect.get(i).asNumber()),
					applyRect([40, 40, 150, 74], invert(page.getTransform())),
				);
			}
			const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
			const pixels = pixmap.getPixels();
			const pixel = (x: number, y: number) => [
				...pixels.slice((y * pixmap.getWidth() + x) * 3, (y * pixmap.getWidth() + x) * 3 + 3),
			];
			expect(pixel(70, 107)[0]).toBeLessThan(30);
			expect(pixel(70, 160)).toEqual([255, 120, 34]);
			expect(pixel(53, 253)[0]).toBeLessThan(30);
			expect(pixel(60, 334)).toEqual([255, 120, 34]);
			let textPixels = 0;
			for (let y = 43; y < 63; y++) for (let x = 42; x < 92; x++) if (pixel(x, y)[0] < 80) textPixels++;
			expect(textPixels).toBeGreaterThan(30);
			pixmap.destroy();
			contents.destroy();
			page.destroy();
		} finally {
			result.destroy();
			source.destroy();
		}
	},
);

it("retains encryption on an edited password protected PDF and reports unsupported glyphs", () => {
	const doc = editDocument();
	const encrypted = readback(
		doc,
		"encrypt=aes-256,user-password=paper-fox,owner-password=lantern-keeper,permissions=-1",
	);
	doc.destroy();
	expect(encrypted.needsPassword()).toBe(true);
	expect(encrypted.authenticatePassword("incorrect")).toBe(0);
	expect(encrypted.authenticatePassword(password)).toBeGreaterThan(0);
	expect(applyItems(encrypted, byPage([{ ...text, text: "字", lines: ["字"] }]), fonts, {}, "flatten")).toEqual(["字"]);
	const result = readback(encrypted);
	expect(result.needsPassword()).toBe(true);
	expect(result.authenticatePassword(password)).toBeGreaterThan(0);
	expect(result.countPages()).toBe(3);
	result.destroy();
	encrypted.destroy();
});
