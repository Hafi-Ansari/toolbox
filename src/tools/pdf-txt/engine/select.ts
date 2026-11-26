// From a selection in the TXT to the printed passage it stands for, so a
// manual override can be keyed to the source rather than to line numbers.

import type { OutLine } from "./index.ts";
import { before } from "./source.ts";
import type { SourceSpan } from "./types.ts";

/** The TXT lines a textarea selection touches: [first, last], and whether it is just a caret. */
export function selectedLines(
	value: string,
	start: number,
	end: number,
): { first: number; last: number; caret: boolean } {
	const lineAt = (pos: number) => {
		let n = 0;
		for (let i = value.indexOf("\n"); i >= 0 && i < pos; i = value.indexOf("\n", i + 1)) n++;
		return n;
	};
	if (end <= start) {
		const at = lineAt(start);
		return { first: at, last: at, caret: true };
	}
	// A selection that ends at the start of a line (dragged past a line end) does not take that line.
	const last = value[end - 1] === "\n" ? lineAt(end - 1) : lineAt(end);
	return { first: lineAt(start), last: Math.max(lineAt(start), last), caret: false };
}

export interface Selected {
	span: SourceSpan;
	/** The TXT lines it covers. */
	first: number;
	last: number;
	/** A short label: the passage's first line. */
	text: string;
}

/**
 * The printed passage behind TXT lines [first, last]. A caret stands for its
 * whole paragraph (prose) or stanza (poetry). Titles and blank lines carry no
 * source and are skipped; prose lines stand for every printed line their
 * sentence touches. Null when nothing selected has a source.
 */
export function selectionSpan(lines: OutLine[], first: number, last: number, caret = false): Selected | null {
	if (first < 0 || first >= lines.length) return null;
	last = Math.min(Math.max(first, last), lines.length - 1);
	if (caret) {
		if (!lines[first].text.trim()) return null;
		const same = (i: number) => lines[i]?.text.trim() && lines[i].work === lines[first].work;
		while (same(first - 1)) first--;
		while (same(last + 1)) last++;
	}
	let span: SourceSpan | null = null;
	let text = "";
	let a = -1;
	let b = -1;
	for (let i = first; i <= last; i++) {
		const s = lines[i].span;
		if (!s) continue;
		if (a < 0) {
			a = i;
			text = lines[i].text.trim();
		}
		b = i;
		span = span
			? { from: before(s.from, span.from) ? s.from : span.from, to: before(span.to, s.to) ? s.to : span.to }
			: { from: s.from, to: s.to };
	}
	if (!span) return null;
	return { span, first: a, last: b, text: text.length > 60 ? `${text.slice(0, 59)}…` : text };
}
