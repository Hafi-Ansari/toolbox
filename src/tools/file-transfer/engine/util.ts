// Small async helpers shared by the engine (WP2).
import type { DataChannelLike } from "../types.ts";

/** Thrown into a waiting loop when its lane or batch stops. */
export class Stopped extends Error {
	constructor(reason = "stopped") {
		super(reason);
		this.name = "Stopped";
	}
}

/** Wakes every current waiter on `notify()`. Waiters re-check their condition (no lost-wakeup: check, then wait, with no await between). */
export class Notifier {
	private waiters = new Set<() => void>();

	notify(): void {
		const ws = [...this.waiters];
		this.waiters.clear();
		for (const w of ws) w();
	}

	wait(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(new Stopped());
		return new Promise<void>((resolve, reject) => {
			const done = () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				this.waiters.delete(done);
				reject(new Stopped());
			};
			this.waiters.add(done);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/**
 * Resolves on the channel's next `bufferedamountlow` or `close`/`error` (the caller re-checks
 * `readyState`), rejects with `Stopped` when `signal` aborts.
 */
export function drained(dc: DataChannelLike, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new Stopped());
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			dc.removeEventListener("bufferedamountlow", onEvent);
			dc.removeEventListener("close", onEvent);
			dc.removeEventListener("error", onEvent);
			signal.removeEventListener("abort", onAbort);
		};
		const onEvent = () => {
			cleanup();
			resolve();
		};
		const onAbort = () => {
			cleanup();
			reject(new Stopped());
		};
		dc.addEventListener("bufferedamountlow", onEvent);
		dc.addEventListener("close", onEvent);
		dc.addEventListener("error", onEvent);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * A set of half-open intervals [start, end), kept sorted and merged. Used for "which bytes of a file
 * are claimed" (receiver) so every byte reaches the sink exactly once.
 */
export class IntervalSet {
	/** Flat [s0, e0, s1, e1, …], sorted, disjoint, non-adjacent. */
	private v: number[] = [];

	/** Bytes covered. */
	get size(): number {
		let n = 0;
		for (let i = 0; i < this.v.length; i += 2) n += (this.v[i + 1] as number) - (this.v[i] as number);
		return n;
	}

	/** True when [start, end) is fully covered. */
	covers(start: number, end: number): boolean {
		if (end <= start) return true;
		for (let i = 0; i < this.v.length; i += 2) {
			const s = this.v[i] as number;
			const e = this.v[i + 1] as number;
			if (s <= start && end <= e) return true;
			if (s > start) return false;
		}
		return false;
	}

	/** The parts of [start, end) not covered, in order. */
	gaps(start: number, end: number): Array<[number, number]> {
		const out: Array<[number, number]> = [];
		let pos = start;
		for (let i = 0; i < this.v.length && pos < end; i += 2) {
			const s = this.v[i] as number;
			const e = this.v[i + 1] as number;
			if (e <= pos) continue;
			if (s >= end) break;
			if (s > pos) out.push([pos, s]);
			pos = Math.max(pos, e);
		}
		if (pos < end) out.push([pos, end]);
		return out;
	}

	add(start: number, end: number): void {
		if (end <= start) return;
		const v = this.v;
		let i = 0;
		while (i < v.length && (v[i + 1] as number) < start) i += 2;
		let j = i;
		let s = start;
		let e = end;
		while (j < v.length && (v[j] as number) <= e) {
			s = Math.min(s, v[j] as number);
			e = Math.max(e, v[j + 1] as number);
			j += 2;
		}
		v.splice(i, j - i, s, e);
	}
}
