import { describe, expect, it } from "vitest";
import { crc32 } from "../../lib/zipWriter.ts";
import { concat, readJpeg, readPng, writeJpegMeta, writePngMeta } from "./containers.ts";

/** SOI, a JFIF APP0, a baseline SOF0 for 40×30, and an SOS start (enough for the header reader). */
function jpeg(): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 30, 0,
		40, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x12, 0x34, 0xff,
		0xd9,
	]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const v = new DataView(out.buffer);
	v.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** A PNG with IHDR (50×20, 16-bit RGBA), a stray sRGB chunk, a dummy IDAT and IEND. */
function png(): Uint8Array {
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, 50);
	v.setUint32(4, 20);
	ihdr.set([16, 6, 0, 0, 0], 8);
	return concat([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("sRGB", new Uint8Array([0])),
		chunk("IDAT", new Uint8Array([1, 2, 3])),
		chunk("IEND", new Uint8Array()),
	]);
}

const exif = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
const bigIcc = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 7) & 255);

describe("JPEG metadata", () => {
	it("reads size, EXIF and a multi-segment ICC profile back from what it wrote", () => {
		const { bytes, exifDropped } = writeJpegMeta(jpeg(), { icc: bigIcc, exif });
		expect(exifDropped).toBe(false);
		const info = readJpeg(bytes);
		expect([info.width, info.height, info.bitDepth]).toEqual([40, 30, 8]);
		expect(info.exif).toEqual(exif);
		expect(info.icc).toEqual(bigIcc);
		// The encoder's JFIF segment was replaced; the image data follows untouched.
		expect(new TextDecoder("latin1").decode(bytes).includes("JFIF")).toBe(false);
		expect(Array.from(bytes.subarray(-4))).toEqual([0x12, 0x34, 0xff, 0xd9]);
		// 150 KB of ICC needs three APP2 segments.
		let app2 = 0;
		for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xe2) app2++;
		expect(app2).toBe(3);
	});

	it("leaves out EXIF that can't fit in one segment, and says so", () => {
		const { bytes, exifDropped } = writeJpegMeta(jpeg(), { icc: null, exif: new Uint8Array(70_000) });
		expect(exifDropped).toBe(true);
		expect(readJpeg(bytes).exif).toBeNull();
	});

	it("rejects non-JPEG data", () => {
		expect(() => readJpeg(new Uint8Array([1, 2, 3]))).toThrow();
	});
});

describe("PNG metadata", () => {
	it("writes iCCP after IHDR and eXIf before IDAT, drops conflicting chunks, and reads them back", () => {
		const out = writePngMeta(png(), { icc: bigIcc, exif });
		const info = readPng(out);
		expect([info.width, info.height, info.bitDepth]).toEqual([50, 20, 16]);
		expect(info.icc).toEqual(bigIcc);
		expect(info.exif).toEqual(exif);
		const text = new TextDecoder("latin1").decode(out);
		expect(text.indexOf("iCCP")).toBeGreaterThan(text.indexOf("IHDR"));
		expect(text.indexOf("eXIf")).toBeLessThan(text.indexOf("IDAT"));
		expect(text.includes("sRGB")).toBe(false);
	});

	it("writes valid chunk CRCs", () => {
		const out = writePngMeta(png(), { icc: new Uint8Array([1, 2, 3]), exif });
		const view = new DataView(out.buffer);
		for (let at = 8; at < out.length; ) {
			const length = view.getUint32(at);
			expect(view.getUint32(at + 8 + length)).toBe(crc32(out.subarray(at + 4, at + 8 + length)));
			at += 12 + length;
		}
	});
});
