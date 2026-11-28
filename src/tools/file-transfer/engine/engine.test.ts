// Engine tests over fake lanes (SPEC §16.1): every byte arrives exactly once, backpressure holds,
// lane loss and out-of-order delivery, flow-control and protocol violations, both directions at once.
import { afterEach, describe, expect, it } from "vitest";
import { checkTuning, DEFAULT_TUNING, FRAME_HEADER_BYTES, MANIFEST_PART_FILES, type Tuning } from "../tuning.ts";
import {
	type BatchProgress,
	type CtrlOf,
	type EngineEvent,
	type IncomingOffer,
	parseAck,
	type SendFile,
	type TransferEngine,
} from "../types.ts";
import { createEngine, manifestParts } from "./engine.ts";
import { type FakeChannel, MemorySink, type MemorySinkOptions, type NetOptions, SessionPair } from "./fakes.ts";
import { encodeFrame } from "./frame.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

/** Small numbers so a few MiB exercise every path (several ranges per file, windows, reorder). */
const T: Tuning = {
	...DEFAULT_TUNING,
	lanes: 3,
	chunk: 16 * KiB,
	highWater: 256 * KiB,
	lowWater: 64 * KiB,
	laneWindow: 384 * KiB,
	ackEvery: 64 * KiB,
	readBlock: 128 * KiB,
	rangeMax: 1 * MiB,
	maxWritersPerFile: 2,
	zipRange: 128 * KiB,
	reorderWindow: 1 * MiB,
};
checkTuning(T);

function bytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(n);
	let x = seed * 2654435761 + 1;
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

const SIZES = [0, 1, 255 * KiB, 3 * MiB + 333, 500 * KiB, 0, 500 * KiB, 2 * MiB, 17];
function makeFiles(sizes = SIZES, seed = 1): SendFile[] {
	return sizes.map((n, i) => ({
		path: `Trip/Day ${i % 3}/IMG_${String(i).padStart(4, "0")}.CR3`,
		file: new File([bytes(n, seed + i)], `IMG_${i}.CR3`, { lastModified: 1_700_000_000_000 + i }),
	}));
}

interface Side {
	engine: TransferEngine;
	events: EngineEvent[];
	/** performance.now() of each event. */
	times: number[];
	/** Resolves with the final progress of a batch on this side. */
	final(side: "send" | "receive", batch: number): Promise<BatchProgress>;
	offer(): Promise<IncomingOffer>;
	progress(side: "send" | "receive", batch: number): BatchProgress[];
}

const FINAL = new Set(["done", "declined", "cancelled", "interrupted", "failed"]);
const engines: TransferEngine[] = [];
afterEach(() => {
	for (const e of engines.splice(0)) e.dispose();
});

function side(session: SessionPair["a"], t = T): Side {
	const engine = createEngine(session, t);
	engines.push(engine);
	const events: EngineEvent[] = [];
	const times: number[] = [];
	const waiters: Array<() => void> = [];
	engine.on((e) => {
		events.push(e);
		times.push(performance.now());
		for (const w of waiters.splice(0)) w();
	});
	const until = <V>(pick: () => V | undefined, ms = 20_000): Promise<V> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out")), ms);
			const check = () => {
				const v = pick();
				if (v !== undefined) {
					clearTimeout(timer);
					resolve(v);
				} else waiters.push(check);
			};
			check();
		});
	const progress = (s: "send" | "receive", batch: number) =>
		events.flatMap((e) =>
			e.type === "progress" && e.progress.side === s && e.progress.batch === batch ? [e.progress] : [],
		);
	return {
		engine,
		events,
		times,
		progress,
		final: (s, batch) => until(() => progress(s, batch).find((p) => FINAL.has(p.phase))),
		offer: () => until(() => events.flatMap((e) => (e.type === "offer" ? [e.offer] : []))[0]),
	};
}

function setup(lanes = 3, net: (i: number) => NetOptions = () => ({}), t = T) {
	const pair = new SessionPair(lanes, net);
	return { pair, a: side(pair.a, t), b: side(pair.b, t) };
}

