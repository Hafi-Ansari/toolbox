// The whole pipeline in Node, with the real codecs, on the synthetic fixtures
// (e2e/fixtures/photo, made by scripts/photo-fixtures.py) and on JPEG/PNG inputs built here.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { iccProfile, identifyIcc } from "./color.ts";
import { readJpeg, readPng, writeJpegMeta, writePngMeta } from "./containers.ts";
import { type ConvertOptions, convert } from "./convert.ts";
import { readExif } from "./exif.ts";
import { nodeCodecs } from "./nodeCodecs.ts";

const fixture = (name: string) =>
	new Uint8Array(fs.readFileSync(new URL(`../../../e2e/fixtures/photo/${name}`, import.meta.url)));
const jpegOut: ConvertOptions = { format: "jpeg", quality: 92, srgb: false, stripGps: false };
const pngOut: ConvertOptions = { ...jpegOut, format: "png" };

async function pixel(bytes: Uint8Array, kind: "jpeg" | "png", x: number, y: number) {
	const codecs = await nodeCodecs();
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const image =
		kind === "jpeg"
			? await (await codecs.jpeg()).decode(buffer, { preserveOrientation: false })
			: await (await codecs.png()).decode(buffer, { bitDepth: readPng(bytes).bitDepth === 16 ? 16 : 8 });
	const i = (y * image.width + x) * 4;
	return Array.from(image.data.subarray(i, i + 4));
}

describe("convert (HEIC)", { timeout: 60_000 }, () => {
	it("HEIC → JPEG: upright, Display P3 kept, EXIF kept with orientation 1, location kept", async () => {
		const r = await convert(fixture("main.heic"), "heic", jpegOut, await nodeCodecs());
		expect([r.width, r.height]).toEqual([48, 64]);
		expect(r.color).toBe("Display P3");
		expect(r.notes).toEqual([]);
		expect(r.taken?.getTime()).toBe(new Date(2024, 4, 6, 7, 8, 9).getTime());
		const info = readJpeg(r.bytes);
		expect([info.width, info.height]).toEqual([48, 64]);
		expect(identifyIcc(info.icc as Uint8Array)).toBe("p3");
		expect(readExif(info.exif as Uint8Array)).toMatchObject({
			orientation: 1,
			hasGps: true,
			dateTaken: "2024:05:06 07:08:09",
		});
		// Rotated clockwise: the red third is now the top; P3 red keeps its P3 values (not clipped to sRGB).
		const [r0, g0, b0] = await pixel(r.bytes, "jpeg", 24, 4);
		expect(r0).toBeGreaterThan(245);
		expect(g0).toBeLessThan(12);
		expect(b0).toBeLessThan(12);
		const white = await pixel(r.bytes, "jpeg", 24, 32);
		expect(white.slice(0, 3).every((v) => v > 245)).toBe(true);
	});

	it("Remove location strips GPS; sRGB converts P3 red and tags sRGB", async () => {
		const r = await convert(
			fixture("main.heic"),
			"heic",
			{ ...jpegOut, stripGps: true, srgb: true },
			await nodeCodecs(),
		);
		const info = readJpeg(r.bytes);
		expect(readExif(info.exif as Uint8Array).hasGps).toBe(false);
		expect(identifyIcc(info.icc as Uint8Array)).toBe("srgb");
		expect(r.color).toBe("sRGB");
		// P3 red is outside sRGB: it clamps to sRGB's own red.
		const [r0, g0, b0] = await pixel(r.bytes, "jpeg", 24, 4);
		expect(r0).toBeGreaterThan(245);
		expect(g0).toBeLessThan(12);
		expect(b0).toBeLessThan(12);
	});

	it("10-bit HEIC → 16-bit PNG with its profile", async () => {
		const r = await convert(fixture("deep.heic"), "heic", pngOut, await nodeCodecs());
		const info = readPng(r.bytes);
		expect([info.width, info.height, info.bitDepth]).toEqual([64, 48, 16]);
		expect(identifyIcc(info.icc as Uint8Array)).toBe("p3");
		const white = await pixel(r.bytes, "png", 30, 10);
		expect(white).toEqual([65535, 65535, 65535, 65535]);
	});

	it("HEIC with transparency: PNG keeps it, JPEG fills it with white and says so", async () => {
		const codecs = await nodeCodecs();
		const png = await convert(fixture("alpha.heic"), "heic", pngOut, codecs);
		expect((await pixel(png.bytes, "png", 60, 10))[3]).toBe(0);
		const jpeg = await convert(fixture("alpha.heic"), "heic", jpegOut, codecs);
		expect(jpeg.notes.join(" ")).toMatch(/filled with white/);
		const filled = await pixel(jpeg.bytes, "jpeg", 60, 10);
		expect(filled.slice(0, 3).every((v) => v > 245)).toBe(true);
	});

	it("fails clearly on a file libheif can't read", async () => {
		await expect(convert(new Uint8Array(64), "heic", jpegOut, await nodeCodecs())).rejects.toThrow(/HEIF/);
	});
});

