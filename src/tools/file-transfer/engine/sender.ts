// Sending one batch over N lanes (SPEC §7.4, adapted from WebDrop `Outgoing.run`, minus the crypto).
//
// Each lane runs: pull a work item from the scheduler → stream it → pull again. Per chunk, two levels
// of backpressure:
//   1. the lane's SCTP send buffer: wait while `bufferedAmount > highWater` (resume on
//      `bufferedamountlow`, threshold `lowWater`);
//   2. the receiver: wait while this lane's sent − acked bytes exceed `laneWindow`.
// Reads run one block (`readBlock`) ahead with `File.slice().arrayBuffer()`.
import { FRAME_HEADER_BYTES, type Tuning } from "../tuning.ts";
import type { Ack, ByteRange, DataChannelLike, Dir } from "../types.ts";
import { FrameWriter } from "./frame.ts";
import type { Scheduler } from "./scheduler.ts";
import { drained, Notifier, Stopped } from "./util.ts";

/** A file couldn't be read (moved, deleted or changed while sending). */
export class ReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReadError";
	}
}

/** The lane stopped accepting data (closed, or `send()` threw). */
class LaneGone extends Error {}

export interface SenderOptions {
	batch: number;
	/** Direction bit of this batch (`session.dir`). */
	dir: Dir;
	/** Source per manifest index. */
	files: readonly Blob[];
	sched: Scheduler;
	tuning: Tuning;
	/** Bytes per message, header included (`chunkSize()`). */
	chunk: number;
	/** Something to report: an ack moved progress, or a lane changed. */
	onProgress(): void;
	/** A file couldn't be read: the batch fails. */
	onError(err: ReadError): void;
	/** A lane's channel failed under us; the engine decides what to do (it requeues via `removeLane`). */
	onLaneGone(key: number): void;
}

interface SendLane {
	key: number;
	dc: DataChannelLike;
	abort: AbortController;
	sent: number;
	acked: number;
	acks: Notifier;
	writer: FrameWriter;
	/** File being streamed now, for progress names. */
	file: number | null;
}

export type AckResult = "ok" | "ignored" | "violation";

export class BatchSender {
	private readonly o: SenderOptions;
	private readonly lanes = new Map<number, SendLane>();
	private stopped = false;
	/** Largest `bufferedAmount` seen right after a send, for tests and the benchmark. */
	maxBuffered = 0;

	constructor(o: SenderOptions) {
		this.o = o;
	}

	get laneCount(): number {
		return this.lanes.size;
	}

	/** Files being streamed now (unique, lane order). */
	current(): number[] {
		const out: number[] = [];
		for (const l of this.lanes.values()) if (l.file !== null && !out.includes(l.file)) out.push(l.file);
		return out;
	}

	/** Start a send loop on a lane. */
	addLane(key: number, dc: DataChannelLike): void {
		if (this.stopped || this.lanes.has(key)) return;
		dc.bufferedAmountLowThreshold = this.o.tuning.lowWater;
		const lane: SendLane = {
			key,
			dc,
			abort: new AbortController(),
			sent: 0,
			acked: 0,
			acks: new Notifier(),
			writer: new FrameWriter(this.o.chunk),
			file: null,
		};
		this.lanes.set(key, lane);
		void this.run(lane);
	}

	/** The lane is gone: stop its loop and requeue its unacked work. */
	removeLane(key: number): void {
		const lane = this.lanes.get(key);
		if (!lane) return;
		this.lanes.delete(key);
		lane.abort.abort();
		this.o.sched.laneLost(key);
		this.o.onProgress();
	}

	/** An ack arrived on lane `key` for this batch. */
	onAck(key: number, ack: Ack): AckResult {
		if (this.stopped) return "ignored";
		if (ack.c !== undefined) {
			// Batch-wide, so it counts even from a lane this sender already dropped.
			if (!this.o.sched.ordered || ack.c > this.o.sched.total) return "violation";
			this.o.sched.contiguous(ack.c);
		}
		const lane = this.lanes.get(key);
		if (!lane) return "ignored";
		if (ack.w > lane.sent) return "violation";
		if (ack.w > lane.acked) {
			lane.acked = ack.w;
			this.o.sched.ack(key, ack.w);
			lane.acks.notify();
		}
		this.o.onProgress();
		return "ok";
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const l of this.lanes.values()) l.abort.abort();
		this.lanes.clear();
	}

	private async run(lane: SendLane): Promise<void> {
		const { sched } = this.o;
		const signal = lane.abort.signal;
		try {
			while (!signal.aborted) {
				const work = sched.next(lane.key);
				if (!work) {
					lane.file = null;
					await sched.changed.wait(signal);
					continue;
				}
				for (const r of work.ranges) {
					lane.file = r.file;
					await this.stream(lane, r);
				}
			}
		} catch (err) {
			if (err instanceof Stopped || signal.aborted) return;
			if (err instanceof LaneGone) {
				this.o.onLaneGone(lane.key);
				return;
			}
			const e = err instanceof ReadError ? err : new ReadError(err instanceof Error ? err.message : String(err));
			this.o.onError(e);
		}
	}

	private async stream(lane: SendLane, r: ByteRange): Promise<void> {
		const { tuning: t, dir, batch } = this.o;
		const { dc, writer } = lane;
		const signal = lane.abort.signal;
		const file = this.o.files[r.file];
		if (!file) throw new ReadError(`no source for file ${r.file}`);
		const P = this.o.chunk - FRAME_HEADER_BYTES;
		const block = Math.max(P, Math.floor(t.readBlock / P) * P);
		const read = async (start: number): Promise<Uint8Array> => {
			const end = Math.min(r.end, start + block);
			let buf: ArrayBuffer;
			try {
				buf = await file.slice(start, end).arrayBuffer();
			} catch (err) {
				throw new ReadError(err instanceof Error ? err.message : String(err));
			}
			if (buf.byteLength !== end - start) throw new ReadError("file changed while sending");
			return new Uint8Array(buf);
		};

		let pos = r.start;
		let next: Promise<Uint8Array> | null = read(pos);
		while (next) {
			const buf: Uint8Array = await next;
			const blockEnd = pos + buf.byteLength;
			next = blockEnd < r.end ? read(blockEnd) : null;
			next?.catch(() => {});
			for (let o = 0; o < buf.byteLength; o += P) {
				const len = Math.min(P, buf.byteLength - o);
				// 1. Local send buffer.
				while (dc.bufferedAmount > t.highWater) {
					if (dc.readyState !== "open") throw new LaneGone();
					await drained(dc, signal);
				}
				// 2. Receiver window for this lane.
				while (lane.sent - lane.acked > t.laneWindow) await lane.acks.wait(signal);
				if (signal.aborted) throw new Stopped();
				if (dc.readyState !== "open") throw new LaneGone();
				const offset = pos + o;
				const frame = writer.frame(
					{ dir, last: offset + len === r.end, batch, file: r.file, offset },
					buf.subarray(o, o + len),
				);
				try {
					dc.send(frame);
				} catch {
					throw new LaneGone();
				}
				lane.sent += len;
				if (dc.bufferedAmount > this.maxBuffered) this.maxBuffered = dc.bufferedAmount;
			}
			pos = blockEnd;
		}
	}
}
