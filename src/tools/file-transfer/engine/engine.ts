// TransferEngine (SPEC §7.2–§7.5, §10): batches in both directions over a PeerSession's lanes.
//
// - ctrl (lane 0, via the session): manifest → accept/decline → file-done… → done, or cancel.
// - data channels: binary frames carry file bytes; text messages on the same lane carry acks back.
// One active batch per direction; A and B may send at the same time over the same lanes.
//
// The other browser is untrusted (§13): ctrl shapes are checked by the session (`isCtrl`), frames and
// acks here. A clear protocol violation cancels the batch with reason "protocol" and closes the
// session, which sends `bye` (§10).
import {
	CTRL_MAX_BYTES,
	CURRENT_FILES_SHOWN,
	chunkSize,
	tuning as defaultTuning,
	MANIFEST_PART_FILES,
	MAX_BATCH_ID,
	MAX_OFFSET,
	PROGRESS_MIN_MS,
	type Tuning,
} from "../tuning.ts";
import {
	acceptMode,
	type BatchPhase,
	type BatchProgress,
	type BatchSide,
	type CancelReason,
	type CreateEngine,
	type CtrlOf,
	type DataChannelLike,
	type DeclineReason,
	type Dir,
	type EngineEvent,
	type FtErrorCode,
	isOrderedMode,
	type Lane,
	type ManifestFile,
	type PeerSession,
	parseAck,
	type ReceiveSink,
	type SendFile,
	type SessionEvent,
	type TransferCtrl,
	type TransferEngine,
} from "../types.ts";
import { decodeFrame } from "./frame.ts";
import { RateMeter } from "./meter.ts";
import { BatchReceiver } from "./receiver.ts";
import { Scheduler } from "./scheduler.ts";
import { BatchSender } from "./sender.ts";

/** Most files one incoming manifest may list; more is treated as abuse (§13). */
export const MAX_MANIFEST_FILES = 1_000_000;

const FINAL: ReadonlySet<BatchPhase> = new Set(["done", "declined", "cancelled", "interrupted", "failed"]);
const isFinal = (p: BatchPhase) => FINAL.has(p);
const isRunning = (p: BatchPhase) => p === "running" || p === "reconnecting";

interface LaneRec {
	key: number;
	index: number;
	dc: DataChannelLike;
	onMessage: (ev: MessageEvent<string | ArrayBuffer>) => void;
	onClose: () => void;
}

interface BatchBase {
	id: number;
	p: BatchProgress;
	meter: RateMeter;
	lastEmit: number;
	timer: ReturnType<typeof setTimeout> | null;
	skippedBytes: number;
}

interface OutBatch extends BatchBase {
	side: "send";
	sources: Blob[];
	manifest: ManifestFile[];
	sched: Scheduler | null;
	sender: BatchSender | null;
	filesDone: Set<number>;
}

interface InBatch extends BatchBase {
	side: "receive";
	files: ManifestFile[];
	count: number;
	total: number;
	nextPart: number;
	complete: boolean;
	accepting: boolean;
	receiver: BatchReceiver | null;
}

type Batch = OutBatch | InBatch;

/** Splits a manifest into ctrl messages of ≤ 64 KiB and ≤ ~500 files (§7.2). */
export function manifestParts(batch: number, files: ManifestFile[], total: number): CtrlOf<"manifest">[] {
	const enc = new TextEncoder();
	const base = enc.encode(
		JSON.stringify({ t: "manifest", batch, part: 999999, last: false, files: [], count: files.length, total }),
	).length;
	const parts: CtrlOf<"manifest">[] = [];
	let cur: ManifestFile[] = [];
	let bytes = base;
	const flush = () => {
		parts.push({ t: "manifest", batch, part: parts.length, last: false, files: cur, count: files.length, total });
		cur = [];
		bytes = base;
	};
	for (const f of files) {
		const n = enc.encode(JSON.stringify(f)).length + 1;
		if (base + n > CTRL_MAX_BYTES) throw new RangeError(`path too long: ${f.path.slice(0, 80)}…`);
		if (cur.length >= MANIFEST_PART_FILES || bytes + n > CTRL_MAX_BYTES) flush();
		cur.push(f);
		bytes += n;
	}
	flush();
	(parts[parts.length - 1] as CtrlOf<"manifest">).last = true;
	return parts;
}

