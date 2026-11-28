// Cuts the 16 kHz stream into Whisper-sized windows (at most 30 s), the way faster-whisper's VAD
// path does: long silences are removed first (Whisper invents text on silence), then the remaining
// audio is cut at its quietest moments so no word is split. Each window remembers where its audio
// came from, so its timestamps map back to the media's own timeline.
//
// Audio is analysed in blocks of about two minutes, cut at a quiet moment too: memory stays small
// however long the file is.

export const RATE = 16_000;
const FRAME = RATE / 10; // 100 ms analysis frames

export interface ChunkOptions {
	/** Analysis block length in seconds (cut at the quietest frame in its last quarter). */
	blockSeconds: number;
	/** Longest window handed to Whisper. */
	windowSeconds: number;
	/** Windows are cut at the quietest frame after this many seconds. */
	minWindowSeconds: number;
	/** Silences at least this long are removed. */
	minSilenceSeconds: number;
	/** Audio kept on each side of a removed silence. */
	padSeconds: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = {
	blockSeconds: 120,
	windowSeconds: 29.5,
	minWindowSeconds: 18,
	minSilenceSeconds: 2,
	padSeconds: 0.4,
};

export interface Window {
	audio: Float32Array;
	/** Media time of the window's first and last sample, in seconds. */
	start: number;
	end: number;
	/** Maps a time within the window (seconds) to media time. */
	toMedia(t: number): number;
	/** True when most of the media span [a, b) is below the silence threshold. */
	quiet(a: number, b: number): boolean;
}

interface Piece {
	at: number; // sample offset in the compacted audio
	src: number; // absolute sample index in the media
	len: number;
}

export class Chunker {
	private parts: Float32Array[] = [];
	private length = 0;
	private origin = 0; // absolute sample index of the buffered audio's start

	private readonly opts: ChunkOptions;

	constructor(opts: ChunkOptions = DEFAULT_CHUNKING) {
		this.opts = opts;
	}

	/** Buffers 16 kHz mono audio; returns the windows of every block now complete. */
	push(audio: Float32Array): Window[] {
		if (audio.length === 0) return [];
		this.parts.push(audio);
		this.length += audio.length;
		const block = this.opts.blockSeconds * RATE;
		if (this.length < block) return [];
		const buffered = this.take();
		const searchFrom = Math.floor((block * 0.75) / FRAME);
		const cut = quietestFrame(frameRms(buffered.subarray(0, block)), searchFrom) * FRAME;
		const rest = buffered.slice(cut);
		const windows = this.process(buffered.subarray(0, cut));
		this.parts = rest.length ? [rest] : [];
		this.length = rest.length;
		return windows;
	}

	flush(): Window[] {
		const windows = this.length ? this.process(this.take()) : [];
		this.parts = [];
		this.length = 0;
		return windows;
	}

	private take(): Float32Array {
		if (this.parts.length === 1) return this.parts[0];
		const all = new Float32Array(this.length);
		let at = 0;
		for (const p of this.parts) {
			all.set(p, at);
			at += p.length;
		}
		this.parts = [all];
		return all;
	}

