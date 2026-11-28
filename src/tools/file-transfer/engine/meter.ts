// Throughput over a sliding window of recent samples (from WebDrop's RateMeter, §7.5).

export class RateMeter {
	private samples: Array<[time: number, bytes: number]> = [];
	private readonly windowMs: number;

	constructor(windowMs = 3000) {
		this.windowMs = windowMs;
	}

	/** Record the running total of persisted bytes at `now` (ms). */
	push(bytes: number, now = performance.now()): void {
		const last = this.samples[this.samples.length - 1];
		if (last && last[0] === now) last[1] = bytes;
		else this.samples.push([now, bytes]);
		while (this.samples.length > 2 && now - (this.samples[0] as [number, number])[0] > this.windowMs)
			this.samples.shift();
	}

	/** Bytes per second, 0 until there are at least 250 ms of samples. */
	get rate(): number {
		const first = this.samples[0];
		const last = this.samples[this.samples.length - 1];
		if (!first || !last || last[0] - first[0] < 250) return 0;
		return Math.max(0, ((last[1] - first[1]) * 1000) / (last[0] - first[0]));
	}

	/** Milliseconds left for `remaining` bytes, or null while the rate is unknown. */
	eta(remaining: number): number | null {
		if (remaining <= 0) return 0;
		const r = this.rate;
		return r > 0 ? Math.round((remaining * 1000) / r) : null;
	}

	reset(): void {
		this.samples = [];
	}
}