class Engine implements TransferEngine {
	private readonly session: PeerSession;
	private readonly t: Tuning;
	private readonly listeners = new Set<(e: EngineEvent) => void>();
	private readonly lanes = new Map<number, LaneRec>();
	private readonly unsubscribe: () => void;
	private nextKey = 1;
	private outCounter = 0;
	private lastInId = 0;
	private out: OutBatch | null = null;
	private inc: InBatch | null = null;
	private disposed = false;

	constructor(session: PeerSession, t: Tuning) {
		this.session = session;
		this.t = t;
		this.unsubscribe = session.on((e) => this.onSession(e));
		for (const lane of session.lanes()) this.attach(lane);
	}

	/** Direction bit of incoming batches. */
	private get remoteDir(): Dir {
		return this.session.dir === 1 ? 0 : 1;
	}

	/* ====================================================================================================
	 * Public API
	 * ================================================================================================== */

	send(files: SendFile[]): number {
		if (files.length === 0) throw new RangeError("no files");
		if (this.disposed) throw new Error("engine disposed");
		if (this.out && !isFinal(this.out.p.phase)) throw new Error("an outgoing batch is still active");
		if (this.outCounter >= MAX_BATCH_ID) throw new RangeError("too many batches in this session");
		const manifest: ManifestFile[] = files.map((f, i) => ({
			i,
			path: f.path,
			size: f.file.size,
			mtime: Math.max(0, Math.floor(f.file.lastModified || 0)),
		}));
		const total = manifest.reduce((n, f) => n + f.size, 0);
		const id = this.outCounter + 1;
		const parts = manifestParts(id, manifest, total);
		this.outCounter = id;
		const b: OutBatch = {
			...this.base(id, "send", manifest.length, total),
			side: "send",
			sources: files.map((f) => f.file),
			manifest,
			sched: null,
			sender: null,
			filesDone: new Set(),
		};
		this.out = b;
		for (const part of parts) this.sendCtrl(part);
		this.emitNow(b);
		return id;
	}

	async accept(batch: number, sink: ReceiveSink): Promise<void> {
		const b = this.inc;
		if (!b || b.id !== batch || !b.complete || b.p.phase !== "offered" || b.accepting)
			throw new Error(`batch ${batch} is not waiting for an answer`);
		b.accepting = true;
		let skipList: number[];
		try {
			({ skip: skipList } = await sink.begin(b.files));
		} catch {
			await sink.abort("error").catch(() => {});
			if (b.p.phase === "offered") {
				this.sendCtrl({ t: "cancel", batch, by: "receiver", reason: "error" });
				this.endIn(b, "failed", { error: "sink-error" });
			}
			return;
		}
		if (b.p.phase !== "offered" || this.disposed) {
			await sink.abort("cancelled").catch(() => {});
			return;
		}
		const skip = new Set(skipList.filter((i) => Number.isSafeInteger(i) && i >= 0 && i < b.files.length));
		const mode = acceptMode(sink);
		b.receiver = new BatchReceiver({
			batch,
			dir: this.remoteDir,
			files: b.files,
			skip,
			sink,
			tuning: this.t,
			onFileDone: (file) => {
				this.sendCtrl({ t: "file-done", batch, file });
				this.bump(b);
			},
			onDone: (location) => {
				this.sendCtrl({ t: "done", batch });
				this.endIn(b, "done", { location });
			},
			onFail: (code) => {
				this.sendCtrl({ t: "cancel", batch, by: "receiver", reason: code === "sink-error" ? "error" : "protocol" });
				this.endIn(b, "failed", { error: code });
				if (code !== "sink-error") this.session.close();
			},
			onProgress: () => this.bump(b),
		});
		b.skippedBytes = 0;
		for (const i of skip) b.skippedBytes += (b.files[i] as ManifestFile).size;
		b.p.mode = mode;
		b.p.skipped = skip.size;
		b.p.phase = "running";
		b.p.startedAt = Date.now();
		b.meter.reset();
		this.sendCtrl({ t: "accept", batch, mode, skip: [...skip].sort((x, y) => x - y) });
		b.receiver.start();
		this.emitNow(b);
	}

