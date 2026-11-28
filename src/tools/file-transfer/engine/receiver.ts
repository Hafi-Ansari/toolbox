// Receiving one batch (SPEC §7.3–§7.5, §8): validation, reorder buffer, acks, writes into a ReceiveSink.
//
// Every byte reaches the sink exactly once, even when requeued ranges arrive twice (§7.3 allows
// duplicates):
// - Unordered sinks: a per-file set of claimed bytes; only unclaimed parts are written. Each lane's
//   frames are written in arrival order through that lane's promise chain, so its ack `w` (bytes
//   persisted) is always a prefix of what the lane sent, which is what requeue relies on (§7.5).
// - Ordered sinks: frames are placed by stream offset. In-order bytes go to one write chain; the rest
//   wait in a reorder buffer of disjoint segments; bytes below the queued mark are dropped. Here `w`
//   counts bytes *placed* (queued for writing, buffered, or dropped as duplicate): the receiver owns
//   them, so they never need resending. Counting only written bytes could deadlock: a lane whose window
//   is full of bytes waiting behind a requeued head range could never send that range. Receiver memory
//   is bounded by the stream window instead: no frame may end beyond persisted + reorderWindow.
//
// Flow control (§7.3): unordered, bytes queued but not persisted stay below
// lanes × (laneWindow + chunk); ordered, the stream window above. Violations end the batch.
import { maxUnpersisted, type Tuning } from "../tuning.ts";
import type { DataChannelLike, Dir, FrameHeader, ManifestFile, ReceiveSink, TransferErrorCode } from "../types.ts";
import { encodeAck } from "./frame.ts";
import { type StreamLayout, streamLayout } from "./scheduler.ts";
import { IntervalSet } from "./util.ts";

/** Ordered mode: report a contiguous-mark advance smaller than ackEvery after this long. */
const C_ACK_DELAY_MS = 20;

export interface ReceiverOptions {
	batch: number;
	/** Direction bit of the batch (the remote side's `dir`). */
	dir: Dir;
	files: readonly ManifestFile[];
	skip: ReadonlySet<number>;
	sink: ReceiveSink;
	tuning: Tuning;
	onFileDone(file: number): void;
	onDone(location: string): void;
	/** The batch failed here: `sink-error`, `protocol` or `flow-control`. The sink is already being aborted. */
	onFail(code: Extract<TransferErrorCode, "sink-error" | "protocol" | "flow-control">, err?: unknown): void;
	onProgress(): void;
}

interface Rec {
	len: number;
	last: boolean;
	done: boolean;
}

interface RecvLane {
	key: number;
	dc: DataChannelLike;
	recs: Rec[];
	/** Cumulative bytes acked-able (prefix of completed records). */
	w: number;
	lastAckW: number;
	chain: Promise<void>;
}

/** Ordered mode: a held out-of-order piece, disjoint from every other. */
interface Seg {
	g: number;
	end: number;
	file: number;
	offset: number;
	data: Uint8Array;
	lane: RecvLane;
}

export class BatchReceiver {
	readonly layout: StreamLayout;
	readonly ordered: boolean;
	private readonly o: ReceiverOptions;
	private readonly lanes = new Map<number, RecvLane>();
	private ended = false;
	private finishedFiles = 0;
	private finishingAll = false;
	/** Bytes received but not yet persisted (unordered flow control). */
	private unpersisted = 0;
	/** Largest `unpersisted` seen, for tests. */
	maxUnpersisted = 0;

	// Unordered
	private readonly claimed = new Map<number, IntervalSet>();
	private readonly inflight = new Map<number, number>();
	private readonly finishing = new Set<number>();
	private readonly open = new Set<number>();
	private written = 0;

	// Ordered
	private segs: Seg[] = [];
	/** Bytes held in the reorder buffer. */
	held = 0;
	/** Largest `held` seen, for tests. */
	maxHeld = 0;
	/** Stream bytes handed to the write chain. */
	private queued = 0;
	/** Stream bytes the sink has written. */
	private persisted = 0;
	private lastC = 0;
	private cTimer: ReturnType<typeof setTimeout> | null = null;
	private nextFinish = 0;
	private writing: number | null = null;
	private order: Promise<void> = Promise.resolve();

	constructor(o: ReceiverOptions) {
		this.o = o;
		this.ordered = o.sink.ordered;
		this.layout = streamLayout(
			o.files.map((f) => f.size),
			o.skip,
		);
	}

	/** Bytes persisted (excluding skipped files). */
	get bytesDone(): number {
		return this.ordered ? this.persisted : this.written;
	}

	get filesDone(): number {
		return this.finishedFiles;
	}

	/** Files being written now. */
	current(): number[] {
		if (this.ordered) return this.writing === null ? [] : [this.writing];
		return [...this.open];
	}

