// In-memory fakes for engine tests (and WP6's harness): data channel pairs with a simulated send
// buffer, latency and drain rate; a PeerSession pair whose ctrl messages go through the real
// encode/parse; and an in-memory ReceiveSink that checks every byte is written exactly once (and, when
// ordered, strictly in stream order).
import {
	type Ctrl,
	type CtrlOf,
	type DataChannelLike,
	type Dir,
	encodeCtrl,
	isTransferCtrl,
	type Lane,
	type ManifestFile,
	type PeerSession,
	parseCtrl,
	type ReceiveSink,
	type SessionEvent,
	type TransferCtrl,
} from "../types.ts";
import { IntervalSet } from "./util.ts";

const CHROME_QUEUE_MAX = 16 * 1024 * 1024;

export interface NetOptions {
	/** One-way delivery delay, ms. */
	delayMs?: number;
	/** Bytes leaving the send buffer per tick (≈ 1 ms). */
	bytesPerTick?: number;
}

type Listener = (ev: never) => void;

export class FakeChannel implements DataChannelLike {
	readonly label: string;
	readyState: RTCDataChannelState = "open";
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	binaryType: BinaryType = "arraybuffer";
	peer!: FakeChannel;
	net: Required<NetOptions>;
	/** Largest bufferedAmount ever reached. */
	maxBuffered = 0;
	/** Messages sent (binary, text). */
	sentFrames = 0;
	sentTexts: string[] = [];
	/** Called for every outgoing message, before it is queued. */
	onSend: ((data: string | ArrayBuffer) => void) | null = null;
	private readonly listeners = new Map<string, Set<Listener>>();
	private queue: Array<{ data: string | ArrayBuffer; size: number }> = [];
	private pumping = false;

	constructor(label: string, net: NetOptions = {}) {
		this.label = label;
		this.net = { delayMs: net.delayMs ?? 0, bytesPerTick: net.bytesPerTick ?? 4 * 1024 * 1024 };
	}

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
		let copy: string | ArrayBuffer;
		if (typeof data === "string") copy = data;
		else if (data instanceof ArrayBuffer) copy = data.slice(0);
		else copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
		const size = typeof copy === "string" ? copy.length : copy.byteLength;
		if (this.bufferedAmount + size > CHROME_QUEUE_MAX) throw new Error("OperationError: send queue is full");
		this.onSend?.(copy);
		if (typeof copy === "string") this.sentTexts.push(copy);
		else this.sentFrames++;
		this.bufferedAmount += size;
		if (this.bufferedAmount > this.maxBuffered) this.maxBuffered = this.bufferedAmount;
		this.queue.push({ data: copy, size });
		this.pump();
	}

	close(): void {
		if (this.readyState === "closed") return;
		for (const ch of [this, this.peer]) {
			if (ch.readyState === "closed") continue;
			ch.readyState = "closed";
			ch.queue = [];
			ch.bufferedAmount = 0;
			setTimeout(() => ch.dispatch("close", new Event("close")), 0);
		}
	}

	addEventListener(type: string, listener: Listener): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}

	/** Inject a message as if the peer had sent it (tests of a rogue peer). */
	inject(data: string | ArrayBuffer): void {
		this.dispatch("message", { data } as MessageEvent);
	}

	private dispatch(type: string, ev: unknown): void {
		for (const l of [...(this.listeners.get(type) ?? [])]) (l as (e: unknown) => void)(ev);
	}

	private pump(): void {
		if (this.pumping) return;
		this.pumping = true;
		setTimeout(() => {
			this.pumping = false;
			if (this.readyState !== "open") return;
			let budget = this.net.bytesPerTick;
			const before = this.bufferedAmount;
			while (this.queue.length > 0 && budget > 0) {
				const m = this.queue.shift() as { data: string | ArrayBuffer; size: number };
				budget -= m.size;
				this.bufferedAmount -= m.size;
				const peer = this.peer;
				const deliver = () => {
					if (peer.readyState === "open") peer.dispatch("message", { data: m.data } as MessageEvent);
				};
				if (this.net.delayMs > 0) setTimeout(deliver, this.net.delayMs);
				else deliver();
			}
			if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold)
				this.dispatch("bufferedamountlow", new Event("bufferedamountlow"));
			if (this.queue.length > 0) this.pump();
		}, 0);
	}
}