	decline(batch: number, reason: DeclineReason): void {
		const b = this.inc;
		if (!b || b.id !== batch || b.p.phase !== "offered") return;
		this.sendCtrl({ t: "decline", batch, reason });
		this.endIn(b, "declined", { declineReason: reason });
	}

	cancel(side: BatchSide, batch: number): void {
		if (side === "send") {
			const b = this.out;
			if (!b || b.id !== batch || isFinal(b.p.phase)) return;
			this.sendCtrl({ t: "cancel", batch, by: "sender", reason: "cancelled" });
			this.endOut(b, "cancelled", { cancelledBy: "sender" });
		} else {
			const b = this.inc;
			if (!b || b.id !== batch || isFinal(b.p.phase)) return;
			this.sendCtrl({ t: "cancel", batch, by: "receiver", reason: "cancelled" });
			this.endIn(b, "cancelled", { cancelledBy: "receiver" });
		}
	}

	on(listener: (e: EngineEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.out && !isFinal(this.out.p.phase)) this.endOut(this.out, "interrupted", {});
		if (this.inc && !isFinal(this.inc.p.phase)) this.endIn(this.inc, "interrupted", {});
		this.unsubscribe();
		for (const rec of [...this.lanes.values()]) this.detach(rec);
	}

	/* ====================================================================================================
	 * Session and lanes
	 * ================================================================================================== */

	private onSession(e: SessionEvent): void {
		if (this.disposed) return;
		switch (e.type) {
			case "lane-open":
				this.attach(e.lane);
				break;
			case "lane-lost":
				for (const rec of [...this.lanes.values()]) if (rec.index === e.index) this.detach(rec);
				break;
			case "reconnecting":
			case "reconnected":
				for (const b of [this.out, this.inc])
					if (b && isRunning(b.p.phase)) {
						b.p.phase = e.type === "reconnecting" ? "reconnecting" : "running";
						this.emitNow(b);
					}
				break;
			case "ctrl":
				this.onCtrl(e.msg);
				break;
			case "closed":
				this.dispose();
				break;
			case "path":
				break;
		}
	}

	private attach(lane: Lane): void {
		for (const r of this.lanes.values()) if (r.dc === lane.data) return;
		const dc = lane.data;
		dc.binaryType = "arraybuffer";
		const rec: LaneRec = {
			key: this.nextKey++,
			index: lane.index,
			dc,
			onMessage: (ev) => this.onLaneMessage(rec, ev.data),
			onClose: () => this.detach(rec),
		};
		dc.addEventListener("message", rec.onMessage);
		dc.addEventListener("close", rec.onClose);
		this.lanes.set(rec.key, rec);
		const out = this.out;
		if (out?.sender && isRunning(out.p.phase)) {
			out.sender.addLane(rec.key, dc);
			this.bump(out);
		}
	}

	private detach(rec: LaneRec): void {
		if (!this.lanes.delete(rec.key)) return;
		rec.dc.removeEventListener("message", rec.onMessage);
		rec.dc.removeEventListener("close", rec.onClose);
		const out = this.out;
		if (out?.sender && isRunning(out.p.phase)) {
			out.sender.removeLane(rec.key);
			this.bump(out);
		}
		if (this.inc && isRunning(this.inc.p.phase)) this.bump(this.inc);
	}

	private onLaneMessage(rec: LaneRec, data: unknown): void {
		if (this.disposed) return;
		if (typeof data === "string") this.onAck(rec, data);
		else if (data instanceof ArrayBuffer) this.onFrame(rec, data);
		else this.violation(null, "protocol"); // a Blob: binaryType wasn't honoured, or garbage
	}

