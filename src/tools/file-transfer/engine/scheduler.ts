// Range scheduler (SPEC §7.4, §7.5 requeue).
//
// Work is a list of ranges, built in manifest order with skipped files removed. Both policies work in
// *stream offsets* internally: the non-skipped files concatenated in manifest order. Each lane pulls a
// work item, streams it in order, then pulls again.
//
// - Unordered (folder, test): files ≤ rangeMax are one range; bigger files are cut into rangeMax
//   ranges, and at most `maxWritersPerFile` lanes hold ranges of one file at once. A lane that would
//   be one writer too many takes the next file instead (or waits).
// - Ordered (zip, memory, ordered test): the stream is cut into zipRange ranges (which may span files);
//   no range may end beyond ackedContiguous + reorderWindow.
//
// A lane's items are streamed in order, so its cumulative ack `w` says which items are complete. On
// lane loss the rest goes back to the front of the queue from the first unacked byte (by stream offset
// in ordered mode).
import { tuning as defaultTuning, type Tuning } from "../tuning.ts";
import type { ByteRange } from "../types.ts";
import { Notifier } from "./util.ts";

/** Where each non-skipped file sits in the batch stream. Sender and receiver compute it identically. */
export interface StreamLayout {
	/** Non-skipped files in manifest order (zero-size files included). */
	readonly files: readonly number[];
	/** Stream offset of each file by manifest index; -1 for skipped files. */
	readonly start: readonly number[];
	readonly sizes: readonly number[];
	/** Stream length: sum of non-skipped sizes. */
	readonly total: number;
}

export function streamLayout(sizes: readonly number[], skip: ReadonlySet<number>): StreamLayout {
	const files: number[] = [];
	const start: number[] = new Array(sizes.length).fill(-1);
	let total = 0;
	for (let i = 0; i < sizes.length; i++) {
		if (skip.has(i)) continue;
		files.push(i);
		start[i] = total;
		total += sizes[i] as number;
	}
	return { files, start, sizes, total };
}

/** One pull: `len` stream bytes from stream offset `g`, as per-file ranges (several when a zip range spans files). */
export interface Work {
	g: number;
	len: number;
	ranges: ByteRange[];
}

interface Item {
	g: number;
	len: number;
	/** Lane byte position where this item starts (sum of earlier items on the lane). */
	laneStart: number;
}

interface LaneState {
	assigned: number;
	acked: number;
	items: Item[];
	/** Unordered: the file whose range this lane is streaming now. */
	hold: number | null;
	dead: boolean;
	/** performance.now() of the lane's last ack advance (or its first pull). */
	movedAt: number;
}

/** Unordered queue node: one file's ranges still to hand out (file-local [start, end) pairs). */
interface FileWork {
	file: number;
	ranges: Array<[number, number]>;
	prev: FileWork | null;
	next: FileWork | null;
}

export class Scheduler {
	readonly ordered: boolean;
	readonly layout: StreamLayout;
	/** Woken when work may have become available: a hold released, acked contiguous moved, ranges requeued. */
	readonly changed = new Notifier();

	private readonly t: Tuning;
	private readonly lanes = new Map<number, LaneState>();
	/** Non-skipped files with bytes, and their stream starts, for stream → file lookups. */
	private readonly dataFiles: number[] = [];
	private readonly dataStart: number[] = [];

	// Unordered
	private head: FileWork | null = null;
	private tail: FileWork | null = null;
	private readonly nodes = new Map<number, FileWork>();
	private readonly holders = new Map<number, number>();
	private ackedSum = 0;

	// Ordered
	private cursor = 0;
	private requeued: Array<[number, number]> = [];
	private ackedC = 0;

	constructor(sizes: readonly number[], skip: Iterable<number>, ordered: boolean, t: Tuning = defaultTuning) {
		this.ordered = ordered;
		this.t = t;
		this.layout = streamLayout(sizes, new Set(skip));
		for (const f of this.layout.files) {
			if ((sizes[f] as number) === 0) continue;
			this.dataFiles.push(f);
			this.dataStart.push(this.layout.start[f] as number);
		}
		if (!ordered) {
			for (const f of this.dataFiles) {
				const size = sizes[f] as number;
				const ranges: Array<[number, number]> = [];
				const step = Math.min(size, t.rangeMax);
				for (let s = 0; s < size; s += step) ranges.push([s, Math.min(size, s + step)]);
				this.append(f, ranges);
			}
		}
	}

