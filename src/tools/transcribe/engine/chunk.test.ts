import { describe, expect, it } from "vitest";
import { Chunker, frameRms, RATE, speechRanges, type Window } from "./chunk.ts";

/** Speech stand-in: a 200 Hz tone whose loudness wobbles 4 times a second (dips but never silence). */
const voice = (seconds: number) =>
	Float32Array.from(
		{ length: Math.round(seconds * RATE) },
		(_, i) => (0.2 + 0.15 * Math.sin((2 * Math.PI * 4 * i) / RATE)) * Math.sin((2 * Math.PI * 200 * i) / RATE),
	);
const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE));

function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function chunkAll(audio: Float32Array, piece = 7919): Window[] {
	const c = new Chunker();
	const windows: Window[] = [];
	for (let i = 0; i < audio.length; i += piece) windows.push(...c.push(audio.subarray(i, i + piece)));
	windows.push(...c.flush());
	return windows;
}

describe("speechRanges", () => {
	it("removes long silences but keeps padding and short pauses", () => {
		const rms = Float32Array.from([1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1]);
		expect(speechRanges(rms, 0.5, 5, 1)).toEqual([
			[0, 5],
			[9, 12],
		]);
	});

	it("drops leading and trailing silence, keeping the padding next to speech", () => {
		const rms = Float32Array.from([0, 0, 0, 1, 1, 0, 0, 0]);
		expect(speechRanges(rms, 0.5, 3, 1)).toEqual([[2, 6]]);
	});
});

describe("Chunker", () => {
	it("makes windows of at most 30 s that cover the audio", () => {
		const windows = chunkAll(voice(100));
		expect(windows.length).toBeGreaterThanOrEqual(4);
		for (const w of windows) expect(w.audio.length).toBeLessThanOrEqual(29.5 * RATE);
		expect(windows.reduce((n, w) => n + w.audio.length, 0)).toBe(100 * RATE);
		expect(windows[0].start).toBe(0);
		expect(windows.at(-1)?.end).toBeCloseTo(100, 2);
	});

	it("removes a long silence and maps times across it", () => {
		const windows = chunkAll(concat(voice(10), silence(20), voice(10)));
		expect(windows).toHaveLength(1);
		const [w] = windows;
		expect(w.audio.length / RATE).toBeCloseTo(20.8, 1); // 0.4 s kept each side of the gap
		expect(w.toMedia(5)).toBeCloseTo(5, 3);
		expect(w.toMedia(15)).toBeCloseTo(15 - 10.4 + 29.6, 3); // compacted 10.4 s = media 29.6 s
		expect(w.quiet(12, 28)).toBe(true);
		expect(w.quiet(0, 10)).toBe(false);
	});

	it("cuts windows at quiet moments", () => {
		// Speech with a 1 s pause at 22 s: too short to remove, the natural place to cut.
		const windows = chunkAll(concat(voice(22), silence(1), voice(20)));
		expect(windows[0].end).toBeGreaterThan(22);
		expect(windows[0].end).toBeLessThan(23);
	});

	it("produces nothing for pure silence", () => {
		expect(chunkAll(silence(60))).toEqual([]);
	});

	it("handles long input in blocks with continuous timing", () => {
		const windows = chunkAll(voice(400), 48_000);
		for (let i = 1; i < windows.length; i++) expect(windows[i].start).toBeCloseTo(windows[i - 1].end + 1 / RATE, 3);
		expect(windows.at(-1)?.end).toBeCloseTo(400, 2);
	});
});

describe("frameRms", () => {
	it("measures 100 ms frames", () => {
		const rms = frameRms(
			concat(
				silence(0.1),
				Float32Array.from({ length: 1600 }, () => 0.5),
			),
		);
		expect(Array.from(rms)).toEqual([0, 0.5]);
	});
});
