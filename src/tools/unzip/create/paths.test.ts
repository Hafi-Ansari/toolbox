import { describe, expect, it } from "vitest";
import { archiveName, pathSegments, planArchive, suggestName } from "./paths.ts";

const file = new File(["x"], "x");

describe("pathSegments", () => {
	it.each([
		["a.txt", ["a.txt"]],
		["Folder\\Sub\\a.txt", ["Folder", "Sub", "a.txt"]],
		["./Folder//a.txt/", ["Folder", "a.txt"]],
		["Cafe\u0301/ü.txt", ["Café", "ü.txt"]],
		["new\nline.txt", ["new_line.txt"]],
		["*?:<>.txt", ["*?:<>.txt"]],
	])("normalises %j", (input, expected) => expect(pathSegments(input)).toEqual(expected));

	it.each(["/etc/passwd", "\\\\server\\share\\a", "C:\\Users\\a.txt", "c:a.txt", "a/../../b", "..", "", "/", "./"])(
		"rejects %j",
		(input) => expect(() => pathSegments(input)).toThrow(),
	);
});

describe("planArchive", () => {
	it("keeps folder structure and makes repeated names distinct", () => {
		const { items } = planArchive([
			{ id: 1, path: "Trip/day1/a.txt", file },
			{ id: 2, path: "Trip/day1/a.txt", file },
			{ id: 3, path: "trip/DAY1/A.TXT", file },
			{ id: 4, path: "notes.txt", file },
			{ id: 5, path: "Trip\\day2\\b.txt", file },
		]);
		expect(items.map((item) => [item.id, item.path])).toEqual([
			[1, "Trip/day1/a.txt"],
			[2, "Trip/day1/a (2).txt"],
			[3, "Trip/day1/A (3).TXT"],
			[4, "notes.txt"],
			[5, "Trip/day2/b.txt"],
		]);
	});

	it("separates a file and a folder with the same name", () => {
		const { items } = planArchive([
			{ id: 1, path: "report", file },
			{ id: 2, path: "report/page.txt", file },
		]);
		expect(items.map((item) => item.path)).toEqual(["report", "report (2)/page.txt"]);
	});

	it("keeps only empty folders that hold no files", () => {
		const { directories } = planArchive(
			[{ id: 1, path: "Trip/day1/a.txt", file }],
			["Trip", "Trip/day1", "Trip/empty", "Trip/empty/deeper", "Other"],
		);
		expect(directories).toEqual(["Other", "Trip/empty/deeper"]);
	});
});

it.each([
	["My files.zip", "My files"],
	["a/b:c", "a_b_c"],
	["  ...  ", "Archive"],
	["backup.tar.gz", "backup"],
	["dots...", "dots"],
])("archive name %j", (input, expected) => expect(archiveName(input)).toBe(expected));

it.each([
	[["Photos/a.jpg", "Photos/b/c.jpg"], "Photos"],
	[["report.pdf"], "report"],
	[["a.txt", "b.txt"], "Archive"],
])("suggests a name for %j", (paths, expected) => expect(suggestName(paths)).toBe(expected));
