import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ZipReader } from "../../../lib/zipReader.ts";
import { crc32, ZipWriter } from "../../../lib/zipWriter.ts";
import type { ManifestFile } from "../types.ts";
import { planZip, ZipFeed } from "./zipFeed.ts";
import { type ZipEntrySpec, zipSize } from "./zipSize.ts";

const MAX32 = 0xffffffff;

/** Deterministic bytes. */
function bytesOf(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0, x = seed; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

/** Writes `entries` with ZipWriter.addStream; returns the archive (data from `bytesOf`). */
function writeZip(entries: ZipEntrySpec[]): Uint8Array {
	const parts: Uint8Array[] = [];
	const zip = new ZipWriter((c) => parts.push(c.slice()));
	entries.forEach((e, k) => {
		const s = zip.addStream(e.name, e.size, e.modified);
		const data = bytesOf(e.size, k + 1);
		// Uneven chunks, as lanes deliver them.
		for (let at = 0; at < data.length; at += 7777) s.write(data.subarray(at, at + 7777));
		s.close();
	});
	zip.finish();
	return Buffer.concat(parts);
}

/** CRC32 of each entry from the central directory (small, non-ZIP64 archives). */
function centralCrcs(bytes: Uint8Array): Map<string, number> {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocd = bytes.length - 22;
	const count = v.getUint16(eocd + 10, true);
	let p = v.getUint32(eocd + 16, true);
	const out = new Map<string, number>();
	for (let i = 0; i < count; i++) {
		const nameLen = v.getUint16(p + 28, true);
		const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
		out.set(name, v.getUint32(p + 16, true));
		p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
	}
	return out;
}

const when = Date.UTC(2023, 4, 6, 7, 8, 9);

const shapes: Record<string, ZipEntrySpec[]> = {
	empty: [],
	"one empty file": [{ name: "zero.txt", size: 0 }],
	"one empty file with a time": [{ name: "zero.txt", size: 0, modified: when }],
	"one byte": [{ name: "a", size: 1 }],
	"unicode names": [
		{ name: "Ünïcødé café ☕.txt", size: 33, modified: when },
		{ name: "日本語/写真.jpg", size: 1000 },
		{ name: "emoji 😀/🎉.bin", size: 2, modified: 0 },
	],
	"nested folders, mixed times": [
		{ name: "Trip/Day 1/IMG_0001.CR3", size: 70_000, modified: when },
		{ name: "Trip/Day 1/IMG_0002.CR3", size: 0, modified: when },
		{ name: "Trip/Day 2/clip.mp4", size: 123_457 },
		{ name: "Trip/notes.txt", size: 5, modified: when + 1000 },
		{ name: "readme", size: 256 * 1024 - 16 },
	],
	"long name": [{ name: `${"x".repeat(400)}.jpg`, size: 10, modified: when }],
};

describe("zipSize", () => {
	for (const [label, entries] of Object.entries(shapes)) {
		it(`matches ZipWriter output: ${label}`, async () => {
			const bytes = writeZip(entries);
			expect(zipSize(entries)).toBe(bytes.length);
			// And the archive reads back with the repo's reader and fflate, CRCs included.
			const reader = await ZipReader.open(new Blob([bytes as Uint8Array<ArrayBuffer>]));
			const files = unzipSync(bytes);
			const crcs = centralCrcs(bytes);
			for (const [k, e] of entries.entries()) {
				const expected = bytesOf(e.size, k + 1);
				expect(await reader.bytes(e.name)).toEqual(expected);
				expect(files[e.name]).toEqual(expected);
				expect(crcs.get(e.name)).toBe(crc32(expected));
			}
		});
	}

	it("matches with 65,535+ entries (ZIP64 end records)", async () => {
		const entries = Array.from({ length: 0xffff + 3 }, (_, i) => ({
			name: `f/${i}`,
			size: i % 3,
			...(i % 2 ? { modified: when } : {}),
		}));
		const bytes = writeZip(entries);
		expect(zipSize(entries)).toBe(bytes.length);
		const reader = await ZipReader.open(new Blob([bytes as Uint8Array<ArrayBuffer>]));
		expect(reader.entries.size).toBe(entries.length);
		expect(await reader.bytes("f/65537")).toEqual(bytesOf(65537 % 3, 65538));
	});

	it("does the ZIP64 math for declared sizes and offsets of 4 GiB and more", () => {
		const name = (n: number) => `n${n}`;
		// Sizes at and around the 32-bit sentinel; offsets cross it after the first big entry.
		const big: ZipEntrySpec[] = [
			{ name: name(0), size: 10 },
			{ name: name(1), size: MAX32 - 1 },
			{ name: name(2), size: MAX32, modified: when },
			{ name: name(3), size: 0 },
			{ name: name(4), size: 5 * 2 ** 30, modified: when },
		];
		// Expected by hand from the writer's layout:
		let offset = 0;
		let central = 0;
		for (const e of big) {
			const z = e.size >= MAX32;
			const t = e.modified === undefined ? 0 : 9;
			const zOff = offset >= MAX32;
			offset += 30 + e.name.length + (z ? 20 : 0) + t + e.size + (z ? 24 : 16);
			central += 46 + e.name.length + (z || zOff ? 4 + (z ? 16 : 0) + (zOff ? 8 : 0) : 0) + t;
		}
		expect(zipSize(big)).toBe(offset + central + 76 + 22);
	});

	it("matches real output with a 4 GiB entry and offsets beyond it", async () => {
		// One entry of exactly 0xffffffff bytes: ZIP64 sizes for it, ZIP64 offsets for every later entry.
		const zero = new Uint8Array(64 << 20);
		const segments: Array<{ at: number; bytes: Uint8Array | null; len: number }> = [];
		let total = 0;
		const zip = new ZipWriter((c) => {
			segments.push({ at: total, bytes: c === zero || c.buffer === zero.buffer ? null : c.slice(), len: c.length });
			total += c.length;
		});
		const entries: ZipEntrySpec[] = [
			{ name: "before.txt", size: 3, modified: when },
			{ name: "huge.bin", size: MAX32, modified: when },
			{ name: "after/1.txt", size: 4 },
			{ name: "after/2.txt", size: 0, modified: when },
		];
		for (const e of entries) {
			const s = zip.addStream(e.name, e.size, e.modified);
			if (e.name === "huge.bin") {
				for (let left = e.size; left > 0; left -= zero.length) s.write(zero.subarray(0, Math.min(left, zero.length)));
			} else if (e.size) s.write(new TextEncoder().encode(e.name.slice(0, e.size)));
			s.close();
		}
		zip.finish();
		expect(zipSize(entries)).toBe(total);

		// A sparse Blob over the output, so ZipReader can open it without 4 GiB in memory.
		const sparse = {
			size: total,
			slice(start: number, end: number) {
				const out = new Uint8Array(Math.max(0, Math.min(end, total) - start));
				for (const s of segments) {
					if (!s.bytes || s.at + s.len <= start || s.at >= end) continue;
					const from = Math.max(start, s.at);
					const to = Math.min(end, s.at + s.len);
					out.set(s.bytes.subarray(from - s.at, to - s.at), from - start);
				}
				return new Blob([out]);
			},
		} as unknown as Blob;
		const reader = await ZipReader.open(sparse);
		expect(reader.entries.get("huge.bin")?.size).toBe(MAX32);
		expect(reader.entries.get("after/1.txt")?.offset).toBeGreaterThan(MAX32);
		expect(await reader.text("after/1.txt")).toBe("afte");
		expect(await reader.text("before.txt")).toBe("bef");
		expect(await reader.text("after/2.txt")).toBe("");
	}, 120_000);
});

describe("ZipFeed", () => {
	const manifest: ManifestFile[] = [
		{ i: 0, path: "Trip/a.jpg", size: 5, mtime: when },
		{ i: 1, path: "Trip/empty", size: 0, mtime: when },
		{ i: 2, path: "../Trip/a.jpg", size: 3, mtime: 0 },
		{ i: 3, path: "z.txt", size: 0, mtime: when },
	];

	it("writes the planned archive from in-order writes, empty files included", async () => {
		const plan = planZip(manifest);
		expect(plan.entries.map((e) => e.name)).toEqual(["Trip/a.jpg", "Trip/empty", "Trip/a (2).jpg", "z.txt"]);
		expect(plan.entries[2].modified).toBeUndefined();
		const parts: Uint8Array[] = [];
		const feed = new ZipFeed(plan, (c) => parts.push(c.slice()));
		feed.write(0, 0, Buffer.from("hel"));
		feed.write(0, 1, Buffer.from("ello")); // overlaps what is already written: the dup is dropped
		feed.write(2, 0, Buffer.from("xyz")); // closes 0, writes the empty 1
		feed.finishFile(2);
		feed.finishFile(0); // already closed: ignored
		feed.finish(); // writes the empty 3
		const bytes = Buffer.concat(parts);
		expect(bytes.length).toBe(plan.length);
		const reader = await ZipReader.open(new Blob([bytes]));
		expect(await reader.text("Trip/a.jpg")).toBe("hello");
		expect(await reader.text("Trip/a (2).jpg")).toBe("xyz");
		expect(await reader.text("Trip/empty")).toBe("");
		expect(await reader.text("z.txt")).toBe("");
	});

	it("rejects gaps, skipped files, overruns and early ends as protocol errors", () => {
		const feed = () => new ZipFeed(planZip(manifest), () => {});
		expect(() => feed().write(0, 1, Buffer.from("x"))).toThrow(expect.objectContaining({ code: "protocol" }));
		expect(() => feed().write(2, 0, Buffer.from("x"))).toThrow(expect.objectContaining({ code: "protocol" }));
		expect(() => feed().write(0, 0, Buffer.from("toolong"))).toThrow(expect.objectContaining({ code: "protocol" }));
		expect(() => feed().write(9, 0, Buffer.from("x"))).toThrow(expect.objectContaining({ code: "protocol" }));
		const f = feed();
		f.write(0, 0, Buffer.from("he"));
		expect(() => f.finishFile(0)).toThrow(expect.objectContaining({ code: "protocol" }));
		expect(() => planZip([{ i: 1, path: "a", size: 0, mtime: 0 }])).toThrow(
			expect.objectContaining({ code: "protocol" }),
		);
	});
});
