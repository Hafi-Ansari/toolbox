// Streaming resampler: decoded audio arrives in small pieces at the file's own rate (44.1 or
// 48 kHz, usually); Whisper wants 16 kHz mono. A windowed-sinc low-pass filter evaluated at each
// output position, carrying the filter's history across pieces, so piece boundaries leave no seam.
// The filter is precomputed per phase (polyphase), so each output costs one dot product.

/** Zero crossings of the sinc kept on each side. 12 is plenty for speech recognition. */
const HALF_TAPS = 12;
/** Rate pairs with more distinct phases than this (odd rates) round to the nearest of this many. */
const MAX_PHASES = 4096;

export class Resampler {
	private readonly up: number; // L: output samples per gcd period
	private readonly down: number; // M: input samples per gcd period
	private readonly phases: number;
	private readonly taps: number;
	private readonly table: Float32Array; // phases × taps
	private buf = new Float32Array(0);
	private base = 0; // input index of buf[0]
	private produced = 0; // output samples so far
	private consumed = 0; // input samples so far

	constructor(inRate: number, outRate = 16_000) {
		const g = gcd(Math.round(inRate), Math.round(outRate));
		this.up = Math.round(outRate) / g;
		this.down = Math.round(inRate) / g;
		this.phases = Math.min(this.up, MAX_PHASES);
		// Below the output Nyquist, with a little room for the filter's transition band.
		const cutoff = Math.min(1, outRate / inRate) * 0.94;
		const radius = Math.ceil(HALF_TAPS / cutoff);
		this.taps = 2 * radius;
		this.table = new Float32Array(this.phases * this.taps);
		for (let p = 0; p < this.phases; p++) {
			const frac = p / this.phases;
			let sum = 0;
			for (let k = 0; k < this.taps; k++) {
				// Tap k reads input sample center - radius + 1 + k; its distance from the output position:
				const t = frac + radius - 1 - k;
				const w = kernel(t, cutoff, radius);
				this.table[p * this.taps + k] = w;
				sum += w;
			}
			for (let k = 0; k < this.taps; k++) this.table[p * this.taps + k] /= sum; // unity gain at DC
		}
	}

	/** Feeds mono input; returns every output sample that the input so far fully determines. */
	push(input: Float32Array): Float32Array {
		if (this.up === this.down) return input.slice();
		const merged = new Float32Array(this.buf.length + input.length);
		merged.set(this.buf);
		merged.set(input, this.buf.length);
		this.buf = merged;
		this.consumed += input.length;
		return this.drain(this.consumed, Number.POSITIVE_INFINITY);
	}

	/** Emits the tail, treating the input as followed by silence. */
	flush(): Float32Array {
		if (this.up === this.down) return new Float32Array(0);
		const end = this.consumed;
		const padded = new Float32Array(this.buf.length + this.taps);
		padded.set(this.buf);
		this.buf = padded;
		// Output positions before the end of the input: ceil(end · L / M) samples in all.
		const out = this.drain(Number.POSITIVE_INFINITY, Math.ceil((end * this.up) / this.down));
		this.buf = new Float32Array(0);
		this.base = end;
		return out;
	}

	/** Outputs whose filter window ends before input index `available`, up to `limit` outputs in all. */
	private drain(available: number, limit: number): Float32Array {
		const { up, down, phases, taps, table, buf, base } = this;
		const radius = taps / 2;
		// Output n needs input up to floor(n·M/L) + radius, so n < (available − radius)·L/M.
		const count = Math.max(0, Math.min(limit, Math.ceil(((available - radius) * up) / down)) - this.produced);
		const out = new Float32Array(count);
		for (let n = 0; n < count; n++) {
			const num = this.produced * down;
			const center = Math.floor(num / up);
			const phase =
				phases === up ? num - center * up : Math.min(phases - 1, Math.floor(((num - center * up) / up) * phases));
			const row = phase * taps;
			const first = center - radius + 1 - base;
			let acc = 0;
			for (let k = Math.max(0, -first); k < taps; k++) acc += buf[first + k] * table[row + k]; // before sample 0: silence
			out[n] = acc;
			this.produced++;
		}
		// Keep only the history the next output still needs.
		const keepFrom = Math.max(base, Math.floor((this.produced * down) / up) - radius + 1);
		if (keepFrom > base) {
			this.buf = buf.slice(keepFrom - base);
			this.base = keepFrom;
		}
		return out;
	}
}

/** Low-pass sinc at `cutoff`, under a Blackman window `radius` samples wide on each side. */
function kernel(t: number, cutoff: number, radius: number): number {
	const r = t / radius;
	if (r <= -1 || r >= 1) return 0;
	const x = t * cutoff;
	const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
	const window = 0.42 + 0.5 * Math.cos(Math.PI * r) + 0.08 * Math.cos(2 * Math.PI * r);
	return sinc * window;
}

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a;
}

/** Averages the channels into one. */
export function downmix(planes: Float32Array[]): Float32Array {
	if (planes.length === 1) return planes[0];
	const n = planes[0].length;
	const out = new Float32Array(n);
	for (const plane of planes) for (let i = 0; i < n; i++) out[i] += plane[i];
	const k = 1 / planes.length;
	for (let i = 0; i < n; i++) out[i] *= k;
	return out;
}
