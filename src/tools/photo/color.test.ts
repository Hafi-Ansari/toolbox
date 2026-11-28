import { describe, expect, it } from "vitest";
import { iccProfile, identifyIcc, identifyNclx, linearToSrgb, p3ToSrgb, srgbToLinear } from "./color.ts";

describe("color", () => {
	it("builds valid compact profiles and recognizes them", () => {
		for (const space of ["p3", "srgb"] as const) {
			const icc = iccProfile(space);
			const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
			expect(view.getUint32(0)).toBe(icc.length);
			expect(new TextDecoder().decode(icc.subarray(36, 40))).toBe("acsp");
			expect(identifyIcc(icc)).toBe(space);
		}
	});

	it("calls unknown or broken profiles 'other'", () => {
		expect(identifyIcc(new Uint8Array(200))).toBe("other");
		const gray = iccProfile("srgb").slice();
		gray.set(new TextEncoder().encode("GRAY"), 16);
		expect(identifyIcc(gray)).toBe("other");
	});

	it("maps nclx primaries", () => {
		expect(identifyNclx({ primaries: 12, transfer: 13 })).toBe("p3");
		expect(identifyNclx({ primaries: 1, transfer: 13 })).toBe("srgb");
		expect(identifyNclx({ primaries: 9, transfer: 16 })).toBe("other");
	});

	it("round-trips the sRGB curve", () => {
		for (const v of [0, 0.002, 0.04, 0.2, 0.5, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
	});

	it("converts Display P3 to sRGB: white stays, P3 red clamps, in-gamut colors land within a step", () => {
		const px = new Uint8Array([255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 7, 128, 128, 128, 255]);
		p3ToSrgb(px);
		expect(Array.from(px.subarray(0, 4))).toEqual([255, 255, 255, 255]);
		expect(Array.from(px.subarray(4, 8))).toEqual([255, 0, 0, 255]);
		expect(Array.from(px.subarray(8, 12))).toEqual([0, 0, 0, 7]); // alpha untouched
		expect(Array.from(px.subarray(12, 16))).toEqual([128, 128, 128, 255]); // grays are shared

		// sRGB red, written as P3 (approx. 234, 51, 35), comes back to (255, 0, 0) within a step.
		const red = new Uint8Array([234, 51, 35, 255]);
		p3ToSrgb(red);
		expect(red[0]).toBeGreaterThanOrEqual(254);
		expect(red[1]).toBeLessThanOrEqual(2);
		expect(red[2]).toBeLessThanOrEqual(2);
	});

	it("converts 16-bit pixels too", () => {
		const px = new Uint16Array([65535, 65535, 65535, 65535, 65535, 0, 0, 65535]);
		p3ToSrgb(px);
		expect(Array.from(px)).toEqual([65535, 65535, 65535, 65535, 65535, 0, 0, 65535]);
	});
});
