import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { compileSevenZip, memoryArchive } from "../../../../e2e/archives.ts";
import type { Archive } from "../engine/listing.ts";
import { archiveEngine } from "../engine/sevenzip.ts";
import { type CreateSource, createArchive, positionedBatcher, SOURCE } from "./engine.ts";
import type { CreateOptions } from "./options.ts";

// Made-up contents: a nested folder, a non-ASCII name, an empty file and folder,
// and a block of pseudo-random bytes that doesn't compress.
const random = new Uint8Array(300_000);
for (let i = 0, x = 7; i < random.length; i++) {
	x = (x * 1103515245 + 12345) >>> 0;
	random[i] = x >>> 23;
}
const files: Record<string, Uint8Array> = {
	"readme.txt": new TextEncoder().encode("A made-up note.\n".repeat(200)),
	"Trip/day 1/lighthouse.txt": new TextEncoder().encode("The lamp turns every nine seconds.\n"),
	"Trip/Ünïcødé café ☕.txt": new TextEncoder().encode("Grüße aus Köln\n"),
	"Trip/noise.bin": random,
	"zero.txt": new Uint8Array(),
};

function memorySource(broken?: string): CreateSource {
	return {
		mount({ FS }) {
			FS.mkdir(SOURCE);
			FS.mkdir(`${SOURCE}/Trip`);
			FS.mkdir(`${SOURCE}/Trip/day 1`);
			FS.mkdir(`${SOURCE}/Empty folder`);
			for (const [path, data] of Object.entries(files)) FS.writeFile(`${SOURCE}/${path}`, data);
			if (broken) {
				const node = FS.lookupPath(`${SOURCE}/${broken}`, {}).node as unknown as { stream_ops: object };
				node.stream_ops = {
					...node.stream_ops,
					read() {
						throw new DOMException("The file could not be read.", "NotReadableError");
					},
				};
			}
		},
	};
}

describe("creating archives", () => {
	let compiled: WebAssembly.Module;
	beforeAll(async () => {
		compiled = await compileSevenZip();
	});

	async function create(options: CreateOptions, source = memorySource()) {
		const out = new Uint8Array(4 << 20);
		let progress = 0;
		const { size } = await createArchive(compiled, source, options, {
			write(position, chunk) {
				out.set(chunk, position);
			},
			truncate(length) {
				out.fill(0, length);
			},
			progress(bytes) {
				progress = bytes;
			},
		});
		return { bytes: out.slice(0, size), progress };
	}

	async function unpack(name: string, bytes: Uint8Array, password: string) {
		const engine = archiveEngine(compiled);
		const source = memoryArchive(name, bytes);
		const archive: Archive = await engine.list(source, name, password);
		const result: Record<string, Uint8Array> = {};
		const parts: Uint8Array[] = [];
		let path = "";
		const wanted = new Set(archive.entries.flatMap((entry, i) => (entry.folder ? [] : [i])));
		await engine.extract(source, archive, password, wanted, {
			start(i) {
				path = archive.entries[i].path;
				parts.length = 0;
			},
			write(chunk) {
				parts.push(new Uint8Array(chunk));
			},
			end() {
				result[path] = new Uint8Array(Buffer.concat(parts));
			},
		});
		const folders = archive.entries.filter((entry) => entry.folder).map((entry) => entry.path.replace(/\/$/, ""));
		return { archive, result, folders };
	}

	it.each<[CreateOptions["format"], CreateOptions["level"], string]>([
		["zip", "normal", ""],
		["zip", "store", ""],
		["zip", "max", "correct horse"],
		["7z", "fast", ""],
		["7z", "normal", "correct horse"],
		["tar.gz", "normal", ""],
	])("round-trips %s (%s, password %j) byte for byte", async (format, level, password) => {
		const { bytes, progress } = await create({ format, level, password });
		expect(progress).toBe(Object.values(files).reduce((sum, data) => sum + data.length, 0));
		const name = `made-up.${format}`;
		if (password) await expect(unpack(name, bytes, "")).rejects.toThrow(/NEEDS_PASSWORD/);
		if (format === "7z" && password) await expect(unpack(name, bytes, "wrong")).rejects.toThrow("WRONG_PASSWORD");
		const { archive, result, folders } = await unpack(name, bytes, password);
		expect(Object.keys(result).sort()).toEqual(Object.keys(files).sort());
		for (const [path, data] of Object.entries(files)) expect(Buffer.compare(result[path], data), path).toBe(0);
		expect(folders).toContain("Empty folder");
		if (password) expect(archive.entries.filter((e) => !e.folder && e.size > 0).every((e) => e.encrypted)).toBe(true);
		if (format === "tar.gz") expect(gunzipSync(bytes).length % 512).toBe(0);
	});

	it("marks non-ASCII ZIP names as UTF-8", async () => {
		const { bytes } = await create({ format: "zip", level: "fast", password: "" });
		const view = new DataView(bytes.buffer);
		const names: [string, number][] = [];
		for (let at = 0; at + 46 < bytes.length; at++) {
			if (view.getUint32(at, true) !== 0x02014b50) continue;
			const length = view.getUint16(at + 28, true);
			names.push([new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)), view.getUint16(at + 8, true)]);
		}
		const unicode = names.find(([name]) => name.includes("café"));
		expect(unicode?.[0]).toBe("Trip/Ünïcødé café ☕.txt");
		expect((unicode?.[1] ?? 0) & 0x0800).toBe(0x0800);
	});

	it("stores 7z encrypted names so listing needs the password", async () => {
		const { bytes } = await create({ format: "7z", level: "store", password: "pw" });
		await expect(archiveEngine(compiled).list(memoryArchive("a.7z", bytes), "a.7z", "")).rejects.toThrow(
			"NEEDS_PASSWORD",
		);
	});

	it("names a file that can't be read", async () => {
		await expect(
			create({ format: "zip", level: "fast", password: "" }, memorySource("Trip/day 1/lighthouse.txt")),
		).rejects.toThrow("UNREADABLE:Trip/day 1/lighthouse.txt");
	});
});

