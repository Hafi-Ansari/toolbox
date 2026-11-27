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