function expectReceived(sink: MemorySink, files: SendFile[], skip: number[] = []) {
	expect(sink.errors).toEqual([]);
	return Promise.all(
		files.map(async (f, i) => {
			if (skip.includes(i)) return;
			const want = new Uint8Array(await f.file.arrayBuffer());
			expect(sink.data[i]?.byteLength, `file ${i}`).toBe(want.byteLength);
			expect(Buffer.from(sink.data[i] as Uint8Array).equals(Buffer.from(want)), `file ${i} bytes`).toBe(true);
		}),
	);
}

/** Sends `files` from a to b into a MemorySink; returns both final progresses. */
async function transfer(
	ctx: ReturnType<typeof setup>,
	files: SendFile[],
	sinkOpts: MemorySinkOptions = {},
	during?: (sink: MemorySink) => void,
) {
	const { a, b } = ctx;
	const batch = a.engine.send(files);
	const offer = await b.offer();
	expect(offer.batch).toBe(batch);
	const sink = new MemorySink(sinkOpts);
	await b.engine.accept(batch, sink);
	during?.(sink);
	const [sent, received] = await Promise.all([a.final("send", batch), b.final("receive", batch)]);
	return { batch, sink, sent, received };
}

const until = async (cond: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("condition timed out");
		await new Promise((r) => setTimeout(r, 1));
	}
};

