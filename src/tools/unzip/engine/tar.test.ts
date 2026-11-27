import { expect, it } from "vitest";
import type { Entry } from "./listing.ts";
import { isTarHeader, tarReader } from "./tar.ts";

function tarEntry(name: string, body: string, type = "0", prefix = "") {
	const data = Buffer.from(body);
	const entry = Buffer.alloc(512 + Math.ceil(data.length / 512) * 512);
	entry.write(name, 0, 100);
	entry.write(data.length.toString(8).padStart(11, "0"), 124);
	entry.fill(0x20, 148, 156);
	entry.write(type, 156);
	entry.write("ustar", 257);
	entry.write(prefix, 345);
	const checksum = entry.subarray(0, 512).reduce((sum, next) => sum + next, 0);
	entry.write(checksum.toString(8).padStart(6, "0"), 148);
	data.copy(entry, 512);
	return entry;
}

function paxRecord(field: string) {
	const body = ` ${field}\n`;
	let length = Buffer.byteLength(body) + 1;
	while (length !== Buffer.byteLength(body) + String(length).length)
		length = Buffer.byteLength(body) + String(length).length;
	return `${length}${body}`;
}

it("reads USTAR prefixes, local PAX overrides and GNU names across arbitrary chunks", () => {
	const data = Buffer.concat([
		tarEntry("one.txt", "first", "0", "outer/inner"),
		tarEntry("PaxHeaders/file", paxRecord("path=sub/é.txt") + paxRecord("mtime=1577836800.125"), "x"),
		tarEntry("file", "second"),
		tarEntry("././@LongLink", `${"a".repeat(160)}.txt\0`, "L"),
		tarEntry("short.txt", "third"),
		tarEntry("link.txt", "", "2"),
		tarEntry("empty", "", "5"),
		Buffer.alloc(1024),
	]);
	const entries: Entry[] = [];
	const bodies: string[] = [];
	const reader = tarReader({
		start(entry) {
			entries.push(entry);
			bodies.push("");
		},
		write(chunk) {
			bodies[bodies.length - 1] += Buffer.from(chunk).toString();
		},
		end() {},
	});
	expect(isTarHeader(data.subarray(0, 512))).toBe(true);
	for (let i = 0; i < data.length; i += 73) reader.write(data.subarray(i, i + 73));
	reader.finish();
	expect(entries.map((e) => e.path)).toEqual(["outer/inner/one.txt", "sub/é.txt", `${"a".repeat(160)}.txt`, "empty"]);
	expect(entries[1].modified).toBe("2020-01-01T00:00:00.125Z");
	expect(entries[3].folder).toBe(true);
	expect(bodies).toEqual(["first", "second", "third", ""]);
});

it("rejects truncated contents and bad checksums", () => {
	const data = tarEntry("hello.txt", "some file");
	const sink = { start() {}, write() {}, end() {} };
	const truncated = tarReader(sink);
	truncated.write(data.subarray(0, 514));
	expect(() => truncated.finish()).toThrow("Incomplete TAR archive");
	data[0] = 0x41;
	expect(() => tarReader(sink).write(data)).toThrow("Invalid TAR header");
});
