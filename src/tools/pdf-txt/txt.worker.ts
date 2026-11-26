// Runs PDF reading, conversion and page rendering off the main thread. The
// document stays open between calls: pages are read once, then switching
// modes re-converts from the cached page models, and the preview renders
// single pages on demand.
import * as Comlink from "comlink";
import * as mupdf from "mupdf";
import { meta, openDocument, type Progress } from "../../lib/pdf/document.ts";
import { blockCachedHandle } from "../../lib/pdf/fileStream.ts";
import type { OutlineEntry, PageModel } from "../../lib/pdf/heuristics.ts";
import { guessMode } from "./engine/guess.ts";
import type { Mode, TxtResult } from "./engine/index.ts";
import { convertWithOcr, type OcrPage } from "./engine/ocr.ts";
import { readPdf } from "./engine/read.ts";
import { OCR_DPI, pgm } from "./ocr/params.ts";

declare class FileReaderSync {
	readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

function fileHandle(file: File) {
	const reader = new FileReaderSync();
	return blockCachedHandle(
		file.size,
		(pos, len) => new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, pos + len))),
	);
}

function throttled(progress: Progress): Progress {
	let last = 0;
	return (done, total, phase) => {
		const now = performance.now();
		if (now - last > 100 || done === total) {
			last = now;
			void progress(done, total, phase);
		}
	};
}

/** True when a page is covered by one picture (as a scan is). */
function pictureOnly(open: mupdf.Document, index: number): boolean {
	const page = open.loadPage(index);
	try {
		const [x0, y0, x1, y1] = page.getBounds();
		const area = (x1 - x0) * (y1 - y0);
		let covered = false;
		const st = page.toStructuredText("preserve-images");
		st.walk({
			onImageBlock(bbox) {
				const w = Math.min(bbox[2], x1) - Math.max(bbox[0], x0);
				const h = Math.min(bbox[3], y1) - Math.max(bbox[1], y0);
				if (w > 0 && h > 0 && (w * h) / area >= 0.85) covered = true;
			},
		});
		st.destroy();
		return covered;
	} finally {
		page.destroy();
	}
}

let doc: mupdf.Document | null = null;
let book: { pages: PageModel[]; outline: OutlineEntry[] } | null = null;
/** OCR results by page, kept so every conversion of this book includes them. */
let ocr = new Map<number, OcrPage>();

export interface LoadedBook {
	title: string;
	author: string;
	pages: number;
	/** The mode the book's shape suggests. */
	mode: Mode;
	/** Pages that are scans with no text layer. */
	imageOnly: number;
	/** Pages whose text is an OCR layer over a scan. */
	ocr: number;
}

export interface RenderedPage {
	png: Uint8Array;
	/** Page size in PDF points, for placing highlight boxes. */
	width: number;
	height: number;
}

const api = {
	load(file: File, progress: Progress): LoadedBook {
		doc?.destroy();
		doc = null;
		book = null;
		ocr = new Map();
		const opened = openDocument(fileHandle(file), "pdf");
		doc = opened;
		book = readPdf(opened, throttled(progress));
		return {
			title: meta(opened, "info:Title"),
			author: meta(opened, "info:Author"),
			pages: book.pages.length,
			mode: guessMode(book.pages),
			imageOnly: book.pages.filter((p) => p.imageOnly).length,
			ocr: book.pages.filter((p) => p.ocr).length,
		};
	},

	convert(mode: Mode): TxtResult {
		if (!book) throw new Error("No book is open.");
		return convertWithOcr(book.pages, book.outline, { mode }, ocr);
	},

	/** Renders one page as PNG, `cssWidth` pixels wide at the given device pixel ratio. */
	render(index: number, cssWidth: number, ratio: number): RenderedPage {
		if (!doc) throw new Error("No book is open.");
		const page = doc.loadPage(index);
		try {
			const [x0, y0, x1, y1] = page.getBounds();
			const width = x1 - x0;
			const scale = Math.min(4, (cssWidth * ratio) / width);
			const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
			try {
				const png = pix.asPNG().slice();
				return Comlink.transfer({ png, width, height: y1 - y0 }, [png.buffer]);
			} finally {
				pix.destroy();
			}
		} finally {
			page.destroy();
		}
	},

	/**
	 * Pages that are scans: an OCR text layer, no text at all, or a page-sized
	 * picture without text that the reader took for a blank leaf (its ink test
	 * can miss small type). Born-digital pages are left out.
	 */
	scanPages(): { pages: number[]; textless: number } {
		if (!doc || !book) return { pages: [], textless: 0 };
		const open = doc;
		const textless = (p: PageModel) => !p.blocks.some((b) => b.kind === "text" && b.lines.length);
		return {
			pages: book.pages
				.filter((p) => p.ocr || p.imageOnly || (textless(p) && pictureOnly(open, p.index)))
				.map((p) => p.index),
			/** Pages with no text at all: all of them means a scanned book without a text layer. */
			textless: book.pages.filter(textless).length,
		};
	},

	/** Renders one page for OCR: grey, at OCR_DPI, as a PGM image. `scale` is pixels per PDF point. */
	renderForOcr(index: number): { image: Uint8Array; scale: number } {
		if (!doc) throw new Error("No book is open.");
		const page = doc.loadPage(index);
		try {
			const scale = OCR_DPI / 72;
			const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
			try {
				const image = pgm(pix.getWidth(), pix.getHeight(), pix.getPixels());
				return Comlink.transfer({ image, scale }, [image.buffer]);
			} finally {
				pix.destroy();
			}
		} finally {
			page.destroy();
		}
	},

	/** Keeps what OCR read on a page; the next convert() merges it in. */
	addOcr(result: OcrPage) {
		ocr.set(result.page, result);
	},

	/** Pages that have OCR results. */
	ocrPages(): number[] {
		return [...ocr.keys()];
	},
};

export type TxtApi = typeof api;

mupdf.setLog({
	error: (m: string) => console.error(`[mupdf] ${m}`),
	warning: (m: string) => console.debug(`[mupdf] ${m}`),
});

Comlink.expose(api);
self.postMessage({ type: "ready" });