	get total(): number {
		return this.layout.total;
	}

	/** Contiguous stream bytes the receiver reported persisted (ordered mode). */
	get ackedContiguous(): number {
		return this.ackedC;
	}

	/** Bytes the receiver confirmed: ack-based in unordered mode, the contiguous mark in ordered mode. */
	get doneBytes(): number {
		return this.ordered ? this.ackedC : this.ackedSum;
	}

	/** Lanes holding a range of `file` now (unordered). */
	writers(file: number): number {
		return this.holders.get(file) ?? 0;
	}

	/** File a lane is streaming now (unordered), for progress names. */
	holding(lane: number): number | null {
		return this.lanes.get(lane)?.hold ?? null;
	}

	/** True when nothing is left to hand out (lanes may still be streaming or waiting for acks). */
	get queueEmpty(): boolean {
		return this.ordered ? this.cursor >= this.total && this.requeued.length === 0 : this.head === null;
	}

	/** Bytes assigned to `lane` but not acked yet. */
	unacked(lane: number): number {
		const st = this.lanes.get(lane);
		return st ? st.assigned - st.acked : 0;
	}

	/**
	 * The next work item for `lane`, or null when none is available now (queue empty, writer limit, or
	 * reorder window). Calling it means the lane finished streaming its previous item.
	 */
	next(lane: number): Work | null {
		const st = this.lane(lane);
		if (st.dead) return null;
		this.release(st);
		const item = this.ordered ? this.takeOrdered() : this.takeUnordered(st);
		if (!item) return null;
		st.items.push({ g: item[0], len: item[1] - item[0], laneStart: st.assigned });
		st.assigned += item[1] - item[0];
		return { g: item[0], len: item[1] - item[0], ranges: this.toRanges(item[0], item[1]) };
	}

	/** Cumulative bytes from `lane` the receiver persisted (ack `w`). */
	ack(lane: number, w: number): void {
		const st = this.lanes.get(lane);
		if (!st || st.dead || w <= st.acked) return;
		w = Math.min(w, st.assigned);
		this.ackedSum += w - st.acked;
		st.acked = w;
		st.movedAt = performance.now();
		while (st.items.length > 0) {
			const it = st.items[0] as Item;
			if (it.laneStart + it.len > w) break;
			st.items.shift();
		}
	}

	/** Ordered mode: the receiver's contiguous mark (ack `c`). Returns true when it moved. */
	contiguous(c: number): boolean {
		c = Math.min(c, this.total);
		if (c <= this.ackedC) return false;
		this.ackedC = c;
		this.changed.notify();
		return true;
	}

	/** A lane is gone: requeue everything it was given but the receiver didn't ack. */
	laneLost(lane: number): void {
		const st = this.lanes.get(lane);
		if (!st || st.dead) return;
		st.dead = true;
		this.release(st);
		const back: Array<[number, number]> = [];
		for (const it of st.items) {
			const done = Math.min(it.len, Math.max(0, st.acked - it.laneStart));
			if (done < it.len) back.push([it.g + done, it.g + it.len]);
		}
		st.items = [];
		if (this.ordered) {
			for (const r of back) {
				let i = 0;
				while (i < this.requeued.length && (this.requeued[i] as [number, number])[0] < r[0]) i++;
				this.requeued.splice(i, 0, r);
			}
		} else {
			// Back to the front, keeping their order: prepend in reverse.
			for (let k = back.length - 1; k >= 0; k--) {
				const [gs, ge] = back[k] as [number, number];
				const file = this.fileAt(gs);
				const base = this.layout.start[file] as number;
				this.prepend(file, [gs - base, ge - base]);
			}
		}
		this.changed.notify();
	}