	/** Call once after `accept` is sent: finishes empty files, or the whole batch when nothing is left to receive. */
	start(): void {
		if (this.layout.files.length === 0) {
			void this.finishAll();
			return;
		}
		if (this.ordered) {
			this.order = this.order.then(() => this.advanceFinished());
			return;
		}
		for (const f of this.layout.files) if ((this.o.files[f] as ManifestFile).size === 0) this.finishFile(f);
	}

	/** A frame of this batch arrived on a lane (header already decoded; batch and dir checked by the engine). */
	onFrame(key: number, dc: DataChannelLike, h: FrameHeader, payload: Uint8Array): void {
		if (this.ended) return;
		const file = this.o.files[h.file];
		const len = payload.byteLength;
		if (!file || this.o.skip.has(h.file) || h.offset + len > file.size) {
			this.fail("protocol");
			return;
		}
		let lane = this.lanes.get(key);
		if (!lane) {
			lane = { key, dc, recs: [], w: 0, lastAckW: 0, chain: Promise.resolve() };
			this.lanes.set(key, lane);
		}
		const rec: Rec = { len, last: h.last, done: false };
		if (this.ordered) {
			const g = (this.layout.start[h.file] as number) + h.offset;
			if (g + len > this.persisted + this.o.tuning.reorderWindow) {
				this.fail("flow-control");
				return;
			}
			lane.recs.push(rec);
			this.place(lane, rec, h.file, h.offset, g, payload);
			return;
		}
		if (this.unpersisted + len > maxUnpersisted(this.lanes.size, this.o.tuning)) {
			this.fail("flow-control");
			return;
		}
		this.unpersisted += len;
		if (this.unpersisted > this.maxUnpersisted) this.maxUnpersisted = this.unpersisted;
		lane.recs.push(rec);
		const l = lane;
		lane.chain = lane.chain.then(() => this.writeUnordered(l, rec, h.file, h.offset, payload));
	}

	/** Stop: cancelled, interrupted, or the engine failed the batch. Aborts the sink unless the batch is done. */
	async abort(reason: string): Promise<void> {
		if (this.ended) return;
		this.end();
		await this.o.sink.abort(reason).catch(() => {});
	}

	/* ---------- unordered */

	private async writeUnordered(
		lane: RecvLane,
		rec: Rec,
		file: number,
		offset: number,
		data: Uint8Array,
	): Promise<void> {
		if (this.ended) return;
		const len = data.byteLength;
		if (this.finishing.has(file)) {
			this.complete(lane, rec);
			return;
		}
		let set = this.claimed.get(file);
		if (!set) {
			set = new IntervalSet();
			this.claimed.set(file, set);
		}
		const gaps = set.gaps(offset, offset + len);
		if (gaps.length === 0) {
			this.complete(lane, rec);
			return;
		}
		for (const [s, e] of gaps) set.add(s, e);
		this.inflight.set(file, (this.inflight.get(file) ?? 0) + 1);
		this.open.add(file);
		try {
			for (const [s, e] of gaps) {
				await this.o.sink.write(file, s, data.subarray(s - offset, e - offset));
				this.written += e - s;
			}
		} catch (err) {
			this.fail("sink-error", err);
			return;
		}
		this.inflight.set(file, (this.inflight.get(file) ?? 1) - 1);
		if (this.ended) return;
		this.complete(lane, rec);
		if (this.inflight.get(file) === 0 && set.size === (this.o.files[file] as ManifestFile).size) this.finishFile(file);
		this.o.onProgress();
	}

	private finishFile(file: number): void {
		if (this.finishing.has(file)) return;
		this.finishing.add(file);
		void (async () => {
			try {
				await this.o.sink.finishFile(file);
			} catch (err) {
				this.fail("sink-error", err);
				return;
			}
			if (this.ended) return;
			this.claimed.delete(file);
			this.inflight.delete(file);
			this.open.delete(file);
			this.fileDone(file);
		})();
	}

	/* ---------- ordered */

	private place(lane: RecvLane, rec: Rec, file: number, offset: number, g: number, data: Uint8Array): void {
		const end = g + data.byteLength;
		if (end <= this.queued) {
			// Duplicate of bytes already queued or written.
		} else if (g <= this.queued) {
			const skip = this.queued - g;
			this.enqueue(lane, file, offset + skip, data.subarray(skip), end);
			this.drain();
		} else {
			this.hold(lane, file, offset, g, data);
		}
		this.complete(lane, rec);
	}

	/** Keep the parts of [g, end) no held segment covers yet. */
	private hold(lane: RecvLane, file: number, offset: number, g: number, data: Uint8Array): void {
		const end = g + data.byteLength;
		const pieces: Seg[] = [];
		let pos = g;
		let i = 0;
		for (; i < this.segs.length && pos < end; i++) {
			const s = this.segs[i] as Seg;
			if (s.end <= pos) continue;
			if (s.g >= end) break;
			if (s.g > pos) pieces.push(this.piece(lane, file, offset, g, data, pos, s.g));
			pos = Math.max(pos, s.end);
		}
		if (pos < end) pieces.push(this.piece(lane, file, offset, g, data, pos, end));
		for (const p of pieces) {
			let k = 0;
			while (k < this.segs.length && (this.segs[k] as Seg).g < p.g) k++;
			this.segs.splice(k, 0, p);
			this.held += p.end - p.g;
		}
		if (this.held > this.maxHeld) this.maxHeld = this.held;
	}

