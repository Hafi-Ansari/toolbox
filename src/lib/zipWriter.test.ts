import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";
import { ZipReader } from "./zipReader.ts";
import { crc32, ZipWriter } from "./zipWriter.ts";

it("streams stored entries with descriptors through fflate and ZipReader", async () => {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((chunk) => parts.push(chunk.slice()));
	const empty = zip.addStream("empty.txt", 0);
	empty.close();
	const entry = zip.addStream("nested/café.txt", 6);
	entry.write(Buffer.from("hello"));
	entry.write(Buffer.from("!"));
	entry.close();
	zip.finish();
	const bytes = Buffer.concat(parts);
	const contents = unzipSync(bytes);
	expect(strFromU8(contents["nested/café.txt"])).toBe("hello!");
	expect(contents["empty.txt"]).toHaveLength(0);
	const reader = await ZipReader.open(new Blob([bytes]));
	expect(await reader.text("nested/café.txt")).toBe("hello!");
	expect(zip.bytesWritten).toBe(bytes.length);
	const descriptor = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
	expect(bytes.readUInt32LE(descriptor + 4)).toBe(crc32(Buffer.from("hello!")));
});

it("blocks output whose size differs from its streamed header", () => {
	const zip = new ZipWriter(() => {});
	const entry = zip.addStream("test.txt", 2);
	entry.write(Buffer.from("A"));
	expect(() => entry.close()).toThrow("Incomplete ZIP entry");
	expect(() => entry.write(Buffer.from("BC"))).toThrow("exceeds its declared size");
	expect(() => zip.finish()).toThrow("Close the current ZIP entry");
});

it("uses a ZIP64 local size field at the 32-bit sentinel", () => {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((chunk) => parts.push(chunk));
	zip.addStream("large", 0xffffffff);
	const bytes = Buffer.concat(parts);
	expect(bytes.readUInt16LE(4)).toBe(45);
	expect(bytes.readUInt32LE(18)).toBe(0xffffffff);
	expect(bytes.readUInt16LE(28)).toBe(20);
	expect(bytes.readBigUInt64LE(39)).toBe(0xffffffffn);
});

it("keeps output without a modified time byte-identical to before modified times existed", async () => {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((chunk) => parts.push(chunk.slice()));
	zip.add("a.txt", new TextEncoder().encode("hello ".repeat(100)), true);
	const s = zip.addStream("dir/café.bin", 5);
	s.write(new Uint8Array([1, 2, 3, 4, 5]));
	s.close();
	zip.addStream("empty", 0).close();
	zip.finish();
	const digest = await crypto.subtle.digest("SHA-256", Buffer.concat(parts));
	expect(Buffer.from(digest).toString("hex")).toBe("d3343afe75c8f5a151e638f331e2a2c2ccc8d25b03c0a4566c79385397303d13");
});

it("writes DOS date/time and an extended-timestamp field for a modified time", async () => {
	const modified = new Date(2024, 6, 15, 13, 45, 31).getTime(); // local time, as DOS times are
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((chunk) => parts.push(chunk.slice()));
	const entry = zip.addStream("Trip/IMG_0001.jpg", 3, modified);
	entry.write(Buffer.from("abc"));
	entry.close();
	zip.addStream("plain.txt", 0).close();
	zip.finish();
	const bytes = Buffer.concat(parts);

	const dosTime = (13 << 11) | (45 << 5) | (31 >> 1);
	const dosDate = ((2024 - 1980) << 9) | (7 << 5) | 15;
	expect(bytes.readUInt16LE(10)).toBe(dosTime);
	expect(bytes.readUInt16LE(12)).toBe(dosDate);
	const nameLen = bytes.readUInt16LE(26);
	expect(bytes.readUInt16LE(28)).toBe(9);
	const extra = 30 + nameLen;
	expect(bytes.readUInt16LE(extra)).toBe(0x5455);
	expect(bytes.readUInt16LE(extra + 2)).toBe(5);
	expect(bytes[extra + 4]).toBe(1);
	expect(bytes.readUInt32LE(extra + 5)).toBe(Math.floor(modified / 1000));

	const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	expect(bytes.readUInt16LE(central + 12)).toBe(dosTime);
	expect(bytes.readUInt16LE(central + 14)).toBe(dosDate);
	expect(bytes.readUInt16LE(central + 30)).toBe(9);
	expect(bytes.readUInt16LE(central + 46 + nameLen)).toBe(0x5455);
	expect(bytes.readUInt32LE(central + 46 + nameLen + 5)).toBe(Math.floor(modified / 1000));
	// The entry without a time keeps the fixed 1980 date and no extra field.
	const second = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4);
	expect(bytes.readUInt16LE(second + 14)).toBe((1 << 5) | 1);
	expect(bytes.readUInt16LE(second + 30)).toBe(0);

	expect(strFromU8(unzipSync(bytes)["Trip/IMG_0001.jpg"])).toBe("abc");
	const reader = await ZipReader.open(new Blob([bytes]));
	expect(await reader.text("Trip/IMG_0001.jpg")).toBe("abc");
});

it("clamps modified times outside the DOS range to the fixed date", () => {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((chunk) => parts.push(chunk.slice()));
	zip.addStream("old", 0, Date.UTC(1975, 0, 1)).close();
	const bytes = Buffer.concat(parts);
	expect(bytes.readUInt16LE(10)).toBe(0);
	expect(bytes.readUInt16LE(12)).toBe((1 << 5) | 1);
	expect(bytes.readUInt32LE(30 + 3 + 5)).toBe(Math.floor(Date.UTC(1975, 0, 1) / 1000));
	expect(() => new ZipWriter(() => {}).addStream("bad", 0, Number.NaN)).toThrow("modified time");
});
