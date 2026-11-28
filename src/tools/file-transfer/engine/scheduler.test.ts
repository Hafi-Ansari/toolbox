import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING, type Tuning } from "../tuning.ts";
import { Scheduler, streamLayout, type Work } from "./scheduler.ts";

const MiB = 2 ** 20;
const T: Tuning = { ...DEFAULT_TUNING };

/** Drain every lane round-robin, acking everything; returns the work in hand-out order. */
function drainAll(s: Scheduler, lanes: number[]): Work[] {
	const out: Work[] = [];
	const acked = new Map<number, number>();
	for (let guard = 0; guard < 100_000; guard++) {
		let progress = false;
		for (const l of lanes) {
			const w = s.next(l);
			if (!w) continue;
			progress = true;
			out.push(w);
			acked.set(l, (acked.get(l) ?? 0) + w.len);
			s.ack(l, acked.get(l) as number);
			if (s.ordered) s.contiguous(w.g + w.len);
		}
		if (!progress) break;
	}
	return out;
}

describe("streamLayout", () => {
	it("concatenates non-skipped files in manifest order", () => {
		const l = streamLayout([10, 0, 5, 7], new Set([2]));
		expect(l.files).toEqual([0, 1, 3]);
		expect(l.start).toEqual([0, 10, -1, 10]);
		expect(l.total).toBe(17);
	});
});

describe("Scheduler, unordered", () => {
	it("hands out small files as single ranges, in manifest order, without skipped or empty files", () => {
		const s = new Scheduler([5 * MiB, 0, 32 * MiB, 1, 3 * MiB], [4], false, T);
		const w = drainAll(s, [1]);
		expect(w.map((x) => x.ranges)).toEqual([
			[{ file: 0, start: 0, end: 5 * MiB }],
			[{ file: 2, start: 0, end: 32 * MiB }],
			[{ file: 3, start: 0, end: 1 }],
		]);
		expect(s.queueEmpty).toBe(true);
		expect(s.doneBytes).toBe(37 * MiB + 1);
	});

	it("cuts big files into rangeMax ranges", () => {
		const s = new Scheduler([70 * MiB], [], false, T);
		const w = drainAll(s, [1, 2]);
		expect(w.flatMap((x) => x.ranges).map((r) => [r.start / MiB, r.end / MiB])).toEqual([
			[0, 32],
			[32, 64],
			[64, 70],
		]);
	});

	it("lets at most maxWritersPerFile lanes hold one file", () => {
		const s = new Scheduler([200 * MiB, 10 * MiB], [], false, T);
		const a = s.next(1);
		const b = s.next(2);
		const c = s.next(3);
		expect(a?.ranges[0]?.file).toBe(0);
		expect(b?.ranges[0]?.file).toBe(0);
		expect(s.writers(0)).toBe(2);
		expect(c?.ranges[0]?.file).toBe(1); // a third writer takes the next file instead
		expect(s.next(4)).toBeNull(); // nothing else it may take
		// Lane 1 finished its range: its hold is released when it pulls again.
		const a2 = s.next(1);
		expect(a2?.ranges[0]?.file).toBe(0);
		expect(s.writers(0)).toBe(2);
		expect(s.next(4)).toBeNull();
		s.laneLost(2); // releases lane 2's hold (and requeues its unacked range)
		expect(s.writers(0)).toBe(1);
		const d = s.next(4);
		expect(d?.ranges[0]).toEqual({ file: 0, start: 32 * MiB, end: 64 * MiB }); // lane 2's range, back at the front
	});

	it("requeues a lost lane's unacked ranges from the first unacked byte", () => {
		const s = new Scheduler([10 * MiB, 20 * MiB, 30 * MiB], [], false, T);
		const w1 = s.next(1); // file 0
		const w2 = s.next(1); // file 1 (lane streamed file 0, pulled again)
		expect(w1?.ranges[0]?.file).toBe(0);
		expect(w2?.ranges[0]?.file).toBe(1);
		s.ack(1, 10 * MiB + 4 * MiB); // all of file 0, 4 MiB of file 1
		expect(s.doneBytes).toBe(14 * MiB);
		s.laneLost(1);
		expect(s.next(1)).toBeNull(); // a dead lane gets nothing
		const r = s.next(2);
		expect(r?.ranges).toEqual([{ file: 1, start: 4 * MiB, end: 20 * MiB }]);
		expect(s.next(3)?.ranges).toEqual([{ file: 2, start: 0, end: 30 * MiB }]);
		expect(s.queueEmpty).toBe(true);
	});

	it("keeps requeued pieces in order at the front", () => {
		const s = new Scheduler([MiB, MiB, MiB, MiB], [], false, T);
		s.next(1);
		s.next(1);
		s.next(1); // lane 1 has files 0, 1, 2; nothing acked
		s.ack(1, MiB / 2);
		s.laneLost(1);
		const got = drainAll(s, [2]).map((w) => w.ranges[0]);
		expect(got).toEqual([
			{ file: 0, start: MiB / 2, end: MiB },
			{ file: 1, start: 0, end: MiB },
			{ file: 2, start: 0, end: MiB },
			{ file: 3, start: 0, end: MiB },
		]);
	});
});