	/** An ack for one of my outgoing batches. */
	private onAck(rec: LaneRec, text: string): void {
		const ack = parseAck(text);
		if (!ack || ack.d !== this.session.dir || ack.a > this.outCounter) {
			this.violation("send", "protocol");
			return;
		}
		const b = this.out;
		if (!b || ack.a !== b.id || !b.sender || !isRunning(b.p.phase)) return; // stale: an earlier or finished batch
		if (b.sender.onAck(rec.key, ack) === "violation") this.violation("send", "protocol");
	}

	/** A data frame of an incoming batch. */
	private onFrame(rec: LaneRec, data: ArrayBuffer): void {
		const f = decodeFrame(data);
		if (!f || f.header.dir !== this.remoteDir) {
			this.violation("receive", "protocol");
			return;
		}
		const b = this.inc;
		const batch = f.header.batch;
		if (b && batch === b.id) {
			if (b.receiver && isRunning(b.p.phase)) b.receiver.onFrame(rec.key, rec.dc, f.header, f.payload);
			else if (!isFinal(b.p.phase)) this.violation("receive", "protocol"); // bytes before accept
			return;
		}
		if (batch > this.lastInId) this.violation("receive", "protocol");
		// else: a straggler of an earlier batch.
	}

	/* ====================================================================================================
	 * Ctrl
	 * ================================================================================================== */

	private onCtrl(msg: TransferCtrl): void {
		switch (msg.t) {
			case "manifest": {
				this.onManifest(msg);
				return;
			}
			case "accept": {
				this.onAccept(msg);
				return;
			}
			case "decline": {
				const b = this.outFor(msg.batch);
				if (b && b.p.phase === "offered") this.endOut(b, "declined", { declineReason: msg.reason });
				return;
			}
			case "file-done": {
				const b = this.outFor(msg.batch);
				if (!b || !isRunning(b.p.phase)) return;
				if (msg.file >= b.manifest.length) {
					this.violation("send", "protocol");
					return;
				}
				b.filesDone.add(msg.file);
				this.bump(b);
				return;
			}
			case "done": {
				const b = this.outFor(msg.batch);
				if (b && isRunning(b.p.phase)) this.endOut(b, "done", {});
				return;
			}
			case "cancel": {
				this.onCancel(msg);
				return;
			}
		}
	}

	/** My outgoing batch with this id, or null (stale). A future id is a violation. */
	private outFor(batch: number): OutBatch | null {
		if (batch > this.outCounter) {
			this.violation(null, "protocol");
			return null;
		}
		return this.out && this.out.id === batch ? this.out : null;
	}

	private onManifest(msg: CtrlOf<"manifest">): void {
		let b = this.inc;
		if (msg.batch > this.lastInId) {
			if (b && !isFinal(b.p.phase)) {
				this.violation("receive", "protocol");
				return;
			}
			if (msg.part !== 0 || msg.count > MAX_MANIFEST_FILES || msg.total > MAX_OFFSET) {
				this.violation(null, "protocol");
				return;
			}
			this.lastInId = msg.batch;
			b = {
				...this.base(msg.batch, "receive", msg.count, msg.total),
				side: "receive",
				files: [],
				count: msg.count,
				total: msg.total,
				nextPart: 0,
				complete: false,
				accepting: false,
				receiver: null,
			};
			this.inc = b;
		} else if (!b || b.id !== msg.batch || b.complete) {
			this.violation("receive", "protocol");
			return;
		}
		if (msg.part !== b.nextPart || msg.count !== b.count || msg.total !== b.total) {
			this.violation("receive", "protocol");
			return;
		}
		for (const f of msg.files) {
			if (f.i !== b.files.length || b.files.length >= b.count) {
				this.violation("receive", "protocol");
				return;
			}
			b.files.push({ i: f.i, path: f.path, size: f.size, mtime: f.mtime });
		}
		b.nextPart++;
		if (!msg.last) return;
		let sum = 0;
		for (const f of b.files) sum += f.size;
		if (b.files.length !== b.count || sum !== b.total) {
			this.violation("receive", "protocol");
			return;
		}
		b.complete = true;
		this.emit({ type: "offer", offer: { batch: b.id, files: b.files, count: b.count, total: b.total } });
		this.emitNow(b);
	}

