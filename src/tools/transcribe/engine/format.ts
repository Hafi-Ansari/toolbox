// Transcript output. The formats match the Python script this tool replaces: one line per
// segment, "[HH:MM:SS] text" for TXT, and SRT with "HH:MM:SS,mmm". Times are truncated, never
// rounded, so a line never claims a time later than the speech it marks.

export interface Segment {
	/** Seconds from the start of the media. */
	start: number;
	end: number;
	text: string;
}

/** Same arithmetic as the Python `ts()` (divmod, then int()), so outputs agree to the millisecond. */
export function timestamp(seconds: number, srt = false): string {
	const sec = Math.max(0, seconds);
	const rem = sec % 3600;
	const h = Math.round((sec - rem) / 3600);
	const s = rem % 60;
	const m = Math.round((rem - s) / 60);
	const hms = `${pad(h, 2)}:${pad(m, 2)}:${pad(Math.trunc(s), 2)}`;
	return srt ? `${hms},${pad(Math.trunc((s % 1) * 1000), 3)}` : hms;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

export function toTxt(segments: readonly Segment[]): string {
	return segments.map((seg) => `[${timestamp(seg.start)}] ${seg.text}\n`).join("");
}

export function toSrt(segments: readonly Segment[]): string {
	return segments
		.map((seg, i) => `${i + 1}\n${timestamp(seg.start, true)} --> ${timestamp(seg.end, true)}\n${seg.text}\n\n`)
		.join("");
}
