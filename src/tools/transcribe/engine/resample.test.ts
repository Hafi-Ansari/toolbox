import { describe, expect, it } from "vitest";
import { downmix, Resampler } from "./resample.ts";

const sine = (freq: number, rate: number, seconds: number, amp = 0.5) =>
	Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

/** Runs the resampler over `input` in pieces of `piece` samples. */
function run(r: Resampler, input: Float32Array, piece: number): Float32Array {
	const parts: Float32Array[] = [];
	for (let i = 0; i < input.length; i += piece) parts.push(r.push(input.subarray(i, i + piece)));
	parts.push(r.flush());
	const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Amplitude of `freq` in `x` (single-bin DFT). */
function amplitude(x: Float32Array, freq: number, rate: number): number {
	let re = 0;
	let im = 0;
	for (let i = 0; i < x.length; i++) {
		re += x[i] * Math.cos((2 * Math.PI * freq * i) / rate);
		im += x[i] * Math.sin((2 * Math.PI * freq * i) / rate);
	}
	return (2 * Math.hypot(re, im)) / x.length;
}

describe("Resampler", () => {
	for (const rate of [48_000, 44_100, 22_050, 8_000]) {
		it(`turns ${rate} Hz into 16 kHz with the right length and pitch`, () => {
			const out = run(new Resampler(rate), sine(440, rate, 2), 1013);
			expect(out.length).toBe(32_000);
			const middle = out.subarray(4000, 28_000); // away from the edges
			expect(amplitude(middle, 440, 16_000)).toBeCloseTo(0.5, 2);
		});
	}

	it("gives the same result whatever the piece size", () => {
		const input = sine(1000, 44_100, 0.5);
		const a = run(new Resampler(44_100), input, 64);
		const b = run(new Resampler(44_100), input, 100_000);
		expect(a.length).toBe(b.length);
		let maxDiff = 0;
		for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
		expect(maxDiff).toBeLessThan(1e-6);
	});

	it("removes frequencies above the new Nyquist", () => {
		const out = run(new Resampler(48_000), sine(12_000, 48_000, 1), 4096);
		expect(amplitude(out.subarray(2000, 14_000), 4000, 16_000)).toBeLessThan(0.005); // 12 kHz would alias to 4 kHz
	});

	it("passes 16 kHz through untouched", () => {
		const input = sine(300, 16_000, 0.1);
		expect(run(new Resampler(16_000), input, 333)).toEqual(input);
	});
});

describe("downmix", () => {
	it("averages channels", () => {
		expect(Array.from(downmix([Float32Array.of(1, 0), Float32Array.of(0, 1)]))).toEqual([0.5, 0.5]);
	});
});
