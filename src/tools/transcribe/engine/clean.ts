// Whisper's known failure modes, cleaned up after each window:
// - stock phrases it invents over silence or noise ("Thank you.", "Thanks for watching!"),
//   dropped only where the audio under them is mostly quiet, so real thanks survive;
// - decoding loops ("the the the the …", a sentence repeated over and over);
// - empty or punctuation-only segments.

import type { Segment } from "./format.ts";

const SILENCE_PHRASES = [
	/^thank you\.?$/i,
	/^thanks?( you)? (so much )?for watching[.!]?$/i,
	/^thank you for listening\.?$/i,
	/^(please )?(like and )?subscribe.*$/i,
	/^(subtitles|captions|transcription) by .*$/i,
	/amara\.org/i,
	/^you\.?$/i,
	/^bye\.?$/i,
	/^\[?(music|silence|blank_audio|no speech)\]?$/i,
	/^\(?(music|silence)\)?$/i,
];

/** Runs of a 1-8 word phrase repeated at least this many times in a row collapse to one. */
const LOOP_REPEATS = 4;

export function collapseLoops(text: string): string {
	let words = text.split(/\s+/).filter(Boolean);
	for (let n = 1; n <= 8; n++) {
		const out: string[] = [];
		let i = 0;
		while (i < words.length) {
			let reps = 1;
			while (i + (reps + 1) * n <= words.length && sameWords(words, i, i + reps * n, n)) reps++;
			if (reps >= LOOP_REPEATS) {
				out.push(...words.slice(i, i + n));
				i += reps * n;
			} else {
				out.push(words[i]);
				i++;
			}
		}
		words = out;
	}
	return words.join(" ");
}

function sameWords(words: string[], a: number, b: number, n: number): boolean {
	for (let k = 0; k < n; k++) if (norm(words[a + k]) !== norm(words[b + k])) return false;
	return true;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/**
 * Cleans one window's segments. `quiet(a, b)` says whether the media span is mostly silence.
 * `previous` is the last segment kept so far (from earlier windows), for repeat detection.
 */
export function cleanSegments(
	segments: Segment[],
	quiet: (a: number, b: number) => boolean,
	previous?: Segment,
): Segment[] {
	const out: Segment[] = [];
	let last = previous;
	for (const seg of segments) {
		const text = collapseLoops(seg.text.trim());
		if (!/[\p{L}\p{N}]/u.test(text)) continue;
		if (SILENCE_PHRASES.some((re) => re.test(text)) && quiet(seg.start, Math.max(seg.end, seg.start + 0.5))) continue;
		// A long sentence straight after itself is a loop across windows, not speech.
		if (last && text.length >= 20 && norm(text) === norm(last.text)) continue;
		const start = Math.max(seg.start, last?.start ?? 0); // lines never go back in time
		const kept = { start, end: Math.max(start, seg.end), text };
		out.push(kept);
		last = kept;
	}
	return out;
}
