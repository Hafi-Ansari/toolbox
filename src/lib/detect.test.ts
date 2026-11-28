import { describe, expect, it } from "vitest";
import { detectBytes } from "./detect.ts";

describe("detect archive signatures", () => {
	it.each([
		["255044462d31", "pdf"],
		["504b0304", "zip"],
		["504b0506", "zip"],
		["377abcaf271c", "7z"],
		["526172211a0700", "rar"],
		["526172211a070100", "rar"],
		["1f8b08", "gzip"],
		["425a6839", "bzip2"],
		["fd377a585a00", "xz"],
		["28b52ffd", "zstd"],
		["4d534346", "cab"],
		["1f8b00", "unknown"],
	] as const)("classifies %s as %s", (hex, format) => {
		expect(detectBytes(Buffer.from(hex, "hex"))).toBe(format);
	});

	it("tells photos apart: JPEG, PNG, and HEIF by its brands (HEIC vs AVIF)", () => {
		const ftyp = (major: string, ...compatible: string[]) => {
			const size = 16 + compatible.length * 4;
			const b = Buffer.alloc(size);
			b.writeUInt32BE(size, 0);
			b.write(`ftyp${major}`, 4, "latin1");
			for (const [i, c] of compatible.entries()) b.write(c, 16 + i * 4, "latin1");
			return b;
		};
		expect(detectBytes(Buffer.from("ffd8ffe1", "hex"))).toBe("jpeg");
		expect(detectBytes(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("png");
		expect(detectBytes(ftyp("heic", "mif1", "heic"))).toBe("heic");
		expect(detectBytes(ftyp("mif1", "mif1", "MiHE", "heic"))).toBe("heic");
		expect(detectBytes(ftyp("avif", "mif1", "avif"))).toBe("avif");
		expect(detectBytes(ftyp("mif1", "mif1", "avif"))).toBe("avif");
		expect(detectBytes(ftyp("isom", "isom", "mp41"))).toBe("unknown");
	});

	it("looks for the TAR magic at byte 257", () => {
		const header = new Uint8Array(512);
		header.set(Buffer.from("ustar"), 257);
		expect(detectBytes(header)).toBe("tar");
	});
});
