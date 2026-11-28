import { describe, expect, it } from "vitest";
import { orient } from "./rotate.ts";

// A 3×2 image whose pixels are numbered 1–6 (in the red channel):
//   1 2 3
//   4 5 6
const image = () => {
	const data = new Uint8Array(6 * 4);
	for (let i = 0; i < 6; i++) data.set([i + 1, 0, 0, 255], i * 4);
	return { data, width: 3, height: 2 };
};
const reds = (p: { data: Uint8Array | Uint16Array }) => Array.from(p.data.filter((_, i) => i % 4 === 0));

describe("orient", () => {
	it.each([
		[1, 3, 2, [1, 2, 3, 4, 5, 6]],
		[2, 3, 2, [3, 2, 1, 6, 5, 4]], // mirror horizontally
		[3, 3, 2, [6, 5, 4, 3, 2, 1]], // rotate 180
		[4, 3, 2, [4, 5, 6, 1, 2, 3]], // mirror vertically
		[5, 2, 3, [1, 4, 2, 5, 3, 6]], // transpose
		[6, 2, 3, [4, 1, 5, 2, 6, 3]], // rotate 90 clockwise
		[7, 2, 3, [6, 3, 5, 2, 4, 1]], // transverse
		[8, 2, 3, [3, 6, 2, 5, 1, 4]], // rotate 90 counter-clockwise
	])("orientation %i → %i×%i", (orientation, width, height, expected) => {
		const out = orient(image(), orientation);
		expect([out.width, out.height]).toEqual([width, height]);
		expect(reds(out)).toEqual(expected);
	});

	it("works on 16-bit pixels", () => {
		const data = new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const out = orient({ data, width: 2, height: 1 }, 6);
		expect([out.width, out.height]).toEqual([1, 2]);
		expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		const flipped = orient({ data, width: 2, height: 1 }, 2);
		expect(Array.from(flipped.data)).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
	});
});
