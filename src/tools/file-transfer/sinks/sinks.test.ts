import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ZipReader } from "../../../lib/zipReader.ts";
import { createEngine } from "../engine/engine.ts";
import { SessionPair } from "../engine/fakes.ts";
import { checkTuning, DEFAULT_TUNING, type Tuning } from "../tuning.ts";
import { acceptMode, type BatchProgress, type ManifestFile, type ReceivedFile, type ReceiveSink } from "../types.ts";
import { createFolderSink } from "./folder.ts";
import { createMemorySink, fitsInMemory } from "./memory.ts";
import { createTestSink } from "./test.ts";
import { planZip } from "./zipFeed.ts";
import { createZipStreamSink } from "./zipStream.ts";

const when = Date.UTC(2022, 1, 3, 4, 5, 6);

function bytesOf(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0, x = seed; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

const manifest: ManifestFile[] = [
	{ i: 0, path: "Trip/Day 1/IMG_0001.jpg", size: 300_000, mtime: when },
	{ i: 1, path: "Trip/empty.txt", size: 0, mtime: when },
	{ i: 2, path: "Trip/Day 1/IMG_0001.jpg", size: 10, mtime: when },
	{ i: 3, path: "Ünïcødé ☕.txt", size: 1, mtime: when },
	{ i: 4, path: "../../evil/CON.txt", size: 70_000, mtime: 0 },
];
const contents = manifest.map((f) => bytesOf(f.size, f.i + 7));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Feeds every file in stream order, in uneven chunks, the way the ordered receiver does. */
async function feedOrdered(sink: ReceiveSink, files = manifest, chunk = 65_536 + 3) {
	await sink.begin(files);
	for (const f of files) {
		for (let at = 0; at < f.size; at += chunk) await sink.write(f.i, at, contents[f.i].subarray(at, at + chunk));
		await sink.finishFile(f.i);
	}
	return sink.finish();
}

/** Ranges of every file, interleaved across files and out of order within them, as lanes deliver them. */
async function feedUnordered(sink: ReceiveSink, skip: number[], chunk = 40_000) {
	const ranges: Array<[number, number]> = [];
	for (const f of manifest) {
		if (skip.includes(f.i)) continue;
		for (let at = 0; at < f.size; at += chunk) ranges.push([f.i, at]);
	}
	// Deterministic shuffle.
	for (let i = ranges.length - 1, x = 3; i > 0; i--) {
		x = (x * 1103515245 + 12345) >>> 0;
		const j = x % (i + 1);
		[ranges[i], ranges[j]] = [ranges[j], ranges[i]];
	}
	for (const [file, at] of ranges) {
		await sink.write(file, at, contents[file].subarray(at, at + chunk));
		// A requeued duplicate now and then: folder writes are idempotent.
		if (at % (chunk * 3) === 0) await sink.write(file, at, contents[file].subarray(at, at + chunk));
	}
	for (const f of manifest) if (!skip.includes(f.i)) await sink.finishFile(f.i);
	return sink.finish();
}

const names = [
	"Trip/Day 1/IMG_0001.jpg",
	"Trip/empty.txt",
	"Trip/Day 1/IMG_0001 (2).jpg",
	"Ünïcødé ☕.txt",
	"evil/_CON.txt",
];

describe("memory sink", () => {
	it("builds the planned zip and saves it as one download", async () => {
		const saved: Array<{ blob: Blob; name: string }> = [];
		const sink = createMemorySink(
			{ peerName: "Calm Otter", batch: 1 },
			{ save: (blob, name) => saved.push({ blob, name }) },
		);
		expect(sink.ordered).toBe(true);
		expect(acceptMode(sink)).toBe("memory");
		expect(await feedOrdered(sink)).toEqual({ location: "Photos from Calm Otter.zip" });
		expect(saved).toHaveLength(1);
		expect(saved[0].name).toBe("Photos from Calm Otter.zip");
		expect(saved[0].blob.size).toBe(planZip(manifest).length);
		const reader = await ZipReader.open(saved[0].blob);
		expect([...reader.entries.keys()]).toEqual(names);
		for (const f of manifest) expect(await reader.bytes(names[f.i])).toEqual(contents[f.i]);
	});

	it("refuses batches over memoryMax with too-big", async () => {
		const sink = createMemorySink({ peerName: "x", batch: 1 }, { max: 100_000 });
		await expect(sink.begin(manifest)).rejects.toMatchObject({ code: "too-big" });
		expect(fitsInMemory(manifest, 370_011)).toBe(true);
		expect(fitsInMemory(manifest, 370_010)).toBe(false);
	});
});

describe("zip stream sink", () => {
	it("falls back to the memory sink where the service worker stream can't run", async () => {
		const saved: Blob[] = [];
		const sink = createZipStreamSink({ peerName: "Calm/Otter", batch: 2 }, { memory: { save: (b) => saved.push(b) } });
		expect(sink.mode).toBe("zip");
		expect(await feedOrdered(sink)).toEqual({ location: "Photos from Calm_Otter.zip" });
		expect(sink.mode).toBe("memory");
		expect(acceptMode(sink)).toBe("memory");
		const reader = await ZipReader.open(saved[0]);
		expect(await reader.bytes(names[0])).toEqual(contents[0]);
	});

	it("fails with zip-unsupported when the fallback is off", async () => {
		const sink = createZipStreamSink({ peerName: "x", batch: 1 }, { fallback: false });
		await expect(sink.begin(manifest)).rejects.toMatchObject({ code: "zip-unsupported" });
	});
});

describe("test sink", () => {
	it("hashes every file, unordered by default", async () => {
		const received: ReceivedFile[] = [];
		const sink = createTestSink({ received, ordered: false });
		expect(acceptMode(sink)).toBe("folder");
		await sink.begin(manifest);
		await feedUnordered(sink, []);
		expect(received.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
			manifest
				.map((f) => ({ path: names[f.i], size: f.size, sha256: sha(contents[f.i]) }))
				.sort((a, b) => a.path.localeCompare(b.path)),
		);
	});

	it("checks stream order when ordered", async () => {
		const received: ReceivedFile[] = [];
		const sink = createTestSink({ received, ordered: true });
		expect(acceptMode(sink)).toBe("zip");
		await feedOrdered(sink);
		expect(received.map((r) => r.sha256)).toEqual(manifest.map((f) => sha(contents[f.i])));

		const strict = createTestSink({ received: [], ordered: true });
		await strict.begin(manifest);
		await strict.write(0, 0, contents[0].subarray(0, 10));
		await expect(strict.write(0, 20, contents[0].subarray(20, 30))).rejects.toMatchObject({ code: "protocol" });
		await expect(strict.write(2, 0, contents[2])).rejects.toMatchObject({ code: "protocol" });
	});
});

/* ---------- an in-memory File System Access fake for the folder sink */

const dom = (name: string) => new DOMException(name, name);

class FakeFile {
	readonly kind = "file";
	readonly name: string;
	data: Uint8Array;
	opened = 0;
	writes = 0;
	constructor(name: string, data: Uint8Array = new Uint8Array(0)) {
		this.name = name;
		this.data = data;
	}
	async getFile() {
		return new File([this.data as Uint8Array<ArrayBuffer>], this.name);
	}
	async createWritable({ keepExistingData = false } = {}) {
		this.opened++;
		let swap = keepExistingData ? this.data.slice() : new Uint8Array(0);
		const file = this;
		return {
			async write(chunk: { type: "write"; position: number; data: Uint8Array }) {
				file.writes++;
				const end = chunk.position + chunk.data.length;
				if (end > swap.length) {
					const grown = new Uint8Array(end);
					grown.set(swap);
					swap = grown;
				}
				swap.set(chunk.data, chunk.position);
			},
			async close() {
				file.data = swap;
				FakeDir.open--;
			},
			async abort() {
				FakeDir.open--;
			},
		};
	}
}

class FakeDir {
	static open = 0;
	static maxOpen = 0;
	readonly kind = "directory";
	readonly children = new Map<string, FakeDir | FakeFile>();
	readonly name: string;
	constructor(name: string) {
		this.name = name;
	}
	async getDirectoryHandle(name: string, { create = false } = {}) {
		const hit = this.children.get(name.toLowerCase());
		if (hit instanceof FakeDir) return hit;
		if (hit) throw dom("TypeMismatchError");
		if (!create) throw dom("NotFoundError");
		const dir = new FakeDir(name);
		this.children.set(name.toLowerCase(), dir);
		return dir;
	}
	async getFileHandle(name: string, { create = false } = {}): Promise<object> {
		const hit = this.children.get(name.toLowerCase());
		if (hit instanceof FakeFile) {
			const real = hit;
			return {
				...real,
				getFile: () => real.getFile(),
				createWritable: async (o?: { keepExistingData?: boolean }) => {
					FakeDir.open++;
					FakeDir.maxOpen = Math.max(FakeDir.maxOpen, FakeDir.open);
					return real.createWritable(o);
				},
			};
		}
		if (hit) throw dom("TypeMismatchError");
		if (!create) throw dom("NotFoundError");
		this.children.set(name.toLowerCase(), new FakeFile(name));
		return this.getFileHandle(name);
	}
	at(path: string): FakeDir | FakeFile | undefined {
		let node: FakeDir | FakeFile | undefined = this;
		for (const part of path.split("/"))
			node = node instanceof FakeDir ? node.children.get(part.toLowerCase()) : undefined;
		return node;
	}
	put(path: string, data: Uint8Array) {
		const parts = path.split("/");
		let dir: FakeDir = this;
		for (const part of parts.slice(0, -1)) {
			const next = dir.children.get(part.toLowerCase()) ?? new FakeDir(part);
			dir.children.set(part.toLowerCase(), next);
			dir = next as FakeDir;
		}
		const name = parts[parts.length - 1];
		dir.children.set(name.toLowerCase(), new FakeFile(name, data));
	}
}

const asRoot = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;

describe("folder sink", () => {
	it("writes every file at its sanitized path from out-of-order ranges, coalescing writes", async () => {
		FakeDir.maxOpen = 0;
		const root = new FakeDir("Pictures");
		const sink = createFolderSink(asRoot(root), { coalesce: 100_000 });
		expect(sink.ordered).toBe(false);
		expect(acceptMode(sink)).toBe("folder");
		const { skip } = await sink.begin(manifest);
		expect(skip).toEqual([]);
		expect(await feedUnordered(sink, skip)).toEqual({ location: "Pictures" });
		for (const f of manifest) {
			const node = root.at(names[f.i]);
			expect(node).toBeInstanceOf(FakeFile);
			expect((node as FakeFile).data).toEqual(contents[f.i]);
		}
		expect((root.at(names[0]) as FakeFile).opened).toBe(1);
	});

	it("keeps at most maxOpenFiles writables open", async () => {
		FakeDir.open = 0;
		FakeDir.maxOpen = 0;
		const root = new FakeDir("P");
		await feedOrdered(createFolderSink(asRoot(root), { maxOpenFiles: 1 }));
		expect(FakeDir.maxOpen).toBe(1);
		for (const f of manifest) expect((root.at(names[f.i]) as FakeFile).data).toEqual(contents[f.i]);
		// Contiguous chunks are joined: 300,000 bytes in 65 KiB chunks become one write.
		expect((root.at(names[0]) as FakeFile).writes).toBe(1);
	});

	it("skips identical existing files and numbers clashing ones", async () => {
		const root = new FakeDir("Pictures");
		root.put("Trip/Day 1/IMG_0001.jpg", new Uint8Array(300_000)); // same size: skipped
		root.put("Trip/empty.txt", new Uint8Array(5)); // other size: "empty (1).txt"
		root.put("Trip/empty (1).txt", new Uint8Array(6)); // taken too: "empty (2).txt"
		root.put("Ünïcødé ☕.txt", new Uint8Array(1)); // same size: skipped
		const sink = createFolderSink(asRoot(root));
		const { skip } = await sink.begin(manifest);
		expect(skip).toEqual([0, 3]);
		expect(sink.skippedCount).toBe(2);
		expect(sink.targetOf(1)).toBe("Trip/empty (2).txt");
		await feedUnordered(sink, skip);
		expect((root.at("Trip/empty.txt") as FakeFile).data).toHaveLength(5);
		expect((root.at("Trip/empty (2).txt") as FakeFile).data).toHaveLength(0);
		expect((root.at("Trip/Day 1/IMG_0001 (2).jpg") as FakeFile).data).toEqual(contents[2]);
		expect((root.at("evil/_CON.txt") as FakeFile).data).toEqual(contents[4]);
		await expect(sink.write(0, 0, contents[0].subarray(0, 1))).rejects.toMatchObject({ code: "protocol" });
	});

	it("rejects writes past the end and reports file-system errors as sink errors", async () => {
		const root = new FakeDir("P");
		const sink = createFolderSink(asRoot(root));
		await sink.begin(manifest);
		await expect(sink.write(3, 0, new Uint8Array(2))).rejects.toMatchObject({ code: "protocol" });

		const blocked = new FakeDir("P");
		blocked.put("Trip", new Uint8Array(1)); // a file where a folder must go
		await expect(createFolderSink(asRoot(blocked)).begin(manifest)).rejects.toMatchObject({ code: "sink-error" });
	});

	it("abort discards files still being written", async () => {
		const root = new FakeDir("P");
		const sink = createFolderSink(asRoot(root), { coalesce: 1000 });
		await sink.begin(manifest);
		await sink.write(0, 0, contents[0].subarray(0, 5000));
		await sink.abort("cancelled");
		expect((root.at(names[0]) as FakeFile | undefined)?.data ?? new Uint8Array(0)).toHaveLength(0);
		await expect(sink.write(0, 5000, contents[0].subarray(5000, 6000))).rejects.toMatchObject({ code: "sink-error" });
	});
});

/* ---------- folder mode can't deadlock on its open-file limit (WP6) */

describe("folder sink open-file limit", () => {
	it("never makes a lane wait for a file that waits for a slot", async () => {
		// One lane, maxOpenFiles 1: file A takes the slot and still misses its tail, which comes on this
		// lane after B. B's first bytes overflow the buffer, so the lane waits for the disk. Before WP6 the
		// lane then waited for B's writable, which waited for A's slot, which waited for the lane.
		FakeDir.open = 0;
		FakeDir.maxOpen = 0;
		const root = new FakeDir("P");
		const files: ManifestFile[] = [
			{ i: 0, path: "a.bin", size: 20, mtime: 0 },
			{ i: 1, path: "b.bin", size: 40, mtime: 0 },
		];
		const data = files.map((f) => bytesOf(f.size, f.i + 1));
		const sink = createFolderSink(asRoot(root), { maxOpenFiles: 1, coalesce: 10, maxBuffered: 20 });
		await sink.begin(files);
		await sink.write(0, 0, data[0].subarray(0, 10));
		const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 2000));
		await Promise.race([sink.write(1, 0, data[1].subarray(0, 30)), timeout]);
		await sink.write(0, 10, data[0].subarray(10));
		await sink.write(1, 30, data[1].subarray(30));
		await Promise.all([sink.finishFile(0), sink.finishFile(1)]);
		await sink.finish();
		expect((root.at("a.bin") as FakeFile).data).toEqual(data[0]);
		expect((root.at("b.bin") as FakeFile).data).toEqual(data[1]);
		expect(FakeDir.open).toBe(0);
	});

	it("finishes a folder batch over 8 lanes with one slow lane and big files split in ranges", async () => {
		// The scheduler gives each big file up to maxWritersPerFile lanes; a slow lane can hold the tails of
		// many files whose heads arrived on fast lanes, so more files than maxOpenFiles can be half written.
		const KiB = 1024;
		const t: Tuning = {
			...DEFAULT_TUNING,
			lanes: 8,
			chunk: 8 * KiB,
			highWater: 64 * KiB,
			lowWater: 16 * KiB,
			laneWindow: 128 * KiB,
			ackEvery: 32 * KiB,
			readBlock: 32 * KiB,
			rangeMax: 256 * KiB,
			maxWritersPerFile: 2,
			coalesce: 32 * KiB,
			maxOpenFiles: 16,
		};
		checkTuning(t);
		FakeDir.open = 0;
		FakeDir.maxOpen = 0;
		const pair = new SessionPair(8, (i) =>
			i === 7 ? { delayMs: 150, bytesPerTick: 4 * KiB } : { bytesPerTick: 256 * KiB },
		);
		const a = createEngine(pair.a, t);
		const b = createEngine(pair.b, t);
		// 40 files just over one range: a 256 KiB head and a small tail each, plus a few whole ones.
		const sizes = Array.from({ length: 40 }, (_, i) => (i % 5 === 4 ? 100 * KiB + i : 256 * KiB + 1 + i));
		const send = sizes.map((n, i) => ({
			path: `Big/F${i}.bin`,
			file: new File([bytesOf(n, 100 + i) as Uint8Array<ArrayBuffer>], `F${i}.bin`),
		}));
		const root = new FakeDir("Pictures");
		const finals: Promise<BatchProgress>[] = [a, b].map(
			(e, k) =>
				new Promise((resolve) =>
					e.on((ev) => {
						if (ev.type === "offer" && k === 1)
							void b.accept(
								ev.offer.batch,
								createFolderSink(asRoot(root), { coalesce: t.coalesce, maxOpenFiles: 16, maxBuffered: 512 * KiB }),
							);
						if (ev.type === "progress" && ["done", "failed", "cancelled", "interrupted"].includes(ev.progress.phase))
							resolve(ev.progress);
					}),
				),
		);
		a.send(send);
		const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stalled")), 20_000));
		const [sent, received] = await Promise.race([Promise.all(finals), timeout]);
		expect(sent.phase).toBe("done");
		expect(received.phase).toBe("done");
		for (const [i, n] of sizes.entries())
			expect((root.at(`Big/F${i}.bin`) as FakeFile).data).toEqual(bytesOf(n, 100 + i));
		expect(FakeDir.open).toBe(0);
		a.dispose();
		b.dispose();
	}, 30_000);
});