	private piece(lane: RecvLane, file: number, offset: number, g: number, data: Uint8Array, s: number, e: number): Seg {
		return { g: s, end: e, file, offset: offset + (s - g), data: data.subarray(s - g, e - g), lane };
	}

	/** Move held segments that are now in order to the write chain. */
	private drain(): void {
		while (this.segs.length > 0 && (this.segs[0] as Seg).g <= this.queued) {
			const s = this.segs.shift() as Seg;
			this.held -= s.end - s.g;
			if (s.end <= this.queued) continue;
			const skip = this.queued - s.g;
			this.enqueue(s.lane, s.file, s.offset + skip, s.data.subarray(skip), s.end);
		}
	}

	private enqueue(lane: RecvLane, file: number, offset: number, data: Uint8Array, end: number): void {
		this.queued = end;
		this.order = this.order.then(async () => {
			if (this.ended) return;
			this.writing = file;
			try {
				await this.o.sink.write(file, offset, data);
			} catch (err) {
				this.fail("sink-error", err);
				return;
			}
			this.persisted = end;
			await this.advanceFinished();
			if (this.ended) return;
			// Acks also carry the contiguous mark the sender's stream window waits on (§7.4): report it
			// every ackEvery bytes, and shortly after any smaller advance so a waiting sender never stalls.
			if (this.persisted - this.lastC >= this.o.tuning.ackEvery || this.persisted === this.layout.total)
				this.sendAck(lane.dc.readyState === "open" ? lane : this.anyOpenLane());
			else if (this.persisted > this.lastC && !this.cTimer)
				this.cTimer = setTimeout(() => {
					this.cTimer = null;
					if (this.persisted > this.lastC) this.sendAck(this.anyOpenLane());
				}, C_ACK_DELAY_MS);
			this.o.onProgress();
		});
	}

	/** Finish files whose bytes are all persisted, strictly in manifest order (empty files included). */
	private async advanceFinished(): Promise<void> {
		const { files } = this.layout;
		while (this.nextFinish < files.length && !this.ended) {
			const f = files[this.nextFinish] as number;
			if ((this.layout.start[f] as number) + (this.o.files[f] as ManifestFile).size > this.persisted) return;
			try {
				await this.o.sink.finishFile(f);
			} catch (err) {
				this.fail("sink-error", err);
				return;
			}
			if (this.ended) return;
			this.nextFinish++;
			if (this.writing === f) this.writing = null;
			this.fileDone(f);
		}
	}

	/* ---------- shared */

	private fileDone(file: number): void {
		this.finishedFiles++;
		this.o.onFileDone(file);
		this.o.onProgress();
		if (this.finishedFiles === this.layout.files.length) void this.finishAll();
	}

	private async finishAll(): Promise<void> {
		if (this.finishingAll || this.ended) return;
		this.finishingAll = true;
		let location: string;
		try {
			({ location } = await this.o.sink.finish());
		} catch (err) {
			this.fail("sink-error", err);
			return;
		}
		if (this.ended) return;
		this.end();
		this.o.onDone(location);
	}

	/** A record is persisted (unordered) or placed (ordered): advance the lane's `w` and ack when due. */
	private complete(lane: RecvLane, rec: Rec): void {
		rec.done = true;
		if (!this.ordered) this.unpersisted -= rec.len;
		let rangeEnd = false;
		while (lane.recs.length > 0 && (lane.recs[0] as Rec).done) {
			const r = lane.recs.shift() as Rec;
			lane.w += r.len;
			if (r.last) rangeEnd = true;
		}
		if (rangeEnd || lane.w - lane.lastAckW >= this.o.tuning.ackEvery) this.sendAck(lane);
	}

	private anyOpenLane(): RecvLane | undefined {
		for (const l of this.lanes.values()) if (l.dc.readyState === "open") return l;
		return undefined;
	}

	private sendAck(lane: RecvLane | undefined): void {
		if (!lane || this.ended || lane.dc.readyState !== "open") return;
		const c = this.ordered ? this.persisted : undefined;
		try {
			lane.dc.send(encodeAck({ a: this.o.batch, d: this.o.dir, w: lane.w, c }));
		} catch {
			return;
		}
		lane.lastAckW = lane.w;
		if (c !== undefined) this.lastC = c;
	}

	private fail(code: "sink-error" | "protocol" | "flow-control", err?: unknown): void {
		if (this.ended) return;
		this.end();
		void this.o.sink.abort(code).catch(() => {});
		this.o.onFail(code, err);
	}

	private end(): void {
		this.ended = true;
		this.segs = [];
		this.held = 0;
		if (this.cTimer) clearTimeout(this.cTimer);
		this.cTimer = null;
	}
}
