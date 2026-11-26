// Conversion core. Runs inside the Web Worker in the app, and directly in
// Node for tests and scripts. Inputs arrive as random-access stream handles so
// they are never copied whole into WASM memory.
import * as mupdf from "mupdf";
import { EpubBuilder, type NavEntry } from "./epub.ts";
import type { StreamHandle } from "./fileStream.ts";
import {
	bodyFontSize,
	type OutlineEntry,
	type PageModel,
	renderParas,
	splitChapters,
	stripFurniture,
	toParagraphs,
} from "./heuristics.ts";
import { type ChunkSink, crc32 } from "./zip.ts";

export type Format = "pdf" | "epub";
type OutlineItem = NonNullable<ReturnType<mupdf.Document["loadOutline"]>>[number];
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

const MAGIC: Record<Format, string> = { pdf: "application/pdf", epub: "application/epub+zip" };

function open(input: StreamHandle, format: Format): mupdf.Document {
	const doc = mupdf.Document.openDocument(new mupdf.Stream(input), MAGIC[format]);
	if (doc.needsPassword()) {
		doc.destroy();
		throw new Error("This file is password-protected. Remove the password and try again.");
	}
	return doc;
}

const meta = (doc: mupdf.Document, key: string) => (doc.getMetaData(key) ?? "").trim();

export function inspect(input: StreamHandle, format: Format): InputInfo {
	const doc = open(input, format);
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

/* ----------------------------------------------------------------------------- EPUB → PDF */

export function epubToPdf(input: StreamHandle, opts: EpubToPdfOptions, progress: Progress): Uint8Array {
	const doc = open(input, "epub");
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

/** Outline items in reflowable documents carry a link (e.g. "OEBPS/ch1.xhtml"), not a page. */
function resolveOutline(doc: mupdf.Document, items: OutlineItem[] | null): OutlineItem[] {
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

function flattenOutline(items: OutlineItem[], level = 1, out: OutlineEntry[] = []): OutlineEntry[] {
	for (const item of items) {
		if (typeof item.page === "number" && item.page >= 0 && item.title?.trim()) {
			out.push({ title: item.title.trim(), page: item.page, level });
		}
		if (item.down) flattenOutline(item.down, level + 1, out);
	}
	return out;
}

interface ImageSink {
	add(image: mupdf.Image, width: number, height: number): { href: string; width: number; height: number } | null;
}

/** Encodes images once each (identical images, like a repeated logo, are stored once). */
function imageSink(book: EpubBuilder, quality: number): ImageSink {
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
	};
}

function extractPage(page: mupdf.Page, index: number, images: ImageSink): PageModel {
	const [bx0, by0, bx1, by1] = page.getBounds();
	const model: PageModel = { index, width: bx1 - bx0, height: by1 - by0, blocks: [] };
	// No "paragraph-break"/"segment": those wrap content in structure blocks that walk() skips.
	// Paragraphs are rebuilt by the heuristics instead.
	const st = page.toStructuredText("preserve-images,preserve-whitespace,dehyphenate");
	let line: {
		chars: string[];
		sizes: Map<number, number>;
		bold: number;
		italic: number;
		n: number;
		bbox: number[];
	} | null = null;
	let lines: PageModel["blocks"][number] | null = null;
	st.walk({
		onImageBlock(_bbox, _transform, image) {
			const img = images.add(image, 0, 0);
			if (img) model.blocks.push({ kind: "image", ...img });
		},
		beginTextBlock() {
			lines = { kind: "text", lines: [] };
		},
		beginLine(bbox) {
			line = { chars: [], sizes: new Map(), bold: 0, italic: 0, n: 0, bbox };
		},
		onChar(c, _origin, font, size) {
			if (!line) return;
			line.chars.push(c);
			if (c.trim()) {
				const k = Math.round(size * 2) / 2;
				line.sizes.set(k, (line.sizes.get(k) ?? 0) + 1);
				line.n++;
				if (font.isBold()) line.bold++;
				if (font.isItalic()) line.italic++;
			}
		},
		endLine() {
			if (line && lines?.kind === "text") {
				const text = line.chars.join("");
				if (text.trim()) {
					let size = 0;
					let best = -1;
					for (const [s, count] of line.sizes) if (count > best) [size, best] = [s, count];
					const [x0, y0, x1, y1] = line.bbox;
					lines.lines.push({
						text,
						x0: x0 - bx0,
						y0: y0 - by0,
						x1: x1 - bx0,
						y1: y1 - by0,
						size,
						bold: line.bold > line.n / 2,
						italic: line.italic > line.n / 2,
					});
				}
			}
			line = null;
		},
		endTextBlock() {
			if (lines?.kind === "text" && lines.lines.length) model.blocks.push(lines);
			lines = null;
		},
	});
	st.destroy();
	return model;
}

export function pdfToEpub(
	input: StreamHandle,
	opts: PdfToEpubOptions,
	sink: ChunkSink,
	progress: Progress,
): ConvertResult {
	const t0 = performance.now();
	const doc = open(input, "pdf");
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
			const images = imageSink(book, quality);
			const pages: PageModel[] = [];
			for (let i = 0; i < total; i++) {
				const page = doc.loadPage(i);
				pages.push(extractPage(page, i, images));
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