describe("TransferEngine", () => {
	it("delivers every byte exactly once into an unordered sink", async () => {
		const ctx = setup();
		const files = makeFiles();
		const { sink, sent, received } = await transfer(ctx, files);
		await expectReceived(sink, files);
		const total = SIZES.reduce((n, s) => n + s, 0);
		for (const p of [sent, received]) {
			expect(p.phase).toBe("done");
			expect(p.mode).toBe("folder");
			expect(p.bytesDone).toBe(total);
			expect(p.filesDone).toBe(files.length);
			expect(p.error).toBeNull();
		}
		expect(received.location).toBe("memory");
		expect(sink.finished.slice().sort((x, y) => x - y)).toEqual(files.map((_, i) => i));
		// file-done for each file, then done.
		const fileDone = ctx.pair.b.sent.filter((m) => m.t === "file-done").map((m) => (m as CtrlOf<"file-done">).file);
		expect(fileDone.sort((x, y) => x - y)).toEqual(files.map((_, i) => i));
		expect(ctx.pair.b.sent.at(-1)).toEqual({ t: "done", batch: 1 });
		// All lanes carried data.
		for (const [, [ach]] of ctx.pair.channels) expect(ach.sentFrames).toBeGreaterThan(0);
	});

	it("feeds an ordered sink strictly in stream order despite out-of-order lanes", async () => {
		// Lane latencies differ, so ranges arrive out of order across lanes.
		const ctx = setup(4, (i) => ({ delayMs: [0, 7, 2, 13][i] ?? 0 }));
		const files = makeFiles();
		const { sink, sent, received } = await transfer(ctx, files, { ordered: true });
		await expectReceived(sink, files);
		expect(sent.mode).toBe("zip");
		expect(received.phase).toBe("done");
		expect(sink.finished).toEqual(files.map((_, i) => i)); // manifest order, empty files included
	});

	it("holds both levels of backpressure: bufferedAmount and the per-lane ack window", async () => {
		// Slow network drain and a slow sink.
		const ctx = setup(2, () => ({ bytesPerTick: 48 * KiB, delayMs: 1 }));
		const files = makeFiles([3 * MiB, 2 * MiB]);
		// Track sent-minus-acked payload bytes per lane on the sender side.
		const worst: number[] = [];
		for (const [i, [ach, bch]] of ctx.pair.channels) {
			let sent = 0;
			let acked = 0;
			worst[i] = 0;
			ach.onSend = (d) => {
				if (typeof d === "string") return;
				sent += d.byteLength - FRAME_HEADER_BYTES;
				worst[i] = Math.max(worst[i] as number, sent - acked);
			};
			bch.onSend = (d) => {
				if (typeof d === "string") acked = parseAck(d)?.w ?? acked;
			};
		}
		const { sink, received } = await transfer(ctx, files, { writeDelayMs: (n) => (n % 4 === 0 ? 1 : 0) });
		expect(received.phase).toBe("done");
		await expectReceived(sink, files);
		for (const [, [ach]] of ctx.pair.channels) expect(ach.maxBuffered).toBeLessThanOrEqual(T.highWater + T.chunk);
		for (const w of worst) expect(w).toBeLessThanOrEqual(T.laneWindow + T.chunk);
		expect(Math.max(...worst)).toBeGreaterThan(T.laneWindow / 2); // the window was actually reached
	});

	for (const ordered of [false, true]) {
		it(`survives losing a lane mid-transfer (${ordered ? "ordered" : "unordered"})`, async () => {
			const ctx = setup(3, (i) => ({ delayMs: i, bytesPerTick: 256 * KiB }));
			const files = makeFiles();
			const { sink, received, sent } = await transfer(
				ctx,
				files,
				{ ordered, writeDelayMs: (n) => (n % 8 === 0 ? 1 : 0) },
				(sink) => {
					void until(() => sink.writes > 40).then(() => ctx.pair.loseLane(2));
				},
			);
			expect(ctx.pair.channels.get(2)?.[0].readyState).toBe("closed");
			expect(received.phase).toBe("done");
			expect(sent.phase).toBe("done");
			await expectReceived(sink, files);
		});
	}

	it("ordered: hedges the head range when its lane stalls, so the others don't wait for it", async () => {
		// Lane 1 takes 4 s each way (an SCTP association in retransmission back-off). Without hedging,
		// every range it holds stops the zip stream for 4 s.
		const t = { ...T, hedgeMs: 150 };
		const ctx = setup(3, (i) => ({ delayMs: i === 1 ? 4000 : 0 }), t);
		const files = makeFiles([2 * MiB + 5, 700 * KiB, 0, 1]);
		const t0 = performance.now();
		const { sink, received } = await transfer(ctx, files, { ordered: true });
		const ms = performance.now() - t0;
		expect(received.phase).toBe("done");
		await expectReceived(sink, files);
		expect(ms).toBeLessThan(3500);
	});

	it("keeps frames within the session's SCTP max message size (§7.3)", async () => {
		const ctx = setup(2);
		ctx.pair.a.maxMessageSize = 8 * KiB; // below tuning.chunk (16 KiB here)
		let biggest = 0;
		for (const [, [ach]] of ctx.pair.channels)
			ach.onSend = (d) => {
				if (typeof d !== "string") biggest = Math.max(biggest, d.byteLength);
			};
		const files = makeFiles([300 * KiB, 1]);
		const { sink, received } = await transfer(ctx, files);
		expect(received.phase).toBe("done");
		await expectReceived(sink, files);
		expect(biggest).toBe(8 * KiB);
	});

	it("uses a lane that opens mid-transfer", async () => {
		const ctx = setup(1, () => ({ bytesPerTick: 128 * KiB }));
		const files = makeFiles([4 * MiB, 3 * MiB]);
		let late: FakeChannel | undefined;
		const { sink, received } = await transfer(ctx, files, {}, (sink) => {
			void until(() => sink.writes > 5).then(() => {
				late = ctx.pair.addLane(1, { bytesPerTick: 128 * KiB })[0];
			});
		});
		expect(received.phase).toBe("done");
		await expectReceived(sink, files);
		expect(late?.sentFrames).toBeGreaterThan(0);
	});

	it("runs a batch in each direction at once over the same lanes", async () => {
		const { a, b, pair } = setup(3, (i) => ({ delayMs: i * 2 }));
		const fa = makeFiles([2 * MiB, 700 * KiB, 0], 10);
		const fb = makeFiles([1 * MiB, 3 * MiB + 1], 20);
		const ba = a.engine.send(fa);
		const bb = b.engine.send(fb);
		expect(ba).toBe(1);
		expect(bb).toBe(1); // each side counts its own batches
		const [oa, ob] = await Promise.all([b.offer(), a.offer()]);
		const sa = new MemorySink();
		const sb = new MemorySink({ ordered: true });
		await Promise.all([b.engine.accept(oa.batch, sa), a.engine.accept(ob.batch, sb)]);
		const results = await Promise.all([
			a.final("send", 1),
			b.final("receive", 1),
			b.final("send", 1),
			a.final("receive", 1),
		]);
		for (const r of results) expect(r.phase).toBe("done");
		await expectReceived(sa, fa);
		await expectReceived(sb, fb);
		expect(pair.a.closed).toBe(false);
	});

	it("skips the files the sink already has", async () => {
		const ctx = setup();
		const files = makeFiles();
		const { sink, sent, received } = await transfer(ctx, files, { skip: [3, 7] });
		await expectReceived(sink, files, [3, 7]);
		expect(sink.data[3]?.every((x) => x === 0)).toBe(true);
		for (const p of [sent, received]) {
			expect(p.phase).toBe("done");
			expect(p.skipped).toBe(2);
		}
		expect(ctx.pair.b.sent.find((m) => m.t === "accept")).toMatchObject({ skip: [3, 7] });
	});

	it("finishes a batch of only empty or skipped files without any frames", async () => {
		const ctx = setup();
		const files = makeFiles([0, 0, 5]);
		const { sink, received } = await transfer(ctx, files, { skip: [2], ordered: true });
		expect(received.phase).toBe("done");
		expect(sink.finished).toEqual([0, 1]);
		for (const [, [ach]] of ctx.pair.channels) expect(ach.sentFrames).toBe(0);
	});

	it("splits big manifests into parts and reassembles them", async () => {
		const ctx = setup();
		const files = makeFiles(Array.from({ length: MANIFEST_PART_FILES * 2 + 7 }, (_, i) => i % 5));
		const batch = ctx.a.engine.send(files);
		const offer = await ctx.b.offer();
		expect(offer.count).toBe(files.length);
		expect(offer.files.map((f) => f.i)).toEqual(files.map((_, i) => i));
		expect(ctx.pair.a.sent.filter((m) => m.t === "manifest")).toHaveLength(3);
		const sink = new MemorySink();
		await ctx.b.engine.accept(batch, sink);
		expect((await ctx.b.final("receive", batch)).phase).toBe("done");
		await expectReceived(sink, files);
	});

	it("keeps manifest parts under 64 KiB even with long paths", () => {
		const long = "x".repeat(380);
		const files = Array.from({ length: 400 }, (_, i) => ({ i, path: `${long}/${i}`, size: 1, mtime: 0 }));
		const parts = manifestParts(1, files, 400);
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(JSON.stringify(p).length).toBeLessThanOrEqual(64 * 1024);
		expect(parts.flatMap((p) => p.files)).toHaveLength(400);
		expect(parts.map((p) => p.last)).toEqual(parts.map((_, i) => i === parts.length - 1));
	});

	it("declines", async () => {
		const { a, b } = setup();
		const batch = a.engine.send(makeFiles([10]));
		await b.offer();
		b.engine.decline(batch, "too-big");
		const [s, r] = await Promise.all([a.final("send", batch), b.final("receive", batch)]);
		expect(s).toMatchObject({ phase: "declined", declineReason: "too-big" });
		expect(r).toMatchObject({ phase: "declined", declineReason: "too-big" });
		// A new batch may follow.
		expect(a.engine.send(makeFiles([1]))).toBe(2);
	});

	it("refuses a second outgoing batch while one is active", async () => {
		const { a } = setup();
		a.engine.send(makeFiles([10]));
		expect(() => a.engine.send(makeFiles([10]))).toThrow();
		expect(() => a.engine.send([])).toThrow(RangeError);
	});

	it("cancels from the sender mid-transfer", async () => {
		const ctx = setup(2, () => ({ bytesPerTick: 64 * KiB }));
		const files = makeFiles([5 * MiB]);
		const batch = ctx.a.engine.send(files);
		await ctx.b.offer();
		const sink = new MemorySink();
		await ctx.b.engine.accept(batch, sink);
		await until(() => sink.writes > 3);
		ctx.a.engine.cancel("send", batch);
		const [s, r] = await Promise.all([ctx.a.final("send", batch), ctx.b.final("receive", batch)]);
		expect(s).toMatchObject({ phase: "cancelled", cancelledBy: "sender" });
		expect(r).toMatchObject({ phase: "cancelled", cancelledBy: "sender", error: null });
		await until(() => sink.aborted !== null);
		expect(sink.aborted).toBe("cancelled");
		expect(ctx.pair.a.closed).toBe(false); // the session stays up
		const writes = sink.writes;
		await new Promise((r) => setTimeout(r, 30));
		expect(sink.writes).toBe(writes);
	});

	it("cancels from the receiver mid-transfer", async () => {
		const ctx = setup(2, () => ({ bytesPerTick: 64 * KiB }));
		const batch = ctx.a.engine.send(makeFiles([5 * MiB]));
		await ctx.b.offer();
		const sink = new MemorySink();
		await ctx.b.engine.accept(batch, sink);
		await until(() => sink.writes > 3);
		ctx.b.engine.cancel("receive", batch);
		const [s, r] = await Promise.all([ctx.a.final("send", batch), ctx.b.final("receive", batch)]);
		expect(s).toMatchObject({ phase: "cancelled", cancelledBy: "receiver" });
		expect(r).toMatchObject({ phase: "cancelled", cancelledBy: "receiver" });
		expect(sink.aborted).toBe("cancelled");
	});

	it("ends every batch as interrupted when the session closes", async () => {
		const ctx = setup(2, () => ({ bytesPerTick: 64 * KiB }));
		const batch = ctx.a.engine.send(makeFiles([5 * MiB]));
		await ctx.b.offer();
		const sink = new MemorySink({ ordered: true });
		await ctx.b.engine.accept(batch, sink);
		await until(() => sink.writes > 3);
		ctx.pair.b.close();
		const [s, r] = await Promise.all([ctx.a.final("send", batch), ctx.b.final("receive", batch)]);
		expect(s.phase).toBe("interrupted");
		expect(r.phase).toBe("interrupted");
		await until(() => sink.aborted !== null);
		expect(sink.aborted).toBe("interrupted");
		expect(() => ctx.a.engine.send(makeFiles([1]))).toThrow();
	});

	it("fails both sides with sink-error when the sink throws", async () => {
		const ctx = setup();
		const batch = ctx.a.engine.send(makeFiles([2 * MiB]));
		await ctx.b.offer();
		const sink = new MemorySink({ failOnWrite: 5 });
		await ctx.b.engine.accept(batch, sink);
		const [s, r] = await Promise.all([ctx.a.final("send", batch), ctx.b.final("receive", batch)]);
		expect(r).toMatchObject({ phase: "failed", error: "sink-error" });
		expect(s).toMatchObject({ phase: "failed", error: "sink-error", cancelledBy: "receiver" });
		expect(sink.aborted).toBe("sink-error");
		expect(ctx.pair.a.closed).toBe(false);
	});

	it("fails both sides with read-error when a source file can't be read", async () => {
		const ctx = setup();
		const files = makeFiles([MiB, MiB]);
		const broken = files[1]?.file as File;
		Object.defineProperty(broken, "slice", {
			value: () => ({ arrayBuffer: () => Promise.reject(new DOMException("gone", "NotReadableError")) }),
		});
		const { sent, received } = await transfer(ctx, files);
		expect(sent).toMatchObject({ phase: "failed", error: "read-error" });
		expect(received).toMatchObject({ phase: "failed", error: "read-error", cancelledBy: "sender" });
	});

	it("emits progress at most every 250 ms while running", async () => {
		const ctx = setup(2, () => ({ bytesPerTick: 32 * KiB }));
		const { batch } = await transfer(ctx, makeFiles([8 * MiB]));
		const stamps = ctx.a.events.flatMap((e, i) =>
			e.type === "progress" && e.progress.side === "send" && e.progress.phase === "running"
				? [ctx.a.times[i] as number]
				: [],
		);
		expect(stamps.length).toBeGreaterThan(3);
		// Every running snapshot after the phase change is throttled.
		for (let i = 1; i < stamps.length; i++)
			expect((stamps[i] as number) - (stamps[i - 1] as number)).toBeGreaterThanOrEqual(240);
		const done = ctx.a.progress("send", batch).at(-1);
		expect(done?.endedAt).not.toBeNull();
		expect(done?.etaMs).toBe(0);
	});
});

