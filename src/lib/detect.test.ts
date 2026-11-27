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

	it("looks for the TAR magic at byte 257", () => {
		const header = new Uint8Array(512);
		header.set(Buffer.from("ustar"), 257);
		expect(detectBytes(header)).toBe("tar");
	});
});