describe("Scheduler, ordered", () => {
	it("cuts the stream into zipRange ranges that may span files", () => {
		const t = { ...T, zipRange: 100, reorderWindow: 1000 };
		const s = new Scheduler([60, 0, 70, 30, 200], [3], true, t);
		expect(s.next(1)?.ranges).toEqual([
			{ file: 0, start: 0, end: 60 },
			{ file: 2, start: 0, end: 40 },
		]);
		expect(s.next(2)?.ranges).toEqual([
			{ file: 2, start: 40, end: 70 },
			{ file: 4, start: 0, end: 70 },
		]);
		expect(s.total).toBe(330);
	});

	it("never hands out a range ending beyond ackedContiguous + reorderWindow", () => {
		const t = { ...T, zipRange: MiB, reorderWindow: 8 * MiB };
		const s = new Scheduler([100 * MiB], [], true, t);
		const got: Work[] = [];
		for (let i = 0; i < 20; i++) {
			const w = s.next(i % 4);
			if (w) got.push(w);
		}
		expect(got.length).toBe(8);
		expect(Math.max(...got.map((w) => w.g + w.len))).toBeLessThanOrEqual(8 * MiB);
		expect(s.next(0)).toBeNull();
		expect(s.contiguous(3 * MiB)).toBe(true);
		expect(s.contiguous(2 * MiB)).toBe(false); // never moves back
		const more: Work[] = [];
		for (let w = s.next(0); w; w = s.next(0)) more.push(w);
		expect(more.length).toBe(3);
		expect(Math.max(...more.map((w) => w.g + w.len))).toBe(11 * MiB);
		expect(s.doneBytes).toBe(3 * MiB);
	});

	it("requeues by stream offset, sorted, and drops what the receiver already has", () => {
		const t = { ...T, zipRange: 100, reorderWindow: 10_000 };
		const s = new Scheduler([1000], [], true, t);
		s.next(1); // 0-100
		s.next(2); // 100-200
		s.next(1); // 200-300
		s.next(2); // 300-400
		s.ack(2, 50); // lane 2 has 100-150 placed
		s.laneLost(2); // → 150-200, 300-400
		s.contiguous(170); // the receiver already persisted up to 170
		s.laneLost(1); // → 0-100, 200-300 (trimmed below 170 when handed out)
		const got = drainAll(s, [3]).map((w) => [w.g, w.g + w.len]);
		expect(got.slice(0, 3)).toEqual([
			[170, 200],
			[200, 300],
			[300, 400],
		]);
		expect(got[3]).toEqual([400, 500]);
	});

	it("hedges: offers the range holding the contiguous mark again, once until it is taken", () => {
		const s = new Scheduler([4 * MiB], [], true, T);
		const a = s.next(1) as Work; // [0, 1 MiB) on lane 1
		const b = s.next(2) as Work; // [1, 2 MiB) on lane 2
		expect([a.g, b.g]).toEqual([0, MiB]);
		s.ack(1, MiB / 2);
		s.contiguous(MiB / 2); // lane 1 delivered half of its range, then stalled
		expect(s.hedge()).toBe(true);
		expect(s.hedge()).toBe(false); // already waiting for a lane
		const copy = s.next(3) as Work;
		expect([copy.g, copy.len]).toEqual([MiB / 2, MiB / 2]);
		s.contiguous(4 * MiB);
		expect(s.hedge()).toBe(false); // nothing left
		expect(new Scheduler([MiB], [], false, T).hedge()).toBe(false); // unordered never hedges
	});
});
