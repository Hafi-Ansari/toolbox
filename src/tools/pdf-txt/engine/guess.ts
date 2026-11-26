// Guesses whether a book is verse or prose from its shape: prose lines run to
// the right edge of their column, verse lines mostly stop short of it.
import type { PageModel } from "../../../lib/pdf/heuristics.ts";
import type { Mode } from "./types.ts";

/**
 * Share of lines that reach their column's right edge. Lines are grouped into
 * columns by where they start, so two-column pages and indented verse each get
 * their own edge. Measured: poetry collections ≈ 0.3, novels and papers ≈ 0.7.
 */
export function fullLineShare(pages: PageModel[]): number {
	let full = 0;
	let all = 0;
	for (const p of pages) {
		const lines = p.blocks.flatMap((b) => (b.kind === "text" ? b.lines : [])).filter((l) => l.text.trim().length > 1);
		const columns = new Map<number, number[]>();
		for (const l of lines) {
			const key = Math.round(l.x0 / (p.width * 0.05));
			columns.set(key, [...(columns.get(key) ?? []), l.x1]);
		}
		for (const ends of columns.values()) {
			if (ends.length < 6) continue;
			const sorted = [...ends].sort((a, b) => a - b);
			const edge = sorted[Math.floor(sorted.length * 0.9)];
			for (const x of ends) {
				all++;
				if (x >= edge - p.width * 0.04) full++;
			}
		}
	}
	return all ? full / all : 0;
}

/** "prose" when most lines fill their column; "poetry" otherwise (and for books with too little text to tell). */
export function guessMode(pages: PageModel[]): Mode {
	return fullLineShare(pages) >= 0.5 ? "prose" : "poetry";
}
