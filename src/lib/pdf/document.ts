// Opening documents with MuPDF and reading what they say about themselves:
// metadata, page count, outline, and whether the pages carry real text.
// Runs in a Web Worker in the app and directly in Node for tests and scripts.
import * as mupdf from "mupdf";
import type { StreamHandle } from "./fileStream.ts";
import type { OutlineEntry } from "./heuristics.ts";

export type Format = "pdf" | "epub";
export type OutlineItem = NonNullable<ReturnType<mupdf.Document["loadOutline"]>>[number];
export type Progress = (done: number, total: number, phase: string) => void;

export interface InputInfo {
	format: Format;
	title: string;
	author: string;
	/** PDF page count. EPUBs have no fixed pages until laid out, so this is 0. */
	pages: number;
	hasOutline: boolean;
	/** True when sampled PDF pages carry almost no extractable text (likely a scan). */
	looksScanned: boolean;
}

const MAGIC: Record<Format, string> = { pdf: "application/pdf", epub: "application/epub+zip" };

/** Opens a document from a random-access handle, so it is never copied whole into WASM memory. */
export function openDocument(input: StreamHandle, format: Format): mupdf.Document {
	const doc = mupdf.Document.openDocument(new mupdf.Stream(input), MAGIC[format]);
	if (doc.needsPassword()) {
		doc.destroy();
		throw new Error("This file is password-protected. Remove the password and try again.");
	}
	return doc;
}

export const meta = (doc: mupdf.Document, key: string) => (doc.getMetaData(key) ?? "").trim();

export function inspect(input: StreamHandle, format: Format): InputInfo {
	const doc = openDocument(input, format);
	try {
		const title = meta(doc, "info:Title");
		const author = meta(doc, "info:Author");
		const outline = doc.loadOutline();
		if (format === "epub") {
			return { format, title, author, pages: 0, hasOutline: !!outline?.length, looksScanned: false };
		}
		const pages = doc.countPages();
		// Sample up to 6 pages spread across the document.
		const sample = [
			...new Set(Array.from({ length: Math.min(6, pages) }, (_, i) => Math.floor((i * pages) / Math.min(6, pages)))),
		];
		let chars = 0;
		for (const i of sample) {
			const page = doc.loadPage(i);
			const st = page.toStructuredText("");
			chars += st.asText().replace(/\s+/g, "").length;
			st.destroy();
			page.destroy();
		}
		const looksScanned = sample.length > 0 && chars / sample.length < 40;
		return { format, title, author, pages, hasOutline: !!outline?.length, looksScanned };
	} finally {
		doc.destroy();
	}
}

/** Outline items in reflowable documents carry a link (e.g. "OEBPS/ch1.xhtml"), not a page. */
export function resolveOutline(doc: mupdf.Document, items: OutlineItem[] | null): OutlineItem[] {
	return (items ?? []).map((item) => {
		let page = item.page;
		if (typeof page !== "number" && item.uri) {
			try {
				page = doc.resolveLink(item.uri);
			} catch {
				page = undefined;
			}
		}
		return { ...item, page, down: item.down ? resolveOutline(doc, item.down) : undefined };
	});
}

/** The outline as a flat list of titled entries that point at a page. */
export function flattenOutline(items: OutlineItem[], level = 1, out: OutlineEntry[] = []): OutlineEntry[] {
	for (const item of items) {
		if (typeof item.page === "number" && item.page >= 0 && item.title?.trim()) {
			out.push({ title: item.title.trim(), page: item.page, level });
		}
		if (item.down) flattenOutline(item.down, level + 1, out);
	}
	return out;
}
