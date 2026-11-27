// Conversion core. Runs inside the Web Worker in the app, and directly in
// Node for tests and scripts. Opening, inspecting and reading PDF pages is
// shared with other tools in src/lib/pdf/; EPUB packaging lives here.
import * as mupdf from "mupdf";
import {
	flattenOutline,
	meta,
	type OutlineItem,
	openDocument,
	type Progress,
	resolveOutline,
} from "../../../lib/pdf/document.ts";
import { extractPage, type PageImages } from "../../../lib/pdf/extract.ts";
import type { StreamHandle } from "../../../lib/pdf/fileStream.ts";
import { bodyFontSize, type PageModel, stripFurniture, toParagraphs } from "../../../lib/pdf/heuristics.ts";
import { type ChunkSink, crc32 } from "../../../lib/zipWriter.ts";
import { renderParas, splitChapters } from "./chapters.ts";
import { EpubBuilder, type NavEntry } from "./epub.ts";

export type { Format, InputInfo, Progress } from "../../../lib/pdf/document.ts";
export { inspect } from "../../../lib/pdf/document.ts";

export interface EpubToPdfOptions {
	/** Page size in points. */
	width: number;
	height: number;
	/** Base font size in points. */
	fontSize: number;
	/** Page margin in points. */
	margin: number;
}

export interface PdfToEpubOptions {
	mode: "reflow" | "fixed";
	/** Render resolution for fixed layout. */
	dpi?: number;
	/** JPEG quality, 1–100. */
	quality?: number;
}

export interface ConvertResult {
	pages: number;
	bytes: number;
	ms: number;
}

/* ----------------------------------------------------------------------------- EPUB → PDF */

export function epubToPdf(input: StreamHandle, opts: EpubToPdfOptions, progress: Progress): Uint8Array {
	const doc = openDocument(input, "epub");
	const out = new mupdf.Buffer();
	try {
		progress(0, 0, "Laying out pages");
		// Keep the book's own CSS; our stylesheet only sets the page margins.
		doc.style(true, `@page { margin: ${opts.margin}pt; }`);
		doc.layout(opts.width, opts.height, opts.fontSize);
		const total = doc.countPages();
		const writer = new mupdf.DocumentWriter(out, "pdf", "compress");
		for (let i = 0; i < total; i++) {
			const page = doc.loadPage(i);
			const device = writer.beginPage(page.getBounds());
			page.run(device, mupdf.Matrix.identity);
			writer.endPage();
			page.destroy();
			progress(i + 1, total, "Writing pages");
		}
		writer.close();
		writer.destroy();

		// Second pass on the finished PDF: bookmarks from the EPUB's table of
		// contents, plus title/author metadata.
		progress(total, total, "Adding bookmarks");
		const outline = resolveOutline(doc, doc.loadOutline());
		const pdf = mupdf.Document.openDocument(out, "application/pdf") as mupdf.PDFDocument;
		const title = meta(doc, "info:Title");
		const author = meta(doc, "info:Author");
		if (title) pdf.setMetaData("info:Title", title);
		if (author) pdf.setMetaData("info:Author", author);
		pdf.setMetaData("info:Creator", "Toolbox EPUB to PDF");
		if (outline.length) insertOutline(pdf, pdf.outlineIterator(), outline);
		const saved = pdf.saveToBuffer("compress,garbage");
		const bytes = saved.asUint8Array().slice();
		saved.destroy();
		pdf.destroy();
		return bytes;
	} finally {
		out.destroy();
		doc.destroy();
	}
}

function insertOutline(pdf: mupdf.PDFDocument, it: mupdf.OutlineIterator, items: OutlineItem[]): void {
	for (const item of items) {
		const uri =
			typeof item.page === "number" && item.page >= 0
				? pdf.formatLinkURI({ type: "Fit", chapter: 0, page: item.page, x: 0, y: 0, width: 0, height: 0, zoom: 0 })
				: undefined;
		it.insert({ title: item.title ?? "", uri, open: false });
		if (item.down?.length) {
			it.prev();
			it.down();
			insertOutline(pdf, it, item.down);
			it.up();
			it.next();
		}
	}
}

/* ----------------------------------------------------------------------------- PDF → EPUB */

/**
 * Stores pictures in the book. Embedded images are encoded once each (identical
 * images, like a repeated logo, are stored once); whole pages render as JPEG.
 */