it("rewrites ZIP entries that don't compress and truncates the tail", async () => {
	const compiled = await compileSevenZip();
	const noise = new Uint8Array(randomBytes(6 << 20));
	const out = new Uint8Array(16 << 20);
	let truncated = -1;
	const { size } = await createArchive(
		compiled,
		{
			mount({ FS }) {
				FS.mkdir(SOURCE);
				FS.writeFile(`${SOURCE}/a.bin`, noise);
				FS.writeFile(`${SOURCE}/b.bin`, noise);
			},
		},
		{ format: "zip", level: "fast", password: "" },
		{
			write: (position, chunk) => out.set(chunk, position),
			truncate(length) {
				truncated = length;
				out.fill(0, length);
			},
		},
	);
	expect(truncated).toBeGreaterThan(0);
	const bytes = out.slice(0, size);
	const engine = archiveEngine(compiled);
	const source = memoryArchive("n.zip", bytes);
	const archive = await engine.list(source, "n.zip", "");
	expect(archive.entries.map((entry) => [entry.path, entry.size])).toEqual([
		["a.bin", noise.length],
		["b.bin", noise.length],
	]);
	const parts: Uint8Array[] = [];
	await engine.extract(source, archive, "", new Set([1]), {
		start() {},
		write: (chunk) => parts.push(new Uint8Array(chunk)),
		end() {},
	});
	expect(Buffer.compare(Buffer.concat(parts), noise)).toBe(0);
});

it("coalesces contiguous writes and keeps positioned patches", () => {
	const writes: [number, number[]][] = [];
	const batch = positionedBatcher((position, data) => writes.push([position, [...data]]), 4);
	batch.write(0, new Uint8Array([1, 2]));
	batch.write(2, new Uint8Array([3, 4, 5, 6, 7]));
	batch.write(7, new Uint8Array([8]));
	batch.write(0, new Uint8Array([9]));
	batch.flush();
	expect(writes).toEqual([
		[0, [1, 2, 3, 4]],
		[4, [5, 6, 7, 8]],
		[0, [9]],
	]);
});