	private onAccept(msg: CtrlOf<"accept">): void {
		const b = this.outFor(msg.batch);
		if (b?.p.phase !== "offered") return;
		const skip = new Set<number>();
		for (const i of msg.skip) {
			if (i >= b.manifest.length) {
				this.violation("send", "protocol");
				return;
			}
			skip.add(i);
		}
		const sched = new Scheduler(
			b.manifest.map((f) => f.size),
			skip,
			isOrderedMode(msg.mode),
			this.t,
		);
		b.sched = sched;
		b.skippedBytes = 0;
		for (const i of skip) b.skippedBytes += (b.manifest[i] as ManifestFile).size;
		b.p.mode = msg.mode;
		b.p.skipped = skip.size;
		b.p.phase = "running";
		b.p.startedAt = Date.now();
		b.meter.reset();
		b.sender = new BatchSender({
			batch: b.id,
			dir: this.session.dir,
			files: b.sources,
			sched,
			tuning: this.t,
			chunk: chunkSize(undefined, this.t),
			onProgress: () => this.bump(b),
			onError: () => {
				if (!isRunning(b.p.phase)) return;
				this.sendCtrl({ t: "cancel", batch: b.id, by: "sender", reason: "error" });
				this.endOut(b, "failed", { error: "read-error" });
			},
			onLaneGone: (key) => b.sender?.removeLane(key),
		});
		for (const rec of this.lanes.values()) b.sender.addLane(rec.key, rec.dc);
		this.emitNow(b);
	}

	private onCancel(msg: CtrlOf<"cancel">): void {
		const error = (reason: CancelReason, readSide: boolean): FtErrorCode | null =>
			reason === "cancelled" ? null : reason === "protocol" ? "protocol" : readSide ? "read-error" : "sink-error";
		if (msg.by === "receiver") {
			const b = this.outFor(msg.batch);
			if (!b || isFinal(b.p.phase)) return;
			const err = error(msg.reason, false);
			this.endOut(b, err ? "failed" : "cancelled", { cancelledBy: "receiver", error: err });
		} else {
			if (msg.batch > this.lastInId) {
				this.violation(null, "protocol");
				return;
			}
			const b = this.inc;
			if (!b || b.id !== msg.batch || isFinal(b.p.phase)) return;
			const err = error(msg.reason, true);
			this.endIn(b, err ? "failed" : "cancelled", { cancelledBy: "sender", error: err });
		}
	}

	/** §7.3/§10: cancel the batch concerned with reason "protocol", then end the session (`bye`). */
	private violation(side: BatchSide | null, code: "protocol" | "flow-control"): void {
		if (this.disposed) return;
		const out = this.out;
		const inc = this.inc;
		if (side === "send" && out && !isFinal(out.p.phase)) {
			this.sendCtrl({ t: "cancel", batch: out.id, by: "sender", reason: "protocol" });
			this.endOut(out, "failed", { error: code });
		}
		if (side === "receive" && inc && !isFinal(inc.p.phase)) {
			this.sendCtrl({ t: "cancel", batch: inc.id, by: "receiver", reason: "protocol" });
			this.endIn(inc, "failed", { error: code });
		}
		this.session.close();
		this.dispose();
	}

	private sendCtrl(msg: TransferCtrl): void {
		try {
			this.session.sendCtrl(msg);
		} catch {
			// The session is closing; its `closed` event ends the batches.
		}
	}

	/* ====================================================================================================
	 * Batch state and progress
	 * ================================================================================================== */