describe("TransferEngine against a rogue sender", () => {
	/** b runs the engine; a is driven by hand. Returns b's side once the batch is accepted. */
	async function rogue(sizes: number[], sinkOpts: MemorySinkOptions = {}, lanes = 2) {
		const pair = new SessionPair(lanes);
		const b = side(pair.b);
		const files = sizes.map((size, i) => ({ i, path: `f${i}`, size, mtime: 0 }));
		pair.a.sendCtrl({
			t: "manifest",
			batch: 1,
			part: 0,
			last: true,
			files,
			count: files.length,
			total: sizes.reduce((n, s) => n + s, 0),
		});
		await b.offer();
		const sink = new MemorySink(sinkOpts);
		await b.engine.accept(1, sink);
		const ch = (i: number) => pair.channels.get(i)?.[0] as FakeChannel;
		const frame = (file: number, offset: number, len: number, batch = 1, dir: 0 | 1 = 1) =>
			encodeFrame({ dir, last: false, batch, file, offset }, new Uint8Array(len)).buffer;
		return { pair, b, sink, ch, frame };
	}

	it("cancels with protocol when the sender ignores flow control (unordered)", async () => {
		const { pair, b, ch, frame } = await rogue([64 * MiB], { writeDelayMs: 1000 });
		// Never wait for acks: far beyond lanes × (laneWindow + chunk).
		const limit = 2 * (T.laneWindow + T.chunk);
		const len = T.chunk - FRAME_HEADER_BYTES;
		for (let off = 0; off < limit * 2; off += len) ch(off % 2).send(frame(0, off, len));
		const r = await b.final("receive", 1);
		expect(r).toMatchObject({ phase: "failed", error: "flow-control" });
		await until(() => pair.a.received.some((m) => m.t === "cancel"));
		expect(pair.a.received.find((m) => m.t === "cancel")).toEqual({
			t: "cancel",
			batch: 1,
			by: "receiver",
			reason: "protocol",
		});
		expect(pair.b.closed).toBe(true); // … and bye
	});

	it("cancels with protocol when a frame lands beyond the reorder window (ordered)", async () => {
		const { b, ch, frame } = await rogue([8 * MiB], { ordered: true });
		ch(0).send(frame(0, T.reorderWindow, 100));
		expect(await b.final("receive", 1)).toMatchObject({ phase: "failed", error: "flow-control" });
	});

	it("cancels with protocol on frames outside the manifest", async () => {
		type F = (file: number, offset: number, len: number, batch?: number, dir?: 0 | 1) => ArrayBuffer;
		const cases: Array<(f: F) => ArrayBuffer> = [
			(f) => f(5, 0, 10), // no such file
			(f) => f(0, 1000 - 5, 10), // past the end
			(f) => f(0, 0, 10, 1, 0), // wrong direction bit
			(f) => f(0, 0, 10, 9), // future batch
		];
		for (const bad of cases) {
			const { b, ch, frame } = await rogue([1000]);
			ch(0).send(bad(frame));
			expect(await b.final("receive", 1)).toMatchObject({ phase: "failed", error: "protocol" });
		}
	});

	it("rejects frames to a skipped file and garbage on the data channel", async () => {
		{
			const { b, ch, frame } = await rogue([1000, 1000], { skip: [1] });
			ch(0).send(frame(1, 0, 10));
			expect(await b.final("receive", 1)).toMatchObject({ phase: "failed", error: "protocol" });
		}
		{
			const { b, ch } = await rogue([1000]);
			ch(1).send(new Uint8Array([1, 2, 3]).buffer);
			expect(await b.final("receive", 1)).toMatchObject({ phase: "failed", error: "protocol" });
		}
	});

	it("accepts duplicate (requeued) bytes but writes them once", async () => {
		const { pair, b, sink, ch } = await rogue([3000], { ordered: false });
		const data = bytes(3000, 7);
		const send = (lane: number, off: number, len: number, last = false) =>
			ch(lane).send(
				encodeFrame({ dir: 1, last, batch: 1, file: 0, offset: off }, data.subarray(off, off + len)).buffer,
			);
		send(0, 0, 2000, true);
		send(1, 1000, 1500); // overlaps lane 0's bytes
		send(0, 0, 2000, true); // a full duplicate
		send(1, 2500, 500, true);
		const r = await b.final("receive", 1);
		expect(r.phase).toBe("done");
		expect(sink.errors).toEqual([]);
		expect(Buffer.from(sink.data[0] as Uint8Array).equals(Buffer.from(data))).toBe(true);
		// Acks went back on each lane for its own bytes.
		await until(() => (pair.channels.get(0)?.[1].sentTexts.length ?? 0) > 0);
		const acks0 = pair.channels.get(0)?.[1].sentTexts.map((t) => parseAck(t)) ?? [];
		expect(acks0[0]).toMatchObject({ a: 1, d: 1, w: 2000 });
	});
});
