import { describe, expect, it } from "vitest";
import { editExif, readExif, takenDate } from "./exif.ts";

/**
 * Builds a TIFF/EXIF block: IFD0 (Orientation, Make, Exif and GPS pointers) → IFD1 (a thumbnail),
 * an Exif IFD (DateTimeOriginal, OffsetTimeOriginal) and a GPS IFD (latitude as rationals).
 */
function buildExif(le: boolean, orientation = 6): { bytes: Uint8Array; gpsBytes: number[]; thumb: number[] } {
	const buf = new Uint8Array(1024);
	const v = new DataView(buf.buffer);
	const u16 = (o: number, x: number) => v.setUint16(o, x, le);
	const u32 = (o: number, x: number) => v.setUint32(o, x, le);
	buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
	u16(2, 42);
	u32(4, 8);
	const entry = (at: number, tag: number, type: number, count: number, value: number, short = false) => {
		u16(at, tag);
		u16(at + 2, type);
		u32(at + 4, count);
		if (short) u16(at + 8, value);
		else u32(at + 8, value);
	};
	const ascii = (at: number, s: string) => buf.set([...new TextEncoder().encode(s), 0], at);
	// IFD0 at 8: 4 entries.
	u16(8, 4);
	entry(10, 0x010f, 2, 13, 300); // Make → 300
	entry(22, 0x0112, 3, 1, orientation, true);
	entry(34, 0x8769, 4, 1, 400); // Exif IFD
	entry(46, 0x8825, 4, 1, 500); // GPS IFD
	u32(58, 600); // next: IFD1
	ascii(300, "Toolbox test");
	// Exif IFD at 400.
	u16(400, 2);
	entry(402, 0x9003, 2, 20, 440);
	entry(414, 0x9011, 2, 7, 470);
	u32(426, 0);
	ascii(440, "2024:05:06 07:08:09");
	ascii(470, "+02:00");
	// GPS IFD at 500: LatitudeRef "N" (inline), Latitude 3 rationals at 540.
	u16(500, 2);
	entry(502, 1, 2, 2, 0);
	buf.set([0x4e, 0], 510);
	entry(514, 2, 5, 3, 540);
	u32(526, 0);
	for (const [i, n] of [12, 34, 56].entries()) {
		u32(540 + i * 8, n);
		u32(544 + i * 8, 1);
	}
	// IFD1 at 600: thumbnail offset/length → 700, 40 bytes of 0xAB.
	u16(600, 2);
	entry(602, 0x0201, 4, 1, 700);
	entry(614, 0x0202, 4, 1, 40);
	u32(626, 0);
	buf.fill(0xab, 700, 740);
	return {
		bytes: buf.slice(0, 760),
		gpsBytes: Array.from(buf.slice(540, 564)),
		thumb: Array.from(buf.slice(700, 740)),
	};
}

const contains = (hay: Uint8Array, needle: number[]) => {
	outer: for (let i = 0; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
};

describe.each([
	["little endian", true],
	["big endian", false],
])("EXIF (%s)", (_, le) => {
	it("reads orientation, date taken with its offset, and GPS presence", () => {
		const info = readExif(buildExif(le).bytes);
		expect(info).toEqual({ orientation: 6, dateTaken: "2024:05:06 07:08:09", offset: "+02:00", hasGps: true });
		expect(takenDate(info)?.getTime()).toBe(new Date(2024, 4, 6, 7, 8, 9).getTime());
	});

	it("sets orientation to 1, drops the thumbnail, and keeps GPS by default", () => {
		const { bytes, thumb, gpsBytes } = buildExif(le);
		const out = editExif(bytes, { stripGps: false }) as Uint8Array;
		expect(out.length).toBe(bytes.length);
		const info = readExif(out);
		expect(info.orientation).toBe(1);
		expect(info.hasGps).toBe(true);
		expect(info.dateTaken).toBe("2024:05:06 07:08:09");
		expect(contains(out, thumb)).toBe(false);
		expect(contains(out, gpsBytes)).toBe(true);
		// The input is untouched.
		expect(readExif(bytes).orientation).toBe(6);
	});

	it("removes GPS completely when asked: no entry, no IFD, no coordinates left", () => {
		const { bytes, gpsBytes } = buildExif(le);
		const out = editExif(bytes, { stripGps: true }) as Uint8Array;
		const info = readExif(out);
		expect(info.hasGps).toBe(false);
		expect(info.orientation).toBe(1);
		expect(info.dateTaken).toBe("2024:05:06 07:08:09");
		expect(contains(out, gpsBytes)).toBe(false);
		// The Make string (before the removed entry) and the Exif IFD (after) still read.
		expect(new TextDecoder().decode(out.subarray(300, 312))).toBe("Toolbox test");
	});
});

describe("EXIF edge cases", () => {
	it("returns null for something that isn't TIFF, and reads defaults from it", () => {
		expect(editExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), { stripGps: true })).toBeNull();
		expect(readExif(new Uint8Array(4))).toEqual({ orientation: 1, dateTaken: null, offset: null, hasGps: false });
	});

	it("treats out-of-range orientations as upright and bad dates as missing", () => {
		expect(readExif(buildExif(true, 9).bytes).orientation).toBe(1);
		expect(takenDate({ orientation: 1, dateTaken: "0000:00:00 00:00:00", offset: null, hasGps: false })).toBeNull();
	});
});