	private base(id: number, side: BatchSide, files: number, bytes: number): BatchBase {
		return {
			id,
			meter: new RateMeter(),
			lastEmit: Number.NEGATIVE_INFINITY,
			timer: null,
			skippedBytes: 0,
			p: {
				batch: id,
				side,
				phase: "offered",
				mode: null,
				files,
				bytes,
				filesDone: 0,
				bytesDone: 0,
				skipped: 0,
				rate: 0,
				etaMs: null,
				current: [],
				lanes: this.lanes.size,
				startedAt: Date.now(),
				endedAt: null,
				location: null,
				declineReason: null,
				cancelledBy: null,
				error: null,
			},
		};
	}

	private endOut(b: OutBatch, phase: BatchPhase, extra: Partial<BatchProgress>): void {
		if (isFinal(b.p.phase)) return;
		b.sender?.stop();
		this.finish(b, phase, extra);
		b.sources = [];
	}

	private endIn(b: InBatch, phase: BatchPhase, extra: Partial<BatchProgress>): void {
		if (isFinal(b.p.phase)) return;
		if (phase !== "done" && b.receiver) void b.receiver.abort(phase === "interrupted" ? "interrupted" : "cancelled");
		this.finish(b, phase, extra);
	}

	private finish(b: Batch, phase: BatchPhase, extra: Partial<BatchProgress>): void {
		this.refresh(b);
		Object.assign(b.p, extra);
		if (phase === "done") {
			b.p.filesDone = b.p.files;
			b.p.bytesDone = b.p.bytes;
		}
		b.p.phase = phase;
		b.p.endedAt = Date.now();
		b.p.rate = 0;
		b.p.etaMs = phase === "done" ? 0 : null;
		b.p.current = [];
		this.emitNow(b, false);
	}

	/** Recompute the live numbers of a batch. */
	private refresh(b: Batch): void {
		const p = b.p;
		if (isFinal(p.phase)) return;
		p.lanes = this.lanes.size;
		let current: number[] = [];
		if (b.side === "send") {
			if (b.sched) p.bytesDone = Math.min(p.bytes, b.skippedBytes + b.sched.doneBytes);
			p.filesDone = Math.min(p.files, p.skipped + b.filesDone.size);
			current = b.sender?.current() ?? [];
		} else if (b.receiver) {
			p.bytesDone = Math.min(p.bytes, b.skippedBytes + b.receiver.bytesDone);
			p.filesDone = Math.min(p.files, p.skipped + b.receiver.filesDone);
			current = b.receiver.current();
		}
		const names = b.side === "send" ? b.manifest : b.files;
		p.current = current.slice(0, CURRENT_FILES_SHOWN).map((i) => (names[i] as ManifestFile).path);
		if (isRunning(p.phase)) {
			b.meter.push(p.bytesDone);
			p.rate = b.meter.rate;
			p.etaMs = b.meter.eta(p.bytes - p.bytesDone);
		}
	}

	/** Something changed: emit at most every PROGRESS_MIN_MS (§7.5). */
	private bump(b: Batch): void {
		if (isFinal(b.p.phase) || b.timer) return;
		const wait = b.lastEmit + PROGRESS_MIN_MS - performance.now();
		if (wait <= 0) this.emitNow(b);
		else
			b.timer = setTimeout(() => {
				b.timer = null;
				if (!isFinal(b.p.phase)) this.emitNow(b);
			}, wait);
	}

	private emitNow(b: Batch, refresh = true): void {
		if (b.timer) {
			clearTimeout(b.timer);
			b.timer = null;
		}
		if (refresh) this.refresh(b);
		b.lastEmit = performance.now();
		this.emit({ type: "progress", progress: { ...b.p, current: [...b.p.current] } });
	}

	private emit(e: EngineEvent): void {
		for (const l of [...this.listeners]) {
			try {
				l(e);
			} catch (err) {
				console.error(err);
			}
		}
	}
}

/** Creates the engine for a connected session. `t` defaults to the shared (benchmark-mutable) tuning. */
export function createEngine(session: PeerSession, t: Tuning = defaultTuning): TransferEngine {
	return new Engine(session, t);
}

createEngine satisfies CreateEngine;