export function channelPair(label: string, ab: NetOptions = {}, ba: NetOptions = ab): [FakeChannel, FakeChannel] {
	const a = new FakeChannel(label, ab);
	const b = new FakeChannel(label, ba);
	a.peer = b;
	b.peer = a;
	return [a, b];
}

const hello = (name: string): CtrlOf<"hello"> => ({
	t: "hello",
	v: 1,
	name,
	emoji: "🦊",
	caps: { folder: true, zip: true, memoryMax: 2 ** 30, lanes: 6 },
});

export class FakeSession implements PeerSession {
	readonly offerer: boolean;
	readonly dir: Dir;
	readonly remote: CtrlOf<"hello">;
	/** Lane 0's SCTP max message size, as `PeerSession.maxMessageSize` (tests set it). */
	maxMessageSize?: number;
	peer!: FakeSession;
	closed = false;
	/** Every ctrl message this side sent, in order. */
	readonly sent: Ctrl[] = [];
	/** Every ctrl message this side received, in order. */
	readonly received: Ctrl[] = [];
	ctrlDelayMs = 0;
	readonly laneList: Lane[] = [];
	private readonly listeners = new Set<(e: SessionEvent) => void>();

	constructor(offerer: boolean, remoteName: string) {
		this.offerer = offerer;
		this.dir = offerer ? 1 : 0;
		this.remote = hello(remoteName);
	}

	lanes(): readonly Lane[] {
		return this.laneList;
	}

	sendCtrl(msg: TransferCtrl | Ctrl): void {
		if (this.closed) throw new Error("session closed");
		const text = encodeCtrl(msg);
		this.sent.push(msg);
		const peer = this.peer;
		setTimeout(() => peer.deliver(text), this.ctrlDelayMs);
	}

	on(listener: (e: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		if (this.closed) return;
		this.end("local");
		const peer = this.peer;
		setTimeout(() => peer.end("bye"), 0);
		for (const l of this.laneList) l.data.close();
	}

	emit(e: SessionEvent): void {
		for (const l of [...this.listeners]) l(e);
	}

	private deliver(text: string): void {
		if (this.closed) return;
		const msg = parseCtrl(text);
		if (!msg) throw new Error(`bad ctrl: ${text.slice(0, 100)}`);
		this.received.push(msg);
		if (isTransferCtrl(msg)) this.emit({ type: "ctrl", msg });
	}

	private end(reason: "local" | "bye" | "lost"): void {
		if (this.closed) return;
		this.closed = true;
		this.emit({ type: "closed", reason });
	}
}

/** Two connected sessions: `a` is the offerer. Lanes 0..lanes-1 are open from the start. */
export class SessionPair {
	readonly a = new FakeSession(true, "Calm Otter");
	readonly b = new FakeSession(false, "Brisk Fox");
	/** Channels by lane index: [a side, b side]. */
	readonly channels = new Map<number, [FakeChannel, FakeChannel]>();

	constructor(lanes = 3, net: (index: number) => NetOptions = () => ({})) {
		this.a.peer = this.b;
		this.b.peer = this.a;
		for (let i = 0; i < lanes; i++) this.addLane(i, net(i), false);
	}

	addLane(index: number, net: NetOptions = {}, announce = true): [FakeChannel, FakeChannel] {
		const pair = channelPair(`data-${index}`, net);
		this.channels.set(index, pair);
		const la: Lane = { index, data: pair[0] };
		const lb: Lane = { index, data: pair[1] };
		this.a.laneList.push(la);
		this.b.laneList.push(lb);
		if (announce) {
			this.a.emit({ type: "lane-open", lane: la });
			this.b.emit({ type: "lane-open", lane: lb });
		}
		return pair;
	}

