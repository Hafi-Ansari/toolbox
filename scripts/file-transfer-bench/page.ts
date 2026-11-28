// Browser half of the File Transfer benchmark (SPEC §16.3). Served by Vite from bench.ts and driven
// over Playwright. It runs the REAL lanes (rtc/lanes.ts) and the REAL engine (engine/engine.ts); only
// signaling (a mailbox in the Node process), the source files and the sinks are stand-ins:
// - sources are virtual Files whose slices come from one random 4 MiB block (no disk reads), so a run
//   can last as long as it needs to;
// - "unordered" receives into a discarding sink (folder/test scheduling);
// - "ordered" feeds the zip writer (CRC32, ZIP64 headers) with zip-stream scheduling, but drops the
//   archive instead of streaming it through the service worker to disk.
import { createEngine } from "../../src/tools/file-transfer/engine/engine.ts";
import { createConnect } from "../../src/tools/file-transfer/rtc/lanes.ts";
import { planZip, ZipFeed } from "../../src/tools/file-transfer/sinks/zipFeed.ts";
import { tuning } from "../../src/tools/file-transfer/tuning.ts";
import type {
	BatchPhase,
	ManifestFile,
	PeerSession,
	ReceiveSink,
	SendFile,
	Signaling,
	SignalMessage,
	TransferEngine,
} from "../../src/tools/file-transfer/types.ts";

declare global {
	interface Window {
		__benchSignal(to: string, json: string): Promise<void>;
		__benchRead(me: string): Promise<string | null>;
		__benchMunge(sdp: string): Promise<string>;
		bench: typeof bench;
	}
}

const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let session: PeerSession | null = null;
let engine: TransferEngine | null = null;
const stats = { bytesDone: 0, phase: "none" as BatchPhase | "none", batch: 0, lanes: 0, error: null as string | null };

/** Signaling through the Node process (stands in for api/file-transfer.ts). */
function signaling(me: "a" | "b"): Signaling {
	const other = me === "a" ? "b" : "a";
	return {
		pair: "0123456789abcdef",
		self: me === "a" ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb",
		remote: me === "a" ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa",
		offerer: me === "a",
		send: (msg: SignalMessage) => window.__benchSignal(other, JSON.stringify(msg)),
		async next(signal?: AbortSignal) {
			for (;;) {
				signal?.throwIfAborted();
				const json = await window.__benchRead(me);
				if (json) return JSON.parse(json) as SignalMessage;
				await sleep(50);
			}
		},
	};
}

/** The answerer behind the proxy: offers are rewritten to the proxy, answers lose their candidates. */
function proxiedPeerConnection(config: RTCConfiguration): RTCPeerConnection {
	const pc = new RTCPeerConnection(config);
	const local = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "localDescription")?.get;
	Object.defineProperty(pc, "localDescription", {
		get() {
			const d = local?.call(pc) as RTCSessionDescription | null;
			if (!d) return d;
			const sdp = d.sdp
				.split("\r\n")
				.filter((l) => !l.startsWith("a=candidate:") && l !== "a=end-of-candidates")
				.join("\r\n");
			return { type: d.type, sdp, toJSON: () => ({ type: d.type, sdp }) };
		},
	});
	const setRemote = pc.setRemoteDescription.bind(pc);
	pc.setRemoteDescription = async (d: RTCSessionDescriptionInit) =>
		setRemote(d.type === "offer" && d.sdp ? { type: "offer", sdp: await window.__benchMunge(d.sdp) } : d);
	return pc;
}

/** A File-like source of `size` bytes, sliced from one random block. */
function virtualFile(name: string, size: number, block: Uint8Array): File {
	const fake = {
		name,
		size,
		lastModified: Date.now(),
		type: "",
		slice(start: number, end: number) {
			return {
				async arrayBuffer() {
					const out = new Uint8Array(end - start);
					for (let at = 0; at < out.length; at += block.length)
						out.set(block.subarray(0, Math.min(block.length, out.length - at)), at);
					return out.buffer;
				},
			};
		},
	};
	return fake as unknown as File;
}

function discardSink(): ReceiveSink {
	return {
		mode: "test",
		ordered: false,
		begin: async () => ({ skip: [] }),
		write: async () => {},
		finishFile: async () => {},
		finish: async () => ({ location: "bench" }),
		abort: async () => {},
	};
}