describe("convert (JPEG and PNG)", { timeout: 60_000 }, () => {
	/** A 6×4 JPEG with EXIF Orientation 6 and a P3 profile: left half red, right half blue. */
	async function sideways(): Promise<Uint8Array> {
		const codecs = await nodeCodecs();
		const data = new Uint8ClampedArray(6 * 4 * 4);
		for (let y = 0; y < 4; y++)
			for (let x = 0; x < 6; x++) data.set(x < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 6 + x) * 4);
		const raw = new Uint8Array(
			await (await codecs.jpeg()).encode(
				{ data, width: 6, height: 4 },
				{ quality: 95, auto_subsample: false, chroma_subsample: 1 },
			),
		);
		// Minimal big-endian TIFF: IFD0 with Orientation = 6.
		const exif = new Uint8Array([
			0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0,
		]);
		return writeJpegMeta(raw, { icc: iccProfile("p3"), exif }).bytes;
	}

	it("JPEG → PNG applies the EXIF orientation and keeps the profile", async () => {
		const r = await convert(await sideways(), "jpeg", pngOut, await nodeCodecs());
		expect([r.width, r.height]).toEqual([4, 6]);
		const info = readPng(r.bytes);
		expect(identifyIcc(info.icc as Uint8Array)).toBe("p3");
		expect(readExif(info.exif as Uint8Array).orientation).toBe(1);
		// Rotated clockwise: red (the left) is now on top, blue at the bottom.
		const top = await pixel(r.bytes, "png", 2, 0);
		const bottom = await pixel(r.bytes, "png", 2, 5);
		expect(top[0]).toBeGreaterThan(200);
		expect(bottom[2]).toBeGreaterThan(200);
	});

	it("a JPEG asked to become a JPEG is handed back untouched, unless something must change", async () => {
		const input = await sideways();
		const same = await convert(input, "jpeg", jpegOut, await nodeCodecs());
		expect(same.bytes).toBe(input);
		expect(same.notes).toEqual(["Already a JPEG: kept as it was."]);
		const srgb = await convert(input, "jpeg", { ...jpegOut, srgb: true }, await nodeCodecs());
		expect(srgb.bytes).not.toBe(input);
		expect(identifyIcc(readJpeg(srgb.bytes).icc as Uint8Array)).toBe("srgb");
	});

	it("PNG with transparency → JPEG is flattened on white with a note", async () => {
		const codecs = await nodeCodecs();
		const data = new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 255]);
		const raw = new Uint8Array(await (await codecs.png()).encode({ data, width: 2, height: 1 }, { bitDepth: 8 }));
		const r = await convert(writePngMeta(raw, { icc: null, exif: null }), "png", jpegOut, codecs);
		expect(r.notes.join(" ")).toMatch(/filled with white/);
		const first = await pixel(r.bytes, "jpeg", 0, 0);
		expect(first.slice(0, 3).every((v) => v > 240)).toBe(true);
	});

	it("reports unreadable JPEG and PNG files", async () => {
		const codecs = await nodeCodecs();
		await expect(convert(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), "jpeg", pngOut, codecs)).rejects.toThrow(
			/JPEG couldn't be read/,
		);
		await expect(convert(new Uint8Array(20), "png", jpegOut, codecs)).rejects.toThrow(/PNG couldn't be read/);
	});
});
