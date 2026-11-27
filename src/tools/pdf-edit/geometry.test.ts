import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import {
	apply,
	itemMatrix,
	type Matrix,
	type Point,
	pageToScreen,
	pageTransform,
	type Rect,
	screenToPage,
} from "./geometry.ts";

const media: Rect = [10, 20, 410, 620];
const crop: Rect = [30, 40, 400, 600];

function expectNumbers(actual: number[], expected: number[]) {
	actual.forEach((n, i) => {
		expect(n).toBeCloseTo(expected[i], 5);
	});
}

describe("PDF editor page transforms", () => {
	it.each([0, 90, 180, 270] as const)("matches MuPDF at %i degrees with offset and intersected boxes", (rotate) => {
		const doc = new mupdf.PDFDocument();
		try {
			const cases = [undefined, crop, [-20, 40, 450, 600] satisfies Rect];
			for (const [index, box] of cases.entries()) {
				const object = doc.addPage(media, rotate, {}, "");
				if (box) object.put("CropBox", box);
				object.put("UserUnit", 2);
				doc.insertPage(-1, object);
				const page = doc.loadPage(index);
				try {
					expectNumbers(pageTransform(media, box, rotate, 2), page.getTransform());
				} finally {
					page.destroy();
				}
			}
		} finally {
			doc.destroy();
		}
	});

	it.each([0.3, 0.64, 1, 1.75, 4])("round-trips between screen and page at scale %s", (scale) => {
		const point: Point = [245, 390];
		const view = { left: -44, top: 180, scale };
		expectNumbers(screenToPage(pageToScreen(point, view), view), point);
	});

	it.each([0, 90, 180, 270])("maps form corners into the displayed rectangle at %i degrees", (rotate) => {
		const transform: Matrix = pageTransform(media, crop, rotate);
		const placement = itemMatrix({ x: 42, y: 72, h: 24 }, transform);
		expectNumbers(apply(apply([0, 24], placement), transform), [42, 72]);
		expectNumbers(apply(apply([150, 0], placement), transform), [192, 96]);
	});
});