	/** Removes long silences from one block and cuts the rest into windows. */
	private process(block: Float32Array): Window[] {
		const origin = this.origin;
		this.origin += block.length;
		const { opts } = this;
		const rms = frameRms(block);
		const threshold = silenceThreshold(rms);
		const quiet = (a: number, b: number) => {
			const from = Math.max(0, Math.floor((a * RATE - origin) / FRAME));
			const to = Math.min(rms.length, Math.ceil((b * RATE - origin) / FRAME));
			if (to <= from) return false;
			let n = 0;
			for (let i = from; i < to; i++) if (rms[i] < threshold) n++;
			return n / (to - from) >= 0.6;
		};

		// Kept ranges, in samples within the block.
		const kept = speechRanges(rms, threshold, opts.minSilenceSeconds * 10, Math.round(opts.padSeconds * 10)).map(
			([a, b]) => [a * FRAME, Math.min(block.length, b * FRAME)] as const,
		);
		const total = kept.reduce((n, [a, b]) => n + (b - a), 0);
		if (total < RATE / 2) return []; // nothing but silence (or a blip)

		const compact = new Float32Array(total);
		const pieces: Piece[] = [];
		let at = 0;
		for (const [a, b] of kept) {
			compact.set(block.subarray(a, b), at);
			pieces.push({ at, src: origin + a, len: b - a });
			at += b - a;
		}

		const windows: Window[] = [];
		const crms = frameRms(compact);
		const maxLen = Math.floor(opts.windowSeconds * RATE);
		let start = 0;
		while (start < total) {
			let end = Math.min(total, start + maxLen);
			if (total - start > maxLen) {
				const fromFrame = Math.ceil((start + opts.minWindowSeconds * RATE) / FRAME);
				const toFrame = Math.floor(end / FRAME);
				end = quietestFrame(crms, fromFrame, toFrame) * FRAME;
			}
			const offset = start;
			const toMedia = (t: number) => mapCompacted(pieces, offset + t * RATE) / RATE;
			windows.push({
				audio: compact.slice(start, end),
				start: toMedia(0),
				end: mapCompacted(pieces, end - 1) / RATE,
				toMedia,
				quiet,
			});
			start = end;
		}
		return windows;
	}
}

/** RMS of each 100 ms frame (the last one may be shorter). */
export function frameRms(audio: Float32Array): Float32Array {
	const n = Math.ceil(audio.length / FRAME);
	const out = new Float32Array(n);
	for (let f = 0; f < n; f++) {
		const a = f * FRAME;
		const b = Math.min(audio.length, a + FRAME);
		let sum = 0;
		for (let i = a; i < b; i++) sum += audio[i] * audio[i];
		out[f] = Math.sqrt(sum / (b - a));
	}
	return out;
}

/**
 * Twice the block's noise floor (its 5th-percentile frame), kept between -56 and -40 dBFS: high
 * enough to catch room tone, low enough that quiet speech is never taken for silence.
 */
export function silenceThreshold(rms: Float32Array): number {
	if (rms.length === 0) return 0;
	const sorted = Float32Array.from(rms).sort();
	const floor = sorted[Math.floor(sorted.length * 0.05)];
	return Math.min(0.01, Math.max(0.0015, floor * 2));
}

/** Frame ranges [a, b) to keep: everything except silences of `minSilence`+ frames, less `pad` frames each side. */
export function speechRanges(
	rms: Float32Array,
	threshold: number,
	minSilence: number,
	pad: number,
): [number, number][] {
	const ranges: [number, number][] = [];
	let keepFrom = 0;
	let i = 0;
	while (i < rms.length) {
		if (rms[i] >= threshold) {
			i++;
			continue;
		}
		let j = i;
		while (j < rms.length && rms[j] < threshold) j++;
		if (j - i >= minSilence) {
			const cutFrom = i === 0 ? 0 : i + pad;
			const cutTo = j === rms.length ? j : j - pad;
			if (cutFrom > keepFrom) ranges.push([keepFrom, cutFrom]);
			keepFrom = cutTo;
		}
		i = j;
	}
	if (keepFrom < rms.length) ranges.push([keepFrom, rms.length]);
	return ranges;
}

/** Index of the lowest frame in [from, to); ties go to the latest, so windows run as long as allowed. */
function quietestFrame(rms: Float32Array, from: number, to = rms.length): number {
	let best = Math.max(0, Math.min(from, to - 1));
	for (let i = best; i < to; i++) if (rms[i] <= rms[best]) best = i;
	return Math.max(1, best);
}

/** Absolute media sample for a sample offset in the compacted audio. */
function mapCompacted(pieces: Piece[], at: number): number {
	let lo = 0;
	let hi = pieces.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (pieces[mid].at <= at) lo = mid;
		else hi = mid - 1;
	}
	const p = pieces[lo];
	return p.src + Math.min(Math.max(0, at - p.at), p.len);
}
