import { expect, it } from "vitest";
import { parseListing, totalBytes } from "./listing.ts";

it("decodes folders, metadata, encrypted entries and embedded equals signs", () => {
	const { format, entries } = parseListing(
		`
Path = archive.zip
Type = zip
Physical Size = 1203

----------
Path = docs
Folder = +
Size = 0

Path = docs/read = me.txt
Folder = -
Size = 100
Packed Size = 40
Modified = 2026-10-03 12:30:00
CRC = 24F3F99B
Encrypted = +

Path = symlink
Size = 500
Attributes = A lrwxrwxrwx
`
			.trim()
			.split("\n"),
	);
	expect(format).toBe("zip");
	expect(entries[0]).toMatchObject({ path: "docs", folder: true });
	expect(entries[1]).toMatchObject({
		path: "docs/read = me.txt",
		packed: 40,
		size: 100,
		crc: "24F3F99B",
		encrypted: true,
		modified: "2026-10-03 12:30:00",
	});
	expect(entries[2].special).toBe(true);
	expect(totalBytes(entries)).toBe(100);
});

it("rejects an unrepresentable listed size", () => {
	expect(() => parseListing(["----------", "Path = file", "Size = 99999999999999999"])).toThrow("Invalid size");
});