function zipSink(): ReceiveSink {
	let feed: ZipFeed | null = null;
	return {
		mode: "test",
		ordered: true,
		async begin(files: ManifestFile[]) {
			feed = new ZipFeed(planZip(files), () => {});
			return { skip: [] };
		},
		write: async (file, offset, data) => feed?.write(file, offset, data),
		finishFile: async (file) => feed?.finishFile(file),
		async finish() {
			feed?.finish();
			return { location: "bench.zip" };
		},
		abort: async () => {
			feed = null;
		},
	};
}

const bench = {
	reset() {
		engine?.dispose();
		session?.close();
		engine = null;
		session = null;
		Object.assign(stats, { bytesDone: 0, phase: "none", batch: 0, lanes: 0, error: null });
	},

	async connect(role: "a" | "b", lanes: number, proxied: boolean) {
		tuning.lanes = lanes;
		const connect = createConnect({
			iceServers: [],
			createPeerConnection: proxied && role === "b" ? proxiedPeerConnection : undefined,
		});
		session = await connect({
			signaling: signaling(role),
			hello: { name: role, emoji: "🦊", caps: { folder: false, zip: true, memoryMax: tuning.memoryMax, lanes } },
		});
		engine = createEngine(session);
		engine.on((e) => {
			if (e.type === "progress") {
				stats.bytesDone = e.progress.bytesDone;
				stats.phase = e.progress.phase;
				stats.batch = e.progress.batch;
				stats.lanes = e.progress.lanes;
				stats.error = e.progress.error;
			}
		});
		const until = Date.now() + 20_000;
		while (session.lanes().length < lanes && Date.now() < until) await sleep(100);
		return { lanes: session.lanes().length, maxMessageSize: session.maxMessageSize ?? null };
	},

	/** Receiver: accept the next offer into the given sink. */
	arm(mode: "unordered" | "ordered") {
		if (!engine) throw new Error("not connected");
		const e = engine;
		Object.assign(stats, { bytesDone: 0, phase: "none", error: null });
		const off = e.on((ev) => {
			if (ev.type !== "offer") return;
			off();
			void e.accept(ev.offer.batch, mode === "ordered" ? zipSink() : discardSink());
		});
	},

	/** Sender: `count` virtual files of `size` bytes each. */
	send(count: number, size: number) {
		if (!engine) throw new Error("not connected");
		Object.assign(stats, { bytesDone: 0, phase: "none", error: null });
		const block = new Uint8Array(4 * MiB);
		for (let at = 0; at < block.length; at += 65536) crypto.getRandomValues(block.subarray(at, at + 65536));
		const files: SendFile[] = Array.from({ length: count }, (_, i) => ({
			path: `bench/file-${i}.bin`,
			file: virtualFile(`file-${i}.bin`, size, block),
		}));
		return engine.send(files);
	},

	cancel(side: "send" | "receive") {
		engine?.cancel(side, stats.batch);
	},

	stats: () => ({ ...stats }),
	dump: () => dump(),
};

window.bench = bench;

/** The engine internals `--dump` prints (private fields, read for debugging only). */
interface Internals {
	out?: {
		sched?: {
			cursor: number;
			ackedC: number;
			requeued: number[][];
			lanes: Map<number, { assigned: number; acked: number; items: { g: number; len: number }[] }>;
		};
		sender?: { lanes: Map<number, { sent: number; acked: number; dc: RTCDataChannel }> };
	} | null;
	inc?: {
		receiver?: {
			persisted: number;
			queued: number;
			held: number;
			segs: { g: number; end: number }[];
			lanes: Map<number, { w: number }>;
		} | null;
	} | null;
}

/** Debug (`bench.ts --dump`): scheduler, lanes and reorder buffer while a run is stalled. */
function dump(): string {
	const e = engine as unknown as Internals | null;
	const sched = e?.out?.sched;
	const r = e?.inc?.receiver;
	return JSON.stringify({
		send: sched && {
			cursor: sched.cursor,
			ackedC: sched.ackedC,
			requeued: sched.requeued,
			lanes: [...sched.lanes].map(([k, s]) => ({
				k,
				assigned: s.assigned,
				acked: s.acked,
				items: s.items.map((i) => [i.g, i.len]),
			})),
			channels: [...(e?.out?.sender?.lanes.values() ?? [])].map((l) => ({
				sent: l.sent,
				acked: l.acked,
				buffered: l.dc.bufferedAmount,
			})),
		},
		recv: r && {
			persisted: r.persisted,
			queued: r.queued,
			held: r.held,
			segs: r.segs.slice(0, 8).map((x) => [x.g, x.end]),
			lanes: [...r.lanes.values()].map((l) => l.w),
		},
	});
}
