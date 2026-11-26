// Compares a conversion with a reference TXT in the export format (works
// separated by three empty lines, title first). Used by scripts/pdf-txt.ts to
// put numbers on changes; the reference is a second extraction, not truth.
import type { TxtResult } from "./types.ts";

/** Folds the differences two extractions disagree on without meaning: quotes, dashes, ellipses, spacing. */
export function normalizeLine(s: string): string {
	return s
		.normalize("NFKC")
		.replace(/[’‘`´]/g, "'")
		.replace(/[“”„]/g, '"')
		.replace(/[‐‑‒–—―]/g, "-")
		.replace(/…/g, "...")
		.replace(/\s+/g, " ")
		.trim();
}

export function parseReference(txt: string): { title: string; body: string[] }[] {
	return txt
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n[ \t]*\n[ \t]*\n+/)
		.map((chunk) => chunk.split("\n").filter((l) => l.trim()))
		.filter((lines) => lines.length)
		.map(([title, ...body]) => ({ title, body }));
}

function levenshtein(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

export const similarity = (a: string, b: string) => {
	const x = normalizeLine(a).toLowerCase();
	const y = normalizeLine(b).toLowerCase();
	return x || y ? 1 - levenshtein(x, y) / Math.max(x.length, y.length) : 1;
};

/** Length of the longest common subsequence of two string lists. */
export function lcs(a: string[], b: string[]): number {
	let prev = new Uint32Array(b.length + 1);
	let cur = new Uint32Array(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++)
			cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
		[prev, cur] = [cur, prev];
	}
	return prev[b.length];
}

/** Aligns two title sequences in order, pairing titles at least `min` similar. */
function alignTitles(ours: string[], ref: string[], min = 0.6): [number, number][] {
	const n = ours.length;
	const m = ref.length;
	const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
	for (let i = 1; i <= n; i++)
		for (let j = 1; j <= m; j++) {
			const s = similarity(ours[i - 1], ref[j - 1]);
			score[i][j] = Math.max(score[i - 1][j], score[i][j - 1], s >= min ? score[i - 1][j - 1] + s : 0);
		}
	const pairs: [number, number][] = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		const s = similarity(ours[i - 1], ref[j - 1]);
		if (s >= min && Math.abs(score[i][j] - (score[i - 1][j - 1] + s)) < 1e-9) {
			pairs.unshift([i - 1, j - 1]);
			i--;
			j--;
		} else if (score[i - 1][j] >= score[i][j - 1]) i--;
		else j--;
	}
	return pairs;
}

export function compareToReference(result: TxtResult, refTxt: string) {
	const ref = parseReference(refTxt);
	const works = result.works.filter((w) => w.kind === "work");
	const pairs = alignTitles(
		works.map((w) => w.title),
		ref.map((r) => r.title),
	);
	const body = (lines: string[]) => lines.map(normalizeLine).filter(Boolean);
	const ourBody = works.flatMap((w) => body(w.lines.map((l) => l.text)));
	const refBody = ref.flatMap((r) => body(r.body));
	let exact = 0;
	let full = 0;
	let grouping = 0;
	const titleDiffs: string[] = [];
	for (const [o, r] of pairs) {
		const ot = normalizeLine(works[o].title);
		const rt = normalizeLine(ref[r].title);
		if (ot === rt) exact++;
		else titleDiffs.push(`title p${works[o].page + 1}: "${works[o].title}" vs reference "${ref[r].title}"`);
		const a = body(works[o].lines.map((l) => l.text));
		const b = body(ref[r].body);
		if (a.length === b.length && a.every((l, i) => l === b[i])) full++;
		if (Math.abs(a.length - b.length) <= 2 && lcs(a, b) >= b.length * 0.9) grouping++;
	}
	const matchedRef = new Set(pairs.map((p) => p[1]));
	const matchedOurs = new Set(pairs.map((p) => p[0]));
	ref.forEach((r, i) => {
		if (!matchedRef.has(i)) titleDiffs.push(`missed: "${r.title}"`);
	});
	works.forEach((w, i) => {
		if (!matchedOurs.has(i)) titleDiffs.push(`extra p${w.page + 1}: "${w.title || "(untitled)"}"`);
	});
	return {
		refTitles: ref.length,
		titlesFound: pairs.length,
		titlesExact: exact,
		extraTitles: works.length - pairs.length,
		refBodyLines: refBody.length,
		ourBodyLines: ourBody.length,
		bodyMatched: lcs(ourBody, refBody),
		worksFull: full,
		groupingOk: grouping,
		titleDiffs,
	};
}