	/**
	 * Ordered mode, head-of-line (§7.4): when every lane holding the byte at the contiguous mark has had no
	 * ack for `staleMs`, offer that lane's unacked items again (from the mark on), so other lanes deliver
	 * them while it is stuck. The receiver drops whichever copy comes second. Returns true when something
	 * was requeued.
	 */
	hedge(staleMs = 0): boolean {
		if (!this.ordered) return false;
		const c = this.ackedC;
		if (c >= this.total) return false;
		const now = performance.now();
		const holding = [...this.lanes.values()].filter(
			(st) => !st.dead && st.items.some((it) => it.g <= c && c < it.g + it.len),
		);
		// Nobody holds it (it waits in the queue), or a copy is moving on a live lane.
		if (holding.length === 0 || holding.some((st) => now - st.movedAt < staleMs)) return false;
		let added = false;
		for (const st of holding)
			for (const it of st.items) {
				const r: [number, number] = [Math.max(c, it.g), it.g + it.len];
				if (r[0] >= r[1] || this.requeued.some(([s, e]) => s <= r[0] && r[1] <= e)) continue;
				let i = 0;
				while (i < this.requeued.length && (this.requeued[i] as [number, number])[0] < r[0]) i++;
				this.requeued.splice(i, 0, r);
				added = true;
			}
		if (added) this.changed.notify();
		return added;
	}

	/* ---------- internals */

	private lane(key: number): LaneState {
		let st = this.lanes.get(key);
		if (!st) {
			st = { assigned: 0, acked: 0, items: [], hold: null, dead: false, movedAt: performance.now() };
			this.lanes.set(key, st);
		}
		return st;
	}

	private release(st: LaneState): void {
		if (st.hold === null) return;
		const n = (this.holders.get(st.hold) ?? 1) - 1;
		if (n > 0) this.holders.set(st.hold, n);
		else this.holders.delete(st.hold);
		st.hold = null;
		this.changed.notify();
	}

	private takeOrdered(): [number, number] | null {
		const limit = this.ackedC + this.t.reorderWindow;
		while (this.requeued.length > 0) {
			const r = this.requeued[0] as [number, number];
			const s = Math.max(r[0], this.ackedC);
			if (s >= r[1]) {
				this.requeued.shift();
				continue;
			}
			if (r[1] > limit) return null;
			this.requeued.shift();
			return [s, r[1]];
		}
		if (this.cursor >= this.total) return null;
		const s = Math.max(this.cursor, this.ackedC);
		const e = Math.min(this.total, s + this.t.zipRange);
		if (e > limit) return null;
		this.cursor = e;
		return [s, e];
	}

	private takeUnordered(st: LaneState): [number, number] | null {
		for (let n = this.head; n; n = n.next) {
			if (this.writers(n.file) >= this.t.maxWritersPerFile) continue;
			const r = n.ranges.shift() as [number, number];
			if (n.ranges.length === 0) this.unlink(n);
			this.holders.set(n.file, this.writers(n.file) + 1);
			st.hold = n.file;
			const base = this.layout.start[n.file] as number;
			return [base + r[0], base + r[1]];
		}
		return null;
	}

	private append(file: number, ranges: Array<[number, number]>): void {
		const n: FileWork = { file, ranges, prev: this.tail, next: null };
		if (this.tail) this.tail.next = n;
		else this.head = n;
		this.tail = n;
		this.nodes.set(file, n);
	}

	private prepend(file: number, r: [number, number]): void {
		let n = this.nodes.get(file);
		if (n) this.unlink(n);
		n = { file, ranges: n ? [r, ...n.ranges] : [r], prev: null, next: this.head };
		if (this.head) this.head.prev = n;
		else this.tail = n;
		this.head = n;
		this.nodes.set(file, n);
	}

	private unlink(n: FileWork): void {
		if (n.prev) n.prev.next = n.next;
		else this.head = n.next;
		if (n.next) n.next.prev = n.prev;
		else this.tail = n.prev;
		n.prev = n.next = null;
		this.nodes.delete(n.file);
	}

	/** Index into dataFiles of the file containing stream offset g (g < total). */
	private dataIndex(g: number): number {
		let lo = 0;
		let hi = this.dataStart.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((this.dataStart[mid] as number) <= g) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	private fileAt(g: number): number {
		return this.dataFiles[this.dataIndex(g)] as number;
	}

	private toRanges(gs: number, ge: number): ByteRange[] {
		const out: ByteRange[] = [];
		for (let k = this.dataIndex(gs); gs < ge && k < this.dataFiles.length; k++) {
			const file = this.dataFiles[k] as number;
			const base = this.dataStart[k] as number;
			const end = Math.min(ge, base + (this.layout.sizes[file] as number));
			if (end > gs) out.push({ file, start: gs - base, end: end - base });
			gs = end;
		}
		return out;
	}
}
