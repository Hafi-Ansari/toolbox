// Finds where a piece of reflowed prose was printed. The shared paragraph
// builder returns text without positions, so each sentence is matched back to
// the printed lines by its letters and digits alone: joining lines, undoing
// hyphenation and tidying spaces never change those, and their order is kept.
import type { PageModel } from "../../../lib/pdf/heuristics.ts";
import type { Box, SourcePos, SourceSpan } from "./types.ts";

/** Letters and digits only, lowercased: what survives every rejoining of printed lines. */
const key = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/** How far ahead of the last match a sentence may start before it counts as out of order (notes, captions). */
const WINDOW = 4000;
/** Long sentences are matched by their first and last letters, so a footnote printed inside one does not break it. */
const EDGE = 40;

export interface Located {
	page: number;
	box: Box;
	span: SourceSpan;
}

/** Position comparison in reading order. */
export const before = (a: SourcePos, b: SourcePos) => a.page < b.page || (a.page === b.page && a.y < b.y);

/** True when a printed line from `y0` to `y1` on `page` belongs to the span (its middle lies inside it). */
export function inSpan(span: SourceSpan, page: number, y0: number, y1: number): boolean {
	const mid = { page, y: (y0 + y1) / 2 };
	return !before(mid, span.from) && !before(span.to, mid);
}

/**
 * Returns a function that locates successive pieces of text (sentences, in
 * reading order) among the printed lines of `models`. A piece it cannot find
 * gets undefined.
 */
export function sourceFinder(models: PageModel[]): (text: string) => Located | undefined {
	const lines: { page: number; box: Box }[] = [];
	const owner: number[] = [];
	let chars = "";
	for (const m of models)
		for (const b of m.blocks) {
			if (b.kind !== "text") continue;
			for (const l of b.lines) {
				const k = key(l.text);
				if (!k) continue;
				lines.push({ page: m.index, box: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 } });
				chars += k;
				for (let i = 0; i < k.length; i++) owner.push(lines.length - 1);
			}
		}
	let cursor = 0;
	return (text) => {
		const k = key(text);
		if (!k) return undefined;
		const head = k.slice(0, EDGE);
		let start = chars.startsWith(head, cursor) ? cursor : chars.indexOf(head, cursor);
		if (start < 0 || start - cursor > WINDOW) start = chars.indexOf(head);
		if (start < 0) return undefined;
		let end = start + k.length - 1;
		if (chars.slice(start, end + 1) !== k) {
			const tail = k.slice(-EDGE);
			const t = chars.indexOf(tail, start);
			if (t < 0) return undefined;
			end = t + tail.length - 1;
		}
		if (start >= cursor) cursor = end + 1;
		const a = lines[owner[start]];
		const b = lines[owner[end]];
		return {
			page: a.page,
			box: a.box,
			span: { from: { page: a.page, y: a.box.y0 }, to: { page: b.page, y: b.box.y1 } },
		};
	};
}
