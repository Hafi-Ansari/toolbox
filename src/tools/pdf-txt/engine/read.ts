// The MuPDF side: reads every page of an open PDF into page models (text only,
// no images kept) plus the flattened outline. Runs in the worker or in Node.
import type * as mupdf from "mupdf";
import { flattenOutline, type Progress, resolveOutline } from "../../../lib/pdf/document.ts";
import { extractPage } from "../../../lib/pdf/extract.ts";
import type { OutlineEntry, PageModel } from "../../../lib/pdf/heuristics.ts";

export function readPdf(doc: mupdf.Document, progress?: Progress): { pages: PageModel[]; outline: OutlineEntry[] } {
	const outline = flattenOutline(resolveOutline(doc, doc.loadOutline()));
	const total = doc.countPages();
	const pages: PageModel[] = [];
	for (let i = 0; i < total; i++) {
		const page = doc.loadPage(i);
		try {
			pages.push(extractPage(page, i));
		} finally {
			page.destroy();
		}
		progress?.(i + 1, total, "Reading pages");
	}
	return { pages, outline };
}
