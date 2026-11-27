import { expect, it } from "vitest";
import { outputPaths, sanitizePath, uniqueName } from "./names.ts";

it.each([
	["/../hello/.././readme.txt", "hello/readme.txt"],
	["C:\\Users\\.\\..\\folder\\file.txt", "Users/folder/file.txt"],
	["/\\", "unnamed"],
	["\u0001\u0085rtl\u202E\u061C\u200F\u2068.txt", "rtl.txt"],
	["CON .txt/NUL/COM2/LPT³.log", "_CON .txt/_NUL/_COM2/_LPT³.log"],
	["ab:*?<>|. ", "ab______"],
	["safe/..\u0001/file", "safe/unnamed/file"],
] as const)("sanitizes %j", (input, expected) => expect(sanitizePath(input)).toBe(expected));

it("keeps Unicode segments within 255 bytes after disambiguation", () => {
	const safe = sanitizePath("🏠".repeat(200));
	const used = new Set<string>();
	expect(uniqueName(safe, used)).toBe(safe);
	const duplicate = uniqueName(safe, used);
	expect(duplicate).toMatch(/ \(2\)$/);
	expect(Buffer.byteLength(duplicate)).toBeLessThanOrEqual(255);
});

it("disambiguates files and folders at each path level", () => {
	const input = [
		{ path: "file", folder: false },
		{ path: "file/readme.txt", folder: false },
		{ path: "file/README.txt", folder: false },
		{ path: "File/unique.txt", folder: false },
		{ path: "File", folder: true },
	];
	expect(outputPaths(input)).toEqual([
		"file",
		"file (2)/readme.txt",
		"file (2)/README (2).txt",
		"File (3)/unique.txt",
		"File (3)",
	]);
});