	/** Drop a whole lane on both sides, losing whatever was in flight. */
	loseLane(index: number): void {
		const pair = this.channels.get(index);
		if (!pair) return;
		pair[0].close();
		for (const s of [this.a, this.b]) {
			const k = s.laneList.findIndex((l) => l.index === index);
			if (k >= 0) s.laneList.splice(k, 1);
			s.emit({ type: "lane-lost", index });
		}
	}
}

export interface MemorySinkOptions {
	ordered?: boolean;
	/** Files `begin` reports as already present. */
	skip?: number[];
	/** Delay of every write, ms (or a function of the call count). */
	writeDelayMs?: number | ((n: number) => number);
	/** Throw from the n-th write (1-based). */
	failOnWrite?: number;
}

/** In-memory ReceiveSink that verifies exactly-once (and in-order, when ordered) writes. */
export class MemorySink implements ReceiveSink {
	readonly mode = "test" as const;
	readonly ordered: boolean;
	files: ManifestFile[] = [];
	data: Uint8Array[] = [];
	/** Files finished, in call order. */
	finished: number[] = [];
	location: string | null = null;
	aborted: string | null = null;
	/** Contract violations seen (should stay empty). */
	errors: string[] = [];
	writes = 0;
	private readonly o: MemorySinkOptions;
	private readonly covered = new Map<number, IntervalSet>();
	private skip = new Set<number>();
	/** Ordered: next expected file position in the stream. */
	private order: number[] = [];
	private cursor = 0;
	private cursorOffset = 0;

	constructor(o: MemorySinkOptions = {}) {
		this.o = o;
		this.ordered = o.ordered ?? false;
	}

	async begin(files: ManifestFile[]): Promise<{ skip: number[] }> {
		this.files = files;
		this.data = files.map((f) => new Uint8Array(f.size));
		this.skip = new Set(this.o.skip ?? []);
		this.order = files.filter((f) => !this.skip.has(f.i)).map((f) => f.i);
		return { skip: [...this.skip] };
	}

	async write(file: number, offset: number, data: Uint8Array): Promise<void> {
		const n = ++this.writes;
		if (this.o.failOnWrite === n) throw new Error("disk full");
		const f = this.files[file];
		if (!f || this.skip.has(file)) this.errors.push(`write to bad file ${file}`);
		else if (offset + data.byteLength > f.size) this.errors.push(`write past end of ${file}`);
		else if (this.finished.includes(file)) this.errors.push(`write after finishFile ${file}`);
		if (this.aborted) this.errors.push("write after abort");
		let set = this.covered.get(file);
		if (!set) {
			set = new IntervalSet();
			this.covered.set(file, set);
		}
		const gaps = set.gaps(offset, offset + data.byteLength);
		const g0 = gaps[0];
		if (gaps.length !== 1 || !g0 || g0[0] !== offset || g0[1] !== offset + data.byteLength)
			this.errors.push(`overlapping write ${file}@${offset}+${data.byteLength}`);
		set.add(offset, offset + data.byteLength);
		if (this.ordered) {
			if (this.order[this.cursor] !== file || this.cursorOffset !== offset)
				this.errors.push(`out of order: ${file}@${offset}, expected ${this.order[this.cursor]}@${this.cursorOffset}`);
			this.cursorOffset = offset + data.byteLength;
		}
		const d = this.o.writeDelayMs;
		const ms = typeof d === "function" ? d(n) : (d ?? 0);
		if (ms > 0) await new Promise((r) => setTimeout(r, ms));
		this.data[file]?.set(data, offset);
	}

	async finishFile(file: number): Promise<void> {
		const f = this.files[file];
		if (!f) this.errors.push(`finish bad file ${file}`);
		else if ((this.covered.get(file)?.size ?? 0) !== f.size) this.errors.push(`finish incomplete file ${file}`);
		if (this.finished.includes(file)) this.errors.push(`finish twice ${file}`);
		if (this.ordered) {
			if (this.order[this.cursor] !== file) this.errors.push(`finish out of order ${file}`);
			this.cursor++;
			this.cursorOffset = 0;
		}
		this.finished.push(file);
	}

	async finish(): Promise<{ location: string }> {
		if (this.finished.length !== this.order.length) this.errors.push("finish before all files");
		this.location = "memory";
		return { location: this.location };
	}

	async abort(reason: string): Promise<void> {
		this.aborted = reason;
	}
}
