import { describe, expect, it } from "vitest";
import { PATH_MAX, PATH_SEGMENT_MAX } from "../tuning.ts";
import { numbered, sanitizePath, sanitizePaths, sanitizeSegment } from "./paths.ts";

describe("sanitizePath", () => {
	it("drops traversal, empty and dot segments on both separators", () => {
		expect(sanitizePath("../../etc/passwd")).toBe("etc/passwd");
		expect(sanitizePath("..\\..\\Windows\\System32\\x.dll")).toBe("Windows/System32/x.dll");
		expect(sanitizePath("/abs//./a/../b")).toBe("abs/a/b");
		expect(sanitizePath("C:\\Users\\x.txt")).toBe("C_/Users/x.txt");
		expect(sanitizePath("")).toBe("file");
		expect(sanitizePath("../..")).toBe("file");
		expect(sanitizePath("...")).toBe("file");
	});

	it("strips control and bidi characters and replaces reserved punctuation", () => {
		expect(sanitizePath("invoice\u202Etxt.exe")).toBe("invoicetxt.exe");
		expect(sanitizePath("a\u0000b\u001fc\u200F.txt")).toBe("abc.txt");
		expect(sanitizePath('what<>:"|?*.jpg')).toBe("what_______.jpg");
		expect(sanitizePath("Trip/Day 1/IMG_0001.CR3")).toBe("Trip/Day 1/IMG_0001.CR3");
	});

	it("normalizes to NFC and keeps unicode names", () => {
		expect(sanitizePath("Cafe\u0301/Ünïcødé ☕.txt")).toBe("Café/Ünïcødé ☕.txt");
		expect(sanitizePath("Café/x")).toBe(sanitizePath("Cafe\u0301/x"));
	});

	it("renames Windows reserved names with or without an extension", () => {
		for (const name of ["CON", "prn", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
			expect(sanitizeSegment(name)).toBe(`_${name}`);
			expect(sanitizeSegment(`${name}.txt`)).toBe(`_${name}.txt`);
		}
		expect(sanitizeSegment("CON.")).toBe("_CON");
		expect(sanitizeSegment("CONSOLE.txt")).toBe("CONSOLE.txt");
		expect(sanitizeSegment("COM0")).toBe("COM0");
		expect(sanitizePath("nul/aux/con.tar.gz")).toBe("_nul/_aux/_con.tar.gz");
	});

	it("trims trailing dots and spaces", () => {
		expect(sanitizeSegment("name. . ")).toBe("name");
		expect(sanitizePath("folder. /file .")).toBe("folder/file");
		expect(sanitizeSegment("  spaced  ")).toBe("spaced");
	});

	it("limits segments to 120 characters, keeping the extension", () => {
		const long = `${"a".repeat(300)}.jpeg`;
		const out = sanitizeSegment(long);
		expect(Array.from(out)).toHaveLength(PATH_SEGMENT_MAX);
		expect(out.endsWith(".jpeg")).toBe(true);
		// Counted in characters, not UTF-16 units.
		expect(Array.from(sanitizeSegment("😀".repeat(200)))).toHaveLength(PATH_SEGMENT_MAX);
	});

	it("limits the whole path to 400 characters by dropping trailing folders", () => {
		const path = `${Array.from({ length: 10 }, (_, i) => `${i}${"d".repeat(99)}`).join("/")}/photo.jpg`;
		const out = sanitizePath(path);
		expect(out.length).toBeLessThanOrEqual(PATH_MAX);
		expect(out.startsWith(`0${"d".repeat(99)}/`)).toBe(true);
		expect(out.endsWith("/photo.jpg")).toBe(true);
	});
});

describe("sanitizePaths", () => {
	it("numbers duplicates before the extension, case-insensitively", () => {
		expect(sanitizePaths(["a/IMG.jpg", "a/img.JPG", "a/IMG.jpg", "b/IMG.jpg", "../a/IMG.jpg"])).toEqual([
			"a/IMG.jpg",
			"a/img (2).JPG",
			"a/IMG (3).jpg",
			"b/IMG.jpg",
			"a/IMG (4).jpg",
		]);
		expect(sanitizePaths([".bashrc", ".bashrc", "noext", "noext"])).toEqual([
			".bashrc",
			".bashrc (2)",
			"noext",
			"noext (2)",
		]);
	});

	it("renames a file whose path is also another file's folder", () => {
		expect(sanitizePaths(["Trip", "Trip/a.jpg"])).toEqual(["Trip (2)", "Trip/a.jpg"]);
	});

	it("does not collide with names that already carry a number", () => {
		expect(sanitizePaths(["x (2).txt", "x.txt", "x.txt"])).toEqual(["x (2).txt", "x.txt", "x (3).txt"]);
	});

	it("keeps deduplicated paths within the limits", () => {
		const name = `${"n".repeat(200)}.mov`;
		const out = sanitizePaths([name, name, name]);
		expect(new Set(out).size).toBe(3);
		for (const p of out) expect(Array.from(p).length).toBeLessThanOrEqual(PATH_SEGMENT_MAX);
		const deep = `${Array.from({ length: 8 }, () => "f".repeat(60)).join("/")}/v.mp4`;
		for (const p of sanitizePaths([deep, deep])) expect(p.length).toBeLessThanOrEqual(PATH_MAX);
		expect(numbered("IMG.jpg", 12)).toBe("IMG (12).jpg");
	});
});