function bookImages(book: EpubBuilder, quality: number): PageImages {
	const seen = new Map<string, { href: string; width: number; height: number }>();
	let n = 0;
	return {
		add(image) {
			let pix: mupdf.Pixmap | null = null;
			try {
				pix = image.toPixmap();
				if (!pix.getColorSpace()) return null; // stencil masks carry no picture
				const w = pix.getWidth();
				const h = pix.getHeight();
				if (w < 24 || h < 24) return null; // rules, bullets and other decoration
				const cs = pix.getColorSpace();
				if (cs && !cs.isRGB() && !cs.isGray()) {
					const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, !!pix.getAlpha());
					pix.destroy();
					pix = rgb;
				}
				const png = !!pix.getAlpha();
				const data = (png ? pix.asPNG() : pix.asJPEG(quality)).slice();
				const key = `${crc32(data)}:${data.length}`;
				const known = seen.get(key);
				if (known) return known;
				const href = `images/img${++n}.${png ? "png" : "jpg"}`;
				book.addImage(href, png ? "image/png" : "image/jpeg", data);
				const entry = { href, width: w, height: h };
				seen.set(key, entry);
				return entry;
			} catch {
				return null; // an undecodable image should not fail the whole book
			} finally {
				pix?.destroy();
			}
		},
		render(page) {
			// Composites a scan's image layers into one picture.
			const scale = 150 / 72;
			const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
			try {
				const href = `images/img${++n}.jpg`;
				book.addImage(href, "image/jpeg", pix.asJPEG(quality).slice());
				return { href, width: pix.getWidth(), height: pix.getHeight() };
			} finally {
				pix.destroy();
			}
		},
	};
}

export function pdfToEpub(
	input: StreamHandle,
	opts: PdfToEpubOptions,
	sink: ChunkSink,
	progress: Progress,
): ConvertResult {
	const t0 = performance.now();
	const doc = openDocument(input, "pdf");
	try {
		const total = doc.countPages();
		const title = meta(doc, "info:Title") || "Untitled";
		const author = meta(doc, "info:Author") || undefined;
		const quality = opts.quality ?? 85;
		const outline = flattenOutline(resolveOutline(doc, doc.loadOutline()));
		const book = new EpubBuilder({ title, author, fixed: opts.mode === "fixed" }, sink);
		const nav: NavEntry[] = [];

		if (opts.mode === "fixed") {
			const scale = (opts.dpi ?? 150) / 72;
			const pad = String(total).length;
			const pageHref = (i: number) => `page${String(i + 1).padStart(pad, "0")}.xhtml`;
			for (let i = 0; i < total; i++) {
				const page = doc.loadPage(i);
				const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
				const width = pix.getWidth();
				const height = pix.getHeight();
				const jpg = pix.asJPEG(quality).slice();
				pix.destroy();
				page.destroy();
				const img = `images/p${String(i + 1).padStart(pad, "0")}.jpg`;
				book.addImage(img, "image/jpeg", jpg);
				book.addPage(pageHref(i), `Page ${i + 1}`, `<img src="${img}" alt="Page ${i + 1}"/>`, { width, height });
				progress(i + 1, total, "Rendering pages");
			}
			for (const o of outline) if (o.page < total) nav.push({ title: o.title, href: pageHref(o.page), level: o.level });
		} else {
			const images = bookImages(book, quality);
			const pages: PageModel[] = [];
			for (let i = 0; i < total; i++) {
				const page = doc.loadPage(i);
				pages.push(extractPage(page, i, { images }));
				page.destroy();
				progress(i + 1, total, "Reading text");
			}
			progress(total, total, "Rebuilding chapters");
			stripFurniture(pages);
			const paras = toParagraphs(pages, bodyFontSize(pages));
			const chapters = splitChapters(paras, outline, title);
			const pad = String(chapters.length).length;
			chapters.forEach((ch, i) => {
				const href = `chapter${String(i + 1).padStart(pad, "0")}.xhtml`;
				book.addPage(href, ch.title, renderParas(ch.paras));
				for (const entry of ch.nav) nav.push({ ...entry, href });
			});
		}

		book.finish(nav);
		return { pages: total, bytes: book.bytesWritten, ms: Math.round(performance.now() - t0) };
	} finally {
		doc.destroy();
	}
}
