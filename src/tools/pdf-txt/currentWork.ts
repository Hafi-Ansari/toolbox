import type { Work } from "./engine/index.ts";

/**
 * Which work the "Go to work" menu should show for `page`: the work holding the caret (or the one
 * just jumped to) when it covers this page; otherwise the work that started most recently among
 * those covering it. A work often ends on the page where the next one starts, and the newer one
 * is what the reader is looking at. -1 when no listed work covers the page.
 */
export function currentWork(works: Work[], page: number, opts: { matter: boolean; preferred?: number | null }): number {
	const listed = (w: Work) => w.kind !== "matter" || opts.matter;
	const covers = (w: Work) => page >= w.page && page <= w.endPage;
	const p = opts.preferred;
	if (p !== undefined && p !== null && works[p] && listed(works[p]) && covers(works[p])) return p;
	let best = -1;
	works.forEach((w, i) => {
		if (listed(w) && covers(w) && (best < 0 || w.page >= works[best].page)) best = i;
	});
	return best;
}
